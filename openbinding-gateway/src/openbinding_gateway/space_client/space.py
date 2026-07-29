"""Talking to SPACE through its official Python client.

Using ``space-python-client`` rather than SPACE's HTTP API directly, for the
obvious reason and one less obvious one. The obvious: it is maintained by the
people who write SPACE, so when the API moves the client moves with it, and it
brings caching with correct invalidation and a socket subscription for pricing
changes. The less obvious: it already knows the parts of the API that are easy
to get wrong. ``revert`` is ``POST /features/{user}?revert=true``, not the
per-feature path a reasonable person would guess, and finding that out by being
refused is a poor use of anybody's afternoon.

Two things this module still has to do itself.

The client is **synchronous** - it holds an ``httpx.Client``, and there is not
an ``async def`` in it. The gateway is asynchronous and spends its life holding
long solve connections, so every call goes through a worker thread. Blocking the
event loop on somebody else's HTTP call would stall every other request in
flight, including solves that have nothing to do with pricing.

And plan *ceilings* have to be recovered from the pricing token. A contract's
usage levels carry only what has been consumed; the allowance lives in the
pricing, resolved against the subscribed plan. Feature evaluation returns the
allowances for limits its expression mentions, but ``maxPayloadSizeLimit`` and
its kind appear in no expression - they bound a request rather than gate a
feature. The token has all of them, so that is where they come from.
"""

from __future__ import annotations

import base64
import binascii
import functools
import json
import uuid
from typing import Any, Callable, Dict, Optional, TypeVar

import anyio.to_thread

from ..core.settings import Settings
from .gate import (
    SERVICE_NAME,
    LimitUsage,
    PlanCaps,
    PricingUnavailable,
    UsageSnapshot,
    Verdict,
    feature_id,
)

T = TypeVar("T")

#: Limits that bound one request rather than a month, mapped onto PlanCaps.
_CAP_FIELDS = {
    "maxTimeoutPerTaskLimit": "max_timeout_s",
    "maxIterationsLimit": "max_iterations",
    "maxPayloadSizeLimit": "max_payload_mb",
    "maxBindingSpaceLimit": "max_binding_space_log10",
    "jobHistoryRetentionLimit": "job_history_days",
}


class SpacePricingGate:
    """A ``PricingGate`` backed by a real SPACE deployment."""

    def __init__(self, settings: Settings, client: Optional[Any] = None):
        if client is not None:
            self._client = client
        else:
            if not settings.space_url or not settings.space_api_key:
                raise ValueError("SPACE is enabled but SPACE_URL or SPACE_API_KEY is missing.")

            from space_client import SpaceClientFactory

            self._client = SpaceClientFactory.connect(
                settings.space_url, settings.space_api_key, settings.space_timeout_ms
            )

    async def aclose(self) -> None:
        close = getattr(self._client, "close", None)
        if close is not None:
            await self._off_the_loop(close)

    async def _off_the_loop(self, call: Callable[..., T], *args, **kwargs) -> T:
        """Run a blocking client call in a worker thread.

        Every call into the client goes through here. It is the whole reason a
        synchronous dependency is tolerable inside an asynchronous gateway.
        """
        try:
            return await anyio.to_thread.run_sync(functools.partial(call, *args, **kwargs))
        except Exception as error:  # the client raises whatever httpx raised
            raise PricingUnavailable(f"SPACE is not reachable: {error}") from error

    # -- Evaluation ------------------------------------------------------

    async def evaluate(
        self, user_id: uuid.UUID, feature: str, expected: Optional[Dict[str, float]] = None
    ) -> Verdict:
        """Whether a feature may be used right now.

        Asked as a **question**, never as a purchase: no expected consumption is
        sent, and nothing is written. The caller records what it spent
        afterwards, with ``adjust_usage``.

        That split is deliberate. Handing SPACE an expected consumption makes it
        apply the increments limit by limit, concurrently, each one a
        read-modify-write of the same contract - so with more than one limit
        involved the updates race and only one of them survives, and which one
        varies between calls. Accounting that sometimes forgets is worse than no
        accounting at all, because it looks like it works.

        Refusals are unaffected: the check reads the stored levels and is
        correct. It is only the writing that is unreliable, so the gateway does
        the writing.

        ``expected`` is accepted for the protocol's sake and used only to say
        which limits the caller cares about; it is not sent.
        """
        result = await self._off_the_loop(
            self._client.features.evaluate, str(user_id), feature_id(feature)
        )
        if result is None:
            return Verdict.no("No contract for this account.")

        if getattr(result, "eval", False):
            return Verdict.yes()

        error = getattr(result, "error", None)
        reason = getattr(error, "message", None) or "Your plan does not allow this."
        return Verdict.no(str(reason), _refused_limit(result))

    async def revert(self, user_id: uuid.UUID, feature: str) -> None:
        """Give back what an evaluation took.

        SPACE only allows this for a couple of minutes afterwards, which suits
        "the engine refused the request" and not a solve that ran for twenty.
        Anything slower is corrected through ``adjust_usage``.
        """
        await self._off_the_loop(
            self._client.features.revert_evaluation, str(user_id), feature_id(feature)
        )

    async def adjust_usage(self, user_id: uuid.UUID, increments: Dict[str, float]) -> None:
        """Add to, or negatively release, usage levels once the real cost is known.

        Three things about this call are easy to get wrong, and all three fail
        quietly rather than loudly:

        * these are **increments**, not new totals - SPACE adds what it is given;
        * the limit names here are **plain**, unlike the qualified ones feature
          evaluation wants, because the service is already the outer key. Send
          ``openbinding-tasksLimit`` inside and the update is ignored without
          an error;
        * this is the only way to move a NON_RENEWABLE limit. Feature
          evaluation reports what a concurrency slot *would* become but does
          not persist it, so taking and releasing a slot happens here.
        """
        if not increments:
            return
        await self._off_the_loop(
            self._client.contracts.update_contract_usage_levels,
            str(user_id),
            SERVICE_NAME,
            dict(increments),
        )

    # -- Reading the contract --------------------------------------------

    async def _entitlements(self, user_id: uuid.UUID) -> Optional[dict]:
        """Allowances, consumption and feature flags, from the pricing token.

        The token is decoded without verifying its signature, deliberately: it
        was just fetched over an authenticated channel from SPACE itself, and
        the signing key is SPACE's. Verification is what the *browser* needs,
        because the token reaches it second-hand.
        """
        token = await self._off_the_loop(
            self._client.features.generate_user_pricing_token, str(user_id)
        )
        return _decode_claims(str(token)) if token else None

    async def _contract(self, user_id: uuid.UUID) -> Optional[Any]:
        return await self._off_the_loop(self._client.contracts.get_contract, str(user_id))

    async def caps(self, user_id: uuid.UUID) -> PlanCaps:
        claims = await self._entitlements(user_id)
        if claims is None:
            return PlanCaps()

        allowances = _scoped(claims.get("pricingContext", {}).get("usageLimits") or {})
        values: Dict[str, Any] = {}
        for limit_name, attribute in _CAP_FIELDS.items():
            if allowances.get(limit_name) is not None:
                values[attribute] = allowances[limit_name]

        return PlanCaps(
            plan=_plan_name(await self._contract(user_id)),
            features=_scoped(claims.get("pricingContext", {}).get("features") or {}),
            **values,
        )

    async def usage(self, user_id: uuid.UUID) -> UsageSnapshot:
        claims = await self._entitlements(user_id)
        contract = await self._contract(user_id)
        if claims is None:
            return UsageSnapshot(plan=_plan_name(contract))

        allowances = _scoped(claims.get("pricingContext", {}).get("usageLimits") or {})
        consumption = _scoped(claims.get("subscriptionContext") or {})
        renewals = _renewal_dates(contract)

        return UsageSnapshot(
            plan=_plan_name(contract),
            limits={
                name: LimitUsage(
                    limit_id=name,
                    limit=float(allowance),
                    used=float(consumption.get(name, 0) or 0),
                    renews_at=renewals.get(name),
                )
                for name, allowance in allowances.items()
            },
        )

    # -- Contract lifecycle ----------------------------------------------

    async def create_contract(self, user_id: uuid.UUID, plan: str, email: str) -> None:
        from space_client.types.models import (
            BillingPeriodToCreate,
            ContractToCreate,
            UserContact,
        )

        await self._off_the_loop(
            self._client.contracts.add_contract,
            ContractToCreate(
                # `phone` is spelled out, empty, on purpose. Left unset the
                # client serialises it as JSON null, and SPACE's validator
                # marks the field optional in a way that accepts a missing key
                # but not an explicit null - so the contract is refused with
                # "phone must be a string". An empty string satisfies both.
                # Worth reporting upstream; it needs no local patch.
                user_contact=UserContact(
                    user_id=str(user_id), username=str(user_id), email=email, phone=""
                ),
                billing_period=BillingPeriodToCreate(auto_renew=True, renewal_days=30),
                contracted_services={SERVICE_NAME: "1.0.0"},
                subscription_plans={SERVICE_NAME: plan},
                subscription_add_ons={},
            ),
        )

    async def change_plan(self, user_id: uuid.UUID, plan: str) -> None:
        """Move an account to another plan. SPACE calls this a novation."""
        from space_client.types.models import Subscription

        await self._off_the_loop(
            self._client.contracts.update_contract_subscription,
            str(user_id),
            Subscription(
                contracted_services={SERVICE_NAME: "1.0.0"},
                subscription_plans={SERVICE_NAME: plan},
                subscription_add_ons={},
            ),
        )

    async def pricing_token(self, user_id: uuid.UUID) -> str:
        token = await self._off_the_loop(
            self._client.features.generate_user_pricing_token, str(user_id)
        )
        if not token:
            raise PricingUnavailable("SPACE did not return a pricing token.")
        return str(token)


def _scoped(entries: Dict[str, Any]) -> Dict[str, Any]:
    """Strip the ``openbinding-`` prefix SPACE puts on names it returns.

    Inside the pricing document and in usage-level updates these are plain
    names; feature evaluation and the pricing token qualify them by service,
    because one instance serves several. Entries belonging to another service
    are dropped.
    """
    prefix = f"{SERVICE_NAME}-"
    scoped = {}
    for name, value in entries.items():
        if name.startswith(prefix):
            scoped[name[len(prefix):]] = value
        elif "-" not in name:
            scoped[name] = value
    return scoped


def _decode_claims(token: str) -> Optional[dict]:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except (IndexError, ValueError, binascii.Error):
        return None


def _refused_limit(result: Any) -> Optional[LimitUsage]:
    """Which limit ran out, when the evaluation says so.

    Feature evaluation reports the allowance and consumption for every limit
    its expression reads, so a refusal can name the one that caused it rather
    than leaving the caller to guess.
    """
    limits = _scoped(getattr(result, "limit", None) or {})
    used = _scoped(getattr(result, "used", None) or {})
    for name, allowance in limits.items():
        if allowance is not None and used.get(name, 0) >= allowance:
            return LimitUsage(limit_id=name, limit=float(allowance), used=float(used[name]))
    return None


def _plan_name(contract: Any) -> str:
    plans = _attribute(contract, "subscription_plans", "subscriptionPlans") or {}
    return str(plans.get(SERVICE_NAME) or "BASIC")


def _renewal_dates(contract: Any) -> Dict[str, str]:
    """When each renewable limit next resets.

    The token says what is allowed and what is spent, but not when the slate is
    wiped - which is the thing an account holder most wants to know once a
    quota has run out.
    """
    levels = _attribute(contract, "usage_levels", "usageLevels") or {}
    scoped = levels.get(SERVICE_NAME)
    source = scoped if isinstance(scoped, dict) else levels

    dates = {}
    for name, level in source.items():
        reset_at = _attribute(level, "reset_time_stamp", "resetTimeStamp")
        if reset_at:
            dates[_scoped({name: None}).popitem()[0] if "-" in name else name] = str(reset_at)
    return dates


def _attribute(source: Any, *names: str) -> Any:
    """Read a field whether the client handed back a model or a plain dict."""
    if source is None:
        return None
    for name in names:
        if isinstance(source, dict) and name in source:
            return source[name]
        if hasattr(source, name):
            return getattr(source, name)
    return None

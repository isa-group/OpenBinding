"""Talking to SPACE through its official Python client.

Using ``space-python-client`` rather than SPACE's HTTP API directly, for the
obvious reason and one less obvious one. The obvious: it is maintained by the
people who write SPACE, so when the API moves the client moves with it, and it
brings caching with correct invalidation and a socket subscription for pricing
changes. The less obvious: it already knows the parts of the API that are easy
to get wrong. ``revert`` is ``POST /features/{user}?revert=true``, not the
per-feature path a reasonable person would guess, and finding that out by being
refused is a poor use of anybody's afternoon.

The integration uses the 1.x client's native asynchronous transport, typed
errors and awaited close lifecycle; no worker-thread compatibility wrapper is
kept.

And plan *ceilings* have to be recovered from the pricing token. A contract's
usage levels carry only what has been consumed; the allowance lives in the
pricing, resolved against the subscribed plan. The token contains both limits
linked to feature expressions and per-request limits, so it is the one source
used for both enforcement and display.
"""

from __future__ import annotations

import base64
import binascii
import inspect
import json
import math
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, Dict, Optional, TypeVar

from ..core.settings import Settings
from ..pricing_catalog import PricingCatalog, PricingCatalogError
from .gate import (
    SERVICE_NAME,
    LimitUsage,
    PlanCaps,
    PricingUnavailable,
    SubscriptionSnapshot,
    UsageSnapshot,
    Verdict,
    feature_id,
)

T = TypeVar("T")


class SpacePricingGate:
    """A ``PricingGate`` backed by a real SPACE deployment."""

    def __init__(
        self,
        settings: Settings,
        client: Optional[Any] = None,
        catalog_resolver: Callable[[str], Awaitable[PricingCatalog]] | None = None,
    ):
        self._catalog_resolver = catalog_resolver
        if client is not None:
            self._client = client
        else:
            if not settings.space_url or not settings.space_api_key:
                raise ValueError("SPACE is enabled but SPACE_URL or SPACE_API_KEY is missing.")

            from space_client import SpaceClientFactory

            self._client = SpaceClientFactory.connect_async(
                settings.space_url, settings.space_api_key, settings.space_timeout_ms
            )

    async def aclose(self) -> None:
        close = getattr(self._client, "close", None)
        if close is not None:
            result = close()
            if inspect.isawaitable(result):
                await result

    async def _call(self, operation: Callable[[], Any]) -> T:
        """Invoke the async 1.x client and map transport errors at one seam.

        Accepting a plain value keeps injected test doubles tiny; the
        production factory always returns native awaitables.
        """
        from space_client import SpaceError
        try:
            result = operation()
            return await result if inspect.isawaitable(result) else result
        except (SpaceError, OSError, RuntimeError) as error:
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
        catalog = await self._catalog_for_user(user_id)
        if feature not in catalog.feature_definitions:
            return Verdict.no(f"Unknown feature identifier {feature!r}.")
        result = await self._call(
            lambda: self._client.features.evaluate(str(user_id), feature_id(feature))
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
        catalog = await self._catalog_for_user(user_id)
        if feature not in catalog.feature_definitions:
            raise PricingUnavailable(f"Unknown feature identifier {feature!r}")
        await self._call(
            lambda: self._client.features.revert_evaluation(
                str(user_id), feature_id(feature)
            )
        )

    async def adjust_usage(self, user_id: uuid.UUID, increments: Dict[str, float]) -> None:
        """Add to, or negatively release, usage levels once the real cost is known.

        Three things about this call are easy to get wrong, and all three fail
        quietly rather than loudly:

        * these are **increments**, not new totals - SPACE adds what it is given;
        * the limit names here are **plain**, unlike the service-qualified ones
          feature evaluation wants, because the service is already the outer
          key. Qualifying one again makes SPACE ignore the update;
        * this is the only way to move a NON_RENEWABLE limit. Feature
          evaluation reports what a concurrency slot *would* become but does
          not persist it, so taking and releasing a slot happens here.
        """
        if not increments:
            return
        catalog = await self._catalog_for_user(user_id)
        unknown = set(increments) - set(catalog.limit_definitions)
        if unknown:
            raise PricingUnavailable(
                "Unknown usage-limit identifier(s): " + ", ".join(sorted(unknown))
            )
        await self._call(
            lambda: self._client.contracts.update_contract_usage_levels(
                str(user_id), SERVICE_NAME, increments
            )
        )

    # -- Reading the contract --------------------------------------------

    async def _entitlements(self, user_id: uuid.UUID) -> Optional[dict]:
        """Allowances, consumption and feature flags, from the pricing token.

        The token is decoded without verifying its signature, deliberately: it
        was just fetched over an authenticated channel from SPACE itself, and
        the signing key is SPACE's. Verification is what the *browser* needs,
        because the token reaches it second-hand.
        """
        token = await self._call(
            lambda: self._client.features.generate_user_pricing_token(str(user_id))
        )
        return _decode_claims(str(token)) if token else None

    async def _contract(self, user_id: uuid.UUID) -> Optional[Any]:
        return await self._call(lambda: self._client.contracts.get_contract(str(user_id)))

    async def _catalog(self, version: str) -> PricingCatalog:
        if self._catalog_resolver is None:
            raise PricingUnavailable("No SPHERE pricing catalog resolver is configured.")
        try:
            return await self._catalog_resolver(version)
        except PricingCatalogError as exc:
            raise PricingUnavailable(str(exc)) from exc

    async def _catalog_for_user(self, user_id: uuid.UUID) -> PricingCatalog:
        contract = await self._contract(user_id)
        if contract is None:
            raise PricingUnavailable("SPACE has no contract for this account.")
        services = _attribute(contract, "contracted_services", "contractedServices") or {}
        version = services.get(SERVICE_NAME)
        if not version:
            raise PricingUnavailable("The SPACE contract has no OpenBinding pricing version.")
        return await self._catalog(str(version))

    async def caps(self, user_id: uuid.UUID) -> PlanCaps:
        claims = await self._entitlements(user_id)
        if claims is None:
            raise PricingUnavailable("SPACE did not return pricing entitlements.")

        contract = await self._contract(user_id)
        if contract is None:
            raise PricingUnavailable("SPACE has no contract for this account.")
        services = _attribute(contract, "contracted_services", "contractedServices") or {}
        # Resolve the exact SPHERE document to verify the contract version and
        # digest. Entitlement values themselves come only from SPACE's token.
        await self._catalog(str(services.get(SERVICE_NAME) or ""))
        plan = _plan_name(contract)
        pricing_context = claims.get("pricingContext")
        if not isinstance(pricing_context, dict):
            raise PricingUnavailable("SPACE returned malformed pricing entitlements.")
        raw_features = _scoped(pricing_context.get("features") or {})
        raw_allowances = _scoped(pricing_context.get("usageLimits") or {})
        features = {
            name: value
            for name, value in raw_features.items()
            if isinstance(name, str) and isinstance(value, bool)
        }
        allowances: dict[str, float] = {}
        for name, raw in raw_allowances.items():
            if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                allowances[name] = float(raw)
            elif raw is None:
                # JSON has no Infinity; SPACE/Jose serialises an authoritative
                # unlimited entitlement as null in its signed token.
                allowances[name] = float("inf")
        return PlanCaps(
            plan=plan,
            features=features,
            limits=allowances,
        )

    async def usage(self, user_id: uuid.UUID) -> UsageSnapshot:
        claims = await self._entitlements(user_id)
        contract = await self._contract(user_id)
        if claims is None:
            return UsageSnapshot(plan=_plan_name(contract))

        services = _attribute(contract, "contracted_services", "contractedServices") or {}
        catalog = await self._catalog(str(services.get(SERVICE_NAME) or ""))

        allowances = _scoped(claims.get("pricingContext", {}).get("usageLimits") or {})
        consumption = _scoped(claims.get("subscriptionContext") or {})
        renewals = _renewal_dates(contract)

        finite_allowances = {}
        for name, allowance in allowances.items():
            try:
                if math.isfinite(float(allowance)):
                    finite_allowances[name] = allowance
            except (TypeError, ValueError):
                continue

        return UsageSnapshot(
            plan=_plan_name(contract),
            limits={
                name: LimitUsage(
                    limit_id=name,
                    limit=float(allowance),
                    used=float(consumption.get(name, 0) or 0),
                    unit=(catalog.limit_definitions.get(name) or {}).get("unit"),
                    renews_at=renewals.get(name),
                )
                for name, allowance in finite_allowances.items()
            },
        )

    # -- Contract lifecycle ----------------------------------------------

    async def create_contract(
        self,
        user_id: uuid.UUID,
        plan: str,
        email: str,
        pricing_version: Optional[str] = None,
    ) -> None:
        from space_client.types.models import (
            BillingPeriodToCreate,
            ContractToCreate,
            UserContact,
        )

        if not pricing_version:
            raise PricingUnavailable("An exact LIVE pricing version is required.")
        # Resolve the exact SPHERE document and verify its digest. SPACE owns
        # plan/add-on validation; duplicating it here creates a second contract.
        await self._catalog(pricing_version)
        await self._call(
            lambda: self._client.contracts.add_contract(ContractToCreate(
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
                contracted_services={SERVICE_NAME: pricing_version},
                subscription_plans={SERVICE_NAME: plan},
                subscription_add_ons={},
            )),
        )

        # Read it back, because ``add_contract`` returns None whether it worked
        # or not: the client turns a 4xx into a quiet None rather than raising.
        # That is how a pricing version drift - the plans were renamed and the
        # gateway still asked for the old one - produced accounts with no
        # contract while every call reported success.
        if await self._contract(user_id) is None:
            raise PricingUnavailable(
                f"SPACE accepted no contract for this account on plan {plan!r}. The usual "
                f"cause is that pricing version {pricing_version} of '{SERVICE_NAME}' does "
                f"not declare that plan - check what is registered against "
                f"space/pricing/openbinding.yml."
            )

    async def change_plan(
        self, user_id: uuid.UUID, plan: str, pricing_version: Optional[str] = None
    ) -> None:
        """Move an account to another plan. SPACE calls this a novation."""
        existing = await self._contract(user_id)
        add_ons = _service_add_ons(existing)
        await self.change_subscription(user_id, plan, add_ons, pricing_version)

    async def subscription(self, user_id: uuid.UUID) -> SubscriptionSnapshot:
        existing = await self._contract(user_id)
        if existing is None:
            raise PricingUnavailable("SPACE has no contract for this account.")
        services = _attribute(existing, "contracted_services", "contractedServices") or {}
        period = _attribute(existing, "billing_period", "billingPeriod")
        return SubscriptionSnapshot(
            plan=_plan_name(existing),
            pricing_version=str(services.get(SERVICE_NAME) or ""),
            add_ons=_service_add_ons(existing),
            renews_at=_attribute(period, "end_date", "endDate"),
        )

    async def change_subscription(
        self,
        user_id: uuid.UUID,
        plan: str,
        add_ons: Dict[str, int],
        pricing_version: Optional[str] = None,
    ) -> SubscriptionSnapshot:
        from space_client.types.models import Subscription

        if not pricing_version:
            raise PricingUnavailable("An exact pricing version is required for a novation.")
        target_version = pricing_version
        # Verify the version bytes, then let SPACE validate the novation.
        await self._catalog(target_version)
        updated = await self._call(
            lambda: self._client.contracts.update_contract_subscription(
                str(user_id), Subscription(
                contracted_services={SERVICE_NAME: target_version},
                subscription_plans={SERVICE_NAME: plan},
                subscription_add_ons={SERVICE_NAME: dict(add_ons)} if add_ons else {},
                )
            )
        )
        if updated is None:
            updated = await self._contract(user_id)
            services = _attribute(updated, "contracted_services", "contractedServices") or {}
            if updated is None or _plan_name(updated) != plan or services.get(SERVICE_NAME) != target_version:
                raise PricingUnavailable(
                    "SPACE did not persist the requested subscription novation."
                )
        period = _attribute(updated, "billing_period", "billingPeriod")
        return SubscriptionSnapshot(
            plan=plan,
            pricing_version=target_version,
            add_ons=dict(add_ons),
            renews_at=_attribute(period, "end_date", "endDate"),
        )

    async def migrate_due_contract(self, user_id: uuid.UUID, pricing_version: str) -> bool:
        existing = await self._contract(user_id)
        if existing is None:
            raise PricingUnavailable("SPACE has no contract for this account.")
        services = _attribute(existing, "contracted_services", "contractedServices") or {}
        if services.get(SERVICE_NAME) == pricing_version:
            return False
        period = _attribute(existing, "billing_period", "billingPeriod")
        end_date = _attribute(period, "end_date", "endDate")
        if not _is_due(end_date):
            return False
        await self.change_subscription(
            user_id,
            _plan_name(existing),
            _service_add_ons(existing),
            pricing_version,
        )
        return True

    async def pricing_token(self, user_id: uuid.UUID) -> str:
        token = await self._call(
            lambda: self._client.features.generate_user_pricing_token(str(user_id))
        )
        if not token:
            raise PricingUnavailable("SPACE did not return a pricing token.")
        return str(token)

    async def remove_contract(self, user_id: uuid.UUID) -> None:
        await self._call(lambda: self._client.contracts.remove_contract(str(user_id)))


def _scoped(entries: object) -> Dict[str, Any]:
    """Strip the ``openbinding-`` prefix SPACE puts on names it returns.

    Inside the pricing document and in usage-level updates these are plain
    names; feature evaluation and the pricing token qualify them by service,
    because one instance serves several. Entries belonging to another service
    are dropped.
    """
    if not isinstance(entries, dict):
        return {}
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
        claims = json.loads(base64.urlsafe_b64decode(payload))
        return claims if isinstance(claims, dict) else None
    except (IndexError, UnicodeDecodeError, ValueError, binascii.Error):
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
    return str(plans.get(SERVICE_NAME) or "")


def _service_add_ons(contract: Any) -> Dict[str, int]:
    values = _attribute(contract, "subscription_add_ons", "subscriptionAddOns") or {}
    scoped = values.get(SERVICE_NAME, {}) if isinstance(values, dict) else {}
    if not isinstance(scoped, dict):
        return {}
    return {str(name): int(quantity) for name, quantity in scoped.items()}


def _is_due(value: Any) -> bool:
    if not value:
        return False
    if isinstance(value, datetime):
        moment = value
    else:
        try:
            moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment <= datetime.now(timezone.utc)


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
            scoped = _scoped({name: None})
            if scoped:
                dates[next(iter(scoped))] = str(reset_at)
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

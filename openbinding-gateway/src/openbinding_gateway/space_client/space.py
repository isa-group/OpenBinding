"""Talking to SPACE through its official Python client.

Using ``space-python-client`` rather than SPACE's HTTP API directly: it is
maintained by the people who write SPACE, so when the API moves the client moves
with it, and it brings caching with correct invalidation and a socket
subscription for pricing changes.

The integration uses the 1.x client's native asynchronous transport, typed
errors and awaited close lifecycle; no worker-thread compatibility wrapper is
kept.

Plan *ceilings* are recovered from the pricing token: the allowance lives in the
pricing, resolved against the subscribed plan, and the token carries both the
feature flags and the per-request limits.
"""

from __future__ import annotations

import base64
import binascii
import inspect
import json
import uuid
from collections.abc import Callable
from typing import Any, Dict, Optional, TypeVar

from ..core.public_errors import log_internal_failure
from ..core.settings import Settings
from .gate import (
    PlanCaps,
    PricingUnavailable,
    SubscriptionRejected,
    SubscriptionSnapshot,
)

T = TypeVar("T")


class SpacePricingGate:
    """A ``PricingGate`` backed by a real SPACE deployment."""

    def __init__(self, settings: Settings, client: Optional[Any] = None):
        self._settings = settings
        self._service = settings.space_service_name
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
        try:
            from space_client import SpaceError
        except ImportError:
            class SpaceError(Exception):
                pass
        try:
            result = operation()
            return await result if inspect.isawaitable(result) else result
        except (SpaceError, OSError, RuntimeError) as error:
            # The text of these errors names the host or address that failed. It
            # goes to the log, masked; the exception that travels says only what kind.
            log_internal_failure("SPACE request", error)
            raise PricingUnavailable(f"SPACE is not reachable ({type(error).__name__})") from error

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

    def _target_version(self, pricing_version: Optional[str]) -> Optional[str]:
        """The explicit version, else the configured ``SPACE_PRICING_VERSION``."""
        return pricing_version or self._settings.space_pricing_version or None

    async def caps(self, user_id: uuid.UUID) -> PlanCaps:
        claims = await self._entitlements(user_id)
        if claims is None:
            raise PricingUnavailable("SPACE did not return pricing entitlements.")

        # Entitlement values come only from SPACE's token.
        contract = await self._contract(user_id)
        if contract is None:
            raise PricingUnavailable("SPACE has no contract for this account.")
        plan = _plan_name(contract, self._service)
        pricing_context = claims.get("pricingContext")
        if not isinstance(pricing_context, dict):
            raise PricingUnavailable("SPACE returned malformed pricing entitlements.")
        raw_features = _scoped(pricing_context.get("features") or {}, self._service)
        raw_allowances = _scoped(pricing_context.get("usageLimits") or {}, self._service)
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

    # -- Contract lifecycle ----------------------------------------------

    async def create_contract(
        self,
        user_id: uuid.UUID,
        plan: Optional[str],
        email: str,
        pricing_version: Optional[str] = None,
    ) -> None:
        from space_client.types.models import (
            BillingPeriodToCreate,
            ContractToCreate,
            UserContact,
        )

        pricing_version = self._target_version(pricing_version)
        if not pricing_version:
            raise PricingUnavailable(
                "No pricing version to contract: set SPACE_PRICING_VERSION."
            )
        # SPACE owns plan/add-on validation; duplicating it here would be a
        # second source of truth. Without a plan, SPACE assigns the contract's.
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
                contracted_services={self._service: pricing_version},
                subscription_plans={self._service: plan} if plan else {},
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
                f"cause is that pricing version {pricing_version} of '{self._service}' is not "
                f"deployed in SPACE or does not declare that plan - check it in the SPACE console."
            )

    async def change_plan(
        self, user_id: uuid.UUID, plan: str, pricing_version: Optional[str] = None
    ) -> None:
        """Move an account to another plan. SPACE calls this a novation."""
        existing = await self._contract(user_id)
        add_ons = _service_add_ons(existing, self._service)
        await self.change_subscription(user_id, plan, add_ons, pricing_version)

    async def subscription(self, user_id: uuid.UUID) -> SubscriptionSnapshot:
        existing = await self._contract(user_id)
        if existing is None:
            raise PricingUnavailable("SPACE has no contract for this account.")
        services = _attribute(existing, "contracted_services", "contractedServices") or {}
        period = _attribute(existing, "billing_period", "billingPeriod")
        return SubscriptionSnapshot(
            plan=_plan_name(existing, self._service),
            pricing_version=str(services.get(self._service) or ""),
            add_ons=_service_add_ons(existing, self._service),
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

        target_version = self._target_version(pricing_version)
        if not target_version:
            # A plan change keeps the version the contract is already pinned to.
            existing = await self._contract(user_id)
            if existing is None:
                raise PricingUnavailable("SPACE has no contract for this account.")
            services = _attribute(existing, "contracted_services", "contractedServices") or {}
            target_version = str(services.get(self._service) or "")
        if not target_version:
            raise PricingUnavailable(
                "No pricing version for the novation: set SPACE_PRICING_VERSION."
            )
        # SPACE validates the novation against the version it has deployed.
        updated = await self._call(
            lambda: self._client.contracts.update_contract_subscription(
                str(user_id), Subscription(
                contracted_services={self._service: target_version},
                subscription_plans={self._service: plan},
                subscription_add_ons={self._service: dict(add_ons)} if add_ons else {},
                )
            )
        )
        if updated is None:
            updated = await self._contract(user_id)
            services = _attribute(updated, "contracted_services", "contractedServices") or {}
            if (
                updated is None
                or _plan_name(updated, self._service) != plan
                or services.get(self._service) != target_version
            ):
                raise SubscriptionRejected(
                    "SPACE did not accept the requested subscription novation: check the plan "
                    f"and add-ons against pricing version {target_version} in SPACE."
                )
        period = _attribute(updated, "billing_period", "billingPeriod")
        return SubscriptionSnapshot(
            plan=plan,
            pricing_version=target_version,
            add_ons=dict(add_ons),
            renews_at=_attribute(period, "end_date", "endDate"),
        )

    async def pricing_token(self, user_id: uuid.UUID) -> str:
        token = await self._call(
            lambda: self._client.features.generate_user_pricing_token(str(user_id))
        )
        if not token:
            raise PricingUnavailable("SPACE did not return a pricing token.")
        return str(token)

    async def remove_contract(self, user_id: uuid.UUID) -> None:
        await self._call(lambda: self._client.contracts.remove_contract(str(user_id)))


def _scoped(entries: object, service: str) -> Dict[str, Any]:
    """Strip the ``<service>-`` prefix SPACE puts on names it returns.

    Inside the pricing document and in usage-level updates these are plain
    names; feature evaluation and the pricing token qualify them by service,
    because one instance serves several. Entries belonging to another service
    are dropped.
    """
    if not isinstance(entries, dict):
        return {}
    prefix = f"{service}-"
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


def _plan_name(contract: Any, service: str) -> str:
    plans = _attribute(contract, "subscription_plans", "subscriptionPlans") or {}
    return str(plans.get(service) or "")


def _service_add_ons(contract: Any, service: str) -> Dict[str, int]:
    values = _attribute(contract, "subscription_add_ons", "subscriptionAddOns") or {}
    scoped = values.get(service, {}) if isinstance(values, dict) else {}
    if not isinstance(scoped, dict):
        return {}
    return {str(name): int(quantity) for name, quantity in scoped.items()}


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

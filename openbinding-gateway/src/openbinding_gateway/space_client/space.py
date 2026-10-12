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
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, Dict, Optional, TypeVar

from ..core.settings import Settings
from ..pricing_catalog import PricingCatalog, PricingCatalogError
from .gate import (
    SERVICE_NAME,
    PlanCaps,
    PricingUnavailable,
    SubscriptionSnapshot,
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
        try:
            from space_client import SpaceError
        except ImportError:
            class SpaceError(Exception):
                pass
        try:
            result = operation()
            return await result if inspect.isawaitable(result) else result
        except (SpaceError, OSError, RuntimeError) as error:
            raise PricingUnavailable(f"SPACE is not reachable: {error}") from error

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

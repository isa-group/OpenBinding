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

A novation is guarded against concurrent edits when SPACE can guard it (it
advertises ``novation-preview`` and ``contract-version`` in
``X-Space-Capabilities``): a dry run validates it first and reports the contract
version, and the write is applied only to the version the change was computed on
(``If-Match``). A contract that moved in between - another administrator, a
renewal - is ``ContractChanged`` and nothing is written. Every novation keeps the
current billing period when SPACE advertises ``keep-billing-period``; none asks
SPACE to reject private plans, since administrators may assign them.
"""

from __future__ import annotations

import base64
import binascii
import inspect
import json
import logging
import uuid
from collections.abc import Callable
from typing import Any, Dict, Optional, TypeVar

from ..core.public_errors import log_internal_failure
from ..core.settings import Settings
from .gate import (
    ContractChanged,
    PlanCaps,
    PricingUnavailable,
    SubscriptionRejected,
    SubscriptionSnapshot,
)

T = TypeVar("T")

logger = logging.getLogger(__name__)

# HTTP statuses with which SPACE refuses a request. Anything else that goes wrong
# (401/403 credentials, 429, 5xx, no connection) says nothing about the request.
# A 412 is not here: it only answers If-Match, and the client raises it as
# ``ContractChangedError``, which ``_call`` maps by type.
_REJECTION_STATUSES = frozenset({400, 404, 409, 422})

# ``X-Space-Capabilities`` tokens. A guarded novation needs the dry run, which
# validates the change and reports the contract version, and If-Match on the write.
_GUARDED_NOVATION = ("novation-preview", "contract-version")
# A novation that keeps the current billing period instead of restarting it.
_KEEP_BILLING_PERIOD = "keep-billing-period"


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
        from space_client import ContractChangedError, SpaceError

        try:
            return await _awaited(operation())
        except ContractChangedError as error:
            # SPACE answered 412 to If-Match (or the client saw the new version
            # before writing): the contract moved after the read this change was
            # computed on. Nothing was written; it is a conflict, not an outage.
            raise self._contract_changed(
                error.expected_contract_version, error.contract_version
            ) from error
        except (SpaceError, OSError, RuntimeError) as error:
            # The text of these errors names the host or address that failed. It
            # goes to the log, masked; the exception that travels says only what kind.
            log_internal_failure("SPACE request", error)
            status = getattr(error, "status_code", None)
            if status in _REJECTION_STATUSES:
                # SPACE answered and refused the request itself (unknown plan or
                # contract, a conflict, an invalid body): not an outage.
                raise SubscriptionRejected(
                    f"SPACE rejected the request for service '{self._service}' (HTTP {status})"
                ) from error
            raise PricingUnavailable(f"SPACE is not reachable ({type(error).__name__})") from error

    def _contract_changed(self, expected: Optional[str], current: Optional[str]) -> ContractChanged:
        """The refusal of a novation computed on a contract version that is no longer current."""
        changed = ContractChanged(
            f"The contract for service '{self._service}' changed after the change was computed "
            f"(expected version {expected or 'unknown'}, current {current or 'unknown'})"
        )
        log_internal_failure("SPACE novation", changed, level=logging.INFO)
        return changed

    async def _supports(self, *capabilities: str) -> bool:
        """Whether SPACE advertises every one of ``capabilities`` (``X-Space-Capabilities``).

        The client answers from the header of SPACE's latest response (trusted
        for 60 s) or reads its unauthenticated healthcheck; a SPACE it cannot
        read advertises nothing. A client without ``has_capability`` (an
        injected double) advertises nothing either.
        """
        has_capability = getattr(self._client, "has_capability", None)
        if has_capability is None:
            return False
        for capability in capabilities:
            if await _awaited(has_capability(capability)) is not True:
                return False
        return True

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
            elif raw is None and not self._settings.space_null_limit_is_unknown:
                # JSON has no Infinity; SPACE/Jose serialises an authoritative
                # unlimited entitlement as null in its signed token. With
                # SPACE_NULL_LIMIT_IS_UNKNOWN the null is left out instead: an
                # undeclared limit, which every reader treats as unknown.
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
        # The client raises when SPACE refuses the contract, and ``_call`` maps
        # that to ``SubscriptionRejected`` (or ``PricingUnavailable`` for an outage).
        await self._call(
            lambda: self._client.contracts.add_contract(ContractToCreate(
                user_contact=UserContact(
                    user_id=str(user_id), username=str(user_id), email=email, phone=None
                ),
                billing_period=BillingPeriodToCreate(auto_renew=True, renewal_days=30),
                contracted_services={self._service: pricing_version},
                subscription_plans={self._service: plan} if plan else {},
                subscription_add_ons={},
            )),
        )

    async def change_plan(
        self,
        user_id: uuid.UUID,
        plan: str,
        pricing_version: Optional[str] = None,
        expected_contract_version: Optional[str] = None,
    ) -> None:
        """Move an account to another plan. SPACE calls this a novation."""
        existing = await self._contract(user_id)
        add_ons = _service_add_ons(existing, self._service)
        # The add-ons carried over come from this read, so the change is computed
        # on it, unless the caller decided on an earlier one.
        await self.change_subscription(
            user_id,
            plan,
            add_ons,
            pricing_version,
            expected_contract_version or _contract_version(existing),
        )

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
            contract_version=_contract_version(existing),
        )

    async def change_subscription(
        self,
        user_id: uuid.UUID,
        plan: str,
        add_ons: Dict[str, int],
        pricing_version: Optional[str] = None,
        expected_contract_version: Optional[str] = None,
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
            expected_contract_version = expected_contract_version or _contract_version(existing)
        if not target_version:
            raise PricingUnavailable(
                "No pricing version for the novation: set SPACE_PRICING_VERSION."
            )
        requested = Subscription(
            contracted_services={self._service: target_version},
            subscription_plans={self._service: plan},
            subscription_add_ons={self._service: dict(add_ons)} if add_ons else {},
        )
        # SPACE validates the novation against the version it has deployed.
        updated = await self._novate(user_id, requested, expected_contract_version)
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
            contract_version=_contract_version(updated),
        )

    async def _novate(
        self, user_id: uuid.UUID, requested: Any, expected_contract_version: Optional[str]
    ) -> Any:
        """Apply a novation, guarded against concurrent edits when SPACE can guard it.

        Guarded, SPACE first runs the novation as a dry run that writes nothing
        (``preview_novation``): an invalid selection is refused there, and its
        ``contract_version`` is the version the change applies to. The write then
        carries the version the caller decided on (``If-Match``); a contract that
        moved since is ``ContractChanged``. Unguarded, it is the unconditional
        PUT it always was. Either way the billing period is kept when SPACE
        advertises ``keep-billing-period``; private plans are never refused here.
        """
        options: Dict[str, Any] = {}
        if await self._supports(_KEEP_BILLING_PERIOD):
            options["keep_billing_period"] = True
        if not await self._supports(*_GUARDED_NOVATION):
            logger.warning(
                "SPACE does not advertise %s: sending the novation without a concurrency guard",
                " and ".join(_GUARDED_NOVATION),
            )
            return await self._put(user_id, requested, **options)

        preview = await self._call(
            lambda: self._client.contracts.preview_novation(str(user_id), requested, **options)
        )
        if not preview.valid:
            reasons = "; ".join(
                f"{error.code}: {error.message}" if error.message else str(error.code)
                for error in preview.errors
            )
            raise SubscriptionRejected(
                f"SPACE refused the novation for service '{self._service}' in its dry run: "
                f"{reasons or 'no reason given'}"
            )
        current = preview.contract_version
        if expected_contract_version and current and current != expected_contract_version:
            # Early, and not atomic: If-Match on the write stays the real check.
            raise self._contract_changed(expected_contract_version, current)
        version = expected_contract_version or current
        if not version:
            # Sending no If-Match would turn the guarded write into an unguarded one.
            raise PricingUnavailable("SPACE did not say which contract version the novation applies to.")
        return await self._put(user_id, requested, expected_contract_version=version, **options)

    async def _put(self, user_id: uuid.UUID, requested: Any, **options: Any) -> Any:
        """The novation write. A guarantee SPACE dropped *after* writing is not a failure.

        ``SpaceFeatureUnsupportedError`` with ``written`` means SPACE applied the
        novation but ignored an option (If-Match without an ``ETag``, a restarted
        billing period). The change is in place, so it is reported as made, and
        what SPACE stored is what the gateway records; the log says which
        guarantee was missing. Before writing (``written`` false) it is an outage.
        """
        from space_client import SpaceFeatureUnsupportedError

        async def put() -> Any:
            try:
                return await _awaited(
                    self._client.contracts.update_contract_subscription(
                        str(user_id), requested, **options
                    )
                )
            except SpaceFeatureUnsupportedError as error:
                if not error.written:
                    raise
                log_internal_failure(
                    "SPACE novation guarantee", error, capability=error.capability
                )
                return error.contract

        return await self._call(put)

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


async def _awaited(value: Any) -> Any:
    """The value, awaited if the client handed back an awaitable (the 1.x client always does)."""
    return await value if inspect.isawaitable(value) else value


def _contract_version(contract: Any) -> Optional[str]:
    """The opaque version of a contract SPACE returned; None from a SPACE that keeps none."""
    version = _attribute(contract, "contract_version", "contractVersion")
    return str(version) if version else None


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

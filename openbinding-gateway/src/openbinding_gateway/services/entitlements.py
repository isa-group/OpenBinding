"""The one place that reads an account's plan and turns it into decisions.

Every caller used to fetch ``get_gate().caps(user_id)`` itself and translate
``PricingUnavailable`` by hand, so the 503, its wording and the order of the
checks around it were repeated in a handful of modules.  This service owns that
read.  The rules themselves stay where they were: ceilings and clamps in
``access.policy``, the 403/429 refusals in ``domain.entitlements``; the methods
here only give them names and fetch the caps they need.

Two ways to fail when the plan cannot be read, because callers differ:

* ``caps_for`` raises ``EntitlementsUnavailable`` (a domain exception, no HTTP
  involved).  Code outside a request, or a request that wants to retry later
  (a study cell launch treats ``pricing_unavailable`` as retryable), uses it.
* ``caps_or_503`` raises the stable ``503 pricing_unavailable`` ``HTTPException``.

The gate is looked up on every call, never cached, so a gate installed by the
lifespan (or by a test) is always the one consulted.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, Mapping, Optional
from uuid import UUID

from fastapi import HTTPException, status

from .. import space_client
from ..access import policy
from ..domain import entitlements as refusals
from ..models.errors import api_error
from ..space_client import PlanCaps, PricingUnavailable

#: Problem code (503) when the plan of an account cannot be read.
PRICING_UNAVAILABLE = "pricing_unavailable"

#: The largest upload the gateway accepts whatever the plan says.
UPLOAD_CEILING_BYTES = 512 * 1024 * 1024


class EntitlementsUnavailable(PricingUnavailable):
    """The account's entitlements cannot be read; ``str()`` is the pricing service's reason."""

    status = status.HTTP_503_SERVICE_UNAVAILABLE
    code = PRICING_UNAVAILABLE

    def to_http(self, prefix: str = "") -> HTTPException:
        """The stable 503 response for this failure, optionally with ``prefix`` before the reason."""
        return api_error(self.status, self.code, f"{prefix}{self}")


class EntitlementService:
    """Plan reading and plan-derived decisions, usable with or without HTTP."""

    def __init__(self, gate_provider: Callable[[], Any] | None = None) -> None:
        self._gate_provider = gate_provider or space_client.get_gate

    # -- reading the plan -------------------------------------------------

    async def caps_for(self, user_id: UUID) -> PlanCaps:
        """The authoritative capabilities of ``user_id``; unreadable pricing fails closed."""
        try:
            return await self._gate_provider().caps(user_id)
        except PricingUnavailable as error:
            raise EntitlementsUnavailable(str(error)) from error

    async def caps_or_503(self, user_id: UUID, *, prefix: str = "") -> PlanCaps:
        """``caps_for`` for a request handler: unreadable pricing is the stable 503."""
        try:
            return await self.caps_for(user_id)
        except EntitlementsUnavailable as error:
            raise error.to_http(prefix) from error

    # -- features ---------------------------------------------------------

    @staticmethod
    def feature_refusal(
        caps: PlanCaps,
        feature: str,
        *,
        default_not_entitled_detail: str = refusals.DEFAULT_NOT_ENTITLED_DETAIL,
    ) -> Optional[refusals.Refusal]:
        """The 403 refusal for a plan without ``feature``, or ``None``."""
        return refusals.feature_refusal(
            caps, feature, default_not_entitled_detail=default_not_entitled_detail
        )

    def require_feature(
        self,
        caps: PlanCaps,
        feature: str,
        *,
        detail: str = refusals.DEFAULT_NOT_ENTITLED_DETAIL,
    ) -> None:
        """Raise the stable 403 ``feature_not_entitled`` when the plan lacks ``feature``."""
        refusal = self.feature_refusal(caps, feature, default_not_entitled_detail=detail)
        if refusal is not None:
            raise api_error(refusal.status, refusal.code, refusal.detail, **refusal.extra)

    # -- ceilings and clamps (rules live in access.policy) -----------------

    @staticmethod
    def payload_ceiling(caps: PlanCaps, gateway_ceiling: int) -> int:
        return policy.payload_ceiling_bytes(caps, gateway_ceiling)

    @staticmethod
    def solve_timeout(caps: PlanCaps, gateway_ceiling: float) -> float:
        return policy.solve_timeout_s(caps, gateway_ceiling)

    @staticmethod
    def clamp_options(options: Optional[Dict[str, Any]], caps: PlanCaps) -> policy.ClampedOptions:
        return policy.clamp_options(options, caps)

    @staticmethod
    def complexity_too_large(log10_cardinality: Optional[float], caps: PlanCaps) -> bool:
        return policy.instance_complexity_too_large(log10_cardinality, caps)

    async def upload_limit(self, user_id: UUID) -> int:
        """The per-request upload ceiling of ``user_id``, capped by the platform maximum (503 if unreadable)."""
        caps = await self.caps_or_503(user_id)
        limit = caps.limit("maxPayloadBytes")
        return UPLOAD_CEILING_BYTES if limit is None else min(UPLOAD_CEILING_BYTES, int(limit))

    # -- sponsor quotas ----------------------------------------------------

    async def enforce_sponsor_usage(self, sponsor_id: UUID, usage: Mapping[str, int]) -> None:
        """Refuse (402 ``sponsor_quota_exceeded``) a complete hypothetical sponsor total above the contract."""
        caps = await self.caps_or_503(sponsor_id)
        breach = policy.sponsor_quota_breach(caps, usage)
        if breach is not None:
            raise api_error(
                status.HTTP_402_PAYMENT_REQUIRED,
                "sponsor_quota_exceeded",
                f"The sponsor contract allows {breach.limit} {breach.limit_id}; this operation would exceed it.",
                quota={"limit_id": breach.limit_id, "limit": breach.limit, "used": breach.used},
            )

    async def enforce_storage_quota(
        self,
        sponsor_id: UUID,
        incoming: int,
        stored_bytes: Callable[[], Awaitable[int]],
    ) -> None:
        """Refuse (402 ``storage_quota_exceeded``) storing ``incoming`` bytes past the sponsor's allowance.

        ``stored_bytes`` is only awaited when the plan limits storage at all.
        """
        caps = await self.caps_or_503(sponsor_id)
        if caps.limit("storageBytes") is None:
            return
        breach = policy.storage_quota_breach(caps, await stored_bytes(), incoming)
        if breach is not None:
            raise api_error(
                status.HTTP_402_PAYMENT_REQUIRED,
                "storage_quota_exceeded",
                "The sponsor storage allowance would be exceeded.",
                quota={"limit_id": breach.limit_id, "limit": breach.limit, "used": breach.used},
            )


#: The process-wide service.  It holds no state: the gate is resolved per call.
entitlement_service = EntitlementService()


def get_entitlements() -> EntitlementService:
    """FastAPI dependency (``Depends(get_entitlements)``) for routes that need the service."""
    return entitlement_service

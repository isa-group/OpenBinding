"""The pricing service, and the seam that keeps it replaceable."""

from collections.abc import Awaitable, Callable
from typing import Optional

from ..core.settings import Settings
from ..pricing_catalog import PricingCatalog
from .fake import FakePricingGate
from .gate import (
    SERVICE_NAME,
    LimitUsage,
    PlanCaps,
    PricingGate,
    PricingUnavailable,
    SubscriptionSnapshot,
    UsageSnapshot,
    Verdict,
    feature_id,
)
from .space import SpacePricingGate

_gate: Optional[PricingGate] = None


def build_gate(
    settings: Settings,
    *,
    catalog: PricingCatalog | None = None,
    catalog_resolver: Callable[[str], Awaitable[PricingCatalog]] | None = None,
) -> PricingGate:
    """The gate this deployment should use.

    A gateway with SPACE switched off still has a working pricing gate - the
    fake one, with real balances - so that quota handling is exercised in
    development rather than only in production.
    """
    if settings.space_enabled:
        return SpacePricingGate(settings, catalog_resolver=catalog_resolver)
    return FakePricingGate(catalog)


def set_gate(gate: Optional[PricingGate]) -> None:
    """Install the process-wide gate. Called from the application's lifespan."""
    global _gate
    _gate = gate


def get_gate() -> PricingGate:
    """The installed gate, building a fallback if the lifespan never ran.

    The fallback matters for tests that import a route module directly rather
    than starting the application.
    """
    global _gate
    if _gate is None:
        _gate = FakePricingGate()
    return _gate


__all__ = [
    "FakePricingGate",
    "LimitUsage",
    "PlanCaps",
    "PricingGate",
    "PricingUnavailable",
    "SERVICE_NAME",
    "SpacePricingGate",
    "SubscriptionSnapshot",
    "UsageSnapshot",
    "Verdict",
    "build_gate",
    "feature_id",
    "get_gate",
    "set_gate",
]

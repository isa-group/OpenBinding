"""The pricing service, and the seam that keeps it replaceable."""

import os
from collections.abc import Awaitable, Callable
from pathlib import Path
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
    local_catalog = os.environ.get("LOCAL_PRICING_CATALOG")
    if catalog is None and local_catalog:
        catalog = PricingCatalog.parse(Path(local_catalog).read_bytes())
    gate = FakePricingGate(catalog)
    local_plan = os.environ.get("LOCAL_PRICING_PLAN")
    if local_plan:
        if catalog is None or local_plan not in catalog.plans:
            raise ValueError(f"LOCAL_PRICING_PLAN {local_plan!r} is absent from the local catalog")
        gate.default_plan = local_plan
    return gate


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

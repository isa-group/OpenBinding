"""Pricing test helpers, built from the synthetic ``fixtures/pricing_test.yml``.

The fixture is a minimal stand-in for a SPACE pricing (functional limits only,
no consumption counters, version 0.1.0). The real pricings are administered in
SPHERE and SPACE, never in this repository.
"""

from functools import lru_cache
from pathlib import Path

from _fake_space import FakePricingGate, PricingCatalog
from openbinding_gateway.space_client import PlanCaps

PRICING_YAML = Path(__file__).resolve().parent / "fixtures" / "pricing_test.yml"

#: The version the fixture declares; conftest points ``SPACE_PRICING_VERSION`` at it.
FIXTURE_VERSION = "0.1.0"


@lru_cache(maxsize=1)
def pricing_catalog() -> PricingCatalog:
    return PricingCatalog.parse(PRICING_YAML.read_bytes())


def fake_pricing_gate() -> FakePricingGate:
    return FakePricingGate(pricing_catalog())


def caps_for(plan: str) -> PlanCaps:
    catalog = pricing_catalog()
    features, limits = catalog.entitlements(plan)
    return PlanCaps(plan=plan, features=features, limits=limits)


def largest_plan(limit_id: str = "maxPayloadBytes") -> str:
    """Pick a high-capacity fixture plan, without naming one in code.

    By a functional limit: the plan that allows the largest packages.
    """
    catalog = pricing_catalog()
    return max(catalog.plans, key=lambda plan: catalog.entitlements(plan)[1][limit_id])

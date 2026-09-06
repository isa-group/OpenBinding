"""Pricing test fixtures parsed from the same YAML that is published."""

from functools import lru_cache
from pathlib import Path

from openbinding_gateway.pricing_catalog import PricingCatalog
from openbinding_gateway.space_client import FakePricingGate, PlanCaps

PRICING_YAML = Path(__file__).resolve().parents[2] / "space/pricing/openbinding.yml"


@lru_cache(maxsize=1)
def pricing_catalog() -> PricingCatalog:
    return PricingCatalog.parse(PRICING_YAML.read_bytes())


def fake_pricing_gate() -> FakePricingGate:
    return FakePricingGate(pricing_catalog())


def caps_for(plan: str) -> PlanCaps:
    catalog = pricing_catalog()
    features, limits = catalog.entitlements(plan)
    return PlanCaps(plan=plan, features=features, limits=limits)


def largest_plan(limit_id: str = "taskStarts") -> str:
    """Pick a high-capacity fixture plan from YAML, without naming one in code."""
    catalog = pricing_catalog()
    return max(catalog.plans, key=lambda plan: catalog.entitlements(plan)[1][limit_id])

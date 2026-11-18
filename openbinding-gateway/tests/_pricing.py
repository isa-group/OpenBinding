"""Pricing test helpers, built from the published pricing 0.2.0.

The recorded SPHERE version 0.2.0 of OpenBinding's pricing
(``fixtures/sphere/6ab0a323697330667ccce891/6ada6dbd4b2b5b01c587d17f.yml``), byte-identical to
``docs/pricing/openbinding-0.2.0.yml`` (plans FREE, RESEARCH and LAB). The fake
gate resolves its plans the way SPACE would; the real pricings are administered
in SPHERE and SPACE, never in this repository.
"""

from functools import lru_cache
from pathlib import Path

from _fake_space import FakePricingGate, PricingCatalog
from openbinding_gateway.space_client import PlanCaps

PRICING_YAML = Path(__file__).resolve().parent / "fixtures" / "sphere" / "6ab0a323697330667ccce891" / "6ada6dbd4b2b5b01c587d17f.yml"

#: The version the fixture declares; conftest points ``SPACE_PRICING_VERSION`` at it.
FIXTURE_VERSION = "0.2.0"


@lru_cache(maxsize=1)
def pricing_catalog() -> PricingCatalog:
    return PricingCatalog.parse(PRICING_YAML.read_bytes())


def fake_pricing_gate() -> FakePricingGate:
    return FakePricingGate(pricing_catalog())


def caps_for(plan: str) -> PlanCaps:
    catalog = pricing_catalog()
    features, limits = catalog.entitlements(plan)
    return PlanCaps(plan=plan, features=features, limits=limits)


def roomy_plan() -> str:
    """The fixture plan that allows the most simultaneous jobs.

    For tests about something other than concurrency that need a second job in
    flight: the default plan allows one at a time, and its limit now applies.
    """
    return largest_plan("maxConcurrentRuns")


def largest_plan(limit_id: str = "maxRunMinutes") -> str:
    """Pick a high-capacity fixture plan, without naming one in code.

    By a functional limit: the plan that allows the longest runs.
    """
    catalog = pricing_catalog()
    return max(catalog.plans, key=lambda plan: catalog.entitlements(plan)[1][limit_id])


#: Two add-ons the published 0.2.0 does not have, for the tests of add-on novations.
TEST_ADD_ONS = {
    "EXTRA_ENGINES": {
        "availableFor": ["FREE", "LAB"],
        "price": 0,
        "unit": "pack/month",
        "subscriptionConstraints": {"minQuantity": 1, "maxQuantity": 5, "quantityStep": 1},
        "usageLimitsExtensions": {"maxFederatedEngines": {"value": 1}},
    },
    "EXTRA_KEYS": {
        "availableFor": ["FREE", "LAB"],
        "price": 0,
        "unit": "pack/month",
        "subscriptionConstraints": {"minQuantity": 1, "maxQuantity": 5, "quantityStep": 1},
        "usageLimitsExtensions": {"maxApiKeys": {"value": 2}},
    },
}


def catalog_with_add_ons() -> PricingCatalog:
    """The fixture pricing plus ``TEST_ADD_ONS`` (available to FREE and LAB, never to RESEARCH)."""
    import yaml

    document = yaml.safe_load(PRICING_YAML.read_bytes())
    document["addOns"] = TEST_ADD_ONS
    return PricingCatalog.parse(yaml.safe_dump(document).encode())

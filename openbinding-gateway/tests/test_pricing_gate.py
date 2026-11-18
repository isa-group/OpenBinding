"""The pricing seam: entitlements, contracts, and what an outage is not.

Plans live in a SPACE instance, so most of what matters here is the shape of
the conversation. The fake gate serves the same entitlements from the published
pricing 0.2.0 (the recorded SPHERE version, ``_pricing.PRICING_YAML``) so that the refusal
paths can be exercised without one; it counts no consumption. The open gate is the stateless
stand-in for ``SPACE_ENABLED=false``.
"""

from __future__ import annotations

import uuid

import pytest
import yaml

from _fake_space import FakePricingGate, FixtureCatalog, FixtureCatalogError
from openbinding_gateway.access import policy
from openbinding_gateway.core.settings import Settings
from openbinding_gateway.modules.plans.domain import entitlement_map
from openbinding_gateway.space_client import (
    OpenGate,
    PricingGate,
    PricingUnavailable,
    build_gate,
    get_gate,
    set_gate,
)
from _pricing import PRICING_YAML, caps_for, fake_pricing_gate, largest_plan, fixture_catalog

CATALOG = fixture_catalog()
DEFAULT_PLAN = CATALOG.default_plan
LARGER_PLAN = largest_plan()


@pytest.fixture
def gate() -> FakePricingGate:
    return fake_pricing_gate()


@pytest.fixture
def user_id() -> uuid.UUID:
    return uuid.uuid4()


def test_the_fake_satisfies_the_protocol():
    # The tests would be worthless if the fake could drift from the interface
    # the gateway actually calls.
    assert isinstance(fake_pricing_gate(), PricingGate)


async def test_a_fresh_account_has_the_runs_feature(gate, user_id):
    caps = await gate.caps(user_id)

    assert caps.allows("runs") is True


def test_the_fake_keeps_no_consumption_state(gate):
    # Nothing is counted per account: the fake holds contracts and nothing else.
    state = [
        name for name in dir(gate)
        if any(word in name for word in ("consum", "evaluat", "spend", "exhaust", "usage"))
    ]

    assert state == []


async def test_larger_yaml_plan_raises_allowances(gate, user_id):
    baseline = await gate.caps(user_id)
    await gate.change_plan(user_id, LARGER_PLAN)
    larger = await gate.caps(user_id)

    assert larger.limit("maxRunMinutes") > baseline.limit("maxRunMinutes")
    assert larger.limit("maxProblems") is None  # Infinity reads as unlimited.


async def test_renaming_a_plan_in_yaml_changes_catalog_fake_and_contract_validation():
    document = yaml.safe_load(PRICING_YAML.read_bytes())
    old_name = FixtureCatalog.parse(PRICING_YAML.read_bytes()).default_plan
    new_name = "RENAMED_DEFAULT"
    document["plans"][new_name] = document["plans"].pop(old_name)
    for add_on in document.get("addOns", {}).values():
        add_on["availableFor"] = [
            new_name if plan == old_name else plan
            for plan in add_on.get("availableFor", [])
        ]

    catalog = FixtureCatalog.parse(yaml.safe_dump(document).encode())
    gate = FakePricingGate(catalog)
    account_id = uuid.uuid4()

    assert catalog.default_plan == new_name
    assert gate.plan_of(account_id) == new_name
    with pytest.raises(FixtureCatalogError, match="Unknown plan"):
        catalog.validate_selection(old_name, {})
    await gate.create_contract(account_id, new_name, "renamed@example.org")
    assert gate.plan_of(account_id) == new_name


async def test_yaml_feature_limit_and_add_on_changes_drive_space_decisions():
    document = yaml.safe_load(PRICING_YAML.read_bytes())
    catalog_before = FixtureCatalog.parse(PRICING_YAML.read_bytes())
    plan = catalog_before.default_plan
    document["plans"][plan]["features"]["runs"] = {"value": False}
    document["plans"][plan]["usageLimits"]["maxRunMinutes"] = {"value": 1}
    document["features"]["addedAtRuntime"] = {
        "description": "Mutation-test feature",
        "type": "DOMAIN",
        "valueType": "BOOLEAN",
        "defaultValue": False,
        "expression": "pricingContext['features']['addedAtRuntime']",
    }
    document["plans"][plan]["features"]["addedAtRuntime"] = {"value": True}
    # Pricing 0.2.0 has no add-ons; one is added at runtime.
    add_on_id = "EXTRA_ENGINES"
    document["addOns"] = {
        add_on_id: {
            "availableFor": [plan],
            "price": 0,
            "unit": "pack/month",
            "subscriptionConstraints": {"minQuantity": 1, "maxQuantity": 3, "quantityStep": 1},
            "usageLimitsExtensions": {"maxFederatedEngines": {"value": 2}},
        }
    }

    catalog = FixtureCatalog.parse(yaml.safe_dump(document).encode())
    gate = FakePricingGate(catalog)
    account_id = uuid.uuid4()

    caps = await gate.caps(account_id)
    assert caps.allows("runs") is False
    assert caps.allows("addedAtRuntime") is True
    assert caps.limit("maxRunMinutes") == 1
    await gate.create_contract(account_id, plan, "dynamic@example.org")
    changed = await gate.change_subscription(account_id, plan, {add_on_id: 3})
    assert changed.add_ons == {add_on_id: 3}
    assert (await gate.caps(account_id)).limit("maxFederatedEngines") == 1 + 2 * 3


async def test_changing_plan_raises_the_ceilings(gate, user_id):
    before = await gate.caps(user_id)
    await gate.change_plan(user_id, LARGER_PLAN)
    after = await gate.caps(user_id)

    assert before.limit("maxRunMinutes") < after.limit("maxRunMinutes")


@pytest.mark.parametrize("plan", list(fixture_catalog().plans))
def test_every_plan_bounds_a_single_request(plan):
    # A ceiling of zero or infinity would either refuse everything or protect
    # nothing; both have to be finite and positive on every plan.
    caps = caps_for(plan)

    assert caps.limit("maxRunMinutes")
    assert caps.limit("maxConcurrentRuns")
    assert caps.limit("maxStudyCells")


async def test_a_plan_that_grants_longer_runs_than_the_gateway_waits_runs_as_long_as_it_waits():
    # LAB grants a day; ENGINE_SOLVE_TIMEOUT_S is the most the gateway waits, so it decides.
    ceiling = Settings(_env_file=None).engine_solve_timeout_s
    assert caps_for(LARGER_PLAN).limit("maxRunMinutes") * 60 > ceiling
    assert policy.solve_timeout_s(caps_for(LARGER_PLAN), ceiling) == ceiling


async def test_an_unmodelled_feature_fails_closed(gate, user_id):
    caps = await gate.caps(user_id)

    assert caps.allows("some-feature-the-pricing-has-never-heard-of") is False


async def test_an_outage_is_not_a_refusal(gate, user_id):
    # "Your plan lacks this" and "I could not find out" call for different
    # answers; conflating them either leaks compute or refuses everyone.
    gate.unavailable = True

    with pytest.raises(PricingUnavailable):
        await gate.caps(user_id)


async def test_a_contract_records_the_plan(gate, user_id):
    plan = DEFAULT_PLAN
    await gate.create_contract(user_id, plan, "someone@example.org")

    assert gate.plan_of(user_id) == plan


async def test_a_pricing_token_is_issued_per_account(gate, user_id):
    other = uuid.uuid4()

    assert await gate.pricing_token(user_id) != await gate.pricing_token(other)


def test_the_fixture_is_the_published_pricing_and_declares_every_id_the_gateway_reads():
    document = yaml.safe_load(PRICING_YAML.read_bytes())

    assert document["version"] == "0.2.0"
    assert set(document["plans"]) == {"FREE", "RESEARCH", "LAB"}
    assert entitlement_map.missing_ids(document) == []
    forbidden = {"capacityUnits", "taskStarts", "solverSeconds", "federatedTaskStarts"}
    assert not forbidden & set(document["usageLimits"])
    for plan in document["plans"].values():
        assert not forbidden & set(plan["usageLimits"])


# -- The open gate (SPACE_ENABLED=false) ------------------------------------------


def test_the_open_gate_satisfies_the_protocol():
    assert isinstance(OpenGate(), PricingGate)


async def test_the_open_gate_grants_every_functional_capability_without_plans(user_id):
    caps = await OpenGate().caps(user_id)

    assert caps.plan == ""
    assert caps.allows("runs") is True
    assert caps.allows("a-feature-nobody-declared") is True
    assert set(caps.features) == set(entitlement_map.REQUIRED_FEATURES) and all(caps.features.values())
    # Every limit the gateway reads is unbounded; the deployment's technical ceilings still apply.
    assert set(caps.limits) == set(entitlement_map.REQUIRED_LIMITS)
    assert all(caps.limit(name) is None for name in entitlement_map.REQUIRED_LIMITS)
    view = caps.http_view()
    assert view["plan"] == ""
    assert set(view["capabilities"]) == set(view["limits"]) == set(caps.limits)


async def test_the_open_gate_keeps_no_state_and_counts_nothing(user_id):
    gate = OpenGate()
    await gate.create_contract(user_id, "ANY", "someone@example.org", "0.1.0")
    await gate.change_plan(user_id, "OTHER")

    assert vars(gate) == {}
    assert (await gate.subscription(user_id)).plan == ""
    assert (await gate.caps(user_id)).plan == ""


def test_space_disabled_builds_the_open_gate_outside_production():
    for environment in ("dev", "test"):
        built = build_gate(Settings(_env_file=None, app_env=environment, space_enabled=False))
        assert isinstance(built, OpenGate)


def test_production_without_space_has_no_gate_to_build():
    settings = Settings.model_construct(app_env="prod", space_enabled=False)

    with pytest.raises(RuntimeError, match="SPACE_ENABLED is false while APP_ENV=prod"):
        build_gate(settings)


def test_there_is_no_fallback_gate_when_none_was_installed():
    previous = get_gate()
    set_gate(None)
    try:
        with pytest.raises(RuntimeError, match="No pricing gate is installed"):
            get_gate()
    finally:
        set_gate(previous)

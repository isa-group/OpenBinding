"""The pricing seam: entitlements, contracts, and what an outage is not.

Plans live in a SPACE instance, so most of what matters here is the shape of
the conversation. The fake gate serves the same entitlements from the synthetic
test pricing (``fixtures/pricing_test.yml``) so that the refusal paths can be
exercised without one; it counts no consumption. The open gate is the stateless
stand-in for ``SPACE_ENABLED=false``.
"""

from __future__ import annotations

import uuid

import pytest
import yaml

from _fake_space import FakePricingGate, PricingCatalog, PricingCatalogError
from openbinding_gateway.core.settings import Settings
from openbinding_gateway.space_client import (
    OpenGate,
    PricingGate,
    PricingUnavailable,
    build_gate,
    feature_id,
    get_gate,
    set_gate,
)
from _pricing import PRICING_YAML, caps_for, fake_pricing_gate, largest_plan, pricing_catalog

CATALOG = pricing_catalog()
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


def test_feature_identifiers_carry_the_service_name():
    # A mistyped identifier fails as "not in your plan" rather than as an
    # error, which is why building them lives in one place.
    assert feature_id("solve") == "openbinding-solve"


async def test_a_fresh_account_has_the_solve_feature(gate, user_id):
    caps = await gate.caps(user_id)

    assert caps.allows("solve") is True


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

    assert larger.limit("maxPayloadBytes") > baseline.limit("maxPayloadBytes")
    assert larger.limit("apiKeys") is None  # Infinity reads as unlimited.


async def test_renaming_a_plan_in_yaml_changes_catalog_fake_and_contract_validation():
    document = yaml.safe_load(PRICING_YAML.read_bytes())
    old_name = PricingCatalog.parse(PRICING_YAML.read_bytes()).default_plan
    new_name = "RENAMED_DEFAULT"
    document["plans"][new_name] = document["plans"].pop(old_name)
    for add_on in document.get("addOns", {}).values():
        add_on["availableFor"] = [
            new_name if plan == old_name else plan
            for plan in add_on.get("availableFor", [])
        ]

    catalog = PricingCatalog.parse(yaml.safe_dump(document).encode())
    gate = FakePricingGate(catalog)
    account_id = uuid.uuid4()

    assert catalog.default_plan == new_name
    assert gate.plan_of(account_id) == new_name
    with pytest.raises(PricingCatalogError, match="Unknown plan"):
        catalog.validate_selection(old_name, {})
    await gate.create_contract(account_id, new_name, "renamed@example.org")
    assert gate.plan_of(account_id) == new_name


async def test_yaml_feature_limit_and_add_on_changes_drive_space_decisions():
    document = yaml.safe_load(PRICING_YAML.read_bytes())
    catalog_before = PricingCatalog.parse(PRICING_YAML.read_bytes())
    plan = catalog_before.default_plan
    document["plans"][plan]["features"]["solve"] = {"value": False}
    document["plans"][plan]["usageLimits"]["maxIterations"] = {"value": 1}
    document["features"]["addedAtRuntime"] = {
        "description": "Mutation-test feature",
        "type": "DOMAIN",
        "valueType": "BOOLEAN",
        "defaultValue": False,
        "expression": "pricingContext['features']['addedAtRuntime']",
    }
    document["plans"][plan]["features"]["addedAtRuntime"] = {"value": True}
    add_on_id, add_on = next(iter(document["addOns"].items()))
    constraints = add_on["subscriptionConstraints"]
    constraints["maxQuantity"] += constraints["quantityStep"]

    catalog = PricingCatalog.parse(yaml.safe_dump(document).encode())
    gate = FakePricingGate(catalog)
    account_id = uuid.uuid4()

    caps = await gate.caps(account_id)
    assert caps.allows("solve") is False
    assert caps.allows("addedAtRuntime") is True
    assert caps.limit("maxIterations") == 1
    add_on_plan = add_on["availableFor"][0]
    await gate.create_contract(account_id, add_on_plan, "dynamic@example.org")
    changed = await gate.change_subscription(
        account_id, add_on_plan, {add_on_id: constraints["maxQuantity"]}
    )
    assert changed.add_ons == {add_on_id: constraints["maxQuantity"]}


async def test_changing_plan_raises_the_ceilings(gate, user_id):
    before = await gate.caps(user_id)
    await gate.change_plan(user_id, LARGER_PLAN)
    after = await gate.caps(user_id)

    assert before.limit("maxTimeoutSeconds") < after.limit("maxTimeoutSeconds")


@pytest.mark.parametrize("plan", list(pricing_catalog().plans))
def test_every_plan_bounds_a_single_request(plan):
    # A ceiling of zero or infinity would either refuse everything or protect
    # nothing; both have to be finite and positive on every plan.
    caps = caps_for(plan)

    assert caps.limit("maxTimeoutSeconds")
    assert caps.limit("maxIterations")
    assert caps.limit("maxPayloadBytes")


async def test_the_largest_ceiling_never_promises_more_than_the_gateway_waits():
    # Asking for a longer solve than ENGINE_SOLVE_TIMEOUT_S would be a promise
    # the gateway cannot keep: it stops waiting first.
    assert caps_for(LARGER_PLAN).limit("maxTimeoutSeconds") <= Settings(
        _env_file=None
    ).engine_solve_timeout_s


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


def test_the_fixture_is_marked_as_a_test_pricing_without_consumption_or_cu():
    document = yaml.safe_load(PRICING_YAML.read_bytes())
    text = PRICING_YAML.read_text(encoding="utf-8")

    assert text.startswith("# TEST FIXTURE, NOT A REAL PRICING.")
    assert document["version"] == "0.1.0"
    assert document["createdAt"] == "2026-10-12T00:00:00Z"
    forbidden = {"capacityUnits", "taskStarts", "solverSeconds", "federatedTaskStarts"}
    assert not forbidden & set(document["usageLimits"])
    for plan in document["plans"].values():
        assert not forbidden & set(plan["usageLimits"])
    assert {"apiKeys", "concurrentJobs"} <= set(document["usageLimits"])


# -- The open gate (SPACE_ENABLED=false) ------------------------------------------


def test_the_open_gate_satisfies_the_protocol():
    assert isinstance(OpenGate(), PricingGate)


async def test_the_open_gate_grants_every_functional_capability_without_plans(user_id):
    caps = await OpenGate().caps(user_id)

    assert caps.plan == ""
    assert caps.allows("solve") is True
    assert caps.allows("a-feature-nobody-declared") is True
    assert caps.limit("maxTimeoutSeconds") is None
    assert caps.limit("apiKeys") is None
    assert caps.http_view()["capabilities"] == {}


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

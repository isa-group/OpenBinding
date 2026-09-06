"""The pricing seam: balances, refusals, and what an outage is not.

Quotas live in a SPACE instance, so most of what matters here is the shape of
the conversation rather than the arithmetic. The fake gate keeps real balances
precisely so that the refusal paths can be exercised without one.
"""

from __future__ import annotations

import uuid

import pytest
import yaml

from openbinding_gateway.pricing_catalog import PricingCatalog, PricingCatalogError
from openbinding_gateway.space_client import (
    FakePricingGate,
    PricingGate,
    PricingUnavailable,
    feature_id,
)
from _pricing import PRICING_YAML, caps_for, fake_pricing_gate, largest_plan, pricing_catalog

CATALOG = pricing_catalog()
DEFAULT_PLAN = CATALOG.default_plan
LARGER_PLAN = largest_plan()
TASKS = "taskStarts"
CONCURRENT = "concurrentJobs"
SOLVER_TIME = "solverSeconds"


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


async def test_a_fresh_account_may_solve(gate, user_id):
    verdict = await gate.evaluate(user_id, "solve", {"taskStarts": 1})

    assert verdict.allowed is True


async def test_evaluating_spends_nothing(gate, user_id):
    # Asking whether you may is not the same as doing it. SPACE loses all but
    # one increment when several limits are involved, so the gateway keeps the
    # accounts itself and the fake mirrors that.
    await gate.evaluate(user_id, "solve", {"taskStarts": 1})

    usage = await gate.usage(user_id)

    assert usage.limits[TASKS].used == 0


async def test_a_spent_limit_refuses(gate, user_id):
    gate.exhaust(user_id, "taskStarts")

    verdict = await gate.evaluate(user_id, "solve", {"taskStarts": 1})

    assert verdict.allowed is False
    assert verdict.limit.limit_id == TASKS


async def test_consumption_is_recorded_by_the_caller(gate, user_id):
    # The gateway spends explicitly once it knows what it spent.
    await gate.adjust_usage(user_id, {"taskStarts": 1})

    usage = await gate.usage(user_id)

    assert usage.limits[TASKS].used == 1


async def test_work_that_did_not_happen_is_given_back(gate, user_id):
    # There is nothing for a revert to undo, because evaluating spent nothing.
    # A negative adjustment is what corrects an aborted solve.
    await gate.adjust_usage(user_id, {"taskStarts": 1})

    await gate.adjust_usage(user_id, {"taskStarts": -1})
    usage = await gate.usage(user_id)

    assert usage.limits[TASKS].used == 0


async def test_usage_can_be_adjusted_once_the_real_cost_is_known(gate, user_id):
    # Solver time is not charged up front - nobody knows how long a solve will
    # take until it has taken it.
    await gate.adjust_usage(user_id, {"solverSeconds": 42.5})

    usage = await gate.usage(user_id)

    assert usage.limits[SOLVER_TIME].used == 42.5


async def test_a_released_slot_goes_back(gate, user_id):
    await gate.adjust_usage(user_id, {"concurrentJobs": 1})

    await gate.adjust_usage(user_id, {"concurrentJobs": -1})
    usage = await gate.usage(user_id)

    assert usage.limits[CONCURRENT].used == 0


async def test_usage_never_goes_negative(gate, user_id):
    # Releasing a slot twice - a reconciler racing a late poll - must not leave
    # the account with credit it never had.
    await gate.adjust_usage(user_id, {"concurrentJobs": -5})

    usage = await gate.usage(user_id)

    assert usage.limits[CONCURRENT].used == 0


async def test_larger_yaml_plan_raises_allowances(gate, user_id):
    baseline = await gate.usage(user_id)
    await gate.change_plan(user_id, LARGER_PLAN)
    larger = await gate.usage(user_id)

    assert TASKS in baseline.limits
    assert TASKS not in larger.limits  # Infinity is omitted from finite balances.
    assert larger.limits[CONCURRENT].limit > baseline.limits[CONCURRENT].limit


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
    document["plans"][plan]["usageLimits"]["taskStarts"] = {"value": 1}
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

    assert (await gate.evaluate(account_id, "solve")).allowed is False
    assert (await gate.evaluate(account_id, "addedAtRuntime")).allowed is True
    assert (await gate.usage(account_id)).limits["taskStarts"].limit == 1
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
    from openbinding_gateway.core.settings import Settings

    assert caps_for(LARGER_PLAN).limit("maxTimeoutSeconds") <= Settings(
        _env_file=None
    ).engine_solve_timeout_s


async def test_an_unmodelled_feature_fails_closed(gate, user_id):
    caps = await gate.caps(user_id)

    assert caps.allows("some-feature-the-pricing-has-never-heard-of") is False


async def test_an_outage_is_not_a_refusal(gate, user_id):
    # "You have no quota" and "I could not find out" call for different
    # answers; conflating them either leaks compute or refuses everyone.
    gate.unavailable = True

    with pytest.raises(PricingUnavailable):
        await gate.evaluate(user_id, "solve", {"taskStarts": 1})


async def test_a_contract_records_the_plan(gate, user_id):
    plan = DEFAULT_PLAN
    await gate.create_contract(user_id, plan, "someone@example.org")

    assert gate.plan_of(user_id) == plan


async def test_a_pricing_token_is_issued_per_account(gate, user_id):
    other = uuid.uuid4()

    assert await gate.pricing_token(user_id) != await gate.pricing_token(other)

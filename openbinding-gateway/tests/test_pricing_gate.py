"""The pricing seam: balances, refusals, and what an outage is not.

Quotas live in a SPACE instance, so most of what matters here is the shape of
the conversation rather than the arithmetic. The fake gate keeps real balances
precisely so that the refusal paths can be exercised without one.
"""

from __future__ import annotations

import uuid

import pytest

from openbinding_gateway.space_client import (
    FakePricingGate,
    PricingGate,
    PricingUnavailable,
    feature_id,
)
from openbinding_gateway.space_client.fake import PLAN_CAPS


@pytest.fixture
def gate() -> FakePricingGate:
    return FakePricingGate()


@pytest.fixture
def user_id() -> uuid.UUID:
    return uuid.uuid4()


def test_the_fake_satisfies_the_protocol():
    # The tests would be worthless if the fake could drift from the interface
    # the gateway actually calls.
    assert isinstance(FakePricingGate(), PricingGate)


def test_feature_identifiers_carry_the_service_name():
    # A mistyped identifier fails as "not in your plan" rather than as an
    # error, which is why building them lives in one place.
    assert feature_id("solve") == "openbinding-solve"


async def test_a_fresh_account_may_solve(gate, user_id):
    verdict = await gate.evaluate(user_id, "solve", {"tasksLimit": 1})

    assert verdict.allowed is True


async def test_evaluating_spends_nothing(gate, user_id):
    # Asking whether you may is not the same as doing it. SPACE loses all but
    # one increment when several limits are involved, so the gateway keeps the
    # accounts itself and the fake mirrors that.
    await gate.evaluate(user_id, "solve", {"tasksLimit": 1})

    usage = await gate.usage(user_id)

    assert usage.limits["tasksLimit"].used == 0


async def test_a_spent_limit_refuses(gate, user_id):
    gate.exhaust(user_id, "tasksLimit")

    verdict = await gate.evaluate(user_id, "solve", {"tasksLimit": 1})

    assert verdict.allowed is False
    assert verdict.limit.limit_id == "tasksLimit"


async def test_consumption_is_recorded_by_the_caller(gate, user_id):
    # The gateway spends explicitly once it knows what it spent.
    await gate.adjust_usage(user_id, {"tasksLimit": 1})

    usage = await gate.usage(user_id)

    assert usage.limits["tasksLimit"].used == 1


async def test_work_that_did_not_happen_is_given_back(gate, user_id):
    # There is nothing for a revert to undo, because evaluating spent nothing.
    # A negative adjustment is what corrects an aborted solve.
    await gate.adjust_usage(user_id, {"tasksLimit": 1})

    await gate.adjust_usage(user_id, {"tasksLimit": -1})
    usage = await gate.usage(user_id)

    assert usage.limits["tasksLimit"].used == 0


async def test_usage_can_be_adjusted_once_the_real_cost_is_known(gate, user_id):
    # Solver time is not charged up front - nobody knows how long a solve will
    # take until it has taken it.
    await gate.adjust_usage(user_id, {"solverTimeLimit": 42.5})

    usage = await gate.usage(user_id)

    assert usage.limits["solverTimeLimit"].used == 42.5


async def test_a_released_slot_goes_back(gate, user_id):
    await gate.adjust_usage(user_id, {"concurrentTasksLimit": 1})

    await gate.adjust_usage(user_id, {"concurrentTasksLimit": -1})
    usage = await gate.usage(user_id)

    assert usage.limits["concurrentTasksLimit"].used == 0


async def test_usage_never_goes_negative(gate, user_id):
    # Releasing a slot twice - a reconciler racing a late poll - must not leave
    # the account with credit it never had.
    await gate.adjust_usage(user_id, {"concurrentTasksLimit": -5})

    usage = await gate.usage(user_id)

    assert usage.limits["concurrentTasksLimit"].used == 0


async def test_pro_allows_far_more_than_basic(gate, user_id):
    basic = await gate.usage(user_id)
    await gate.change_plan(user_id, "PRO")
    pro = await gate.usage(user_id)

    assert pro.limits["tasksLimit"].limit > basic.limits["tasksLimit"].limit
    assert pro.limits["concurrentTasksLimit"].limit > basic.limits["concurrentTasksLimit"].limit


async def test_changing_plan_raises_the_ceilings(gate, user_id):
    before = await gate.caps(user_id)
    await gate.change_plan(user_id, "PRO")
    after = await gate.caps(user_id)

    assert before.max_timeout_s < after.max_timeout_s


@pytest.mark.parametrize("plan", ["FREE", "PRO"])
def test_every_plan_bounds_a_single_request(plan):
    # A ceiling of zero or infinity would either refuse everything or protect
    # nothing; both have to be finite and positive on every plan.
    caps = PLAN_CAPS[plan]

    assert caps.max_timeout_s > 0
    assert caps.max_iterations > 0
    assert caps.max_payload_mb > 0


async def test_a_pro_ceiling_never_promises_more_than_the_gateway_waits():
    # Asking for a longer solve than ENGINE_SOLVE_TIMEOUT_S would be a promise
    # the gateway cannot keep: it stops waiting first.
    from openbinding_gateway.core.settings import Settings

    assert PLAN_CAPS["PRO"].max_timeout_s <= Settings(_env_file=None).engine_solve_timeout_s


async def test_an_unmodelled_feature_is_allowed(gate, user_id):
    # Otherwise every new endpoint would be denied until the pricing is
    # republished, which makes the pricing a deployment blocker.
    caps = await gate.caps(user_id)

    assert caps.allows("some-feature-the-pricing-has-never-heard-of") is True


async def test_an_outage_is_not_a_refusal(gate, user_id):
    # "You have no quota" and "I could not find out" call for different
    # answers; conflating them either leaks compute or refuses everyone.
    gate.unavailable = True

    with pytest.raises(PricingUnavailable):
        await gate.evaluate(user_id, "solve", {"tasksLimit": 1})


async def test_a_contract_records_the_plan(gate, user_id):
    await gate.create_contract(user_id, "FREE", "someone@example.org")

    assert gate.plan_of(user_id) == "FREE"


async def test_a_pricing_token_is_issued_per_account(gate, user_id):
    other = uuid.uuid4()

    assert await gate.pricing_token(user_id) != await gate.pricing_token(other)

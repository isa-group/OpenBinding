"""Bringing a request inside a plan: what gets reduced, and what gets refused.

The distinction under test is not a preference. A time budget is a request for
effort, so asking for more than the plan allows is answered by doing the allowed
amount. A binding space is a fact about the instance, so there is nothing to
reduce and the only honest answer is no.
"""

from __future__ import annotations

import pytest

from openbinding_gateway.access import policy
from openbinding_gateway.space_client import PlanCaps
from openbinding_gateway.space_client.fake import PLAN_CAPS

BASIC = PLAN_CAPS["BASIC"]
PRO = PLAN_CAPS["PRO"]


def test_options_within_the_plan_are_left_alone():
    result = policy.clamp_options({"time_limit_ms": 1000, "iterations_count": 50}, BASIC)

    assert result.options == {"time_limit_ms": 1000, "iterations_count": 50}
    assert result.warnings == []


@pytest.mark.parametrize("option", ["time_limit_ms", "time_budget_ms"])
def test_a_time_budget_beyond_the_plan_is_reduced(option):
    result = policy.clamp_options({option: 99_999_999}, BASIC)

    assert result.options[option] == BASIC.max_timeout_s * 1000
    assert result.warnings[0].code == policy.OPTION_CLAMPED


@pytest.mark.parametrize("option", ["iterations_count", "max_evaluations"])
def test_search_effort_beyond_the_plan_is_reduced(option):
    result = policy.clamp_options({option: 10_000_000}, BASIC)

    assert result.options[option] == BASIC.max_iterations
    assert result.warnings[0].details["option"] == option


def test_a_reduction_says_what_was_asked_and_what_was_done():
    # A solve that quietly did a tenth of the work asked for would produce a
    # worse answer with no explanation - the kind of result that gets published.
    result = policy.clamp_options({"time_limit_ms": 900_000}, BASIC)

    details = result.warnings[0].details
    assert details["requested"] == 900_000
    assert details["applied"] == 300_000
    assert "300000" in result.warnings[0].message


def test_the_same_request_is_untouched_on_a_larger_plan():
    asked = {"time_limit_ms": 900_000, "iterations_count": 500_000}

    assert policy.clamp_options(asked, PRO).options == asked
    assert policy.clamp_options(asked, PRO).warnings == []


def test_several_options_over_the_line_are_each_reported():
    result = policy.clamp_options(
        {"time_limit_ms": 900_000, "max_evaluations": 10_000_000}, BASIC
    )

    assert len(result.warnings) == 2


def test_options_that_are_not_budgets_are_left_alone():
    result = policy.clamp_options({"solver": "gecode", "seed": 7, "archive_size": 20}, BASIC)

    assert result.options == {"solver": "gecode", "seed": 7, "archive_size": 20}


def test_a_missing_budget_is_not_invented():
    # An option the caller left out is filled in by the engine's defaults,
    # which are clamped separately.
    assert policy.clamp_options({"seed": 1}, BASIC).options == {"seed": 1}


def test_a_null_budget_is_left_alone():
    # random-search defaults time_budget_ms to None, meaning "no budget".
    assert policy.clamp_options({"time_budget_ms": None}, BASIC).options == {
        "time_budget_ms": None
    }


def test_a_budget_that_is_not_a_number_is_left_to_validation():
    assert policy.clamp_options({"time_limit_ms": "soon"}, BASIC).options == {
        "time_limit_ms": "soon"
    }


def test_a_boolean_is_not_mistaken_for_a_number():
    # True == 1 in Python, and an option that happens to be boolean must not be
    # silently turned into a duration.
    assert policy.clamp_options({"intermediate_solutions": True}, BASIC).options == {
        "intermediate_solutions": True
    }


def test_clamping_does_not_mutate_what_the_caller_sent():
    asked = {"time_limit_ms": 900_000}

    policy.clamp_options(asked, BASIC)

    assert asked == {"time_limit_ms": 900_000}


def test_the_engine_defaults_a_free_account_sees_are_ones_it_can_run():
    # MiniZinc defaults to fifteen minutes and the free plan allows five. Left
    # alone, the Playground would offer a request it silently reduces on send.
    defaults = policy.plan_aware_defaults(
        {"solver": "gecode", "time_limit_ms": 900_000, "intermediate_solutions": True}, BASIC
    )

    assert defaults["time_limit_ms"] == 300_000
    assert defaults["solver"] == "gecode"
    assert defaults["intermediate_solutions"] is True


def test_the_engine_wait_never_exceeds_the_gateway_ceiling():
    # Waiting longer than the gateway itself will is a promise it cannot keep.
    assert policy.solve_timeout_s(PRO, 1800.0) <= 1800.0


def test_the_engine_wait_allows_a_little_beyond_the_plan_budget():
    # The budget describes solving; the wait also covers sending the instance
    # and receiving the answer.
    assert policy.solve_timeout_s(BASIC, 1800.0) > BASIC.max_timeout_s


def test_the_payload_ceiling_is_the_smaller_of_the_two():
    assert policy.payload_ceiling_bytes(BASIC, 512 * 1024 * 1024) == 16 * 1024 * 1024
    assert policy.payload_ceiling_bytes(PRO, 16 * 1024 * 1024) == 16 * 1024 * 1024


def test_an_instance_within_the_plan_is_solvable():
    assert policy.binding_space_too_large(6.0, BASIC) is False


def test_an_instance_beyond_the_plan_is_refused():
    assert policy.binding_space_too_large(12.0, BASIC) is True


def test_the_same_instance_is_solvable_on_the_larger_plan():
    assert policy.binding_space_too_large(12.0, PRO) is False


def test_an_instance_exactly_at_the_ceiling_is_allowed():
    assert policy.binding_space_too_large(BASIC.max_binding_space_log10, BASIC) is False


def test_an_unmeasured_binding_space_is_not_refused():
    # Analysis always reports a size; refusing when it somehow did not would
    # turn a missing measurement into a billing decision.
    assert policy.binding_space_too_large(None, BASIC) is False


def test_a_plan_with_no_ceilings_configured_still_bounds_a_request():
    # PlanCaps' own defaults are the free plan's, so an account whose contract
    # says nothing is bounded rather than unbounded.
    bare = PlanCaps()

    assert bare.max_timeout_s > 0
    assert policy.clamp_options({"time_limit_ms": 10**9}, bare).warnings != []

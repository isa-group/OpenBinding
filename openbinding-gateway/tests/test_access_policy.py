"""Bringing a request inside a plan: what gets reduced, and what gets refused.

The distinction under test is not a preference. A time budget is a request for
effort, so asking for more than the plan allows is answered by doing the allowed
amount. Instance complexity is a fact about the submitted resources, so there
is nothing to reduce and the only honest answer is no.
"""

from __future__ import annotations

import pytest

from openbinding_gateway.access import policy
from openbinding_gateway.space_client import PlanCaps
from openbinding_gateway.space_client.fake import PLAN_CAPS

FREE = PLAN_CAPS["FREE"]
PRO = PLAN_CAPS["PRO"]


def test_options_within_the_plan_are_left_alone():
    result = policy.clamp_options({"time_budget_ms": 1000, "iterations": 50}, FREE)

    assert result.options == {"time_budget_ms": 1000, "iterations": 50}
    assert result.warnings == []


def test_a_time_budget_beyond_the_plan_is_reduced():
    result = policy.clamp_options({"time_budget_ms": 99_999_999}, FREE)

    assert result.options["time_budget_ms"] == FREE.max_timeout_s * 1000
    assert result.warnings[0].code == policy.OPTION_CLAMPED


@pytest.mark.parametrize("option", ["iterations", "max_evaluations"])
def test_search_effort_beyond_the_plan_is_reduced(option):
    result = policy.clamp_options({option: 10_000_000}, FREE)

    assert result.options[option] == FREE.max_iterations
    assert result.warnings[0].details["option"] == option


def test_a_reduction_says_what_was_asked_and_what_was_done():
    # A solve that quietly did a tenth of the work asked for would produce a
    # worse answer with no explanation - the kind of result that gets published.
    result = policy.clamp_options({"time_budget_ms": 900_000}, FREE)

    details = result.warnings[0].details
    assert details["requested"] == 900_000
    assert details["applied"] == 300_000
    assert "300000" in result.warnings[0].message


def test_the_same_request_is_untouched_on_a_larger_plan():
    asked = {"time_budget_ms": 900_000, "iterations": 500_000}

    assert policy.clamp_options(asked, PRO).options == asked
    assert policy.clamp_options(asked, PRO).warnings == []


def test_several_options_over_the_line_are_each_reported():
    result = policy.clamp_options(
        {"time_budget_ms": 900_000, "max_evaluations": 10_000_000}, FREE
    )

    assert len(result.warnings) == 2


def test_options_that_are_not_budgets_are_left_alone():
    result = policy.clamp_options({"solver": "gecode", "seed": 7, "archive_size": 20}, FREE)

    assert result.options == {"solver": "gecode", "seed": 7, "archive_size": 20}


def test_a_missing_budget_is_not_invented():
    # An option the caller left out is filled in by the engine's defaults,
    # which are clamped separately.
    assert policy.clamp_options({"seed": 1}, FREE).options == {"seed": 1}


def test_a_null_budget_is_left_for_the_mode_schema_to_reject():
    assert policy.clamp_options({"time_budget_ms": None}, FREE).options == {
        "time_budget_ms": None
    }


def test_a_budget_that_is_not_a_number_is_left_to_validation():
    assert policy.clamp_options({"time_budget_ms": "soon"}, FREE).options == {
        "time_budget_ms": "soon"
    }


def test_a_boolean_is_not_mistaken_for_a_number():
    # True == 1 in Python, and an option that happens to be boolean must not be
    # silently turned into a duration.
    assert policy.clamp_options({"time_budget_ms": True}, FREE).options == {
        "time_budget_ms": True
    }


def test_clamping_does_not_mutate_what_the_caller_sent():
    asked = {"time_budget_ms": 900_000}

    policy.clamp_options(asked, FREE)

    assert asked == {"time_budget_ms": 900_000}


def test_the_engine_defaults_a_free_account_sees_are_ones_it_can_run():
    defaults = policy.plan_aware_defaults(
        {"solver": "gecode", "time_budget_ms": 900_000}, FREE
    )

    assert defaults["time_budget_ms"] == 300_000
    assert defaults["solver"] == "gecode"


def test_population_size_is_left_to_the_mode_contract():
    asked = {"population_size": 50_000}

    assert policy.clamp_options(asked, FREE).options == asked
    assert policy.clamp_options(asked, FREE).warnings == []


def test_the_engine_wait_never_exceeds_the_gateway_ceiling():
    # Waiting longer than the gateway itself will is a promise it cannot keep.
    assert policy.solve_timeout_s(PRO, 1800.0) <= 1800.0


def test_the_engine_wait_allows_a_little_beyond_the_plan_budget():
    # The budget describes solving; the wait also covers sending the instance
    # and receiving the answer.
    assert policy.solve_timeout_s(FREE, 1800.0) > FREE.max_timeout_s


def test_the_payload_ceiling_is_the_smaller_of_the_two():
    assert policy.payload_ceiling_bytes(FREE, 512 * 1024 * 1024) == 16 * 1024 * 1024
    assert policy.payload_ceiling_bytes(PRO, 16 * 1024 * 1024) == 16 * 1024 * 1024


def test_an_instance_within_the_plan_is_solvable():
    assert policy.instance_complexity_too_large(6.0, FREE) is False


def test_an_instance_beyond_the_plan_is_refused():
    assert policy.instance_complexity_too_large(12.0, FREE) is True


def test_the_same_instance_is_solvable_on_the_larger_plan():
    assert policy.instance_complexity_too_large(12.0, PRO) is False


def test_an_instance_exactly_at_the_ceiling_is_allowed():
    assert policy.instance_complexity_too_large(FREE.max_instance_complexity_log10, FREE) is False


def test_an_unmeasured_instance_complexity_is_not_refused():
    # Analysis always reports a size; refusing when it somehow did not would
    # turn a missing measurement into a billing decision.
    assert policy.instance_complexity_too_large(None, FREE) is False


def test_a_plan_with_no_ceilings_configured_still_bounds_a_request():
    # PlanCaps' own defaults are the free plan's, so an account whose contract
    # says nothing is bounded rather than unbounded.
    bare = PlanCaps()

    assert bare.max_timeout_s > 0
    assert policy.clamp_options({"time_budget_ms": 10**9}, bare).warnings != []

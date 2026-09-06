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
from _pricing import caps_for, largest_plan, pricing_catalog

CATALOG = pricing_catalog()
BASE = caps_for(CATALOG.default_plan)
LARGE = caps_for(largest_plan())


def above(caps: PlanCaps, role: str) -> int:
    ceiling = caps.limit(role)
    assert ceiling is not None
    return int(ceiling) + 1


def test_options_within_the_plan_are_left_alone():
    result = policy.clamp_options({"time_budget_ms": 1000, "iterations": 50}, BASE)

    assert result.options == {"time_budget_ms": 1000, "iterations": 50}
    assert result.warnings == []


def test_a_time_budget_beyond_the_plan_is_reduced():
    result = policy.clamp_options({"time_budget_ms": above(BASE, "maxTimeoutSeconds") * 1000}, BASE)

    assert result.options["time_budget_ms"] == BASE.limit("maxTimeoutSeconds") * 1000
    assert result.warnings[0].code == policy.OPTION_CLAMPED


@pytest.mark.parametrize("option", ["iterations", "max_evaluations"])
def test_search_effort_beyond_the_plan_is_reduced(option):
    result = policy.clamp_options({option: above(BASE, "maxIterations")}, BASE)

    assert result.options[option] == BASE.limit("maxIterations")
    assert result.warnings[0].details["option"] == option


def test_a_reduction_says_what_was_asked_and_what_was_done():
    # A solve that quietly did a tenth of the work asked for would produce a
    # worse answer with no explanation - the kind of result that gets published.
    requested = above(BASE, "maxTimeoutSeconds") * 1000
    result = policy.clamp_options({"time_budget_ms": requested}, BASE)

    details = result.warnings[0].details
    assert details["requested"] == requested
    assert details["applied"] == BASE.limit("maxTimeoutSeconds") * 1000
    assert str(int(details["applied"])) in result.warnings[0].message


def test_the_same_request_is_untouched_on_a_larger_plan():
    asked = {"time_budget_ms": 900_000, "iterations": 500_000}

    assert policy.clamp_options(asked, LARGE).options == asked
    assert policy.clamp_options(asked, LARGE).warnings == []


def test_several_options_over_the_line_are_each_reported():
    result = policy.clamp_options(
        {
            "time_budget_ms": above(BASE, "maxTimeoutSeconds") * 1000,
            "max_evaluations": above(BASE, "maxIterations"),
        },
        BASE,
    )

    assert len(result.warnings) == 2


def test_options_that_are_not_budgets_are_left_alone():
    result = policy.clamp_options({"solver": "gecode", "seed": 7, "archive_size": 20}, BASE)

    assert result.options == {"solver": "gecode", "seed": 7, "archive_size": 20}


def test_a_missing_budget_is_not_invented():
    # An option the caller left out is filled in by the engine's defaults,
    # which are clamped separately.
    assert policy.clamp_options({"seed": 1}, BASE).options == {"seed": 1}


def test_a_null_budget_is_left_for_the_mode_schema_to_reject():
    assert policy.clamp_options({"time_budget_ms": None}, BASE).options == {
        "time_budget_ms": None
    }


def test_a_budget_that_is_not_a_number_is_left_to_validation():
    assert policy.clamp_options({"time_budget_ms": "soon"}, BASE).options == {
        "time_budget_ms": "soon"
    }


def test_a_boolean_is_not_mistaken_for_a_number():
    # True == 1 in Python, and an option that happens to be boolean must not be
    # silently turned into a duration.
    assert policy.clamp_options({"time_budget_ms": True}, BASE).options == {
        "time_budget_ms": True
    }


def test_clamping_does_not_mutate_what_the_caller_sent():
    asked = {"time_budget_ms": 900_000}

    policy.clamp_options(asked, BASE)

    assert asked == {"time_budget_ms": 900_000}


def test_the_engine_defaults_a_free_account_sees_are_ones_it_can_run():
    defaults = policy.plan_aware_defaults(
        {"solver": "gecode", "time_budget_ms": above(BASE, "maxTimeoutSeconds") * 1000}, BASE
    )

    assert defaults["time_budget_ms"] == BASE.limit("maxTimeoutSeconds") * 1000
    assert defaults["solver"] == "gecode"


def test_population_size_is_left_to_the_mode_contract():
    asked = {"population_size": 50_000}

    assert policy.clamp_options(asked, BASE).options == asked
    assert policy.clamp_options(asked, BASE).warnings == []


def test_the_engine_wait_uses_the_space_entitlement_when_technically_supported():
    assert policy.solve_timeout_s(LARGE, 1800.0) == LARGE.limit("maxTimeoutSeconds")


def test_the_engine_wait_refuses_to_silently_clip_a_space_entitlement():
    with pytest.raises(ValueError, match="exceeds"):
        policy.solve_timeout_s(LARGE, 60.0)


def test_the_payload_ceiling_is_the_space_entitlement_when_technically_supported():
    gateway_ceiling = 512 * 1024 * 1024
    assert policy.payload_ceiling_bytes(BASE, gateway_ceiling) == int(
        BASE.limit("maxPayloadBytes") or 0
    )
    with pytest.raises(ValueError, match="exceeds"):
        policy.payload_ceiling_bytes(LARGE, 16 * 1024 * 1024)


def test_an_instance_within_the_plan_is_solvable():
    ceiling = BASE.limit("maxInstanceComplexityLog10")
    assert ceiling is not None
    assert policy.instance_complexity_too_large(ceiling - 1, BASE) is False


def test_an_instance_beyond_the_plan_is_refused():
    assert policy.instance_complexity_too_large(
        above(BASE, "maxInstanceComplexityLog10"), BASE
    ) is True


def test_the_same_instance_is_solvable_on_the_larger_plan():
    base_ceiling = BASE.limit("maxInstanceComplexityLog10")
    large_ceiling = LARGE.limit("maxInstanceComplexityLog10")
    assert base_ceiling is not None and large_ceiling is not None and large_ceiling > base_ceiling
    assert policy.instance_complexity_too_large(base_ceiling + 1, LARGE) is False


def test_an_instance_exactly_at_the_ceiling_is_allowed():
    ceiling = BASE.limit("maxInstanceComplexityLog10")
    assert ceiling is not None
    assert policy.instance_complexity_too_large(ceiling, BASE) is False


def test_an_unmeasured_instance_complexity_is_not_refused():
    # Analysis always reports a size; refusing when it somehow did not would
    # turn a missing measurement into a billing decision.
    assert policy.instance_complexity_too_large(None, BASE) is False


def test_a_plan_with_no_ceilings_configured_still_bounds_a_request():
    # Missing canonical entitlements fail closed rather than silently inheriting a
    # commercial configuration from application code.
    bare = PlanCaps(plan="unknown")

    assert bare.limit("maxTimeoutSeconds") == 0
    assert policy.clamp_options({"time_budget_ms": 10**9}, bare).warnings != []

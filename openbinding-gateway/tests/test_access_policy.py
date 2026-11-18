"""Bringing a request inside a plan: what gets reduced, and what gets refused.

The distinction under test is not a preference. A time budget is a request for
effort, so asking for more than the plan allows is answered by doing the allowed
amount. The plan sets the time budget (``maxRunMinutes``); the effort budget
(``MAX_ITERATIONS``) and the package size (``MAX_PACKAGE_BYTES``) are settings of
the deployment.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi import HTTPException

from openbinding_gateway.access import policy
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.space_client import OpenGate, PlanCaps
from _pricing import caps_for, largest_plan, fixture_catalog

CATALOG = fixture_catalog()
BASE = caps_for(CATALOG.default_plan)
LARGE = caps_for(largest_plan())


def plan_ms(caps: PlanCaps) -> int:
    minutes = caps.limit("maxRunMinutes")
    assert minutes is not None
    return int(minutes * 60_000)


def max_iterations() -> int:
    return get_settings().max_iterations


def test_options_within_the_plan_are_left_alone():
    result = policy.clamp_options({"time_budget_ms": 1000, "iterations": 50}, BASE)

    assert result.options == {"time_budget_ms": 1000, "iterations": 50}
    assert result.warnings == []


def test_a_time_budget_beyond_the_plan_is_reduced():
    result = policy.clamp_options({"time_budget_ms": plan_ms(BASE) + 1}, BASE)

    assert result.options["time_budget_ms"] == plan_ms(BASE)
    assert result.warnings[0].code == policy.OPTION_CLAMPED


@pytest.mark.parametrize("option", ["iterations", "max_evaluations"])
def test_search_effort_beyond_the_deployment_is_reduced(option):
    result = policy.clamp_options({option: max_iterations() + 1}, BASE)

    assert result.options[option] == max_iterations()
    assert result.warnings[0].details["option"] == option


def test_a_reduction_says_what_was_asked_and_what_was_done():
    # A solve that quietly did a tenth of the work asked for would produce a
    # worse answer with no explanation - the kind of result that gets published.
    requested = plan_ms(BASE) + 1
    result = policy.clamp_options({"time_budget_ms": requested}, BASE)

    details = result.warnings[0].details
    assert details["requested"] == requested
    assert details["applied"] == plan_ms(BASE)
    assert str(int(details["applied"])) in result.warnings[0].message


def test_the_same_request_is_untouched_on_a_larger_plan():
    asked = {"time_budget_ms": 900_000, "iterations": 500_000}

    assert policy.clamp_options(asked, LARGE).options == asked
    assert policy.clamp_options(asked, LARGE).warnings == []


def test_several_options_over_the_line_are_each_reported():
    result = policy.clamp_options(
        {
            "time_budget_ms": plan_ms(BASE) + 1,
            "max_evaluations": max_iterations() + 1,
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
        {"solver": "gecode", "time_budget_ms": plan_ms(BASE) + 1}, BASE
    )

    assert defaults["time_budget_ms"] == plan_ms(BASE)
    assert defaults["solver"] == "gecode"


def test_population_size_is_left_to_the_mode_contract():
    asked = {"population_size": 50_000}

    assert policy.clamp_options(asked, BASE).options == asked
    assert policy.clamp_options(asked, BASE).warnings == []


def test_the_engine_wait_is_the_plan_within_the_gateways_ceiling():
    assert policy.solve_timeout_s(BASE, 1800.0) == BASE.limit("maxRunMinutes") * 60
    # LAB grants more than the gateway waits: the gateway's ceiling decides, and the budget is brought to it.
    assert LARGE.limit("maxRunMinutes") * 60 > 1800.0
    assert policy.solve_timeout_s(LARGE, 1800.0) == 1800.0
    clamped = policy.clamp_options({"time_budget_ms": plan_ms(LARGE)}, LARGE)
    assert clamped.options["time_budget_ms"] == get_settings().engine_solve_timeout_s * 1000


def test_a_plan_that_does_not_declare_its_run_minutes_fails_closed_with_a_controlled_problem():
    with pytest.raises(HTTPException) as error:
        policy.solve_timeout_s(PlanCaps(plan="REAL"), 1800.0)
    assert error.value.status_code == 503
    assert error.value.detail["code"] == policy.PRICING_MISCONFIGURED


def test_the_payload_ceiling_is_the_setting_within_the_gateways_ceiling(monkeypatch):
    monkeypatch.setattr(get_settings(), "max_package_bytes", 8 * 1024 * 1024)
    assert policy.payload_ceiling_bytes(512 * 1024 * 1024) == 8 * 1024 * 1024
    assert policy.payload_ceiling_bytes(1024) == 1024


def test_the_open_gate_never_exceeds_a_technical_ceiling():
    settings = get_settings()
    caps = asyncio.run(OpenGate().caps(uuid.uuid4()))

    assert policy.solve_timeout_s(caps, settings.engine_solve_timeout_s) == settings.engine_solve_timeout_s


def test_the_open_gate_clamps_only_at_the_technical_ceilings():
    settings = get_settings()
    caps = asyncio.run(OpenGate().caps(uuid.uuid4()))
    beyond = int(settings.engine_solve_timeout_s * 1000) + 1

    result = policy.clamp_options({"time_budget_ms": beyond, "iterations": 10**12, "max_evaluations": 10**12}, caps)

    assert result.options["time_budget_ms"] == int(settings.engine_solve_timeout_s * 1000)
    assert result.options["iterations"] == result.options["max_evaluations"] == settings.max_iterations
    assert [w.details["option"] for w in result.warnings] == ["time_budget_ms", "iterations", "max_evaluations"]
    assert policy.plan_aware_defaults({"time_budget_ms": 1000}, caps) == {"time_budget_ms": 1000}


def test_a_plan_with_no_ceilings_configured_still_bounds_a_request():
    # Missing canonical entitlements fail closed rather than silently inheriting a
    # commercial configuration from application code.
    bare = PlanCaps(plan="unknown")

    assert bare.limit("maxRunMinutes") == 0
    assert policy.clamp_options({"time_budget_ms": 10**9}, bare).warnings != []

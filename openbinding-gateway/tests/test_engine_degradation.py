"""Verification of fault detection, engine degradation, and dynamic re-routing."""

from __future__ import annotations

import pytest
from openbinding_gateway.engine_routing import get_adaptation_manager, get_health_monitor


@pytest.fixture
def exact_friendly_problem():
    return {
        "spec": {
            "application": {
                "tasks": {
                    "t1": {"kind": "task"},
                    "t2": {"kind": "task"},
                }
            },
            "eligibility": {
                "t1": [{"resource": "r", "id": "1"}, {"resource": "r", "id": "2"}],
                "t2": [{"resource": "r", "id": "1"}, {"resource": "r", "id": "2"}],
            },
            "constraints": [
                {"assert": {"op": "eq", "left": 1, "right": 1}}
            ],
            "optimization": {
                "terms": [
                    {"metric": {"id": "quality"}, "direction": "maximize", "weight": 1.0}
                ]
            },
        }
    }


@pytest.fixture(autouse=True)
def reset_monitor():
    get_health_monitor().reset()
    yield
    get_health_monitor().reset()


@pytest.mark.asyncio
async def test_failure_records_trigger_degraded_state():
    monitor = get_health_monitor()
    eng = "minizinc-csp"
    monitor.force_status(eng, None)

    # Record 3 failures
    monitor.record_job_completion(eng, latency=1.5, success=False)
    monitor.record_job_completion(eng, latency=2.0, success=False)
    monitor.record_job_completion(eng, latency=1.8, success=False)

    health = monitor.get_health(eng)
    assert health.health_status == "DEGRADED"
    assert health.recent_failure_rate == 1.0
    assert monitor.is_available(eng) is True  # still reachable but degraded


@pytest.mark.asyncio
async def test_dynamic_rerouting_away_from_degraded_engine(exact_friendly_problem):
    manager = get_adaptation_manager()
    monitor = get_health_monitor()
    eng = "minizinc-csp"

    # Reset any forced status
    monitor.force_status(eng, None)

    # 1. Normal conditions: exact-friendly problem prefers minizinc-csp
    opts = {
        "routing": {
            "softPreferences": {
                "weights": {
                    "quality": 0.80,
                    "latency": 0.10,
                    "costCredits": 0.10,
                }
            }
        }
    }
    normal_plan = await manager.plan_routing(exact_friendly_problem, options=opts)
    assert normal_plan.selected_engine == "minizinc-csp"

    # 2. Inject failure/degraded status into minizinc-csp
    monitor.force_status(eng, "DEGRADED")

    # 3. Dynamic autonomic reaction: re-route to evolutionary-heuristics
    degraded_plan = await manager.plan_routing(exact_friendly_problem, options=opts)
    assert degraded_plan.selected_engine == "evolutionary-heuristics"

    evaluations = degraded_plan.provenance_admin["candidateEvaluations"]
    mzn_eval = next(c for c in evaluations if c["engine"] == "minizinc-csp")
    assert mzn_eval["admissible"] is False
    assert "DEGRADED" in mzn_eval["rejectionReason"]

    # 4. Recovery: restore healthy status
    monitor.force_status(eng, "HEALTHY")
    recovered_plan = await manager.plan_routing(exact_friendly_problem, options=opts)
    assert recovered_plan.selected_engine == "minizinc-csp"

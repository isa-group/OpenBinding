"""Verification of hard constraints and soft multi-criteria preferences in routing."""

from __future__ import annotations

import pytest
from openbinding_gateway.engine_routing import get_adaptation_manager


@pytest.fixture
def test_problem():
    return {
        "spec": {
            "application": {
                "tasks": {f"t{i}": {"kind": "task"} for i in range(1, 10)}
            },
            "eligibility": {
                f"t{i}": [
                    {"resource": "r", "id": f"c{j}"} for j in range(1, 5)
                ]
                for i in range(1, 10)
            },
            "constraints": [
                {"assert": {"op": "eq", "left": 1, "right": 1}}
            ],
            "optimization": {
                "terms": [
                    {"feature": {"id": "latency"}, "direction": "minimize", "weight": 1.0}
                ]
            },
        }
    }


@pytest.mark.asyncio
async def test_require_exact_enforces_exact_engine(test_problem):
    manager = get_adaptation_manager()
    plan = await manager.plan_routing(
        problem=test_problem,
        options={
            "routing": {
                "hardConstraints": {
                    "requireExact": True,
                    "maxTimeBudgetMs": 60000,
                }
            }
        }
    )

    assert plan.selected_engine == "minizinc-csp"
    evaluations = plan.provenance_admin["candidateEvaluations"]
    for cand in evaluations:
        if cand["engine"] in ("evolutionary-heuristics", "random-search", "many-heuristic"):
            assert cand["admissible"] is False
            assert "exact" in cand["rejectionReason"].lower()


@pytest.mark.asyncio
async def test_max_credits_rejects_expensive_engines(test_problem):
    manager = get_adaptation_manager()
    # Limit maxCredits to 2 (random-search costs 2 CUs, evolutionary costs 6 CUs)
    plan = await manager.plan_routing(
        problem=test_problem,
        options={
            "routing": {
                "hardConstraints": {
                    "maxCredits": 2,
                }
            }
        }
    )

    assert plan.selected_engine == "random-search"
    evaluations = plan.provenance_admin["candidateEvaluations"]
    for cand in evaluations:
        if cand["engine"] in ("evolutionary-heuristics", "minizinc-csp"):
            assert cand["admissible"] is False
            assert "credits" in cand["rejectionReason"].lower()


@pytest.mark.asyncio
async def test_max_time_budget_rejects_slow_engines(test_problem):
    manager = get_adaptation_manager()
    # Strict 50ms budget
    plan = await manager.plan_routing(
        problem=test_problem,
        options={
            "routing": {
                "hardConstraints": {
                    "maxTimeBudgetMs": 50,
                }
            }
        }
    )

    assert plan.selected_engine == "random-search"
    evaluations = plan.provenance_admin["candidateEvaluations"]
    for cand in evaluations:
        if cand["engine"] == "evolutionary-heuristics":
            assert cand["admissible"] is False
            assert "latency" in cand["rejectionReason"].lower() or "budget" in cand["rejectionReason"].lower()


@pytest.mark.asyncio
async def test_soft_preferences_cost_bias(test_problem):
    manager = get_adaptation_manager()
    # Soft preference heavily biased toward minimizing cost
    plan = await manager.plan_routing(
        problem=test_problem,
        options={
            "routing": {
                "softPreferences": {
                    "weights": {
                        "costCredits": 0.90,
                        "quality": 0.05,
                        "latency": 0.05,
                    }
                }
            }
        }
    )

    # Cost-heavy weighting should favor random-search (1 CU)
    assert plan.selected_engine == "random-search"


@pytest.mark.asyncio
async def test_active_queue_wait_penalizes_congested_engine(test_problem):
    manager = get_adaptation_manager()

    # Artificially congest evolutionary-heuristics with 80 active jobs in queue
    manager.health_monitor._active_jobs["evolutionary-heuristics"] = 80
    try:
        plan = await manager.plan_routing(
            problem=test_problem,
            options={
                "routing": {
                    "hardConstraints": {
                        "maxTimeBudgetMs": 4000,  # 4 seconds budget
                    }
                }
            }
        )

        evaluations = plan.provenance_admin["candidateEvaluations"]
        evo_cand = next(c for c in evaluations if c["engine"] == "evolutionary-heuristics")

        # Verify queue wait was tracked and modeled
        assert evo_cand["predicted"]["activeJobs"] == 80
        assert evo_cand["predicted"]["queueWait"] > 0.0
        assert evo_cand["predicted"]["latency"] > evo_cand["predicted"]["solveLatency"]

        # Congested evolutionary engine should be rejected or deprioritized due to queue delay
        assert plan.selected_engine != "evolutionary-heuristics"
    finally:
        manager.health_monitor._active_jobs.clear()


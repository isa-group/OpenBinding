"""One candidate serving several tasks, end to end through every engine.

The point of these is agreement. Each engine has its own copy of the semantics -
the MiniZinc model, the shared Java evaluator - and the gateway re-scores
whatever any of them answers with the reference evaluator. If an engine divided
a shared feature differently, or counted a shared candidate's demand twice, it
would report a binding the gateway then calls worse or infeasible. So the
assertions are: the answer is the one worked out by hand, and the gateway's own
numbers agree with it.
"""

from __future__ import annotations

import copy

import pytest
import requests

# Two tasks in sequence. "shared" can serve either and costs 12 whoever uses it;
# the dedicated candidates cost 7 each. Picking "shared" for both means 6 apiece,
# which beats 14 - but only because cost is declared DIVIDE.
SHARING_INSTANCE = {
    "metadata": {"id": "test-sharing", "name": "Sharing", "version": "1.0",
                 "created_at": "2026-07-29T00:00:00Z"},
    "tasks": [{"id": "T1", "name": "Task 1"}, {"id": "T2", "name": "Task 2"}],
    "providers": [{"id": "ProvA", "name": "Provider A"}, {"id": "ProvB", "name": "Provider B"}],
    "candidates": [
        {"id": "shared", "task_ids": ["T1", "T2"], "provider_id": "ProvA", "name": "Shared",
         "features": {"cost": 12}},
        {"id": "only_t1", "task_ids": ["T1"], "provider_id": "ProvB", "name": "Only T1",
         "features": {"cost": 7}},
        {"id": "only_t2", "task_ids": ["T2"], "provider_id": "ProvB", "name": "Only T2",
         "features": {"cost": 7}},
    ],
    "composition": {"type": "STRUCTURED", "root": {
        "id": "seq1", "kind": "SEQ", "children": [
            {"id": "t1", "kind": "TASK", "task_id": "T1"},
            {"id": "t2", "kind": "TASK", "task_id": "T2"},
        ]}},
    "features": [{"id": "cost", "name": "Cost", "direction": "MINIMIZE", "scale": "RATIO",
                  "unit": "USD", "valid_range": {"min": 0, "max": 1000}, "sharing": "DIVIDE"}],
    "aggregation_policies": {"cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}}},
    "objective": {"type": "MONO", "targets": ["cost"], "weights": {"cost": 1.0}},
}


def solve(gateway_url, wait_for_job, engine, instance):
    response = requests.post(f"{gateway_url}/v1/solve", json={
        "engine_id": engine, "instance": instance, "verbose": True,
    })
    if response.status_code == 422:
        pytest.skip(f"{engine} does not accept this instance: {response.text[:200]}")
    assert response.status_code in (200, 202), response.text

    data = response.json()
    job = data if response.status_code == 200 else wait_for_job(data["job_id"])
    if job["status"] == "failed":
        pytest.fail(f"Job failed: {job.get('error')}")

    solutions = (job.get("result") or {}).get("solutions") or []
    assert solutions, "no solution returned"
    return solutions[0]


def test_sharing_one_candidate_is_cheaper_than_two(gateway_url, wait_for_job, engine):
    """12 split between two tasks beats 7 + 7, and every engine has to see it."""
    solution = solve(gateway_url, wait_for_job, engine, copy.deepcopy(SHARING_INSTANCE))

    assert solution["binding"] == {"T1": "shared", "T2": "shared"}
    assert solution["aggregated_features"]["cost"] == pytest.approx(12.0)
    assert solution["feasible"]


def test_without_the_sharing_declaration_two_candidates_win(gateway_url, wait_for_job, engine):
    """The same numbers, charged in full to each task: 24 against 14."""
    instance = copy.deepcopy(SHARING_INSTANCE)
    del instance["features"][0]["sharing"]

    solution = solve(gateway_url, wait_for_job, engine, instance)

    assert solution["binding"] == {"T1": "only_t1", "T2": "only_t2"}
    assert solution["aggregated_features"]["cost"] == pytest.approx(14.0)


def test_same_candidate_forces_one_thing_for_both(gateway_url, wait_for_job, engine):
    instance = copy.deepcopy(SHARING_INSTANCE)
    del instance["features"][0]["sharing"]
    instance["constraints"] = [{
        "id": "together", "kind": "DEPENDENCY", "type": "SAME_CANDIDATE",
        "tasks": ["T1", "T2"], "hard": True,
    }]

    solution = solve(gateway_url, wait_for_job, engine, instance)

    assert solution["binding"] == {"T1": "shared", "T2": "shared"}
    assert solution["feasible"], "the only binding that satisfies it"


def test_different_candidate_forbids_it(gateway_url, wait_for_job, engine):
    instance = copy.deepcopy(SHARING_INSTANCE)
    instance["constraints"] = [{
        "id": "apart", "kind": "DEPENDENCY", "type": "DIFFERENT_CANDIDATE",
        "tasks": ["T1", "T2"], "hard": True,
    }]

    solution = solve(gateway_url, wait_for_job, engine, instance)

    assert solution["binding"] == {"T1": "only_t1", "T2": "only_t2"}
    assert solution["feasible"]


def test_a_shared_candidate_takes_up_its_pool_once(gateway_url, wait_for_job, engine):
    """A pool with room for one deployment: sharing fits where two do not."""
    instance = copy.deepcopy(SHARING_INSTANCE)
    instance["resource_model"] = {
        "pools": [{"id": "pool", "name": "Node", "kind": "EDGE", "capacity": {"memory": 3.0}}],
        "candidate_bindings": [
            {"candidate_id": "shared", "pool_id": "pool", "demand": {"memory": 2.0}},
            {"candidate_id": "only_t1", "pool_id": "pool", "demand": {"memory": 2.0}},
            {"candidate_id": "only_t2", "pool_id": "pool", "demand": {"memory": 2.0}},
        ],
    }

    solution = solve(gateway_url, wait_for_job, engine, instance)

    assert solution["binding"] == {"T1": "shared", "T2": "shared"}
    assert solution["feasible"], "one deployment wants 2.0 of the pool's 3.0"
    assert solution["violations"] == []

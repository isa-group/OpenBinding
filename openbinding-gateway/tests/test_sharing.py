"""One candidate serving several tasks at once.

A candidate used to belong to a single task, so no two tasks could ever pick
the same one. Now they can, and the question is what that costs: a feature
spent on every invocation still costs each task in full, while one paid for the
candidate itself is split between the tasks sharing it, and the pool it runs on
hosts one deployment rather than one per task.

The arithmetic below is written out by hand rather than derived from the code,
so a change in the code that moves a number has to disagree with a number here.
"""

from __future__ import annotations

import copy
from typing import Any, Dict

from openbinding_gateway.semantics import evaluate_solution
from openbinding_gateway.validation.analysis import compute_binding_space_summary
from openbinding_gateway.validation.semantic_general import GeneralSemanticValidator


def instance(**overrides: Any) -> Dict[str, Any]:
    """Two tasks in sequence, one candidate able to serve both."""
    base: Dict[str, Any] = {
        "metadata": {"id": "sharing", "name": "Sharing", "version": "1.0.0",
                     "created_at": "2026-07-29T00:00:00Z"},
        "features": [
            {"id": "cost", "name": "Cost", "direction": "MINIMIZE", "unit": "eur",
             "scale": "RATIO", "valid_range": {"min": 0, "max": 100}, "sharing": "DIVIDE"},
            {"id": "latency", "name": "Latency", "direction": "MINIMIZE", "unit": "ms",
             "scale": "RATIO", "valid_range": {"min": 0, "max": 100}},
        ],
        "providers": [{"id": "p1", "name": "Provider"}],
        "tasks": [{"id": "t1", "name": "One"}, {"id": "t2", "name": "Two"}],
        "candidates": [
            {"id": "both", "name": "Serves either", "task_ids": ["t1", "t2"],
             "provider_id": "p1", "features": {"cost": 10.0, "latency": 4.0}},
            {"id": "only_t1", "name": "Only one", "task_ids": ["t1"],
             "provider_id": "p1", "features": {"cost": 3.0, "latency": 1.0}},
            {"id": "only_t2", "name": "Only two", "task_ids": ["t2"],
             "provider_id": "p1", "features": {"cost": 3.0, "latency": 1.0}},
        ],
        "composition": {"type": "STRUCTURED", "root": {
            "id": "seq", "kind": "SEQ", "children": [
                {"id": "n1", "kind": "TASK", "task_id": "t1"},
                {"id": "n2", "kind": "TASK", "task_id": "t2"},
            ]}},
        "aggregation_policies": {
            "cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}},
            "latency": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}},
        },
        "objective": {"type": "MONO", "targets": ["cost"], "weights": {"cost": 1.0}},
    }
    base.update(copy.deepcopy(overrides))
    return base


def test_one_task_per_candidate_is_what_it_always_was() -> None:
    """k = 1 divides by one, so nothing about an unshared binding moves."""
    result = evaluate_solution(instance(), {"t1": "only_t1", "t2": "only_t2"})

    assert result["aggregated_features"] == {"cost": 6.0, "latency": 2.0}


def test_a_shared_candidate_splits_what_is_paid_for_it() -> None:
    """Both tasks on one candidate: 10 paid once, 5 carried by each."""
    result = evaluate_solution(instance(), {"t1": "both", "t2": "both"})

    assert result["aggregated_features"]["cost"] == 10.0


def test_a_shared_candidate_does_not_split_what_is_spent_per_task() -> None:
    """Latency is not declared DIVIDE, so each task still pays all four."""
    result = evaluate_solution(instance(), {"t1": "both", "t2": "both"})

    assert result["aggregated_features"]["latency"] == 8.0


def test_a_candidate_used_once_is_not_split() -> None:
    """Sharing is a property of the binding, not of the candidate."""
    result = evaluate_solution(instance(), {"t1": "both", "t2": "only_t2"})

    assert result["aggregated_features"]["cost"] == 13.0


def test_the_share_counts_every_bound_task_including_unreached_branches() -> None:
    """A task under the branch not taken still shares the candidate it picked.

    The XOR weighting is about which branch runs; the split is about how many
    tasks the candidate was bought for, and all three of them were.
    """
    spec = instance()
    spec["tasks"].append({"id": "t3", "name": "Three"})
    spec["candidates"][0]["task_ids"].append("t3")
    spec["composition"]["root"] = {
        "id": "seq", "kind": "SEQ", "children": [
            {"id": "n1", "kind": "TASK", "task_id": "t1"},
            {"id": "xor", "kind": "XOR", "branches": [
                {"p": 0.5, "child": {"id": "n2", "kind": "TASK", "task_id": "t2"}},
                {"p": 0.5, "child": {"id": "n3", "kind": "TASK", "task_id": "t3"}},
            ]},
        ]}
    spec["aggregation_policies"]["cost"]["compose"]["xor"] = {"fn": "SCALED_SUM"}
    spec["aggregation_policies"]["latency"]["compose"]["xor"] = {"fn": "SCALED_SUM"}

    result = evaluate_solution(spec, {"t1": "both", "t2": "both", "t3": "both"})

    # 10/3 for the first task, plus the expectation over two branches that each
    # carry 10/3 as well.
    assert abs(result["aggregated_features"]["cost"] - 20.0 / 3.0) < 1e-9


def test_a_local_bound_reads_the_share_not_the_whole() -> None:
    """The bound sees what the task actually accounts for."""
    spec = instance(constraints=[{
        "id": "cheap_enough", "kind": "ATTRIBUTE_BOUND", "scope": "LOCAL",
        "tasks": ["t1"], "attribute_id": "cost", "op": "<=", "value": 6.0, "hard": True,
    }])

    shared = evaluate_solution(spec, {"t1": "both", "t2": "both"})
    alone = evaluate_solution(spec, {"t1": "both", "t2": "only_t2"})

    assert shared["feasible"], "5.0 is within the bound of 6.0"
    assert not alone["feasible"], "10.0 alone breaks it"


def test_a_candidate_scoped_bound_reads_the_share_too() -> None:
    spec = instance(constraints=[{
        "id": "cheap_enough", "kind": "ATTRIBUTE_BOUND", "scope": "LOCAL",
        "candidates": ["both"], "attribute_id": "cost", "op": "<=", "value": 6.0, "hard": True,
    }])

    assert evaluate_solution(spec, {"t1": "both", "t2": "both"})["feasible"]
    assert not evaluate_solution(spec, {"t1": "both", "t2": "only_t2"})["feasible"]


def placement_instance() -> Dict[str, Any]:
    """The same two tasks, over a pool with room for one deployment only."""
    spec = instance()
    spec["resource_model"] = {
        "resources": ["memory"],
        "pools": [{"id": "pool", "name": "Node", "kind": "EDGE", "capacity": {"memory": 3.0}}],
        "candidate_bindings": [
            {"candidate_id": "both", "pool_id": "pool", "demand": {"memory": 2.0}},
            {"candidate_id": "only_t1", "pool_id": "pool", "demand": {"memory": 2.0}},
            {"candidate_id": "only_t2", "pool_id": "pool", "demand": {"memory": 2.0}},
        ],
        "constraints": [{"id": "cap", "kind": "DEPENDENCY", "type": "RESOURCE_CAPACITY",
                         "scope": "ALL_POOLS", "resources": ["memory"], "hard": True}],
    }
    return spec


def test_a_shared_candidate_takes_up_its_demand_once() -> None:
    """One thing deployed, whatever the number of tasks it ends up serving."""
    result = evaluate_solution(placement_instance(), {"t1": "both", "t2": "both"})

    assert result["feasible"], "2.0 of the pool's 3.0 is used, by one deployment"


def test_two_candidates_on_one_pool_take_up_their_demand_each() -> None:
    result = evaluate_solution(placement_instance(), {"t1": "only_t1", "t2": "only_t2"})

    assert not result["feasible"], "two deployments want 4.0 of a pool that has 3.0"
    assert any(v["constraint_id"] == "cap" for v in result["violations"])


def test_same_candidate_is_satisfied_only_by_one_candidate_for_both() -> None:
    spec = instance(constraints=[{
        "id": "together", "kind": "DEPENDENCY", "type": "SAME_CANDIDATE",
        "tasks": ["t1", "t2"], "hard": True,
    }])

    assert evaluate_solution(spec, {"t1": "both", "t2": "both"})["feasible"]
    assert not evaluate_solution(spec, {"t1": "only_t1", "t2": "only_t2"})["feasible"]


def test_different_candidate_is_the_other_way_round() -> None:
    spec = instance(constraints=[{
        "id": "apart", "kind": "DEPENDENCY", "type": "DIFFERENT_CANDIDATE",
        "tasks": ["t1", "t2"], "hard": True,
    }])

    assert evaluate_solution(spec, {"t1": "only_t1", "t2": "only_t2"})["feasible"]
    assert not evaluate_solution(spec, {"t1": "both", "t2": "both"})["feasible"]


def test_a_candidate_counts_in_the_market_of_every_task_it_serves() -> None:
    summary = compute_binding_space_summary(instance())

    assert summary.per_task_counts == {"t1": 2, "t2": 2}
    assert summary.cardinality == "4"


def violations_of(spec: Dict[str, Any]) -> Dict[str, str]:
    """Every message the validator reports, gathered under its code."""
    gathered: Dict[str, str] = {}
    for violation in GeneralSemanticValidator().validate(spec):
        gathered[violation.code] = f"{gathered.get(violation.code, '')} {violation.message}".strip()
    return gathered


def test_an_unsatisfiable_same_candidate_is_refused() -> None:
    spec = instance(constraints=[{
        "id": "impossible", "kind": "DEPENDENCY", "type": "SAME_CANDIDATE",
        "tasks": ["t1", "t2"], "hard": True,
    }])
    spec["candidates"] = [c for c in spec["candidates"] if c["id"] != "both"]

    assert "unsatisfiable_constraint" in violations_of(spec)


def test_a_soft_same_candidate_that_cannot_hold_is_not_refused() -> None:
    """It still leaves every binding solvable; it just always pays."""
    spec = instance(constraints=[{
        "id": "wishful", "kind": "DEPENDENCY", "type": "SAME_CANDIDATE",
        "tasks": ["t1", "t2"], "hard": False,
    }])
    spec["candidates"] = [c for c in spec["candidates"] if c["id"] != "both"]

    assert "unsatisfiable_constraint" not in violations_of(spec)


def test_dividing_the_end_to_end_latency_is_refused() -> None:
    spec = instance()
    spec["features"][1]["sharing"] = "DIVIDE"
    spec["latency_model"] = {
        "unit": "ms",
        "pool_latency_matrix_ms": {},
        "event_generator_pools": {},
        "event_latency_matrix_ms": {},
        "transition_constraints": [],
        "global_latency": {"attribute_id": "latency", "include_execution_latency_feature": True,
                           "xor_semantics": "EXPECTED", "and_semantics": "MAX"},
    }

    assert "semantic_invariant_error" in violations_of(spec)


def test_dividing_a_feature_that_multiplies_is_refused() -> None:
    spec = instance()
    spec["aggregation_policies"]["cost"]["compose"] = {"seq": {"fn": "PRODUCT"}}

    assert "semantic_invariant_error" in violations_of(spec)


def test_dividing_a_feature_that_admits_negative_values_is_refused() -> None:
    spec = instance()
    spec["features"][0]["valid_range"] = {"min": -10, "max": 100}

    assert "semantic_invariant_error" in violations_of(spec)


def test_a_candidate_still_declaring_one_task_is_named_as_such() -> None:
    spec = instance()
    spec["candidates"][0] = {"id": "both", "name": "Serves either", "task_id": "t1",
                             "provider_id": "p1", "features": {"cost": 10.0, "latency": 4.0}}

    messages = violations_of(spec)
    assert "referential_integrity_error" in messages
    assert "task_ids" in messages["referential_integrity_error"]

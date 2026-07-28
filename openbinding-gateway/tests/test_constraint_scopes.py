"""Attribute bound constraints: every scope and every operator must bite.

A hard constraint that is accepted by validation and then ignored by the
evaluator is worse than a rejected one, because the answer comes back marked
feasible. These tests pin the cases that used to be silently dropped.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List

import pytest

from openbinding_gateway.semantics import evaluate_solution


def instance_with(constraints: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "metadata": {"id": "scopes", "name": "Scopes", "version": "1.0", "created_at": "2026-01-01T00:00:00Z"},
        "tasks": [{"id": "T1", "name": "T1"}, {"id": "T2", "name": "T2"}],
        "providers": [{"id": "P1", "name": "P1"}],
        "candidates": [
            {"id": "A1", "task_id": "T1", "provider_id": "P1", "name": "A1", "features": {"cost": 1.0}},
            {"id": "A2", "task_id": "T1", "provider_id": "P1", "name": "A2", "features": {"cost": 50.0}},
            {"id": "B1", "task_id": "T2", "provider_id": "P1", "name": "B1", "features": {"cost": 1.0}},
            {"id": "B2", "task_id": "T2", "provider_id": "P1", "name": "B2", "features": {"cost": 50.0}},
        ],
        "composition": {
            "type": "STRUCTURED",
            "root": {
                "id": "s",
                "kind": "SEQ",
                "children": [
                    {"id": "n1", "kind": "TASK", "task_id": "T1"},
                    {"id": "n2", "kind": "TASK", "task_id": "T2"},
                ],
            },
        },
        "features": [
            {
                "id": "cost",
                "name": "Cost",
                "direction": "MINIMIZE",
                "unit": "u",
                "scale": "RATIO",
                "valid_range": {"min": 0, "max": 1000},
            }
        ],
        "aggregation_policies": {"cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}}},
        "objective": {"type": "MONO", "targets": ["cost"], "weights": {"cost": 1.0}},
        "constraints": constraints,
    }


def local_constraint(**overrides: Any) -> Dict[str, Any]:
    constraint = {
        "id": "c_local",
        "kind": "ATTRIBUTE_BOUND",
        "scope": "LOCAL",
        "attribute_id": "cost",
        "op": "<=",
        "value": 10,
        "hard": True,
    }
    constraint.update(overrides)
    return constraint


def test_local_constraint_binds_every_listed_task() -> None:
    instance = instance_with([local_constraint(tasks=["T1", "T2"])])

    assert evaluate_solution(instance, {"T1": "A1", "T2": "B1"})["feasible"]

    # The second task breaking the bound has to count just as much as the first.
    for binding in ({"T1": "A2", "T2": "B1"}, {"T1": "A1", "T2": "B2"}):
        evaluation = evaluate_solution(instance, binding)
        assert not evaluation["feasible"], binding
        assert len(evaluation["violations"]) == 1


def test_local_constraint_scoped_by_candidate_is_enforced() -> None:
    """Scoping by candidate id is schema-legal and used to be ignored entirely."""
    instance = instance_with([local_constraint(candidates=["B2"])])

    # B2 breaks the bound, so selecting it is a violation.
    evaluation = evaluate_solution(instance, {"T1": "A2", "T2": "B2"})
    assert not evaluation["feasible"]
    assert len(evaluation["violations"]) == 1
    assert "B2" in evaluation["violations"][0]["message"]

    # A2 also breaks the bound but is not in scope, so it is free to be picked.
    assert evaluate_solution(instance, {"T1": "A2", "T2": "B1"})["feasible"]


def test_candidate_scope_only_applies_to_the_selected_candidate() -> None:
    instance = instance_with([local_constraint(candidates=["A2", "B2"])])

    assert evaluate_solution(instance, {"T1": "A1", "T2": "B1"})["feasible"]
    assert len(evaluate_solution(instance, {"T1": "A2", "T2": "B2"})["violations"]) == 2


def test_task_and_candidate_scopes_combine() -> None:
    instance = instance_with([local_constraint(tasks=["T1"], candidates=["B2"])])

    assert evaluate_solution(instance, {"T1": "A1", "T2": "B1"})["feasible"]
    assert not evaluate_solution(instance, {"T1": "A2", "T2": "B1"})["feasible"]
    assert not evaluate_solution(instance, {"T1": "A1", "T2": "B2"})["feasible"]


@pytest.mark.parametrize(
    "op,value,binding,expected_feasible",
    [
        ("IN_RANGE", {"min": 0, "max": 10}, {"T1": "A1", "T2": "B1"}, True),
        ("IN_RANGE", {"min": 0, "max": 10}, {"T1": "A2", "T2": "B2"}, False),
        ("IN_RANGE", {"min": 40, "max": 60}, {"T1": "A1", "T2": "B1"}, False),
        ("!=", 2, {"T1": "A1", "T2": "B1"}, False),
        ("!=", 2, {"T1": "A2", "T2": "B1"}, True),
        ("==", 2, {"T1": "A1", "T2": "B1"}, True),
        (">", 50, {"T1": "A2", "T2": "B2"}, True),
        (">", 100, {"T1": "A2", "T2": "B2"}, False),
    ],
)
def test_global_bound_operators(op: str, value: Any, binding: Dict[str, str], expected_feasible: bool) -> None:
    instance = instance_with(
        [
            {
                "id": "c_global",
                "kind": "ATTRIBUTE_BOUND",
                "scope": "GLOBAL",
                "attribute_id": "cost",
                "op": op,
                "value": copy.deepcopy(value),
                "hard": True,
            }
        ]
    )

    assert evaluate_solution(instance, binding)["feasible"] == expected_feasible


def test_soft_constraints_do_not_make_a_solution_infeasible() -> None:
    instance = instance_with([local_constraint(tasks=["T1", "T2"], hard=False)])
    evaluation = evaluate_solution(instance, {"T1": "A2", "T2": "B2"})

    assert evaluation["feasible"]
    assert len(evaluation["violations"]) == 2


def test_specialization_schemas_accept_what_their_engine_implements() -> None:
    """A capability implemented in three places is useless if the schema rejects it.

    Pool dependencies are enforced by the MiniZinc model, every JVM engine
    through the shared core, and the reference evaluator, and were rejected by
    every engine's specialization schema, so no instance could ever use them.
    """
    import json
    import os

    import jsonschema

    repo_root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    pool_constraint = {
        "constraints": [
            {"id": "c", "kind": "DEPENDENCY", "type": "SAME_POOL", "tasks": ["T1", "T2"], "hard": True}
        ]
    }

    for engine in ("minizinc-csp", "random-search", "evolutionary-heuristics", "many-heuristic"):
        path = os.path.join(repo_root, "schemas", "specializations", f"{engine}.schema.json")
        with open(path) as handle:
            schema = json.load(handle)
        validator = jsonschema.Draft202012Validator(schema)
        offending = [e for e in validator.iter_errors(pool_constraint) if "constraints" in str(e.path)]
        assert not offending, f"{engine} rejects a pool dependency it implements: {offending[:1]}"

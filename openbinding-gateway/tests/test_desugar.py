"""The short way of writing an instance, and the long way it stands for.

Each shorthand has exactly one expansion, and the expansion is what everything
downstream reads. Two things have to hold for that to be safe: an instance
written either way must evaluate to the same numbers, and an instance that is
already expanded must come out of the expansion untouched.
"""

from __future__ import annotations

import copy
import glob
import json
import os
from typing import Any, Dict

import pytest

from openbinding_gateway.semantics.desugar import desugar_instance, has_shorthand
from openbinding_gateway.semantics.errors import DesugarError

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def every_example() -> list:
    return [
        path
        for path in sorted(glob.glob(os.path.join(REPO_ROOT, "examples", "**", "*.json"), recursive=True))
        if f"{os.sep}parts{os.sep}" not in path
    ]


@pytest.mark.parametrize("path", every_example())
def test_expanding_twice_changes_nothing(path: str) -> None:
    with open(path) as handle:
        instance = json.load(handle)

    once = desugar_instance(instance)
    assert desugar_instance(copy.deepcopy(once)) == once


def test_an_already_expanded_instance_is_left_as_it_came() -> None:
    """No copy, so evaluating many bindings of one instance costs nothing."""
    instance = {
        "objective": {"type": "MONO", "targets": ["cost"], "weights": {"cost": 1.0}},
        "aggregation_policies": {"cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}}},
        "composition": {"type": "STRUCTURED", "root": {"id": "n1", "kind": "TASK", "task_id": "t1"}},
    }

    assert not has_shorthand(instance)
    assert desugar_instance(instance) is instance


def test_a_bare_task_id_is_the_task_node_it_stands_for() -> None:
    instance = {"composition": {"type": "STRUCTURED", "root": {
        "id": "seq", "kind": "SEQ", "children": ["t1", "t2"]}}}

    root = desugar_instance(instance)["composition"]["root"]

    assert root["children"] == [
        {"id": "n_t1", "kind": "TASK", "task_id": "t1"},
        {"id": "n_t2", "kind": "TASK", "task_id": "t2"},
    ]


def test_a_generated_node_id_gives_way_to_one_written_by_hand() -> None:
    instance = {"composition": {"type": "STRUCTURED", "root": {
        "id": "seq", "kind": "SEQ", "children": [
            {"id": "n_t1", "kind": "TASK", "task_id": "t1"},
            "t1",
        ]}}}

    children = desugar_instance(instance)["composition"]["root"]["children"]

    assert [child["id"] for child in children] == ["n_t1", "n_t1_2"]


def test_branches_without_a_probability_are_equally_likely() -> None:
    instance = {"composition": {"type": "STRUCTURED", "root": {
        "id": "xor", "kind": "XOR", "branches": [{"child": "a"}, {"child": "b"}, {"child": "c"}]}}}

    branches = desugar_instance(instance)["composition"]["root"]["branches"]

    assert [round(branch["p"], 6) for branch in branches] == [0.333333, 0.333333, 0.333333]


def test_declaring_a_probability_for_some_branches_only_is_refused() -> None:
    instance = {"composition": {"type": "STRUCTURED", "root": {
        "id": "xor", "kind": "XOR", "branches": [{"p": 0.7, "child": "a"}, {"child": "b"}]}}}

    with pytest.raises(DesugarError, match="some branches"):
        desugar_instance(instance)


def test_one_function_stands_for_all_four_operators() -> None:
    instance = {"aggregation_policies": {"cost": {"neutral": 0, "fn": "SUM"}}}

    compose = desugar_instance(instance)["aggregation_policies"]["cost"]["compose"]

    assert compose == {
        "seq": {"fn": "SUM"}, "and": {"fn": "SUM"},
        "xor": {"fn": "SCALED_SUM"}, "loop": {"fn": "SCALED_SUM"},
    }


def test_the_worst_of_several_branches_is_still_the_worst() -> None:
    """Only the accumulating functions have a scaled counterpart."""
    instance = {"aggregation_policies": {"security": {"neutral": 1, "fn": "MIN"}}}

    compose = desugar_instance(instance)["aggregation_policies"]["security"]["compose"]

    assert compose["xor"] == {"fn": "MIN"} and compose["loop"] == {"fn": "MIN"}


def test_giving_both_a_function_and_a_compose_block_is_refused() -> None:
    instance = {"aggregation_policies": {"cost": {
        "neutral": 0, "fn": "SUM", "compose": {"seq": {"fn": "MAX"}}}}}

    with pytest.raises(DesugarError, match="both"):
        desugar_instance(instance)


def test_targets_weigh_the_same_when_no_weights_are_given() -> None:
    instance = {"objective": {"type": "MULTI", "targets": ["cost", "latency"]}}

    assert desugar_instance(instance)["objective"]["weights"] == {"cost": 0.5, "latency": 0.5}


def placement_shorthand() -> Dict[str, Any]:
    return {
        "candidates": [
            {"id": "c1", "task_ids": ["t1"], "features": {"cost": 1},
             "placement": {"pool": "pool", "demand": {"memory": 2.0}}},
        ],
        "resource_model": {
            "pools": [{"id": "pool", "name": "Node", "kind": "EDGE", "capacity": {"memory": 4.0}}],
        },
    }


def test_a_candidate_can_say_where_it_runs_itself() -> None:
    canonical = desugar_instance(placement_shorthand())

    assert "placement" not in canonical["candidates"][0]
    assert canonical["resource_model"]["candidate_bindings"] == [
        {"candidate_id": "c1", "pool_id": "pool", "demand": {"memory": 2.0}}
    ]


def test_saying_it_twice_is_refused() -> None:
    instance = placement_shorthand()
    instance["resource_model"]["candidate_bindings"] = [
        {"candidate_id": "c1", "pool_id": "pool", "demand": {"memory": 1.0}}
    ]

    with pytest.raises(DesugarError, match="keep one of them"):
        desugar_instance(instance)


def test_the_resources_are_the_ones_that_are_actually_used() -> None:
    canonical = desugar_instance(placement_shorthand())

    assert canonical["resource_model"]["resources"] == ["memory"]


def test_capacity_is_checked_by_default() -> None:
    canonical = desugar_instance(placement_shorthand())

    assert canonical["resource_model"]["constraints"] == [{
        "id": "resource_capacity", "kind": "DEPENDENCY", "type": "RESOURCE_CAPACITY",
        "scope": "ALL_POOLS", "resources": ["memory"], "hard": True,
    }]


def test_an_empty_constraint_list_means_no_capacity_is_checked() -> None:
    """Absent is the default; empty is the opposite, and says so on purpose."""
    instance = placement_shorthand()
    instance["resource_model"]["constraints"] = []

    assert desugar_instance(instance)["resource_model"]["constraints"] == []

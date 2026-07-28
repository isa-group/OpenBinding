"""Characterization tests: the numbers the gateway returns must not move.

These lock down the post-processing pipeline for every bundled example
instance, with and without placement extensions. They exist so that
refactors of the validation and aggregation code can be proven behaviour
preserving rather than argued to be.

Regenerate the snapshots with tools/regenerate_goldens.py, and only ever do so
when a change of the produced numbers is intended and reviewed.
"""

from __future__ import annotations

import copy
import json
import math
import os
from typing import Any, Dict, List

import pytest

from openbinding_gateway.validation.engine_plugins.aggregation import canonicalize_result_data
from openbinding_gateway.validation.engine_plugins.reference_evaluator import evaluate_solution

TOLERANCE = 1e-9

GOLDEN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden")
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def golden_files() -> List[str]:
    return sorted(name for name in os.listdir(GOLDEN_DIR) if name.endswith(".json"))


def load_golden(name: str) -> Dict[str, Any]:
    with open(os.path.join(GOLDEN_DIR, name)) as handle:
        return json.load(handle)


def load_instance(relative_path: str) -> Dict[str, Any]:
    with open(os.path.join(REPO_ROOT, relative_path)) as handle:
        return json.load(handle)


def assert_close(actual: Any, expected: Any, context: str) -> None:
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert isinstance(actual, (int, float)) and not isinstance(actual, bool), context
        assert math.isclose(float(actual), float(expected), rel_tol=0.0, abs_tol=TOLERANCE), (
            f"{context}: {actual} != {expected}"
        )
        return
    assert actual == expected, context


def assert_features_close(actual: Any, expected: Any, context: str) -> None:
    assert set((actual or {}).keys()) == set((expected or {}).keys()), f"{context}: feature keys"
    for feature_id, value in (expected or {}).items():
        assert_close((actual or {})[feature_id], value, f"{context}: feature '{feature_id}'")


@pytest.mark.parametrize("golden_name", golden_files())
def test_gateway_response_is_unchanged(golden_name: str) -> None:
    """What a client receives from /v1/solve, per example instance and binding."""
    golden = load_golden(golden_name)
    instance = load_instance(golden["instance"])

    for case in golden["cases"]:
        where = f"{golden['instance']}#{case['index']}"

        reported = {
            "solutions": [
                {
                    "binding": case["binding"],
                    "objective_value": case["engine_reported_objective"],
                }
            ]
        }
        solution = canonicalize_result_data(copy.deepcopy(reported), instance)["solutions"][0]
        expected = case["gateway"]

        assert_features_close(
            solution.get("aggregated_features"), expected["aggregated_features"], where
        )
        assert_close(solution.get("objective_value"), expected["objective_value"], f"{where}: objective")
        assert solution.get("engine_objective_value") == expected["engine_objective_value"], where
        assert solution.get("feasible") == expected["feasible"], f"{where}: feasible"
        assert solution.get("violations") == expected["violations"], f"{where}: violations"

        blank = {"solutions": [{"binding": case["binding"]}]}
        without = canonicalize_result_data(copy.deepcopy(blank), instance)["solutions"][0]
        assert_close(
            without.get("objective_value"),
            case["gateway_without_engine_objective"]["objective_value"],
            f"{where}: objective without engine value",
        )


@pytest.mark.parametrize("golden_name", golden_files())
def test_reference_evaluator_is_unchanged(golden_name: str) -> None:
    """The reference evaluator, which is also the experimentation oracle."""
    golden = load_golden(golden_name)
    instance = load_instance(golden["instance"])

    for case in golden["cases"]:
        where = f"{golden['instance']}#{case['index']}"
        evaluation = evaluate_solution(instance, case["binding"])
        expected = case["reference_evaluator"]

        assert_features_close(evaluation["aggregated_features"], expected["aggregated_features"], where)
        assert_close(evaluation["objective_value"], expected["objective_value"], f"{where}: objective")
        assert evaluation["feasible"] == expected["feasible"], f"{where}: feasible"
        assert evaluation["violations"] == expected["violations"], f"{where}: violations"


def test_every_example_instance_has_a_golden() -> None:
    """A new example must come with its snapshot, or it is silently uncovered."""
    expected = set()
    for directory in ("demo", "literature", "placement"):
        for entry in os.listdir(os.path.join(REPO_ROOT, "examples", directory)):
            if entry.endswith(".json"):
                expected.add(f"examples__{directory}__{entry}")

    assert set(golden_files()) == expected


def test_objective_convention_is_predicted_by_declared_normalization() -> None:
    """Placement is not what selects the canonical objective: normalization is.

    Every instance that declares normalize bounds for all of its objective
    targets is canonicalized by the reference evaluator, and every instance
    that declares none keeps the engine-reported value. This is what allows
    the two historical code paths to be merged without moving any number.
    """
    for golden_name in golden_files():
        golden = load_golden(golden_name)
        fully_normalized = golden["normalized_targets"] == golden["objective_targets"]
        assert fully_normalized == golden["placement"], (
            f"{golden['instance']}: normalization no longer coincides with placement; "
            "the merged canonicalization rule needs to be revisited"
        )

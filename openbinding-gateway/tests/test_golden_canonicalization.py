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

from openbinding_gateway.semantics import canonicalize_result_data
from openbinding_gateway.semantics import evaluate_solution

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

    An instance that declares normalize bounds for all of its objective targets
    is canonicalized by the reference evaluator, so the value an engine reported
    is replaced and kept alongside as engine_objective_value. An instance that
    declares none keeps what the engine said. Placement has nothing to do with
    it, which is what the shared-candidates example makes visible: it declares
    normalization and carries no placement blocks at all.
    """
    normalized_without_placement = []

    for golden_name in golden_files():
        golden = load_golden(golden_name)
        fully_normalized = golden["normalized_targets"] == golden["objective_targets"]
        if fully_normalized and not golden["placement"]:
            normalized_without_placement.append(golden["instance"])

        for case in golden["cases"]:
            gateway = case["gateway"]
            where = f"{golden['instance']}#{case['index']}"
            if fully_normalized:
                assert gateway["engine_objective_value"] == case["engine_reported_objective"], (
                    f"{where}: a fully normalized instance must keep what the engine reported "
                    "alongside the canonical value"
                )
            else:
                assert gateway["engine_objective_value"] is None, (
                    f"{where}: without full normalization the instance's own convention is the "
                    "answer, so there is no canonical value to keep the engine's beside"
                )

    assert normalized_without_placement, (
        "no example declares normalization without placement any more; the rule that "
        "normalization alone selects the convention is no longer covered"
    )


def test_schema_modules_bundle_into_one_equivalent_document() -> None:
    """The split into one file per tuple element must not change what validates.

    schemas/general/ is one file per element of I' = (M_A, M'_C, Delta, O) so
    that a model can be referenced and reused on its own. Everything that
    consumes the schema is served the bundle instead, and the bundle has to
    accept and reject exactly what a single file would.
    """
    import glob

    import jsonschema

    from openbinding_gateway.validation.schema_bundle import load_general_schema

    bundle = load_general_schema()
    jsonschema.Draft202012Validator.check_schema(bundle)
    validator = jsonschema.Draft202012Validator(bundle)

    valid = [
        path
        for path in sorted(glob.glob(os.path.join(REPO_ROOT, "examples", "**", "*.json"), recursive=True))
        if f"{os.sep}parts{os.sep}" not in path
    ]
    assert valid, "no example instances found"
    for path in valid:
        with open(path) as handle:
            instance = json.load(handle)
        errors = list(validator.iter_errors(instance))
        assert not errors, f"{os.path.basename(path)} should validate: {errors[0].message}"

    # And rejection, which is the half a permissive bundle would silently lose.
    with open(os.path.join(REPO_ROOT, "examples", "demo", "01_simple_seq.json")) as handle:
        base = json.load(handle)

    without_objective = {k: v for k, v in base.items() if k != "objective"}
    assert list(validator.iter_errors(without_objective)), "a required block is missing"

    unknown_key = {**base, "not_part_of_the_model": 1}
    assert list(validator.iter_errors(unknown_key)), "the root forbids unknown keys"

    bad_operator = copy.deepcopy(base)
    bad_operator["constraints"] = [
        {"id": "c", "kind": "ATTRIBUTE_BOUND", "scope": "GLOBAL",
         "attribute_id": "latency", "op": "<>", "value": 1}
    ]
    assert list(validator.iter_errors(bad_operator)), "'<>' is not an operator"

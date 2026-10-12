"""Adversarial re-evaluation and result-validation vectors (``golden/vectors_extra.json``).

They have no OpenBinding original.  Each vector is an answer a hostile or sloppy Engine could send for the demo
problem.  The expectations below are written by hand, independently of the code that produced the pinned golden:
what ``reevaluate_result`` must never believe, and what ``validate_result`` must refuse.

Expectation = ``(termination after re-evaluation, number of solutions kept, code of the ProtocolError of
validate_result or None if valid, code under finite=True or None)``.
"""

import math

import pytest

from bim_core import compile_instance, load_package, reevaluate_result, validate_result
from bim_core.errors import ProtocolError
from conftest import CORPUS_MARKER, GOLDEN_DIR, check_or_create_golden, corpus_root

EXTRA_GOLDEN = GOLDEN_DIR.parent / "vectors_extra.json"
DEMO = "examples/demo/01_simple_seq"
EVERYTHING = ["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"]

NON_FINITE = "non_finite_number"
DECISION = "solution_decision_invalid"

EXPECTED = {
    # the engine lies about what it computed
    "objective_penalty_and_score_altered": ("OPTIMAL", 1, None, None),
    "objective_component_weight_and_loss_altered": ("OPTIMAL", 1, None, None),
    "objective_type_altered": ("OPTIMAL", 1, None, None),
    "objective_scalarization_altered": ("OPTIMAL", 1, None, None),
    "features_altered": ("OPTIMAL", 1, None, None),
    "penalties_altered": ("OPTIMAL", 1, None, None),
    "violations_hidden": ("OPTIMAL", 1, None, None),
    # the binding is not a valid decision
    "binding_unknown_candidate": ("UNKNOWN", 0, None, None),
    "binding_candidate_of_another_task": ("UNKNOWN", 0, None, None),
    "binding_missing_task": ("UNKNOWN", 0, None, None),
    "binding_extra_task": ("UNKNOWN", 0, None, None),
    "binding_empty": ("UNKNOWN", 0, None, None),
    "binding_value_extra_key": ("UNKNOWN", 0, DECISION, DECISION),
    "binding_value_not_an_object": ("UNKNOWN", 0, DECISION, DECISION),
    "binding_other_resource": ("UNKNOWN", 0, None, None),
    "valid_and_ineligible_in_one_answer": ("UNKNOWN", 1, None, None),
    "duplicate_solutions": ("FEASIBLE", 2, None, None),
    # terminations that claim more than the solutions or the declared guarantees support
    "unknown_with_valid_binding": ("UNKNOWN", 1, None, None),
    "unknown_with_ineligible_binding": ("UNKNOWN", 0, None, None),
    "infeasible_with_valid_binding_declared": ("UNKNOWN", 1, None, None),
    "infeasible_with_valid_binding_default": ("UNKNOWN", 1, None, None),
    "infeasible_without_binding_default": ("UNKNOWN", 0, None, None),
    "optimal_with_default_guarantees": ("UNKNOWN", 1, None, None),
    "feasible_when_only_unknown_is_declared": ("UNKNOWN", 1, None, None),
    "termination_lowercase": ("UNKNOWN", 1, "invalid_termination", "invalid_termination"),
    "termination_unhashable": ("UNKNOWN", 1, "invalid_termination", "invalid_termination"),
    "termination_missing": ("UNKNOWN", 1, "invalid_termination", "invalid_termination"),
    "allowed_terminations_unhashable_and_unknown": ("FEASIBLE", 1, None, None),
    # numbers that are not numbers, or not finite
    "nan_feature": ("OPTIMAL", 1, None, NON_FINITE),
    "infinite_penalty": ("OPTIMAL", 1, None, NON_FINITE),
    "negative_infinite_penalty_entry": ("OPTIMAL", 1, "penalties_invalid", NON_FINITE),
    "nan_score": ("OPTIMAL", 1, None, NON_FINITE),
    "nan_component_loss": ("OPTIMAL", 1, None, NON_FINITE),
    "nan_in_provenance": ("OPTIMAL", 1, None, NON_FINITE),
    "boolean_feature": ("OPTIMAL", 1, "solution_features_invalid", "solution_features_invalid"),
    "string_feature": ("OPTIMAL", 1, "solution_features_invalid", "solution_features_invalid"),
    "negative_penalty_entry": ("OPTIMAL", 1, "penalties_invalid", "penalties_invalid"),
    "boolean_penalty_entry": ("OPTIMAL", 1, "penalties_invalid", "penalties_invalid"),
    # keys the protocol does not define
    "extra_key_in_result": ("OPTIMAL", 1, "unknown_fields", "unknown_fields"),
    "extra_key_in_solution": ("OPTIMAL", 1, DECISION, DECISION),
    "extra_key_in_decision": ("OPTIMAL", 1, DECISION, DECISION),
    "extra_key_in_objectives": ("OPTIMAL", 1, "solution_objectives_invalid", "solution_objectives_invalid"),
    "extra_key_in_component": ("OPTIMAL", 1, "objective_component_invalid", "objective_component_invalid"),
    "extra_key_in_violation": ("OPTIMAL", 1, "violation_invalid", "violation_invalid"),
    "provenance_not_an_object": ("OPTIMAL", 1, "provenance_invalid", "provenance_invalid"),
    # wrong shapes
    "solutions_not_an_array": ("UNKNOWN", 0, "solutions_missing", "solutions_missing"),
    "solution_not_an_object": ("UNKNOWN", 0, DECISION, DECISION),
    "decision_kind_not_binding": ("UNKNOWN", 0, DECISION, DECISION),
    "result_is_a_list": (None, None, "result_not_object", "result_not_object"),
}
ALTERED_CLAIMS = [
    "objective_penalty_and_score_altered",
    "objective_component_weight_and_loss_altered",
    "objective_type_altered",
    "objective_scalarization_altered",
    "features_altered",
    "penalties_altered",
    "violations_hidden",
    "nan_feature",
    "infinite_penalty",
    "nan_score",
    "nan_component_loss",
    "extra_key_in_result",
    "extra_key_in_solution",
    "extra_key_in_decision",
    "extra_key_in_objectives",
    "extra_key_in_component",
    "extra_key_in_violation",
]


@pytest.fixture(scope="module")
def root():
    path = corpus_root()
    if not (path / CORPUS_MARKER).is_file():
        pytest.skip(f"BIM corpus not available at {path} (set BIM_CORPUS_ROOT)")
    return path


@pytest.fixture(scope="module")
def problem(root):
    return compile_instance(load_package(root / DEMO))


@pytest.fixture(scope="module")
def built(baseline_tool, root):
    return baseline_tool.build_vectors_extra(root)


@pytest.fixture(scope="module")
def decoded(baseline_tool, root):
    """The inputs as Python values (with real NaN/Infinity), by id."""
    return {case["id"]: case for case in baseline_tool.extra_vector_inputs(root)}


@pytest.fixture(scope="module")
def vectors(built):
    return {item["id"]: item for item in built["vectors"]}


def test_every_vector_has_a_hand_written_expectation_and_the_reverse(vectors) -> None:
    assert sorted(vectors) == sorted(EXPECTED)
    assert len(vectors) == 49


@pytest.mark.parametrize("vector_id", sorted(EXPECTED))
def test_reevaluation_lowers_the_termination_and_keeps_only_authoritative_solutions(
    vector_id, vectors, decoded, problem
) -> None:
    termination, count, _, _ = EXPECTED[vector_id]
    case = decoded[vector_id]
    if termination is None:
        assert "reevaluate" not in vectors[vector_id]
        return
    arguments = (problem, case["result"], None) + (() if case["allowed"] is None else (case["allowed"],))
    result = reevaluate_result(*arguments)

    assert result["termination"] == termination
    assert len(result["solutions"]) == count
    assert set(result) == {"termination", "solutions", "provenance"}
    for solution in result["solutions"]:
        assert set(solution) == {"decision", "features", "objectives", "penalties", "violations"}
        assert all(math.isfinite(value) for value in solution["features"].values())
        assert math.isfinite(solution["objectives"]["penalty"])
        assert not any(entry.get("enforcement") == "hard" for entry in solution["violations"])


@pytest.mark.parametrize("vector_id", sorted(EXPECTED))
def test_validation_refuses_what_the_protocol_does_not_define(vector_id, decoded) -> None:
    _, _, code, finite_code = EXPECTED[vector_id]
    payload = decoded[vector_id]["result"]

    for options, expected in (({}, code), ({"finite": True}, finite_code)):
        if expected is None:
            assert validate_result(payload, **options) is payload
            continue
        with pytest.raises(ProtocolError) as caught:
            validate_result(payload, **options)
        assert caught.value.code == expected
        assert isinstance(caught.value, ValueError)


@pytest.mark.parametrize("vector_id", ALTERED_CLAIMS)
def test_whatever_the_engine_claims_the_solution_is_the_authoritative_one(vector_id, decoded, problem) -> None:
    honest = decoded["objective_penalty_and_score_altered"]["result"]["solutions"][0]
    binding = honest["decision"]["binding"]
    reference = reevaluate_result(
        problem,
        {"termination": "OPTIMAL", "solutions": [{"decision": {"kind": "binding", "binding": binding}}]},
        None,
        EVERYTHING,
    )["solutions"]
    case = decoded[vector_id]

    result = reevaluate_result(problem, case["result"], None, EVERYTHING)

    assert reference and result["solutions"] == [reference[0]] * len(result["solutions"])
    evaluation = problem.evaluate(binding)
    assert result["solutions"][0]["features"] == evaluation["features"]
    assert result["solutions"][0]["objectives"] == evaluation["objectives"]


def test_the_provenance_is_passed_through_untouched_even_if_it_is_not_finite(decoded, problem) -> None:
    # Documented limitation: provenance is opaque to the core.  A host that serializes it must use
    # allow_nan=False (the platform's strict parser never produces it) or validate_result(finite=True).
    result = reevaluate_result(problem, decoded["nan_in_provenance"]["result"], None, EVERYTHING)
    assert math.isnan(result["provenance"]["elapsed"])
    result = reevaluate_result(problem, decoded["provenance_not_an_object"]["result"], None, EVERYTHING)
    assert result["provenance"] == "synthetic"


def test_the_non_finite_encoding_round_trips(baseline_tool) -> None:
    value = {"a": [math.nan, math.inf, -math.inf, 1.5], "b": {"c": 2}}
    encoded = baseline_tool.encode_floats(value)

    assert encoded == {
        "a": [{"$float": "NaN"}, {"$float": "Infinity"}, {"$float": "-Infinity"}, 1.5],
        "b": {"c": 2},
    }
    decoded_value = baseline_tool.decode_floats(encoded)
    assert math.isnan(decoded_value["a"][0]) and decoded_value["a"][1:] == [math.inf, -math.inf, 1.5]
    baseline_tool.dump(encoded)  # strict JSON: no NaN is written


def test_the_vectors_are_pinned_in_the_golden(baseline_tool, built) -> None:
    check_or_create_golden(baseline_tool, EXTRA_GOLDEN, built)

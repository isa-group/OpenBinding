"""bim_core.reevaluate: an engine's claims are replaced by the canonical evaluation of its decisions."""

import copy
import json

import pytest

from bim_core import BindingProblem, compile_instance, evaluate, reevaluate_result
from bim_core.reevaluate import authoritative_evaluation, binding_violations, candidate_ref

from _language import BINDING, SAME_CATALOG_BINDING, base_package

ALL = ("OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN")
WEIGHTED = {
    "type": "SINGLE",
    "scalarization": "weighted-sum",
    "weights": [{"criteria": "latency", "value": 0.75}, {"criteria": "cost", "value": 0.25}],
}


def variant(**assertions):
    """The base package with the given constraint assertions replaced (``hard=...``, ``soft=...``)."""
    value = base_package()
    for name, assertion in assertions.items():
        document = json.loads(value.files[f"{name}.json"])
        document["spec"]["constraints"]["limit"]["assert"] = assertion
        value.files[f"{name}.json"] = json.dumps(document).encode()
    return compile_instance(value)


@pytest.fixture(scope="module")
def problem() -> BindingProblem:
    return compile_instance(base_package())


def solution(problem, binding, execution=None):
    evaluation = problem.evaluate(binding, execution)
    penalties = problem.document["spec"]["optimization"]["penalties"]
    return {
        "decision": {"kind": "binding", "binding": copy.deepcopy(binding)},
        "features": evaluation["features"],
        "objectives": evaluation["objectives"],
        "penalties": [0.0 for _ in penalties],
        "violations": evaluation["violations"],
    }


def answer(termination, *solutions, **extra):
    return {"termination": termination, "solutions": list(solutions), **extra}


# -- candidate_ref and binding_violations ---------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ({"resource": "cat-a", "id": "c1"}, ("cat-a", "c1")),
        ({"id": "c1", "resource": "cat-a"}, ("cat-a", "c1")),
        ({"resource": "cat-a", "id": ""}, ("cat-a", "")),
        ({"resource": "cat-a"}, None),
        ({"resource": "cat-a", "id": "c1", "extra": 1}, None),
        ({"resource": 1, "id": "c1"}, None),
        ({"resource": "cat-a", "id": None}, None),
        (["cat-a", "c1"], None),
        ("cat-a/c1", None),
        (None, None),
    ],
)
def test_candidate_ref_accepts_only_a_closed_reference_of_strings(value, expected) -> None:
    assert candidate_ref(value) == expected


def test_a_valid_binding_has_no_violations_and_an_invalid_one_has_one_hard_violation(problem) -> None:
    assert binding_violations(problem, BINDING) == []
    found = binding_violations(problem, {"t1": BINDING["t1"]})

    assert [(item["code"], item["enforcement"]) for item in found] == [("binding_invalid", "hard")]
    assert "missing=['t2']" in found[0]["message"]


# -- authoritative_evaluation ----------------------------------------------------------------------


def test_authoritative_evaluation_is_the_canonical_evaluation(problem) -> None:
    evaluation = evaluate(problem, BINDING, WEIGHTED)

    features, objectives, violations = authoritative_evaluation(problem, BINDING, WEIGHTED)

    assert (features, objectives, violations) == (
        evaluation["features"], evaluation["objectives"], evaluation["violations"],
    )
    assert (objectives["type"], objectives["scalarization"]) == ("SINGLE", "weighted-sum")


def test_without_an_execution_selection_the_default_is_a_single_equal_weight_sum(problem) -> None:
    _, objectives, _ = authoritative_evaluation(problem, BINDING)

    assert (objectives["type"], objectives["scalarization"]) == ("SINGLE", "weighted-sum")
    assert [item["weight"] for item in objectives["components"]] == [0.5, 0.5]


def test_an_invalid_binding_yields_zero_features_no_objectives_and_a_hard_violation(problem) -> None:
    features, objectives, violations = authoritative_evaluation(problem, {})

    assert features == {"latency": 0.0, "cost": 0.0}
    assert objectives == {}
    assert [(item["code"], item["enforcement"]) for item in violations] == [("binding_invalid", "hard")]


@pytest.mark.parametrize("failure", [ZeroDivisionError("x"), KeyError("k"), TypeError("t"), ValueError("v")])
def test_a_binding_that_cannot_be_evaluated_is_a_hard_violation_not_an_exception(problem, monkeypatch, failure) -> None:
    def broken(self, binding, execution=None):
        raise failure

    monkeypatch.setattr(BindingProblem, "evaluate", broken)

    features, objectives, violations = authoritative_evaluation(problem, BINDING)

    assert features == {"latency": 0.0, "cost": 0.0} and objectives == {}
    assert violations == [{"code": "binding_evaluation", "message": str(failure), "enforcement": "hard"}]


def test_a_bug_in_the_evaluator_is_not_swallowed(problem, monkeypatch) -> None:
    def broken(self, binding, execution=None):
        raise RuntimeError("bug")

    monkeypatch.setattr(BindingProblem, "evaluate", broken)

    with pytest.raises(RuntimeError):
        authoritative_evaluation(problem, BINDING)


# -- reevaluate_result -----------------------------------------------------------------------------


def test_an_honest_answer_comes_back_unchanged_in_content(problem) -> None:
    honest = solution(problem, BINDING, WEIGHTED)

    result = reevaluate_result(problem, answer("OPTIMAL", honest, provenance={"engine": "x"}), WEIGHTED, ALL)

    assert result == {"termination": "OPTIMAL", "solutions": [honest], "provenance": {"engine": "x"}}


def test_every_qos_field_the_engine_sent_is_replaced(problem) -> None:
    lying = solution(problem, BINDING)
    lying["features"] = {"latency": 0.0, "cost": 0.0, "invented": 1.0}
    lying["objectives"]["score"] = -1e9
    lying["objectives"]["penalty"] = 0.0
    lying["penalties"] = [42.0]
    lying["violations"] = []

    result = reevaluate_result(problem, answer("OPTIMAL", lying), None, ALL)

    assert result["solutions"] == [solution(problem, BINDING)]
    assert "invented" not in result["solutions"][0]["features"]


def test_the_answer_is_not_modified(problem) -> None:
    received = answer("OPTIMAL", solution(problem, BINDING), provenance={"a": [1]})
    before = copy.deepcopy(received)

    reevaluate_result(problem, received, None, ALL)

    assert received == before


def test_missing_provenance_is_an_empty_object(problem) -> None:
    assert reevaluate_result(problem, answer("UNKNOWN"))["provenance"] == {}


@pytest.mark.parametrize(
    ("termination", "allowed", "expected"),
    [
        ("FEASIBLE", None, "FEASIBLE"),
        ("UNKNOWN", None, "UNKNOWN"),
        ("OPTIMAL", None, "UNKNOWN"),
        ("INFEASIBLE", None, "UNKNOWN"),
        ("OPTIMAL", ["OPTIMAL"], "OPTIMAL"),
        ("OPTIMAL", ("OPTIMAL", "FEASIBLE"), "OPTIMAL"),
        ("OPTIMAL", {"OPTIMAL"}, "OPTIMAL"),
        ("OPTIMAL", [], "UNKNOWN"),
        ("FEASIBLE", ["OPTIMAL"], "UNKNOWN"),
        ("OPTIMAL", ["SOMETIMES", "OPTIMAL"], "OPTIMAL"),
        ("OPTIMAL", ["SOMETIMES"], "UNKNOWN"),
        ("optimal", ALL, "UNKNOWN"),
        (None, ALL, "UNKNOWN"),
        (1, ALL, "UNKNOWN"),
    ],
)
def test_a_termination_is_never_stronger_than_what_the_mode_declares(problem, termination, allowed, expected) -> None:
    received = answer(termination, solution(problem, BINDING))
    arguments = (problem, received, None) + (() if allowed is None else (allowed,))

    assert reevaluate_result(*arguments)["termination"] == expected


def test_a_claim_of_solution_without_a_solution_is_unknown(problem) -> None:
    for termination in ("OPTIMAL", "FEASIBLE"):
        assert reevaluate_result(problem, answer(termination), None, ALL)["termination"] == "UNKNOWN"
    assert reevaluate_result(problem, answer("INFEASIBLE"), None, ALL)["termination"] == "INFEASIBLE"


def test_a_claim_of_infeasibility_with_a_solution_is_unknown(problem) -> None:
    received = answer("INFEASIBLE", solution(problem, BINDING))

    result = reevaluate_result(problem, received, None, ALL)

    assert result["termination"] == "UNKNOWN" and len(result["solutions"]) == 1


@pytest.mark.parametrize(
    "decision",
    [
        {"kind": "plan", "binding": BINDING},
        {"kind": "binding"},
        {"kind": "binding", "binding": []},
        {"kind": "binding", "binding": {"t1": "cat-a/c1", "t2": "cat-b/c1"}},
        {"kind": "binding", "binding": {"t1": {"resource": "cat-a", "id": "c1", "x": 1}, "t2": BINDING["t2"]}},
        {"kind": "binding", "binding": {"t1": {"resource": "cat-a", "id": 3}, "t2": BINDING["t2"]}},
        "binding",
        None,
    ],
)
def test_a_decision_that_is_not_a_closed_binding_drops_the_solution_and_the_termination(problem, decision) -> None:
    received = answer("FEASIBLE", {"decision": decision})

    result = reevaluate_result(problem, received, None, ALL)

    assert result["solutions"] == [] and result["termination"] == "UNKNOWN"


@pytest.mark.parametrize("item", [1, "x", None, [], {}, {"decision": {}}])
def test_a_solution_that_is_not_an_object_with_a_decision_is_dropped(problem, item) -> None:
    result = reevaluate_result(problem, {"termination": "FEASIBLE", "solutions": [item]}, None, ALL)

    assert result["solutions"] == [] and result["termination"] == "UNKNOWN"


@pytest.mark.parametrize("solutions", [None, "x", {"0": 1}, 3])
def test_solutions_that_are_not_an_array_count_as_none(problem, solutions) -> None:
    result = reevaluate_result(problem, {"termination": "FEASIBLE", "solutions": solutions}, None, ALL)

    assert result["solutions"] == [] and result["termination"] == "UNKNOWN"


def test_one_ineligible_binding_poisons_the_termination_but_not_the_valid_solutions(problem) -> None:
    ineligible = solution(problem, BINDING)
    ineligible["decision"]["binding"]["t1"] = {"resource": "cat-b", "id": "zzz"}

    result = reevaluate_result(problem, answer("FEASIBLE", solution(problem, BINDING), ineligible), None, ALL)

    assert [item["decision"]["binding"] for item in result["solutions"]] == [BINDING]
    assert result["termination"] == "UNKNOWN"


def test_a_binding_with_a_hard_violation_is_kept_but_makes_the_termination_unknown() -> None:
    problem = variant(hard="features.latency <= 30")
    received = answer("OPTIMAL", solution(problem, BINDING))

    result = reevaluate_result(problem, received, None, ALL)

    assert result["termination"] == "UNKNOWN"
    assert [item["enforcement"] for item in result["solutions"][0]["violations"]] == ["hard"]


def test_a_binding_that_respects_the_hard_constraint_keeps_its_termination() -> None:
    problem = variant(hard="features.latency <= 30")

    result = reevaluate_result(problem, answer("OPTIMAL", solution(problem, SAME_CATALOG_BINDING)), None, ALL)

    assert result["termination"] == "OPTIMAL"


def test_penalties_follow_the_optimization_not_the_engine() -> None:
    problem = variant(soft="tasks.t1.provider.resource == 'never'")
    received = answer("FEASIBLE", solution(problem, BINDING))
    received["solutions"][0]["penalties"] = [0.0]

    result = reevaluate_result(problem, received, None, ALL)

    (kept,) = result["solutions"]
    assert kept["penalties"] == [2.0]
    assert kept["objectives"]["penalty"] == 2.0
    assert [(item["enforcement"], item["penalty"]) for item in kept["violations"]] == [("soft", 2.0)]
    assert result["termination"] == "FEASIBLE"


def test_the_execution_selection_decides_the_objectives(problem) -> None:
    received = answer("FEASIBLE", solution(problem, BINDING))

    default = reevaluate_result(problem, received, None, ALL)["solutions"][0]["objectives"]
    weighted = reevaluate_result(problem, received, WEIGHTED, ALL)["solutions"][0]["objectives"]

    assert [item["weight"] for item in default["components"]] == [0.5, 0.5]
    assert [item["weight"] for item in weighted["components"]] == [0.75, 0.25]
    assert default["score"] != weighted["score"]

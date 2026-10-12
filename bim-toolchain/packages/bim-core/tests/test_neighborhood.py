"""bim_core.neighborhood: real canonical counterfactuals, bounded coverage.

The corpus-based tests come from ``openbinding-gateway/tests/test_binding_analysis.py`` (the endpoint test of that
file stays in OpenBinding); the others use a small package and need no corpus.
"""

import copy

import pytest

from bim_core import BindingProblem, EvaluationError, analyze_neighborhood, compile_instance, load_package
from core_support import require_corpus_path

from _language import BINDING, base_package

NAN = float("nan")


def problem_and_binding(example="17_analysis_tradeoffs"):
    problem = compile_instance(load_package(require_corpus_path(f"examples/demo/{example}")))
    binding = {task: refs[0] for task, refs in problem.document["spec"]["eligibility"].items()}
    return problem, binding


@pytest.fixture(scope="module")
def small() -> BindingProblem:
    return compile_instance(base_package())


# -- migrated from OpenBinding -------------------------------------------------------------------


@pytest.mark.parametrize("example", ["17_analysis_tradeoffs", "18_analysis_constraints", "19_analysis_journey"])
def test_each_move_is_a_real_single_task_canonical_evaluation(example):
    problem, binding = problem_and_binding(example)
    original = copy.deepcopy(binding)
    result = analyze_neighborhood(problem, binding)
    assert binding == original
    assert result["coverage"]["complete"]
    assert result["coverage"]["total"] == 10
    for move in result["moves"]:
        changed = move["decision"]["binding"]
        assert sum(changed[t] != binding[t] for t in binding) == 1
        evaluation = problem.evaluate(changed)
        assert move["objectives"] == evaluation["objectives"]
        assert move["violations"] == evaluation["violations"]
        assert move["feasible"] == (not any(v["enforcement"] == "hard" for v in evaluation["violations"]))
        for delta, base, new in zip(move["componentDeltas"], result["base"]["objectives"]["components"], move["objectives"]["components"], strict=True):
            assert delta["loss"] == new["loss"] - base["loss"]


def test_partial_and_empty_coverage_never_claims_unchecked_local_optimality():
    problem, binding = problem_and_binding()
    result = analyze_neighborhood(problem, binding, limit=1)
    assert result["coverage"]["evaluated"] == 1
    assert not result["coverage"]["complete"]
    assert result["coverage"]["stopReason"] == "evaluation-limit"
    assert "unchecked" in result["conclusion"]
    timed = analyze_neighborhood(problem, binding, seconds=0)
    assert timed["coverage"]["evaluated"] == 0
    assert timed["coverage"]["stopReason"] == "time-budget"
    task = next(iter(binding))
    only = analyze_neighborhood(problem, binding, task=task)
    assert only["coverage"]["total"] == 5
    assert all(m["task"] == task for m in only["moves"])
    document = copy.deepcopy(problem.document)
    document["spec"]["eligibility"] = {t: [ref, ref] for t, ref in binding.items()}
    singleton = analyze_neighborhood(BindingProblem(document, problem.digest, {}), binding)
    assert singleton["coverage"]["total"] == 0
    assert singleton["coverage"]["complete"]
    assert "no eligible" in singleton["conclusion"]
    with pytest.raises(ValueError):
        analyze_neighborhood(problem, binding, task="unknown")
    with pytest.raises(ValueError):
        analyze_neighborhood(problem, binding, limit=129)


def test_failed_evaluations_are_not_counted_as_complete(monkeypatch):
    problem, binding = problem_and_binding()
    original = BindingProblem.evaluate

    def evaluate(self, candidate, execution=None):
        if candidate != binding:
            raise ValueError("Undefined metric")
        return original(self, candidate, execution)

    monkeypatch.setattr(BindingProblem, "evaluate", evaluate)
    result = analyze_neighborhood(problem, binding)
    assert result["coverage"]["attempted"] == result["coverage"]["total"] == 10
    assert result["coverage"]["evaluated"] == 0
    assert not result["coverage"]["complete"]
    assert len(result["failures"]) == 10


@pytest.mark.parametrize("objective_type, scalarization", [
    ("SINGLE", "weighted-sum"),
    ("SINGLE", "lexicographic"),
    ("SINGLE", "feasibility"),
    ("MULTI", "pareto"),
    ("MANY", "pareto"),
])
def test_comparison_respects_execution_optimization(objective_type, scalarization):
    problem, binding = problem_and_binding()
    criteria = [item["id"] for item in problem.document["spec"]["optimization"]["criteria"]]
    # Unequal weights: the default equal-weight evaluation would order moves differently.
    weights = [{"criteria": criterion, "value": 2.0 ** -(index + 1)} for index, criterion in enumerate(criteria)]
    execution = {"type": objective_type, "scalarization": scalarization, "weights": weights}
    result = analyze_neighborhood(problem, binding, execution=execution)
    assert result["moves"]
    for objectives in [result["base"]["objectives"], *(move["objectives"] for move in result["moves"])]:
        assert (objectives["type"], objectives["scalarization"]) == (objective_type, scalarization)
    for move in result["moves"]:
        a, b = move["objectives"]["score"], result["base"]["objectives"]["score"]
        if objective_type in {"MULTI", "MANY"}:
            expected = "equal" if a == b else "better" if all(x <= y for x, y in zip(a, b, strict=True)) else "worse" if all(x >= y for x, y in zip(a, b, strict=True)) else "trade-off"
        else:
            expected = "better" if a < b else "worse" if a > b else "equal"
        assert move["comparison"] == expected


def test_default_comparison_without_execution_is_single_equal_weight():
    problem, binding = problem_and_binding()
    result = analyze_neighborhood(problem, binding)
    assert (result["base"]["objectives"]["type"], result["base"]["objectives"]["scalarization"]) == ("SINGLE", "weighted-sum")
    assert all(isinstance(move["objectives"]["score"], float) for move in result["moves"])


def test_infeasible_base_is_repaired_only_by_a_feasible_substitution():
    problem, binding = problem_and_binding("18_analysis_constraints")
    for task, refs in problem.document["spec"]["eligibility"].items():
        binding[task] = next(ref for ref in refs if ref["id"] == "overloaded")
    result = analyze_neighborhood(problem, binding)
    assert not result["base"]["feasible"]
    assert any(move["comparison"] == "repairs-feasibility" for move in result["moves"])
    assert all(move["comparison"] == ("repairs-feasibility" if move["feasible"] else "infeasible") for move in result["moves"])


# -- without the corpus ------------------------------------------------------------------------------


def test_every_eligible_one_task_substitution_is_evaluated(small) -> None:
    result = analyze_neighborhood(small, BINDING)

    assert result["kind"] == "canonical-one-task-counterfactuals"
    assert result["irDigest"] == small.digest
    assert (result["scope"], result["task"]) == ("all-service-tasks", None)
    assert result["coverage"] == {
        "total": 2, "attempted": 2, "evaluated": 2, "complete": True,
        "limit": 64, "stopReason": None, "perTask": {"t1": 1, "t2": 1},
    }
    assert [(move["task"], move["to"]) for move in result["moves"]] == [
        ("t1", {"resource": "cat-b", "id": "c1"}),
        ("t2", {"resource": "cat-a", "id": "c1"}),
    ]
    assert result["failures"] == []
    assert result["conclusion"] == (
        "Found 2 feasible canonical improvements or feasibility repairs. "
        "Every eligible one-task move in this scope was evaluated."
    )


def test_the_base_is_the_canonical_evaluation_of_the_normalized_binding(small) -> None:
    result = analyze_neighborhood(small, {"t2": dict(BINDING["t2"]), "t1": dict(BINDING["t1"])})

    assert result["base"] == {
        "decision": {"kind": "binding", "binding": BINDING},
        **small.evaluate(BINDING),
        "feasible": True,
    }


def test_each_move_reports_the_change_against_the_base(small) -> None:
    result = analyze_neighborhood(small, BINDING)
    first, second = result["moves"]

    assert first["from"] == BINDING["t1"] and first["comparison"] == "better" and first["feasible"] is True
    assert [item["value"] for item in first["componentDeltas"]] == pytest.approx([10.0, -5.0])
    assert [item["loss"] for item in first["componentDeltas"]] == pytest.approx([0.1, -0.25])
    assert first["penaltyDelta"] == 0.0
    assert first["decision"] == {"kind": "binding", "binding": {**BINDING, "t1": {"resource": "cat-b", "id": "c1"}}}
    assert second["comparison"] == "better"
    assert first["componentDeltas"][0]["feature"] == {"resource": "app", "id": "latency"}


def test_a_selected_task_restricts_the_scope(small) -> None:
    result = analyze_neighborhood(small, BINDING, task="t2")

    assert (result["scope"], result["task"]) == ("selected-service-task", "t2")
    assert [move["task"] for move in result["moves"]] == ["t2"]
    assert result["coverage"]["perTask"] == {"t2": 1}


def test_the_time_budget_is_a_parameter(small) -> None:
    result = analyze_neighborhood(small, BINDING, seconds=0)

    assert result["moves"] == [] and result["failures"] == []
    assert result["coverage"]["stopReason"] == "time-budget" and not result["coverage"]["complete"]


def test_the_limit_stops_the_analysis_and_says_so(small) -> None:
    result = analyze_neighborhood(small, BINDING, limit=1)

    assert (result["coverage"]["attempted"], result["coverage"]["stopReason"]) == (1, "evaluation-limit")
    assert "Coverage is incomplete" in result["conclusion"]


@pytest.mark.parametrize("limit", [0, -1, 129, 1000])
def test_the_limit_is_between_one_and_128(small, limit) -> None:
    with pytest.raises(EvaluationError) as caught:
        analyze_neighborhood(small, BINDING, limit=limit)

    assert caught.value.code == "neighborhood_limit" and isinstance(caught.value, ValueError)
    assert str(caught.value) == "The evaluation limit must be between 1 and 128"


@pytest.mark.parametrize("limit", [1, 128])
def test_the_extremes_of_the_limit_are_valid(small, limit) -> None:
    assert analyze_neighborhood(small, BINDING, limit=limit)["coverage"]["limit"] == limit


@pytest.mark.parametrize("task", ["unknown", "local", ""])
def test_the_selected_task_must_be_a_service_task_of_the_binding(small, task) -> None:
    with pytest.raises(EvaluationError) as caught:
        analyze_neighborhood(small, BINDING, task=task)

    assert caught.value.code == "task_not_bound"
    assert str(caught.value) == "The selected task is not a bound service task"


@pytest.mark.parametrize("binding", [{}, {"t1": BINDING["t1"]}, [], {**BINDING, "t1": {"resource": "x", "id": "y"}}])
def test_an_invalid_binding_is_refused_before_anything_is_evaluated(small, binding) -> None:
    with pytest.raises(EvaluationError) as caught:
        analyze_neighborhood(small, binding)

    assert caught.value.code == "binding_invalid"


def test_the_limit_is_checked_before_the_binding(small) -> None:
    with pytest.raises(EvaluationError) as caught:
        analyze_neighborhood(small, {}, limit=0)

    assert caught.value.code == "neighborhood_limit"


def test_the_binding_is_not_modified(small) -> None:
    binding = copy.deepcopy(BINDING)

    analyze_neighborhood(small, binding)

    assert binding == BINDING


def test_a_base_with_non_finite_data_is_refused(small, monkeypatch) -> None:
    original = BindingProblem.evaluate

    def poisoned(self, binding, execution=None):
        result = original(self, binding, execution)
        result["objectives"]["score"] = NAN
        return result

    monkeypatch.setattr(BindingProblem, "evaluate", poisoned)

    with pytest.raises(EvaluationError) as caught:
        analyze_neighborhood(small, BINDING)

    assert caught.value.code == "non_finite_evaluation"


def test_a_move_with_non_finite_data_is_a_failure_not_a_move(small, monkeypatch) -> None:
    original = BindingProblem.evaluate

    def poisoned(self, binding, execution=None):
        result = original(self, binding, execution)
        if binding != BINDING:
            result["objectives"]["penalty"] = NAN
        return result

    monkeypatch.setattr(BindingProblem, "evaluate", poisoned)

    result = analyze_neighborhood(small, BINDING)

    assert result["moves"] == []
    assert [item["message"] for item in result["failures"]] == ["Non-finite evaluation data"] * 2
    assert result["coverage"]["complete"] is False


@pytest.mark.parametrize("failure", [ArithmeticError("overflow"), ZeroDivisionError("x"), ValueError("y")])
def test_arithmetic_and_value_errors_of_a_move_are_failures(small, monkeypatch, failure) -> None:
    original = BindingProblem.evaluate

    def flaky(self, binding, execution=None):
        if binding != BINDING:
            raise failure
        return original(self, binding, execution)

    monkeypatch.setattr(BindingProblem, "evaluate", flaky)

    result = analyze_neighborhood(small, BINDING)

    assert len(result["failures"]) == 2 and result["moves"] == []
    assert {item["message"] for item in result["failures"]} == {str(failure)}


def test_a_bug_in_the_evaluator_is_not_reported_as_a_failed_move(small, monkeypatch) -> None:
    original = BindingProblem.evaluate

    def buggy(self, binding, execution=None):
        if binding != BINDING:
            raise KeyError("missing feature")
        return original(self, binding, execution)

    monkeypatch.setattr(BindingProblem, "evaluate", buggy)

    with pytest.raises(KeyError):
        analyze_neighborhood(small, BINDING)


def test_a_long_failure_message_is_truncated(small, monkeypatch) -> None:
    original = BindingProblem.evaluate

    def verbose(self, binding, execution=None):
        if binding != BINDING:
            raise ValueError("x" * 1000)
        return original(self, binding, execution)

    monkeypatch.setattr(BindingProblem, "evaluate", verbose)

    assert {len(item["message"]) for item in analyze_neighborhood(small, BINDING)["failures"]} == {300}

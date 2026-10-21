"""bim_core.evaluator: the public API of the canonical evaluator and its error contract."""

import copy
from types import MappingProxyType

import pytest

from bim_core import BindingProblem, EvaluationError, compile_instance, evaluate, evaluate_many, validate_binding
from bim_core import evaluator

from _language import BINDING, SAME_CATALOG_BINDING, base_package

EXECUTION = {
    "type": "SINGLE",
    "scalarization": "weighted-sum",
    "weights": [{"criteria": "latency", "value": 0.75}, {"criteria": "cost", "value": 0.25}],
}


@pytest.fixture(scope="module")
def problem() -> BindingProblem:
    return compile_instance(base_package())


def test_a_valid_binding_is_normalized_to_closed_references(problem) -> None:
    messy = {"t2": {"id": "c1", "resource": "cat-b"}, "t1": MappingProxyType({"resource": "cat-a", "id": "c1"})}

    assert validate_binding(problem, messy) == BINDING
    assert validate_binding(problem, MappingProxyType(BINDING)) == BINDING


@pytest.mark.parametrize(
    ("binding", "reason"),
    [
        (["t1", "t2"], "binding must be an object"),
        (None, "binding must be an object"),
        ({}, "missing=['t1', 't2']"),
        ({"t1": BINDING["t1"]}, "missing=['t2']"),
        ({**BINDING, "local": BINDING["t1"]}, "extra=['local']"),
        ({**BINDING, "t3": BINDING["t1"]}, "extra=['t3']"),
        ({**BINDING, "t1": "cat-a/c1"}, "must be {resource,id}"),
        ({**BINDING, "t1": {"resource": "cat-a"}}, "must be {resource,id}"),
        ({**BINDING, "t1": {"resource": "cat-a", "id": 1}}, "must be {resource,id}"),
        ({**BINDING, "t1": {"resource": "cat-a", "id": "c1", "extra": 1}}, "must be {resource,id}"),
        ({**BINDING, "t1": {"resource": "cat-a", "id": "nope"}}, "not eligible"),
        ({**BINDING, "t1": {"resource": "cat-z", "id": "c1"}}, "not eligible"),
    ],
)
def test_an_invalid_binding_is_an_evaluation_error_with_the_platform_message(problem, binding, reason) -> None:
    with pytest.raises(EvaluationError) as caught:
        validate_binding(problem, binding)

    error = caught.value
    assert error.code == "binding_invalid"
    assert isinstance(error, ValueError)
    assert reason in str(error) and error.message == str(error)
    # The method keeps raising what it always raised, with the same words.
    with pytest.raises(ValueError) as original:
        problem.validate_binding(binding)
    assert type(original.value) is ValueError
    assert str(original.value) == str(error)
    assert isinstance(error.__cause__, ValueError)
    assert error.as_dict() == {"code": "binding_invalid", "message": str(error)}


def test_evaluate_is_the_canonical_evaluation(problem) -> None:
    assert evaluate(problem, BINDING) == problem.evaluate(BINDING)
    assert evaluate(problem, SAME_CATALOG_BINDING, EXECUTION) == problem.evaluate(SAME_CATALOG_BINDING, EXECUTION)
    result = evaluate(problem, BINDING)
    assert set(result) == {"features", "metrics", "violations", "objectives"}
    assert result["features"] == {"latency": 50.0, "cost": 12.0}


def test_the_binding_is_not_modified(problem) -> None:
    binding = copy.deepcopy(BINDING)

    evaluate(problem, binding, EXECUTION)

    assert binding == BINDING


def test_the_parts_of_an_evaluation_can_be_asked_for_separately(problem) -> None:
    features = evaluator.evaluate_features(problem, BINDING)
    violations = evaluator.evaluate_violations(problem, BINDING, features)
    objectives = evaluator.evaluate_objectives(problem, features, violations, EXECUTION)

    whole = evaluate(problem, BINDING, EXECUTION)
    assert (features, violations, objectives) == (whole["features"], whole["violations"], whole["objectives"])
    assert evaluator.evaluate_violations(problem, BINDING) == violations


@pytest.mark.parametrize("part", ["features", "violations"])
def test_every_part_validates_the_binding_first(problem, part) -> None:
    function = getattr(evaluator, f"evaluate_{part}")

    with pytest.raises(EvaluationError) as caught:
        function(problem, {"t1": BINDING["t1"]})

    assert caught.value.code == "binding_invalid"


@pytest.mark.parametrize("failure", [ZeroDivisionError("division by zero"), KeyError("latency"), TypeError("bad operand"), ValueError("not finite")])
def test_a_failure_while_evaluating_is_an_evaluation_error(problem, monkeypatch, failure) -> None:
    def broken(self, binding, execution=None):
        raise failure

    monkeypatch.setattr(BindingProblem, "evaluate", broken)

    with pytest.raises(EvaluationError) as caught:
        evaluate(problem, BINDING)

    assert caught.value.code == "evaluation_failed"
    assert caught.value.__cause__ is failure
    assert str(caught.value) == str(failure)
    assert isinstance(caught.value, ValueError)


def test_a_bug_is_not_disguised_as_an_evaluation_error(problem, monkeypatch) -> None:
    def broken(self, binding, execution=None):
        raise RuntimeError("bug")

    monkeypatch.setattr(BindingProblem, "evaluate", broken)

    with pytest.raises(RuntimeError, match="bug"):
        evaluate(problem, BINDING)


def test_an_evaluation_error_raised_inside_is_not_wrapped_twice(problem, monkeypatch) -> None:
    inner = EvaluationError("custom", "already ours")

    def broken(self, binding, execution=None):
        raise inner

    monkeypatch.setattr(BindingProblem, "evaluate", broken)

    with pytest.raises(EvaluationError) as caught:
        evaluate(problem, BINDING)

    assert caught.value is inner


def test_objectives_without_the_feature_they_need_fail_as_an_evaluation_error(problem) -> None:
    with pytest.raises(EvaluationError) as caught:
        evaluator.evaluate_objectives(problem, {"latency": 1.0}, [])

    assert caught.value.code == "evaluation_failed"


def test_evaluate_many_keeps_the_order(problem) -> None:
    results = evaluate_many(problem, [BINDING, SAME_CATALOG_BINDING], EXECUTION)

    assert results == [problem.evaluate(BINDING, EXECUTION), problem.evaluate(SAME_CATALOG_BINDING, EXECUTION)]
    assert evaluate_many(problem, []) == []
    assert evaluate_many(problem, iter([BINDING])) == [problem.evaluate(BINDING)]


def test_evaluate_many_raises_on_the_first_failure_by_default(problem) -> None:
    with pytest.raises(EvaluationError) as caught:
        evaluate_many(problem, [BINDING, {"t1": BINDING["t1"]}, SAME_CATALOG_BINDING])

    assert caught.value.code == "binding_invalid"


def test_evaluate_many_can_collect_failures_next_to_the_successes(problem) -> None:
    results = evaluate_many(
        problem, [BINDING, {"t1": BINDING["t1"]}, SAME_CATALOG_BINDING], on_error="collect"
    )

    assert [isinstance(item, EvaluationError) for item in results] == [False, True, False]
    assert results[0] == problem.evaluate(BINDING)
    assert results[1].code == "binding_invalid"
    assert results[2] == problem.evaluate(SAME_CATALOG_BINDING)


def test_evaluate_many_refuses_an_unknown_error_mode(problem) -> None:
    with pytest.raises(EvaluationError) as caught:
        evaluate_many(problem, [BINDING], on_error="ignore")  # type: ignore[arg-type]

    assert caught.value.code == "evaluation_input_invalid"


def test_evaluation_is_deterministic_and_independent_of_the_input_order(problem) -> None:
    reordered = {"t2": BINDING["t2"], "t1": BINDING["t1"]}

    assert evaluate(problem, reordered) == evaluate(problem, BINDING)
    assert evaluate(problem, BINDING) == evaluate(problem, BINDING)

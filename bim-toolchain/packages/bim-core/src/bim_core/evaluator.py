"""Public API of the canonical evaluator.

The evaluation semantics (aggregation operators, workflow folding, constraints, objectives,
placement) live in :class:`bim_core.compiler.BindingProblem`: they share its private helpers
(candidate lookup, expression evaluation, placement) and moving them would not change one byte
of behaviour while it would put the compiler and the evaluator in a circular import.  This module
is the stable entry point instead.  It adds no semantics: every function validates the binding
and delegates to the corresponding ``BindingProblem`` method, and turns the failures of an
invalid binding or of an evaluation into :class:`EvaluationError`.

``EvaluationError`` derives from ``ValueError``, so callers that caught ``ValueError`` keep
working.  The ``BindingProblem`` methods themselves are unchanged and still raise ``ValueError``
(and ``KeyError``/``TypeError``/``ArithmeticError``) because the baseline in
``golden/bim_baseline`` records those type names.

Codes of the errors raised here:

``binding_invalid``
    The binding is not an object, does not cover exactly the service tasks, has a malformed
    reference or references a candidate that is not eligible.
``evaluation_failed``
    A valid binding could not be evaluated (non-finite number, interval where a scalar is
    required, unknown aggregation operator, expression error, ...).
``evaluation_input_invalid``
    An argument of the evaluator API itself is invalid (for example an unknown ``on_error`` mode).
"""

from __future__ import annotations

from typing import Any, Iterable, Literal, Mapping

from .compiler import BindingProblem
from .errors import EvaluationError

#: What an invalid binding raises inside ``BindingProblem.validate_binding``.
_VALIDATION_FAILURES = (KeyError, TypeError, ValueError)
#: What evaluating a valid binding may raise.
_EVALUATION_FAILURES = (ArithmeticError, KeyError, TypeError, ValueError)


def _failure(code: str, exc: BaseException) -> EvaluationError:
    return EvaluationError(code, str(exc))


def validate_binding(problem: BindingProblem, binding: Mapping[str, Any]) -> dict[str, dict[str, str]]:
    """The canonical form of ``binding`` (``{task: {resource, id}}``), or :class:`EvaluationError`.

    The binding must contain exactly the service tasks of the problem and, for each of them, a
    ``{resource, id}`` reference to a candidate that is eligible for the task.
    """
    try:
        return problem.validate_binding(binding)
    except EvaluationError:
        raise
    except _VALIDATION_FAILURES as exc:
        raise _failure("binding_invalid", exc) from exc


def evaluate_features(problem: BindingProblem, binding: Mapping[str, Any]) -> dict[str, float]:
    """The value of every required feature (plus placement overrides) for ``binding``."""
    normalized = validate_binding(problem, binding)
    try:
        return problem.evaluate_binding(normalized)
    except EvaluationError:
        raise
    except _EVALUATION_FAILURES as exc:
        raise _failure("evaluation_failed", exc) from exc


def evaluate_violations(
    problem: BindingProblem,
    binding: Mapping[str, Any],
    features: Mapping[str, float] | None = None,
) -> list[dict[str, Any]]:
    """The constraint and placement violations of ``binding`` (``constraint``, ``enforcement``, ``penalty``)."""
    normalized = validate_binding(problem, binding)
    try:
        return problem.evaluate_constraints(normalized, features)
    except EvaluationError:
        raise
    except _EVALUATION_FAILURES as exc:
        raise _failure("evaluation_failed", exc) from exc


def evaluate_objectives(
    problem: BindingProblem,
    features: Mapping[str, float],
    violations: list[dict[str, Any]],
    execution: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The objective evaluation (``type``, ``scalarization``, ``components``, ``penalty``, ``score``).

    ``execution`` is the execution-time selection (``type``, ``scalarization``, ``weights``);
    without it the default is a single equal-weight weighted sum.
    """
    try:
        return problem.evaluate_objectives(features, violations, execution)
    except EvaluationError:
        raise
    except _EVALUATION_FAILURES as exc:
        raise _failure("evaluation_failed", exc) from exc


def evaluate(
    problem: BindingProblem,
    binding: Mapping[str, Any],
    execution: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The canonical evaluation of one binding: ``features``, ``metrics``, ``violations``, ``objectives``.

    Raises :class:`EvaluationError` (``binding_invalid`` or ``evaluation_failed``); never returns a
    partial result.
    """
    normalized = validate_binding(problem, binding)
    try:
        return problem.evaluate(normalized, execution)
    except EvaluationError:
        raise
    except _EVALUATION_FAILURES as exc:
        raise _failure("evaluation_failed", exc) from exc


def evaluate_many(
    problem: BindingProblem,
    bindings: Iterable[Mapping[str, Any]],
    execution: Mapping[str, Any] | None = None,
    *,
    on_error: Literal["raise", "collect"] = "raise",
) -> list[dict[str, Any] | EvaluationError]:
    """Evaluate each binding in order.

    With ``on_error="raise"`` (the default) the first failure is raised.  With ``"collect"`` the
    result keeps one entry per binding and a failed binding is represented by its
    :class:`EvaluationError`, so one bad binding does not hide the others.
    """
    if on_error not in ("raise", "collect"):
        raise EvaluationError("evaluation_input_invalid", f"on_error must be 'raise' or 'collect', not {on_error!r}")
    results: list[dict[str, Any] | EvaluationError] = []
    for binding in bindings:
        try:
            results.append(evaluate(problem, binding, execution))
        except EvaluationError as exc:
            if on_error == "raise":
                raise
            results.append(exc)
    return results

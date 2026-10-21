"""Authoritative re-evaluation of an engine result.

An engine returns decisions together with the
QoS it claims for them; none of those claims is trusted.  Each decision is re-evaluated against the
canonical IR with the canonical evaluator and only the binding survives from the engine's answer.
The termination is then lowered, never raised, to what the re-evaluation and the mode's declared
guarantees allow.
"""

from __future__ import annotations

from typing import Any, Mapping

from .compiler import BindingProblem
from .errors import EvaluationError
from .evaluator import evaluate, validate_binding
from .protocol import is_termination

#: Terminations a mode may be trusted with when it declares nothing else.
DEFAULT_TERMINATIONS = ("FEASIBLE", "UNKNOWN")


def candidate_ref(value: Any) -> tuple[str, str] | None:
    """``(resource, id)`` of a closed ``{resource, id}`` reference with string members, else ``None``."""
    if not isinstance(value, dict) or set(value) != {"resource", "id"}:
        return None
    if not isinstance(value.get("resource"), str) or not isinstance(value.get("id"), str):
        return None
    return value["resource"], value["id"]


def binding_violations(problem: BindingProblem, binding: dict[str, Any]) -> list[dict[str, Any]]:
    """``[]`` for a valid binding, otherwise one hard ``binding_invalid`` violation with the reason."""
    try:
        validate_binding(problem, binding)
    except EvaluationError as exc:
        return [{"code": "binding_invalid", "message": str(exc), "enforcement": "hard"}]
    return []


def authoritative_evaluation(
    problem: BindingProblem, binding: dict[str, Any], execution: Mapping[str, Any] | None = None
) -> tuple[dict[str, float], dict[str, Any], list[dict[str, Any]]]:
    """``(features, objectives, violations)`` of a returned decision, evaluated by the canonical evaluator.

    An invalid binding yields zero features, no objectives and a ``binding_invalid`` violation; a
    binding that cannot be evaluated yields a ``binding_evaluation`` violation.  Both are hard.
    """
    violations = binding_violations(problem, binding)
    feature_definitions = problem.document["spec"].get("application", {}).get("features", {})
    empty_features = (
        {feature_id: 0.0 for feature_id in feature_definitions}
        if isinstance(feature_definitions, dict)
        else {}
    )
    if violations:
        return empty_features, {}, violations
    try:
        evaluation = evaluate(problem, binding, execution)
        features = evaluation["features"]
        objectives = evaluation["objectives"]
        violations.extend(evaluation["violations"])
    except EvaluationError as exc:
        features = empty_features
        objectives = {}
        violations.append({"code": "binding_evaluation", "message": str(exc), "enforcement": "hard"})
    return features, objectives, violations


def reevaluate_result(
    problem: BindingProblem,
    result: dict[str, Any],
    execution: Mapping[str, Any] | None = None,
    allowed_terminations: list[str] | tuple[str, ...] | set[str] = DEFAULT_TERMINATIONS,
) -> dict[str, Any]:
    """Replace the engine-reported QoS fields with authoritative values.

    Returns ``{"termination", "solutions", "provenance"}``.  A solution is kept only if its decision
    is a ``binding`` of closed references and the canonical evaluation yields objectives; every
    kept solution carries the authoritative ``features``, ``objectives``, ``penalties`` and
    ``violations``.  The termination becomes ``UNKNOWN`` when it is not one of the four values,
    when any decision was malformed, ineligible or violates a hard constraint, or when it is not
    among ``allowed_terminations``; ``OPTIMAL``/``FEASIBLE`` without a solution and ``INFEASIBLE``
    with a solution also become ``UNKNOWN``.
    """
    solutions: list[dict[str, Any]] = []
    invalid = False
    for item in result.get("solutions", []) if isinstance(result.get("solutions"), list) else []:
        decision = item.get("decision") if isinstance(item, dict) else None
        binding = decision.get("binding") if isinstance(decision, dict) else None
        if (
            not isinstance(decision, dict)
            or decision.get("kind") != "binding"
            or not isinstance(binding, dict)
            or any(not isinstance(key, str) or candidate_ref(value) is None for key, value in binding.items())
        ):
            invalid = True
            continue
        features, objectives, violations = authoritative_evaluation(problem, binding, execution)
        if not objectives and (problem.document["spec"]["optimization"].get("criteria") or violations):
            invalid = True
            continue
        soft_by_ref = {
            candidate_ref(entry["constraint"]): float(entry.get("penalty", 0.0))
            for entry in violations
            if entry.get("enforcement") == "soft"
            and candidate_ref(entry.get("constraint")) is not None
        }
        penalties = [
            soft_by_ref.get(candidate_ref(item["constraint"]), 0.0) * float(item["weight"])
            for item in problem.document["spec"]["optimization"].get("penalties", [])
        ]
        solutions.append({
            "decision": {"kind": "binding", "binding": binding},
            "features": features,
            "objectives": objectives,
            "penalties": penalties,
            "violations": violations,
        })
        if any(entry.get("enforcement") == "hard" for entry in violations):
            invalid = True
    termination = result.get("termination")
    if not is_termination(termination) or invalid:
        termination = "UNKNOWN"
    declared_terminations = {value for value in allowed_terminations if is_termination(value)}
    if termination != "UNKNOWN" and termination not in declared_terminations:
        termination = "UNKNOWN"
    if not solutions and termination in {"OPTIMAL", "FEASIBLE"}:
        termination = "UNKNOWN"
    if termination == "INFEASIBLE" and solutions:
        termination = "UNKNOWN"
    return {"termination": termination, "solutions": solutions, "provenance": result.get("provenance", {})}

"""Bounded counterfactual analysis using the canonical evaluator.

These evaluations are new analysis evidence, never reconstructed solver history.
The time budget is a parameter (``seconds``): it is cooperative
between evaluations, not a hard deadline for one evaluator call, and the host bounds concurrent
requests.

Errors are :class:`~bim_core.errors.EvaluationError` (a ``ValueError``): ``neighborhood_limit``
(the limit is outside 1..128), ``binding_invalid`` (the binding is not valid for the problem),
``task_not_bound`` (the selected task is not a service task of the binding) and
``non_finite_evaluation`` (the base binding evaluates to NaN or infinity).  A *move* that cannot be
evaluated is not an error: it is reported in ``failures``.
"""

from __future__ import annotations

import math
import time
from typing import Any

from .compiler import BindingProblem
from .errors import EvaluationError
from .evaluator import evaluate as evaluate_canonical
from .evaluator import validate_binding

MAX_EVALUATIONS = 128


def _finite_tree(value: Any) -> bool:
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, dict):
        return all(_finite_tree(v) for v in value.values())
    if isinstance(value, list):
        return all(_finite_tree(v) for v in value)
    return True


def _feasible(evaluation: dict) -> bool:
    return not any(v["enforcement"] == "hard" for v in evaluation["violations"])


def _losses(evaluation: dict) -> list[float]:
    objectives = evaluation["objectives"]
    return [c["loss"] for c in objectives["components"]] + [objectives["penalty"]]


def _dominates(a: list[float], b: list[float]) -> bool:
    return all(x <= y for x, y in zip(a, b, strict=True)) and a != b


def _comparison(base: dict, alternative: dict) -> str:
    if not _feasible(alternative):
        return "infeasible"
    if not _feasible(base):
        return "repairs-feasibility"
    a, b = alternative["objectives"], base["objectives"]
    if a["type"] in {"MULTI", "MANY"}:
        # Multi-objective executions define only a partial order over the losses.
        x, y = _losses(alternative), _losses(base)
        return "better" if _dominates(x, y) else "worse" if _dominates(y, x) else "equal" if x == y else "trade-off"
    # Python list ordering matches the canonical lexicographic convention.
    return "better" if a["score"] < b["score"] else "worse" if a["score"] > b["score"] else "equal"


def analyze_neighborhood(problem: BindingProblem, binding: dict, *, task: str | None = None,
                         limit: int = 64, seconds: float = 2.0, execution: dict | None = None) -> dict:
    """Evaluate at most `limit` distinct eligible Hamming-distance-one moves.

    `execution` is the job's execution-time optimization (type, scalarization
    and weights). Without it the evaluator default (equal-weight SINGLE) applies.
    The time budget is cooperative between evaluations, not a hard deadline
    for an individual evaluator call. The caller bounds concurrent requests.
    """
    if not 1 <= limit <= MAX_EVALUATIONS:
        raise EvaluationError("neighborhood_limit", "The evaluation limit must be between 1 and 128")
    started = time.monotonic()
    normalized = validate_binding(problem, binding)
    if task is not None and task not in normalized:
        raise EvaluationError("task_not_bound", "The selected task is not a bound service task")

    def evaluate(candidate: dict) -> dict:
        return problem.evaluate(candidate) if execution is None else problem.evaluate(candidate, execution)

    base = evaluate_canonical(problem, normalized, execution)
    if not _finite_tree(base):
        raise EvaluationError("non_finite_evaluation", "The selected binding has non-finite evaluation data")
    choices = {}
    for key in sorted(normalized):
        if task is not None and key != task:
            continue
        unique = {(ref["resource"], ref["id"]) for ref in problem.document["spec"]["eligibility"][key]
                  if ref != normalized[key]}
        choices[key] = [{"resource": resource, "id": identifier} for resource, identifier in sorted(unique)]
    total = sum(len(refs) for refs in choices.values())
    moves, failures = [], []
    attempted = 0
    stop_reason = None
    for key, refs in choices.items():
        for ref in refs:
            if attempted >= limit or time.monotonic() - started >= seconds:
                stop_reason = "evaluation-limit" if attempted >= limit else "time-budget"
                break
            attempted += 1
            changed = {**normalized, key: ref}
            try:
                evaluation = evaluate(changed)
                if not _finite_tree(evaluation):
                    raise ValueError("Non-finite evaluation data")
            except (ValueError, ArithmeticError) as exc:
                failures.append({"task": key, "to": ref, "message": str(exc)[:300]})
                continue
            base_components = base["objectives"]["components"]
            moves.append({
                "task": key, "from": normalized[key], "to": ref,
                "decision": {"kind": "binding", "binding": changed},
                **evaluation, "feasible": _feasible(evaluation),
                "comparison": _comparison(base, evaluation),
                "componentDeltas": [
                    {"feature": c["feature"], "value": c["value"] - b["value"], "loss": c["loss"] - b["loss"]}
                    for c, b in zip(evaluation["objectives"]["components"], base_components, strict=True)
                ],
                "penaltyDelta": evaluation["objectives"]["penalty"] - base["objectives"]["penalty"],
            })
        if stop_reason:
            break
    complete = attempted == total and not failures
    improving = sum(m["comparison"] in {"better", "repairs-feasibility"} for m in moves)
    conclusion = (f"Found {improving} feasible canonical improvements or feasibility repairs."
                  if improving else "No feasible canonical improvement found in the checked moves.")
    if not complete:
        conclusion += " Coverage is incomplete; unchecked or failed moves may improve the binding."
    elif not total:
        conclusion += " There are no eligible one-task alternatives in this scope."
    else:
        conclusion += " Every eligible one-task move in this scope was evaluated."
    return {
        "kind": "canonical-one-task-counterfactuals", "irDigest": problem.digest,
        "scope": "all-service-tasks" if task is None else "selected-service-task", "task": task,
        "base": {"decision": {"kind": "binding", "binding": normalized}, **base, "feasible": _feasible(base)},
        "moves": moves, "failures": failures,
        "coverage": {"total": total, "attempted": attempted, "evaluated": len(moves), "complete": complete,
                     "limit": limit, "stopReason": stop_reason, "perTask": {key: len(refs) for key, refs in choices.items()}},
        "conclusion": conclusion,
        "semantics": "Re-evaluated with the current canonical evaluator against the pinned job IR. "
                     "Comparison uses the job's execution objective type, scalarization and weights, not UI preferences. "
                     "This is new counterfactual evidence, not solver history or global optimality. "
                     "Only eligible single-task substitutions are considered; multi-task changes are untested.",
    }

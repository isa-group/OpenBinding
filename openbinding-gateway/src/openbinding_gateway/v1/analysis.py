"""Bounded counterfactual analysis using the existing canonical evaluator.

These evaluations are new analysis evidence, never reconstructed solver history.
"""
from __future__ import annotations

import math
import time
from typing import Any

from .compiler import BindingProblem


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
    if a["mode"] == "pareto":
        x, y = _losses(alternative), _losses(base)
        return "better" if _dominates(x, y) else "worse" if _dominates(y, x) else "equal" if x == y else "trade-off"
    # Python list ordering matches the canonical lexicographic convention.
    return "better" if a["score"] < b["score"] else "worse" if a["score"] > b["score"] else "equal"


def analyze_neighborhood(problem: BindingProblem, binding: dict, *, task: str | None = None,
                         limit: int = 64, seconds: float = 2.0) -> dict:
    """Evaluate at most `limit` distinct eligible Hamming-distance-one moves.

    The time budget is cooperative between evaluations, not a hard deadline
    for an individual evaluator call. The caller bounds concurrent requests.
    """
    if not 1 <= limit <= 128:
        raise ValueError("The evaluation limit must be between 1 and 128")
    started = time.monotonic()
    normalized = problem.validate_binding(binding)
    if task is not None and task not in normalized:
        raise ValueError("The selected task is not a bound service task")
    base = problem.evaluate(normalized)
    if not _finite_tree(base):
        raise ValueError("The selected binding has non-finite evaluation data")
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
                evaluation = problem.evaluate(changed)
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
                     "Comparison uses the model's original objective mode and weights, not UI preferences. "
                     "This is new counterfactual evidence, not solver history or global optimality. "
                     "Only eligible single-task substitutions are considered; multi-task changes are untested.",
    }

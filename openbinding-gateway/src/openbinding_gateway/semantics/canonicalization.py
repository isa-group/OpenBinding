"""Turning an engine's answer into the response a client receives.

Every engine's solutions go through here, so features, violations and
feasibility come from one implementation rather than from whatever each
engine happens to report. The objective is the one thing the instance
decides: declaring normalization for every target selects the canonical
convention, otherwise the instance's own weighted sum stands.
"""

from __future__ import annotations

from typing import Any, Dict

from .aggregation import compute_objective_value, normalize_qos
from .desugar import desugar_instance
from .evaluator import evaluate_solution
from .placement import PlacementModel
from .objective import declares_normalization


def _canonicalize_solution_objective_value(
    solution: Dict[str, Any],
    objective: Dict[str, Any],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> None:
    aggregated_qos = solution.get("aggregated_features")
    if not isinstance(aggregated_qos, dict):
        return

    objective_type = str(objective.get("type") or "").upper()
    if objective_type not in {"MONO", "WEIGHTED_SUM", "MANY", "MULTI"}:
        return

    if objective_type in {"MONO", "WEIGHTED_SUM"} and solution.get("objective_value") is not None:
        return

    normalized_qos = normalize_qos(aggregated_qos, features, agg_policies)
    solution["objective_value"] = compute_objective_value(objective, normalized_qos)


def canonicalize_result_data(result_data: Dict[str, Any], original_request: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(result_data, dict):
        return result_data

    solutions = result_data.get("solutions")
    if not isinstance(solutions, list):
        return result_data

    # Every engine's answer goes through the reference evaluator: features,
    # violations and feasibility come from one implementation rather than from
    # whatever each engine happens to report, and placement semantics are
    # included whenever the instance declares them.
    #
    # The objective is the one place the instance gets a say. Declaring
    # normalization for every target selects the canonical convention, a
    # weighted mean of losses that the gateway owns; otherwise the instance's
    # own weighted sum stands, and a MONO value the engine already reported is
    # left alone.
    # A request may be written with the authoring shorthands; everything below
    # reads the placement blocks and the policies directly, so it reads them
    # expanded.
    instance = desugar_instance(original_request)

    canonical = declares_normalization(instance)
    # Built once: it depends on the instance, not on the binding, and building
    # it enumerates the XOR scenarios.
    placement = PlacementModel(instance)
    features = {feature["id"]: feature for feature in (instance.get("features") or [])}
    agg_policies = instance.get("aggregation_policies") or {}
    objective = instance.get("objective") or {}

    for solution in solutions:
        if not isinstance(solution, dict):
            continue

        binding = solution.get("binding")
        if not isinstance(binding, dict) or not binding:
            solution.setdefault("aggregated_features", {})
            continue

        evaluation = evaluate_solution(instance, binding, model=placement)
        engine_objective = solution.get("objective_value")

        solution["aggregated_features"] = evaluation["aggregated_features"]
        solution["violations"] = evaluation["violations"]
        solution["feasible"] = evaluation["feasible"]

        if canonical:
            solution["objective_value"] = evaluation["objective_value"]
            if engine_objective is not None:
                solution["engine_objective_value"] = float(engine_objective)
        else:
            _canonicalize_solution_objective_value(solution, objective, features, agg_policies)

    return result_data

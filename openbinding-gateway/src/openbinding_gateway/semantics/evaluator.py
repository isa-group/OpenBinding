"""Evaluation of one binding against one instance.

Thin orchestration of the four models: aggregate the features the application
model composes, override the latency the placement model schedules, check
every constraint, and score the objective. The reference every engine is
measured against, and the oracle the experimentation uses.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List

from .aggregation import build_selected_candidate_by_task, compute_aggregated_qos
from .application import composition_task_ids
from .constraints import (
    _check_attribute_bounds,
    _check_dependencies,
    _check_resource_capacity,
    _check_transitions,
    _violation,
)
from .objective import canonical_objective
from .placement import PlacementModel


def evaluate_solution(
    instance: Dict[str, Any],
    binding: Dict[str, str],
    model: PlacementModel = None,
) -> Dict[str, Any]:
    """Reference evaluation of one binding against one instance.

    ``model`` lets a caller evaluating many bindings of the same instance
    build the placement view once. It is derived from the instance alone, and
    building it enumerates the XOR scenarios - work that does not depend on
    the binding and was being repeated for every solution in an archive.
    """
    candidates_by_id = {c["id"]: c for c in instance.get("candidates", []) or []}
    features = {f["id"]: f for f in instance.get("features", []) or []}
    agg_policies = instance.get("aggregation_policies") or {}
    root = (instance.get("composition") or {}).get("root") or {}

    selected = build_selected_candidate_by_task(binding or {}, candidates_by_id)
    aggregated = compute_aggregated_qos(root, features, selected, agg_policies)

    violations: List[Dict[str, Any]] = []
    # Only tasks the composition actually reaches need a binding. A task that
    # is declared but never executed contributes nothing to any feature, so
    # demanding a candidate for it would call a perfectly good binding
    # infeasible over a choice that cannot matter.
    task_ids = composition_task_ids((instance.get("composition") or {}).get("root") or {})
    missing = sorted(task_ids - set(selected.keys()))
    if missing:
        violations.append(
            _violation(
                "complete_binding",
                f"Binding does not cover tasks: {', '.join(missing)}",
                True,
                -float(len(missing)),
            )
        )

    # An instance without placement blocks yields an empty model: no pools to
    # bind candidates to, no capacity or transition constraints to check, and
    # no end-to-end latency to override. The code below is the same either way.
    if model is None:
        model = PlacementModel(instance)

    pool_of_task: Dict[str, str] = {}
    for task_id, cand in selected.items():
        pool = model.pool_of_candidate.get(cand.get("id"))
        if pool is None:
            if model.pools:
                violations.append(
                    _violation(
                        "candidate_pool_binding",
                        f"Candidate '{cand.get('id')}' has no pool binding",
                        True,
                        -1.0,
                    )
                )
        else:
            pool_of_task[task_id] = pool

    if model.global_latency and not missing and len(pool_of_task) == len(selected):
        lat_attr = model.global_latency.get("attribute_id")
        include_exec = bool(model.global_latency.get("include_execution_latency_feature"))
        exec_of_task = {
            t: float((c.get("features") or {}).get(lat_attr, 0.0)) if include_exec else 0.0
            for t, c in selected.items()
        }
        aggregated[lat_attr] = model.compute_e2e_latency(pool_of_task, exec_of_task)

    violations.extend(_check_resource_capacity(model, selected))
    violations.extend(_check_transitions(model, pool_of_task))

    violations.extend(_check_attribute_bounds(instance, aggregated, selected))
    violations.extend(_check_dependencies(instance, selected, model))

    feasible = not any(v.get("_hard", True) for v in violations)
    for v in violations:
        v.pop("_hard", None)

    objective_value = canonical_objective(instance, aggregated)
    if not all(math.isfinite(v) for v in aggregated.values()):
        feasible = False

    return {
        "aggregated_features": aggregated,
        "objective_value": objective_value,
        "violations": violations,
        "feasible": feasible,
    }

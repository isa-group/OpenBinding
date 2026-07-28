"""Constraint satisfaction (Delta of I' = (M_A, M'_C, Delta, O)).

Attribute bounds in either scope, provider and pool dependencies, cumulative
resource capacity, and transition latency. Every check reports the magnitude
by which it is broken, so a search can tell a near miss from a gross one, and
whether the breach is hard.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

from .placement import PlacementModel

EPS = 1e-6


def check_bound(current: float, op: str, value: Any) -> Tuple[bool, float]:
    """Return (satisfied, slack). Positive slack means margin, negative deficit."""
    if isinstance(value, dict):
        mn = float(value.get("min", float("-inf")))
        mx = float(value.get("max", float("inf")))
        if str(op).upper() == "IN_RANGE" or op == "in_range":
            ok = (mn - EPS) <= current <= (mx + EPS)
            return ok, min(current - mn, mx - current)
        return True, 0.0

    rhs = float(value)
    if op == "<=":
        return current <= rhs + EPS, rhs - current
    if op == "<":
        return current < rhs - EPS, rhs - current
    if op == ">=":
        return current >= rhs - EPS, current - rhs
    if op == ">":
        return current > rhs + EPS, current - rhs
    if op == "==":
        return abs(current - rhs) <= EPS, -abs(current - rhs)
    if op == "!=":
        ok = abs(current - rhs) > EPS
        return ok, (0.0 if ok else -1.0)
    return True, 0.0


def _violation(constraint_id: str, message: str, hard: bool, slack: float) -> Dict[str, Any]:
    return {
        "constraint_id": constraint_id,
        "message": message,
        "code": "constraint_violation" if hard else "soft_constraint_violation",
        "penalty": 0.0,
        "description": f"Slack: {slack}",
        "_hard": hard,
    }


def _check_attribute_bounds(
    instance: Dict[str, Any],
    aggregated: Dict[str, float],
    selected: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    violations: List[Dict[str, Any]] = []
    for constraint in instance.get("constraints", []) or []:
        if str(constraint.get("kind") or "").upper() != "ATTRIBUTE_BOUND":
            continue
        attr = constraint.get("attribute_id")
        op = constraint.get("op")
        value = constraint.get("value")
        hard = bool(constraint.get("hard", True))
        scope = str(constraint.get("scope") or "GLOBAL").upper()
        cid = constraint.get("id") or "attribute_bound"

        if scope == "LOCAL":
            for task_id in constraint.get("tasks", []) or []:
                cand = selected.get(task_id)
                if cand is None:
                    violations.append(
                        _violation(cid, f"Task '{task_id}' has no selected candidate", hard, -1.0)
                    )
                    continue
                current = float((cand.get("features") or {}).get(attr, 0.0))
                ok, slack = check_bound(current, op, value)
                if not ok:
                    violations.append(
                        _violation(
                            cid,
                            f"Local bound on '{attr}' violated for task '{task_id}' "
                            f"({current} {op} {value})",
                            hard,
                            slack,
                        )
                    )

            # A LOCAL constraint may be scoped by candidate id instead of by
            # task, in which case it binds only those candidates, and only when
            # they are the selected one for their task.
            scoped = set(constraint.get("candidates", []) or [])
            for task_id, cand in selected.items():
                if cand.get("id") not in scoped:
                    continue
                current = float((cand.get("features") or {}).get(attr, 0.0))
                ok, slack = check_bound(current, op, value)
                if not ok:
                    violations.append(
                        _violation(
                            cid,
                            f"Local bound on '{attr}' violated for candidate "
                            f"'{cand.get('id')}' of task '{task_id}' "
                            f"({current} {op} {value})",
                            hard,
                            slack,
                        )
                    )
            continue

        current = float(aggregated.get(attr, 0.0))
        ok, slack = check_bound(current, op, value)
        if not ok:
            violations.append(
                _violation(
                    cid,
                    f"Global bound on '{attr}' violated ({current} {op} {value})",
                    hard,
                    slack,
                )
            )
    return violations


def _check_dependencies(
    instance: Dict[str, Any],
    selected: Dict[str, Dict[str, Any]],
    model: PlacementModel,
) -> List[Dict[str, Any]]:
    violations: List[Dict[str, Any]] = []
    for constraint in instance.get("constraints", []) or []:
        if str(constraint.get("kind") or "").upper() != "DEPENDENCY":
            continue
        dep_type = str(constraint.get("type") or "").upper()
        tasks = constraint.get("tasks", []) or []
        hard = bool(constraint.get("hard", True))
        cid = constraint.get("id") or "dependency"

        if dep_type in ("SAME_PROVIDER", "DIFFERENT_PROVIDER"):
            values = [
                (selected.get(t) or {}).get("provider_id") for t in tasks if selected.get(t)
            ]
            label = "provider"
        elif dep_type in ("SAME_POOL", "DIFFERENT_POOL"):
            if not model.pools:
                # No resource model declares pools, so there is nothing to
                # compare. Validation rejects this instance before it gets here.
                continue
            values = [
                model.pool_of_candidate.get((selected.get(t) or {}).get("id"))
                for t in tasks
                if selected.get(t)
            ]
            label = "pool"
        else:
            continue

        distinct = len(set(values))
        if dep_type.startswith("SAME") and distinct > 1:
            violations.append(
                _violation(cid, f"Tasks {tasks} must share the same {label}", hard, -1.0)
            )
        if dep_type.startswith("DIFFERENT") and distinct < len(values):
            violations.append(
                _violation(cid, f"Tasks {tasks} must use different {label}s", hard, -1.0)
            )
    return violations


def _is_capacity_constraint(constraint: Dict[str, Any]) -> bool:
    """Resource capacity is a dependency-type constraint: canonical form
    ``kind: DEPENDENCY`` + ``type: RESOURCE_CAPACITY``; the legacy spelling
    ``kind: RESOURCE_CAPACITY`` is still accepted."""
    kind = str(constraint.get("kind") or "").upper()
    if kind == "RESOURCE_CAPACITY":
        return True
    return (
        kind == "DEPENDENCY"
        and str(constraint.get("type") or "").upper() == "RESOURCE_CAPACITY"
    )


def _check_resource_capacity(
    model: PlacementModel,
    selected: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    violations: List[Dict[str, Any]] = []

    usage: Dict[str, Dict[str, float]] = {}
    for cand in selected.values():
        cand_id = cand.get("id")
        pool_id = model.pool_of_candidate.get(cand_id)
        if pool_id is None:
            continue
        pool_usage = usage.setdefault(pool_id, {})
        for resource, demand in (model.demand_of_candidate.get(cand_id) or {}).items():
            pool_usage[resource] = pool_usage.get(resource, 0.0) + float(demand)

    for constraint in model.resource_constraints:
        if not _is_capacity_constraint(constraint):
            continue
        hard = bool(constraint.get("hard", True))
        cid = constraint.get("id") or "resource_capacity"
        resources = constraint.get("resources") or []
        for pool_id in model.pools_in_scope(constraint):
            capacity = (model.pools.get(pool_id) or {}).get("capacity") or {}
            pool_usage = usage.get(pool_id) or {}
            for resource in resources:
                if resource not in capacity:
                    continue  # undeclared capacity = unconstrained
                used = pool_usage.get(resource, 0.0)
                cap = float(capacity[resource])
                if used > cap + EPS:
                    violations.append(
                        _violation(
                            cid,
                            f"Pool '{pool_id}' exceeds capacity of '{resource}' "
                            f"({used} > {cap})",
                            hard,
                            cap - used,
                        )
                    )
    return violations


def _check_transitions(
    model: PlacementModel,
    pool_of_task: Dict[str, str],
) -> List[Dict[str, Any]]:
    violations: List[Dict[str, Any]] = []
    for constraint in model.transition_constraints:
        cid = constraint.get("id") or "transition"
        hard = bool(constraint.get("hard", True))
        to_task = constraint.get("to_task")
        to_pool = pool_of_task.get(to_task)
        if to_pool is None:
            violations.append(
                _violation(cid, f"Task '{to_task}' has no placement pool", hard, -1.0)
            )
            continue

        if constraint.get("from_event") is not None:
            current = model.event_pool_latency(constraint["from_event"], to_pool)
            source_desc = f"event '{constraint['from_event']}'"
        else:
            from_task = constraint.get("from_task")
            from_pool = pool_of_task.get(from_task)
            if from_pool is None:
                violations.append(
                    _violation(cid, f"Task '{from_task}' has no placement pool", hard, -1.0)
                )
                continue
            current = model.pool_latency(from_pool, to_pool)
            source_desc = f"task '{from_task}'"

        ok, slack = check_bound(current, constraint.get("op"), constraint.get("value"))
        if not ok:
            violations.append(
                _violation(
                    cid,
                    f"Transition latency from {source_desc} to task '{to_task}' violated "
                    f"({current} {constraint.get('op')} {constraint.get('value')})",
                    hard,
                    slack,
                )
            )
    return violations

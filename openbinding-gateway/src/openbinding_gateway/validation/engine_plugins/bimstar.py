"""Reference evaluation semantics for BIM' (placement-aware) instances.

This module is the single source of truth for the placement extensions of BIM:

- End-to-end latency of a binding, defined as the expected makespan over the
  XOR scenarios of the composition. Each scenario fixes one branch per XOR
  node, turning the composition tree into a precedence DAG over tasks; the
  makespan is computed by critical-path scheduling where every task starts
  once all its predecessors have finished and their outputs have been
  transferred over the network (pool-to-pool latency matrix).
- RESOURCE_CAPACITY dependency constraints (canonical form ``kind: DEPENDENCY``
  with ``type: RESOURCE_CAPACITY``; the legacy spelling
  ``kind: RESOURCE_CAPACITY`` is still accepted): cumulative demand of the
  selected candidates placed on a pool must not exceed the pool capacity, for
  every resource.
- Transition latency constraints: pairwise bounds on the network latency
  between the pools hosting two tasks (or an event generator and a task).
- SAME_POOL / DIFFERENT_POOL dependency constraints.
- The canonical objective value: a weighted sum of per-feature losses
  normalized with instance-declared bounds, identical for every engine.

Every solution returned by any engine is re-evaluated with these functions so
that reported metrics are engine-independent.
"""

from __future__ import annotations

import itertools
import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .aggregation import build_selected_candidate_by_task, compute_aggregated_qos

EPS = 1e-6

EVENT_SOURCE = "event"
TASK_SOURCE = "task"


class BimStarError(ValueError):
    """Raised when a BIM' instance cannot be interpreted."""


def is_bimstar(instance: Dict[str, Any]) -> bool:
    return isinstance(instance, dict) and (
        "resource_model" in instance or "latency_model" in instance
    )


# ---------------------------------------------------------------------------
# Scenario enumeration and precedence DAG construction
# ---------------------------------------------------------------------------

def _collect_xor_nodes(node: Dict[str, Any], acc: List[Dict[str, Any]]) -> None:
    kind = node.get("kind")
    if kind == "XOR":
        acc.append(node)
        for branch in node.get("branches", []) or []:
            _collect_xor_nodes(branch.get("child", {}) or {}, acc)
    elif kind in ("SEQ", "AND"):
        for child in node.get("children", []) or []:
            _collect_xor_nodes(child, acc)
    elif kind == "LOOP":
        _collect_xor_nodes(node.get("body", {}) or {}, acc)


def _build_dag(
    node: Dict[str, Any],
    entries: List[Tuple[str, str]],
    choice: Dict[str, int],
    preds: Dict[str, List[Tuple[str, str]]],
    order: List[str],
) -> List[Tuple[str, str]]:
    """Thread entry points through the tree, recording task predecessors.

    Returns the exit points (sources) of ``node``. Fork/join semantics emerge
    from the entry sets: an AND joins because the next consumer receives the
    exits of every branch and must wait for the slowest one.
    """
    kind = node.get("kind")

    if kind == "TASK":
        task_id = node.get("task_id")
        if task_id in preds:
            raise BimStarError(
                f"Task '{task_id}' appears more than once in the composition; "
                "the BIM' latency model requires a single occurrence per task"
            )
        preds[task_id] = list(entries)
        order.append(task_id)
        return [(TASK_SOURCE, task_id)]

    if kind == "ELEMENT":
        return list(entries)

    if kind == "SEQ":
        current = list(entries)
        for child in node.get("children", []) or []:
            current = _build_dag(child, current, choice, preds, order)
        return current

    if kind == "AND":
        exits: List[Tuple[str, str]] = []
        for child in node.get("children", []) or []:
            exits.extend(_build_dag(child, list(entries), choice, preds, order))
        return exits

    if kind == "XOR":
        branches = node.get("branches", []) or []
        idx = choice[id(node)] if id(node) in choice else choice.get(node.get("id"))
        return _build_dag(branches[idx].get("child", {}) or {}, entries, choice, preds, order)

    if kind == "LOOP":
        raise BimStarError("LOOP nodes are not supported by the BIM' latency model")

    raise BimStarError(f"Unsupported composition node kind '{kind}'")


def build_scenarios(
    root: Dict[str, Any], event_ids: Sequence[str]
) -> List[Dict[str, Any]]:
    """Enumerate XOR scenarios of the composition tree.

    Each scenario is ``{"prob", "preds", "order", "sinks"}`` where ``preds``
    maps every active task to its predecessor sources (``("task", id)`` or
    ``("event", id)``), ``order`` is a topological order of the active tasks
    and ``sinks`` are the exit tasks of the scenario.
    """
    xor_nodes: List[Dict[str, Any]] = []
    _collect_xor_nodes(root, xor_nodes)

    branch_indices = [range(len(n.get("branches", []) or [])) for n in xor_nodes]
    entries = [(EVENT_SOURCE, eid) for eid in event_ids]

    scenarios: List[Dict[str, Any]] = []
    for combo in itertools.product(*branch_indices) if xor_nodes else [()]:
        prob = 1.0
        choice: Dict[Any, int] = {}
        for xor_node, idx in zip(xor_nodes, combo):
            choice[id(xor_node)] = idx
            prob *= float(xor_node["branches"][idx].get("p", 0.0))

        preds: Dict[str, List[Tuple[str, str]]] = {}
        order: List[str] = []
        exits = _build_dag(root, list(entries), choice, preds, order)
        sinks = [src_id for src_kind, src_id in exits if src_kind == TASK_SOURCE]

        # An XOR branch may be unreachable in this scenario (nested XOR inside
        # a non-chosen branch), in which case its choice simply never applies.
        scenarios.append({"prob": prob, "preds": preds, "order": order, "sinks": sinks})

    return scenarios


# ---------------------------------------------------------------------------
# BIM' model view
# ---------------------------------------------------------------------------

class BimStarModel:
    """Parsed view of the placement extensions of a BIM' instance."""

    def __init__(self, instance: Dict[str, Any]):
        self.instance = instance

        resource_model = instance.get("resource_model") or {}
        latency_model = instance.get("latency_model") or {}

        self.pools: Dict[str, Dict[str, Any]] = {
            p["id"]: p for p in resource_model.get("pools", []) or []
        }
        self.pool_of_candidate: Dict[str, str] = {}
        self.demand_of_candidate: Dict[str, Dict[str, float]] = {}
        for cb in resource_model.get("candidate_bindings", []) or []:
            self.pool_of_candidate[cb["candidate_id"]] = cb["pool_id"]
            self.demand_of_candidate[cb["candidate_id"]] = {
                str(r): float(v) for r, v in (cb.get("demand") or {}).items()
            }
        self.resource_constraints: List[Dict[str, Any]] = (
            resource_model.get("constraints", []) or []
        )

        self.latency_matrix: Dict[str, Dict[str, float]] = (
            latency_model.get("pool_latency_matrix_ms") or {}
        )
        self.event_latency: Dict[str, Dict[str, float]] = (
            latency_model.get("event_latency_matrix_ms") or {}
        )
        self.event_pools: Dict[str, str] = dict(
            latency_model.get("event_generator_pools") or {}
        )
        self.event_ids: List[str] = sorted(self.event_pools.keys())
        self.transition_constraints: List[Dict[str, Any]] = (
            latency_model.get("transition_constraints") or []
        )
        self.global_latency: Optional[Dict[str, Any]] = latency_model.get("global_latency")

        self._scenarios: Optional[List[Dict[str, Any]]] = None

    # -- latency ------------------------------------------------------------

    def scenarios(self) -> List[Dict[str, Any]]:
        if self._scenarios is None:
            root = (self.instance.get("composition") or {}).get("root") or {}
            self._scenarios = build_scenarios(root, self.event_ids)
        return self._scenarios

    def pool_latency(self, pool_a: str, pool_b: str) -> float:
        if pool_a == pool_b:
            row = self.latency_matrix.get(pool_a) or {}
            return float(row.get(pool_b, 0.0))
        value = (self.latency_matrix.get(pool_a) or {}).get(pool_b)
        if value is None:
            value = (self.latency_matrix.get(pool_b) or {}).get(pool_a)
        if value is None:
            raise BimStarError(f"Missing pool latency entry for '{pool_a}' -> '{pool_b}'")
        return float(value)

    def event_pool_latency(self, event_id: str, pool_b: str) -> float:
        value = (self.event_latency.get(event_id) or {}).get(pool_b)
        if value is None:
            # Same fallback as the Java engines and the dzn builder: derive the
            # latency from the event generator's own pool.
            event_pool = self.event_pools.get(event_id)
            if event_pool is not None:
                return self.pool_latency(event_pool, pool_b)
            raise BimStarError(f"Missing event latency entry for '{event_id}' -> '{pool_b}'")
        return float(value)

    def source_latency(self, source: Tuple[str, str], pool_of_task: Dict[str, str], to_pool: str) -> float:
        src_kind, src_id = source
        if src_kind == EVENT_SOURCE:
            return self.event_pool_latency(src_id, to_pool)
        return self.pool_latency(pool_of_task[src_id], to_pool)

    def compute_e2e_latency(
        self,
        pool_of_task: Dict[str, str],
        exec_of_task: Dict[str, float],
    ) -> float:
        """Expected (or worst-case) makespan of the binding over XOR scenarios."""
        gl = self.global_latency or {}
        xor_semantics = str(gl.get("xor_semantics") or "EXPECTED").upper()
        and_semantics = str(gl.get("and_semantics") or "MAX").upper()
        if and_semantics != "MAX":
            raise BimStarError(f"Unsupported and_semantics '{and_semantics}' (only MAX)")

        makespans: List[Tuple[float, float]] = []
        for scenario in self.scenarios():
            finish: Dict[str, float] = {}
            for task_id in scenario["order"]:
                start = 0.0
                for source in scenario["preds"][task_id]:
                    src_kind, src_id = source
                    ready = 0.0 if src_kind == EVENT_SOURCE else finish[src_id]
                    transfer = self.source_latency(source, pool_of_task, pool_of_task[task_id])
                    start = max(start, ready + transfer)
                finish[task_id] = start + float(exec_of_task.get(task_id, 0.0))
            sinks = scenario["sinks"] or scenario["order"]
            makespan = max((finish[t] for t in sinks), default=0.0)
            makespans.append((scenario["prob"], makespan))

        if xor_semantics == "WORST_CASE":
            return max((mk for _, mk in makespans), default=0.0)
        return sum(p * mk for p, mk in makespans)

    # -- resources ----------------------------------------------------------

    def pools_in_scope(self, resource_constraint: Dict[str, Any]) -> List[str]:
        scope = str(resource_constraint.get("scope") or "ALL_POOLS").upper()
        if scope == "POOL_KIND":
            kinds = set(resource_constraint.get("pool_kinds") or [])
            return [pid for pid, p in self.pools.items() if p.get("kind") in kinds]
        return list(self.pools.keys())


# ---------------------------------------------------------------------------
# Constraint checking
# ---------------------------------------------------------------------------

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
    model: Optional[BimStarModel],
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
            if model is None:
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
    model: BimStarModel,
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
    model: BimStarModel,
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


# ---------------------------------------------------------------------------
# Canonical objective
# ---------------------------------------------------------------------------

def canonical_bounds(instance: Dict[str, Any], feature_id: str) -> Tuple[float, float]:
    """Normalization bounds for a feature: declared normalize bounds, else valid_range."""
    policy = (instance.get("aggregation_policies") or {}).get(feature_id) or {}
    norm = policy.get("normalize") or {}
    bounds = norm.get("bounds")
    if isinstance(bounds, dict) and "min" in bounds and "max" in bounds:
        return float(bounds["min"]), float(bounds["max"])

    feature = next(
        (f for f in instance.get("features", []) or [] if f.get("id") == feature_id), {}
    )
    vr = feature.get("valid_range") or {}
    return float(vr.get("min", 0.0)), float(vr.get("max", 1.0))


def canonical_loss(instance: Dict[str, Any], feature_id: str, value: float) -> float:
    """Per-feature loss in [0, 1]: 0 is best, 1 is worst."""
    mn, mx = canonical_bounds(instance, feature_id)
    if mx <= mn:
        return 0.0
    normalized = (float(value) - mn) / (mx - mn)
    normalized = min(1.0, max(0.0, normalized))

    feature = next(
        (f for f in instance.get("features", []) or [] if f.get("id") == feature_id), {}
    )
    direction = str(feature.get("direction") or "MINIMIZE").upper()
    return normalized if direction == "MINIMIZE" else 1.0 - normalized


def canonical_objective(instance: Dict[str, Any], aggregated: Dict[str, float]) -> float:
    """Weighted MEAN of losses over objective targets (lower is better).

    Dividing by the total weight makes the convention uniform across the
    reference evaluator, the Java engines and the MiniZinc model (identical
    to the plain weighted sum when the weights sum to one, as enforced by
    the gateway validation).
    """
    objective = instance.get("objective") or {}
    targets = objective.get("targets") or []
    weights = objective.get("weights") or {}

    total = 0.0
    total_weight = 0.0
    for target in targets:
        weight = float(weights.get(target, 1.0))
        total += weight * canonical_loss(instance, target, float(aggregated.get(target, 0.0)))
        total_weight += weight
    if total_weight <= 0.0:
        return 0.0
    return total / total_weight


# ---------------------------------------------------------------------------
# Solution evaluation entry points
# ---------------------------------------------------------------------------

def evaluate_solution(instance: Dict[str, Any], binding: Dict[str, str]) -> Dict[str, Any]:
    """Reference evaluation of a binding against a (BIM or BIM') instance."""
    candidates_by_id = {c["id"]: c for c in instance.get("candidates", []) or []}
    features = {f["id"]: f for f in instance.get("features", []) or []}
    agg_policies = instance.get("aggregation_policies") or {}
    root = (instance.get("composition") or {}).get("root") or {}

    selected = build_selected_candidate_by_task(binding or {}, candidates_by_id)
    aggregated = compute_aggregated_qos(root, features, selected, agg_policies)

    violations: List[Dict[str, Any]] = []
    task_ids = {t.get("id") for t in instance.get("tasks", []) or []}
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

    model: Optional[BimStarModel] = None
    if is_bimstar(instance):
        model = BimStarModel(instance)

        pool_of_task: Dict[str, str] = {}
        for task_id, cand in selected.items():
            pool = model.pool_of_candidate.get(cand.get("id"))
            if pool is None:
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


def build_placement_payload(instance: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Compact, engine-oriented view of the placement extensions.

    Scenario enumeration and constraint-scope resolution happen here, once,
    so that every engine (MiniZinc builder, Java heuristics) only has to
    implement the critical-path scheduling loop and simple lookups.
    """
    if not is_bimstar(instance):
        return None

    model = BimStarModel(instance)

    resource_constraints = []
    for constraint in model.resource_constraints:
        if not _is_capacity_constraint(constraint):
            continue
        resource_constraints.append(
            {
                "id": constraint.get("id"),
                "hard": bool(constraint.get("hard", True)),
                "resources": list(constraint.get("resources") or []),
                "pools": model.pools_in_scope(constraint),
            }
        )

    gl = model.global_latency or {}
    scenarios = [
        {
            "prob": s["prob"],
            "order": s["order"],
            "preds": {t: [[k, i] for k, i in sources] for t, sources in s["preds"].items()},
            "sinks": s["sinks"],
        }
        for s in model.scenarios()
    ]

    return {
        "pool_of_candidate": dict(model.pool_of_candidate),
        "demand_of_candidate": dict(model.demand_of_candidate),
        "pools": [
            {
                "id": pid,
                "kind": pool.get("kind"),
                "capacity": {str(r): float(v) for r, v in (pool.get("capacity") or {}).items()},
            }
            for pid, pool in model.pools.items()
        ],
        "resource_constraints": resource_constraints,
        "latency_matrix": model.latency_matrix,
        "event_latency": model.event_latency,
        "event_pools": dict(
            (instance.get("latency_model") or {}).get("event_generator_pools") or {}
        ),
        "transitions": [
            {
                "id": tc.get("id"),
                "hard": bool(tc.get("hard", True)),
                "from_task": tc.get("from_task"),
                "from_event": tc.get("from_event"),
                "to_task": tc.get("to_task"),
                "op": tc.get("op"),
                "value": tc.get("value"),
            }
            for tc in model.transition_constraints
        ],
        "e2e": {
            "attribute_id": gl.get("attribute_id"),
            "include_execution_latency_feature": bool(
                gl.get("include_execution_latency_feature")
            ),
            "xor_semantics": str(gl.get("xor_semantics") or "EXPECTED").upper(),
            "scenarios": scenarios,
        }
        if gl
        else None,
    }


def apply_bimstar_evaluation(result_data: Dict[str, Any], instance: Dict[str, Any]) -> Dict[str, Any]:
    """Overwrite engine-reported metrics of every solution with the reference ones."""
    solutions = result_data.get("solutions")
    if not isinstance(solutions, list):
        return result_data

    for solution in solutions:
        if not isinstance(solution, dict):
            continue
        binding = solution.get("binding")
        if not isinstance(binding, dict) or not binding:
            continue
        engine_objective = solution.get("objective_value")
        evaluation = evaluate_solution(instance, binding)
        solution["aggregated_features"] = evaluation["aggregated_features"]
        solution["objective_value"] = evaluation["objective_value"]
        solution["violations"] = evaluation["violations"]
        solution["feasible"] = evaluation["feasible"]
        if engine_objective is not None:
            solution["engine_objective_value"] = float(engine_objective)

    return result_data

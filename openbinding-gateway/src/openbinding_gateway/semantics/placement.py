"""Candidate model, deployment part (R and L of M'_C = (P, C, F, R, L)).

R is the node resources: pools, their capacities, and what each candidate
demands where it runs. L is the network: pool-to-pool and event-to-pool
latency, with the fallbacks a sparse matrix implies.

Both blocks are optional. An instance without them yields an empty model -
no pools, no constraints, no global latency - so callers never have to ask
whether the instance carries placement data.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .application import EVENT_SOURCE, TASK_SOURCE, build_scenarios
from .errors import PlacementError


class PlacementModel:
    """Parsed view of the optional placement extensions of an instance.

    Every field degrades to an empty collection (or ``None`` for the global
    latency) when the corresponding block is absent, so consumers never have
    to ask whether the instance carries placement data.
    """

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
            raise PlacementError(f"Missing pool latency entry for '{pool_a}' -> '{pool_b}'")
        return float(value)

    def event_pool_latency(self, event_id: str, pool_b: str) -> float:
        value = (self.event_latency.get(event_id) or {}).get(pool_b)
        if value is None:
            # Same fallback as the Java engines and the dzn builder: derive the
            # latency from the event generator's own pool.
            event_pool = self.event_pools.get(event_id)
            if event_pool is not None:
                return self.pool_latency(event_pool, pool_b)
            raise PlacementError(f"Missing event latency entry for '{event_id}' -> '{pool_b}'")
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
            raise PlacementError(f"Unsupported and_semantics '{and_semantics}' (only MAX)")

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

"""Combinatorial workload feature extraction O(1) from BindingProblem.

Projects an optimization problem instance P into the Workload Space W:
x(P) = <S, D_constr, N_tasks, N_cap, OptMode, D_obj, T_budget>
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class WorkloadFeatures:
    """Canonical representation of an instance in Workload Space W."""

    S: float
    D_constr: float
    N_tasks: int
    N_cap: int
    opt_mode: str
    D_obj: int
    T_budget: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "S": round(self.S, 4),
            "D_constr": round(self.D_constr, 4),
            "N_tasks": self.N_tasks,
            "N_cap": self.N_cap,
            "OptMode": self.opt_mode,
            "D_obj": self.D_obj,
            "T_budget": round(self.T_budget, 3),
        }


def extract_features(problem: Any, options: dict[str, Any] | None = None) -> WorkloadFeatures:
    """Extract combinatorial workload vector x(P) in O(1) time."""
    doc = getattr(problem, "document", problem) if problem is not None else {}
    if not isinstance(doc, dict):
        doc = {}
    spec = doc.get("spec", {})

    tasks = spec.get("application", {}).get("tasks", {})
    eligibility = spec.get("eligibility", {})
    constraints = spec.get("constraints", [])
    placement = spec.get("placement", {})
    optimization = spec.get("optimization", {})
    terms = optimization.get("terms", [])

    # Count eligible tasks and combinatorial space magnitude S = sum(log10(|C_t|))
    n_tasks = 0
    total_candidates = 0
    s_log10 = 0.0

    for task_id, task in tasks.items():
        if isinstance(task, dict) and task.get("kind") == "local":
            continue
        cands = eligibility.get(task_id, [])
        cand_count = len(cands) if isinstance(cands, list) else 0
        if cand_count > 0:
            n_tasks += 1
            total_candidates += cand_count
            s_log10 += math.log10(cand_count)

    # Fallback if no tasks explicitly in application
    if n_tasks == 0:
        for _task_id, cands in eligibility.items():
            cand_count = len(cands) if isinstance(cands, list) else 0
            if cand_count > 0:
                n_tasks += 1
                total_candidates += cand_count
                s_log10 += math.log10(cand_count)

    # Constraint density: D_constr = (K_local + K_global) / max(1, N_tasks)
    k_local = len(constraints) if isinstance(constraints, list) else 0
    k_global = 0
    if isinstance(placement, dict):
        coloc = placement.get("colocation", [])
        sep = placement.get("separation", [])
        caps = placement.get("capacities", {})
        k_global += (len(coloc) if isinstance(coloc, list) else 0)
        k_global += (len(sep) if isinstance(sep, list) else 0)
        k_global += (len(caps) if isinstance(caps, dict) else 0)

    d_constr = float(k_local + k_global) / float(max(1, n_tasks))

    # Ensure numerical features are strictly finite and non-negative
    s_val = s_log10 if math.isfinite(s_log10) and s_log10 >= 0.0 else 0.0
    d_val = d_constr if math.isfinite(d_constr) and d_constr >= 0.0 else 0.0

    # Optimization mode and objectives
    opt_mode = "weighted"
    if isinstance(optimization, dict):
        if optimization.get("pareto") is not None:
            opt_mode = "pareto"
        elif optimization.get("mode") is not None:
            opt_mode = str(optimization["mode"])

    d_obj = max(1, len(terms)) if isinstance(terms, list) else 1

    # Time budget
    opts = options or {}
    t_budget_ms = opts.get("time_budget_ms")
    if t_budget_ms is None:
        t_budget = 30.0
    else:
        try:
            val = float(t_budget_ms)
            if math.isfinite(val) and val > 0:
                t_budget = val / 1000.0
            else:
                t_budget = 30.0
        except (ValueError, TypeError):
            t_budget = 30.0

    return WorkloadFeatures(
        S=s_val,
        D_constr=d_val,
        N_tasks=max(1, n_tasks),
        N_cap=max(1, total_candidates),
        opt_mode=opt_mode,
        D_obj=d_obj,
        T_budget=max(0.1, min(3600.0, t_budget)),
    )

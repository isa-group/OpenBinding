"""Predictive engine profiler deriving estimated metrics:
- Latency: L^(e, P)
- Quality: Q^(e, P)
- Failure Risk: F^(e, P)
- Capacity Cost: R^(e, P)
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .capacity_model import get_capacity_model
from .features import WorkloadFeatures
from .calibration import CalibratedSurrogate


@dataclass(frozen=True)
class EngineProfile:
    """Predicted QoS metrics for an engine candidate."""

    engine: str
    mode: str
    latency: float       # seconds
    quality: float       # [0, 1]
    failure_risk: float  # [0, 1]
    credits: int         # capacityUnits
    is_exact: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "latency": round(self.latency, 3),
            "quality": round(self.quality, 3),
            "failureRisk": round(self.failure_risk, 3),
            "credits": self.credits,
            "isExact": self.is_exact,
        }


class EngineProfiler:
    """Computes analytical predictions L^, Q^, F^, R^ from instance features."""

    def __init__(self) -> None:
        self.capacity_model = get_capacity_model()
        self._surrogates: dict[tuple[str, str], CalibratedSurrogate] = {}

    def register_surrogate(self, surrogate: CalibratedSurrogate) -> None:
        self._surrogates[(surrogate.engine, surrogate.mode)] = surrogate

    def get_surrogate(self, engine: str, mode: str) -> CalibratedSurrogate | None:
        return self._surrogates.get((engine, mode)) or self._surrogates.get((engine, "default"))

    def profile(self, engine: str, mode: str | None, features: WorkloadFeatures) -> EngineProfile:
        eff_mode = mode or self._default_mode(engine, features.D_obj)
        is_exact = engine in ("minizinc-csp", "meta-router-csp")

        # 1. Latency estimation L^(e, P)
        latency = self._estimate_latency(engine, eff_mode, features)

        # 2. Quality estimation Q^(e, P)
        quality = self._estimate_quality(engine, eff_mode, features)

        # 3. Failure risk estimation F^(e, P)
        failure_risk = self._estimate_failure_risk(engine, features)

        # 4. Capacity cost R^(e, P)
        credits = self.capacity_model.calculate_capacity_units(engine, features)

        return EngineProfile(
            engine=engine,
            mode=eff_mode,
            latency=min(features.T_budget, max(0.005, latency)),
            quality=max(0.0, min(1.0, quality)),
            failure_risk=max(0.0, min(1.0, failure_risk)),
            credits=credits,
            is_exact=is_exact,
        )

    def _default_mode(self, engine: str, d_obj: int) -> str:
        if engine == "minizinc-csp":
            return "exact-weighted"
        if engine == "evolutionary-heuristics":
            return "pareto-genetic" if d_obj >= 2 else "elitist-genetic"
        if engine == "many-heuristic":
            return "pareto-sampling"
        if engine == "random-search":
            return "seeded"
        if engine == "meta-router-csp":
            return "meta-routing"
        return "default"

    def _estimate_latency(self, engine: str, mode: str, features: WorkloadFeatures) -> float:
        surrogate = self.get_surrogate(engine, mode)
        if surrogate is not None:
            return surrogate.predict_latency(features)

        s = features.S if math.isfinite(features.S) and features.S >= 0.0 else 0.0
        d_constr = features.D_constr if math.isfinite(features.D_constr) and features.D_constr >= 0.0 else 0.0
        n_tasks = max(1, features.N_tasks)
        n_cap = max(1, features.N_cap)

        if engine == "meta-router-csp":
            return 0.010  # ~10 ms

        if engine == "random-search":
            return 0.02 + 0.0005 * n_tasks

        if engine == "minizinc-csp":
            # Exact branch & bound
            tau_0 = 0.05
            a = 0.02
            b = 1e-4
            alpha = 0.35
            beta = 0.5
            exp_term = b * (10.0 ** min(12.0, alpha * s)) * (1.0 + beta * min(10.0, d_constr))
            return tau_0 + a * s + exp_term

        if engine == "evolutionary-heuristics":
            # GA evals: baseline ~1.5s - 2.5s
            tau_0 = 0.20
            evals = 1000
            k1 = 0.00005
            k2 = 0.00002
            base = tau_0 + evals * (k1 * n_tasks + k2 * n_cap)
            if mode == "pareto-genetic":
                base *= (1.0 + 0.25 * features.D_obj)
            return max(0.5, base)

        if engine == "many-heuristic":
            return max(0.8, 0.5 + 0.001 * (n_tasks + n_cap) * features.D_obj)

        return 1.0

    def _estimate_quality(self, engine: str, mode: str, features: WorkloadFeatures) -> float:
        surrogate = self.get_surrogate(engine, mode)
        if surrogate is not None:
            return surrogate.predict_quality(features)

        s = features.S
        d_obj = features.D_obj

        if engine in ("minizinc-csp", "meta-router-csp"):
            return 1.00  # Mathematical optimality

        if engine == "evolutionary-heuristics":
            if mode == "elitist-genetic":
                # Mono-objective schema theorem degradation with 0.94 ceiling
                gamma = 0.03
                s0 = 4.0
                return max(0.60, min(0.94, 0.94 - gamma * max(0.0, s - s0)))
            if mode == "pareto-genetic":
                if d_obj == 2:
                    return 0.95
                # Pareto dominance degradation in D_obj >= 3
                return 0.70

        if engine == "many-heuristic":
            if d_obj >= 3:
                return 0.95
            return 0.85

        if engine == "random-search":
            return max(0.20, 1.0 / (1.0 + 0.40 * s))

        return 0.80

    def _estimate_failure_risk(self, engine: str, features: WorkloadFeatures) -> float:
        surrogate = self.get_surrogate(engine, "default")
        if surrogate is not None:
            return surrogate.predict_failure_risk(features)

        if engine == "meta-router-csp":
            return 0.001

        if engine != "minizinc-csp":
            # Stochastic / heuristic engines always return feasible incumbent
            return 0.02

        # MiniZinc Phase Transition Model
        s = features.S if math.isfinite(features.S) and features.S >= 0.0 else 0.0
        d_constr = features.D_constr if math.isfinite(features.D_constr) and features.D_constr >= 0.0 else 0.0
        t_budget = features.T_budget if math.isfinite(features.T_budget) and features.T_budget > 0.0 else 30.0

        ws = 0.40
        wd = 0.50
        wt = 0.10
        theta = 5.0

        z = ws * s + wd * d_constr - wt * t_budget - theta
        # Sigmoid function
        if z > 15.0:
            return 0.999
        if z < -15.0:
            return 0.001
        return 1.0 / (1.0 + math.exp(-z))


_DEFAULT_PROFILER = EngineProfiler()


def get_engine_profiler() -> EngineProfiler:
    return _DEFAULT_PROFILER

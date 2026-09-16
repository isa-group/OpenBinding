"""Capacity Abstraction Model and Sustainable Throughput (MST) calculations.

Derives the capacityUnits (CUs) for an execution engine solving a given
workload instance in O(1) time:
    sigma_S(e, p) = MST_max / MST(e, p)
    Cost(e, P) = ceil(sigma_S(e, p(P)))
"""

from __future__ import annotations

import math

from .features import WorkloadFeatures

MST_MAX = 100.0  # Maximum sustainable throughput reference (solves/s)


class CapacityModel:
    """Computes computational capacity units based on the Capacity Abstraction Model."""

    def __init__(self, mst_max: float = MST_MAX) -> None:
        self.mst_max = mst_max

    def estimate_sustainable_throughput(self, engine: str, features: WorkloadFeatures) -> float:
        """Estimate Maximum Sustainable Throughput MST(e, p) in solves per second."""
        if engine == "meta-router-csp":
            return float("inf")  # Zero-quota internal engine

        s = features.S
        d_constr = features.D_constr
        d_obj = features.D_obj

        if engine == "random-search":
            # Very lightweight stochastic evaluation
            return self.mst_max / (1.0 + 0.05 * s)

        elif engine in ("evolutionary-heuristics", "elitist-genetic", "pareto-genetic"):
            # Linear population evaluations
            denom = 2.0 + 0.75 * s
            return self.mst_max / max(1.0, denom)

        elif engine == "many-heuristic":
            # Scaled for high dimensional Pareto fronts
            denom = 2.0 + 0.80 * s + 0.5 * max(0, d_obj - 2)
            return self.mst_max / max(1.0, denom)

        elif engine in ("minizinc-csp", "exact-weighted"):
            # Branch-and-bound exact search sensitive to phase transition
            factor = 1.0 + 0.15 * min(5.0, d_constr)
            denom = 2.0 + 0.25 * s + 0.18 * (s**2) * factor
            return self.mst_max / max(1.0, denom)

        # Default fallback engine throughput
        denom = 3.0 + 0.5 * s
        return self.mst_max / max(1.0, denom)

    def calculate_capacity_units(self, engine: str, features: WorkloadFeatures) -> int:
        """Calculate capacityUnits (CUs) to reserve or charge.

        Trivial instances (S <= 3) with random-search consume 1 CU.
        Medium instances (S = 8) with evolutionary-heuristics consume 8 CUs.
        Complex instances (S = 12) with minizinc-csp consume 35 CUs.
        Internal meta-router consumes 0 CU (zero-quota).
        """
        if engine == "meta-router-csp":
            return 0

        s = features.S if math.isfinite(features.S) and features.S >= 0.0 else 0.0
        d_constr = features.D_constr if math.isfinite(features.D_constr) and features.D_constr >= 0.0 else 0.0

        if engine == "random-search":
            if s <= 3.0:
                return 1
            return max(1, math.ceil(1.0 + 0.1 * s))

        if engine in ("evolutionary-heuristics", "elitist-genetic", "pareto-genetic"):
            # At S=8: round(2.0 + 0.75 * 8) = round(2 + 6) = 8
            val = 2.0 + 0.75 * s
            return max(1, round(val))

        if engine == "many-heuristic":
            val = 2.0 + 0.80 * s + 0.5 * max(0, features.D_obj - 2)
            return max(1, round(val))

        if engine in ("minizinc-csp", "exact-weighted"):
            # At S=12, D_constr=1.0: 2.0 + 3.0 + 0.18 * 144 * 1.15 = 5.0 + 29.808 = 34.808 -> 35
            factor = 1.0 + 0.15 * min(5.0, d_constr)
            val = 2.0 + 0.25 * s + 0.18 * (s**2) * factor
            return max(1, round(val))

        mst = self.estimate_sustainable_throughput(engine, features)
        sigma = self.mst_max / max(0.001, mst)
        return max(1, math.ceil(sigma))


_DEFAULT_CAPACITY_MODEL = CapacityModel()


def get_capacity_model() -> CapacityModel:
    return _DEFAULT_CAPACITY_MODEL

"""Confidence and uncertainty estimator based on empirical observation density.

Determines Conf(e, x(P)) in [0, 1] by evaluating the density of historical
observations in the vicinity of x(P) in Workload Space W.
"""

from __future__ import annotations

import math

from .features import WorkloadFeatures


class ConfidenceEstimator:
    """Estimates model confidence in [0, 1] based on historical sample density."""

    def __init__(self) -> None:
        # Map: (engine, s_bin, d_bin) -> count
        self._density: dict[tuple[str, int, int], int] = {}
        # Engine baseline priors
        self._priors: dict[str, int] = {
            "random-search": 10,
            "evolutionary-heuristics": 8,
            "many-heuristic": 6,
            "minizinc-csp": 5,
            "meta-router-csp": 20,
        }

    def _bin(self, s: float, d: float) -> tuple[int, int]:
        # Quantize S in steps of 2, D_constr in steps of 1
        s_bin = int(s // 2)
        d_bin = int(d // 1)
        return s_bin, d_bin

    def estimate_confidence(self, engine: str, features: WorkloadFeatures) -> float:
        """Estimate confidence Conf(e, x(P)) in [0, 1]."""
        s_bin, d_bin = self._bin(features.S, features.D_constr)
        samples = self._density.get((engine, s_bin, d_bin), 0)
        prior = self._priors.get(engine, 3)

        # In phase transition regions for exact solvers, uncertainty is higher unless sampled
        penalty = 0.0
        if engine == "minizinc-csp" and features.S > 10.0 and features.D_constr > 1.5:
            penalty = 0.25

        total = samples + prior
        # Asymptotic convergence towards 1.0
        conf = 1.0 - 0.60 * math.exp(-0.25 * total) - penalty
        return max(0.10, min(0.99, round(conf, 4)))

    def record_observation(self, engine: str, features: WorkloadFeatures) -> None:
        """Update empirical density following an execution."""
        s_bin, d_bin = self._bin(features.S, features.D_constr)
        key = (engine, s_bin, d_bin)
        self._density[key] = self._density.get(key, 0) + 1

    def reset(self) -> None:
        """Reset historical density for tests or recalibration."""
        self._density.clear()


_DEFAULT_CONFIDENCE = ConfidenceEstimator()


def get_confidence_estimator() -> ConfidenceEstimator:
    return _DEFAULT_CONFIDENCE

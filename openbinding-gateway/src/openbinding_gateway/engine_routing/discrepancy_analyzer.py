"""Discrepancy analysis and concept drift detection on telemetry residuals.

Calculates residuals between predicted and actual metrics:
    e_L = |L^(e, P) - tau_actual|
    e_Q = |Q^(e, P) - Q_actual|
    e_R = |R^(e, P) - R_actual|

Detects concept drift using cumulative sum (CUSUM) and marks engines DEGRADED
when sustained divergence is observed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .health_monitor import get_health_monitor


@dataclass(frozen=True)
class DiscrepancyResult:
    residual_latency: float
    residual_quality: float
    residual_credits: int
    is_drift_detected: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "residualLatency": round(self.residual_latency, 3),
            "residualQuality": round(self.residual_quality, 3),
            "residualCredits": self.residual_credits,
            "conceptDriftDetected": self.is_drift_detected,
        }


class DiscrepancyAnalyzer:
    """Computes prediction errors and monitors for concept drift."""

    def __init__(self, drift_threshold: float = 5.0) -> None:
        self.drift_threshold = drift_threshold
        # engine -> running cumulative sum of positive standardized residuals
        self._cusum_pos: dict[str, float] = {}

    def analyze(
        self,
        engine: str,
        predicted: dict[str, Any],
        actual_latency: float,
        actual_quality: float,
        actual_credits: int,
    ) -> DiscrepancyResult:
        pred_lat = float(predicted.get("latency", actual_latency))
        pred_q = float(predicted.get("quality", actual_quality))
        pred_credits = int(predicted.get("credits", actual_credits))

        e_l = abs(pred_lat - actual_latency)
        e_q = abs(pred_q - actual_quality)
        e_r = abs(pred_credits - actual_credits)

        # CUSUM on latency over-runs (actual much slower than predicted)
        slack = 0.5  # allowable margin in seconds
        delta = (actual_latency - pred_lat) - slack
        current_cusum = max(0.0, self._cusum_pos.get(engine, 0.0) + delta)
        self._cusum_pos[engine] = current_cusum

        is_drift = current_cusum > self.drift_threshold
        if is_drift:
            # Concept drift: notify health monitor of degradation
            get_health_monitor().force_status(engine, "DEGRADED")

        return DiscrepancyResult(
            residual_latency=e_l,
            residual_quality=e_q,
            residual_credits=e_r,
            is_drift_detected=is_drift,
        )

    def reset(self, engine: str | None = None) -> None:
        if engine:
            self._cusum_pos.pop(engine, None)
        else:
            self._cusum_pos.clear()


_DEFAULT_DISCREPANCY = DiscrepancyAnalyzer()


def get_discrepancy_analyzer() -> DiscrepancyAnalyzer:
    return _DEFAULT_DISCREPANCY

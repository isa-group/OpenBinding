"""Engine health, active concurrency, and degradation monitor.

Tracks:
- Availability: A_e
- Active concurrency: C_e
- Error rate in 5-minute sliding window: F_e,5m
- p95 observed latency
- Status: HEALTHY, DEGRADED, UNAVAILABLE
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Literal

HealthStatus = Literal["HEALTHY", "DEGRADED", "UNAVAILABLE"]

WINDOW_SECONDS = 300.0  # 5 minutes


@dataclass
class EngineHealthSnapshot:
    engine: str
    available: bool
    active_jobs: int
    health_status: HealthStatus
    recent_failure_rate: float
    p95_latency: float
    confidence: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "activeJobs": self.active_jobs,
            "healthStatus": self.health_status,
            "recentFailureRate": round(self.recent_failure_rate, 3),
            "p95Latency": round(self.p95_latency, 3),
            "confidence": round(self.confidence, 3),
        }


class EngineHealthMonitor:
    """Tracks runtime state, concurrency and health transitions for engines."""

    def __init__(self) -> None:
        self._active_jobs: dict[str, int] = {}
        # engine -> deque of (timestamp, success: bool, latency: float)
        self._history: dict[str, deque[tuple[float, bool, float]]] = {}
        # explicitly degraded overrides
        self._forced_status: dict[str, HealthStatus] = {}

    def record_job_start(self, engine: str) -> None:
        self._active_jobs[engine] = self._active_jobs.get(engine, 0) + 1

    def record_job_completion(self, engine: str, latency: float, success: bool) -> None:
        self._active_jobs[engine] = max(0, self._active_jobs.get(engine, 1) - 1)
        now = time.monotonic()
        if engine not in self._history:
            self._history[engine] = deque(maxlen=200)
        self._history[engine].append((now, success, latency))

    def force_status(self, engine: str, status: HealthStatus | None) -> None:
        """Explicitly override status for test injection or operator override."""
        if status is None:
            self._forced_status.pop(engine, None)
        else:
            self._forced_status[engine] = status

    def get_health(self, engine: str, confidence: float = 0.90) -> EngineHealthSnapshot:
        if engine in self._forced_status:
            status = self._forced_status[engine]
            return EngineHealthSnapshot(
                engine=engine,
                available=(status != "UNAVAILABLE"),
                active_jobs=self._active_jobs.get(engine, 0),
                health_status=status,
                recent_failure_rate=1.0 if status == "DEGRADED" else 0.0,
                p95_latency=0.0,
                confidence=confidence,
            )

        now = time.monotonic()
        history = self._history.get(engine, deque())
        # Filter window
        recent = [entry for entry in history if now - entry[0] <= WINDOW_SECONDS]

        if not recent:
            return EngineHealthSnapshot(
                engine=engine,
                available=True,
                active_jobs=self._active_jobs.get(engine, 0),
                health_status="HEALTHY",
                recent_failure_rate=0.0,
                p95_latency=0.0,
                confidence=confidence,
            )

        failures = sum(1 for _, success, _ in recent if not success)
        failure_rate = failures / len(recent)

        latencies = sorted(lat for _, _, lat in recent)
        p95_index = int(0.95 * (len(latencies) - 1))
        p95 = latencies[p95_index] if latencies else 0.0

        # Automatic transition to DEGRADED if failure rate >= 0.50 (at least 3 runs)
        if len(recent) >= 3 and failure_rate >= 0.50:
            status: HealthStatus = "DEGRADED"
        else:
            status = "HEALTHY"

        return EngineHealthSnapshot(
            engine=engine,
            available=True,
            active_jobs=self._active_jobs.get(engine, 0),
            health_status=status,
            recent_failure_rate=failure_rate,
            p95_latency=p95,
            confidence=confidence,
        )

    def is_available(self, engine: str) -> bool:
        snapshot = self.get_health(engine)
        return snapshot.available and snapshot.health_status != "UNAVAILABLE"

    def is_healthy(self, engine: str) -> bool:
        snapshot = self.get_health(engine)
        return snapshot.health_status == "HEALTHY"

    def get_all_snapshots(self) -> dict[str, dict[str, Any]]:
        known_engines = {"minizinc-csp", "evolutionary-heuristics", "random-search", "many-heuristic"}
        known_engines.update(self._active_jobs.keys())
        known_engines.update(self._history.keys())
        known_engines.update(self._forced_status.keys())

        return {engine: self.get_health(engine).to_dict() for engine in sorted(known_engines)}

    def reset(self) -> None:
        """Clear all active jobs, history, and forced statuses."""
        self._active_jobs.clear()
        self._history.clear()
        self._forced_status.clear()


_DEFAULT_HEALTH_MONITOR = EngineHealthMonitor()


def get_health_monitor() -> EngineHealthMonitor:
    return _DEFAULT_HEALTH_MONITOR

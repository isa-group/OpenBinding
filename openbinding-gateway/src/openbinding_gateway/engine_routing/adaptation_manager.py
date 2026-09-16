"""Central MAPE-K Adaptation Manager for Self-Adaptive Engine Selection.

Coordinates:
- Monitor (M): instance combinatorial features, engine health and telemetry.
- Analyze (A): analytical profiler, confidence estimator and discrepancy detector.
- Plan (P): hard constraints filtering and Meta-QACO 1-task optimization.
- Execute (E): zero-quota router dispatch and capacity reservation.
- Knowledge (K): persistent AdaptationObservation records and online calibration.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AdaptationObservation, utcnow
from .capacity_model import get_capacity_model
from .confidence import get_confidence_estimator
from .discrepancy_analyzer import get_discrepancy_analyzer
from .features import WorkloadFeatures, extract_features
from .health_monitor import get_health_monitor
from .meta_qaco import get_meta_qaco_solver
from .profiler import get_engine_profiler

logger = logging.getLogger(__name__)

BUILTIN_CANDIDATE_ENGINES = [
    "evolutionary-heuristics",
    "minizinc-csp",
    "random-search",
    "many-heuristic",
]


@dataclass(frozen=True)
class RoutingPlanResult:
    selected_engine: str
    selected_mode: str
    credits_cost: int
    adaptation_loop_id: str
    provenance_user: dict[str, Any]
    provenance_admin: dict[str, Any]
    fallback_engine: str | None


class AdaptationManager:
    """Central orchestrator implementing the autonomic MAPE-K loop."""

    def __init__(self) -> None:
        self.profiler = get_engine_profiler()
        self.capacity_model = get_capacity_model()
        self.health_monitor = get_health_monitor()
        self.confidence_estimator = get_confidence_estimator()
        self.discrepancy_analyzer = get_discrepancy_analyzer()
        self.meta_qaco = get_meta_qaco_solver()

    async def plan_routing(
        self,
        problem: Any,
        options: dict[str, Any] | None = None,
        candidate_engines: list[str] | None = None,
        service_url: str | None = None,
    ) -> RoutingPlanResult:
        """Execute M -> A -> P phases to select the optimal engine."""
        opts = options or {}
        routing_opts = opts.get("routing", {})
        adaptation_loop_id = f"adp-{uuid.uuid4().hex[:12]}"

        # --- MONITOR (M) ---
        features = extract_features(problem, opts)
        engine_pool = candidate_engines or BUILTIN_CANDIDATE_ENGINES

        # --- ANALYZE (A) ---
        profiles = []
        health_snapshots = {}
        confidences = {}

        for eng in engine_pool:
            prof = self.profiler.profile(eng, None, features)
            profiles.append(prof)
            conf = self.confidence_estimator.estimate_confidence(eng, features)
            confidences[eng] = conf
            health = self.health_monitor.get_health(eng, confidence=conf)
            health_snapshots[eng] = health

        # --- PLAN (P) ---
        decision = await self.meta_qaco.solve(
            profiles=profiles,
            health_snapshots=health_snapshots,
            confidences=confidences,
            routing_options=routing_opts,
            service_url=service_url,
            features=features,
        )

        # Build concise user provenance
        provenance_user = {
            "selectedEngine": decision.selected_engine,
            "selectedMode": decision.selected_mode,
            "adaptationReason": decision.explanation,
            "utilityScore": round(decision.utility_score, 3),
            "creditsCost": decision.credits_cost,
        }

        # Build comprehensive admin provenance
        provenance_admin = {
            "adaptationLoopId": adaptation_loop_id,
            "workloadFeatures": features.to_dict(),
            "engineHealthSnapshot": {
                eng: snap.to_dict() for eng, snap in health_snapshots.items()
            },
            "candidateEvaluations": [
                cand.to_dict() for cand in decision.candidate_evaluations
            ],
            "fallbackEngine": decision.fallback_engine,
            "actualExecution": None,
        }

        return RoutingPlanResult(
            selected_engine=decision.selected_engine,
            selected_mode=decision.selected_mode,
            credits_cost=decision.credits_cost,
            adaptation_loop_id=adaptation_loop_id,
            provenance_user=provenance_user,
            provenance_admin=provenance_admin,
            fallback_engine=decision.fallback_engine,
        )

    async def observe_execution(
        self,
        adaptation_loop_id: str,
        engine: str,
        features_dict: dict[str, Any],
        predicted_metrics: dict[str, Any],
        actual_latency: float,
        actual_quality: float,
        actual_credits: int,
        outcome: str = "completed",
        candidate_evaluations: list[dict[str, Any]] | None = None,
        engine_health_snapshot: dict[str, Any] | None = None,
        job_id: uuid.UUID | None = None,
        session: AsyncSession | None = None,
    ) -> AdaptationObservation | None:
        """Execute E -> A -> K phase: capture telemetry, compute residuals and persist."""
        success = (outcome in ("completed", "OPTIMAL", "FEASIBLE"))

        # Monitor: record completion in health monitor
        self.health_monitor.record_job_completion(engine, actual_latency, success=success)

        # Analyze: discrepancy and drift analysis
        discrepancy = self.discrepancy_analyzer.analyze(
            engine=engine,
            predicted=predicted_metrics,
            actual_latency=actual_latency,
            actual_quality=actual_quality,
            actual_credits=actual_credits,
        )

        # Reconstruct features to update empirical confidence density
        features = WorkloadFeatures(
            S=float(features_dict.get("S", 0.0)),
            D_constr=float(features_dict.get("D_constr", 0.0)),
            N_tasks=int(features_dict.get("N_tasks", 1)),
            N_cap=int(features_dict.get("N_cap", 1)),
            opt_mode=str(features_dict.get("OptMode", "weighted")),
            D_obj=int(features_dict.get("D_obj", 1)),
            T_budget=float(features_dict.get("T_budget", 30.0)),
        )
        self.confidence_estimator.record_observation(engine, features)

        actual_dict = {
            "actualLatency": round(actual_latency, 3),
            "actualQuality": round(actual_quality, 3),
            "actualCredits": actual_credits,
        }

        observation = AdaptationObservation(
            job_id=job_id,
            adaptation_loop_id=adaptation_loop_id,
            engine_selected=engine,
            workload_features=features_dict,
            candidate_evaluations=candidate_evaluations or [],
            predicted_metrics=predicted_metrics,
            actual_metrics=actual_dict,
            residuals=discrepancy.to_dict(),
            outcome=outcome,
            engine_health_snapshot=engine_health_snapshot or {},
        )

        if session is not None:
            session.add(observation)
            try:
                await session.flush()
            except Exception as exc:
                logger.warning("Failed to persist AdaptationObservation: %s", exc)

        return observation

    async def recalibrate(self, session: AsyncSession | None = None) -> dict[str, Any]:
        """Recalibrate model coefficients and empirical confidence from observations."""
        count = 0
        if session is not None:
            result = await session.execute(select(AdaptationObservation))
            rows = result.scalars().all()
            count = len(rows)
            for row in rows:
                f_dict = row.workload_features or {}
                features = WorkloadFeatures(
                    S=float(f_dict.get("S", 0.0)),
                    D_constr=float(f_dict.get("D_constr", 0.0)),
                    N_tasks=int(f_dict.get("N_tasks", 1)),
                    N_cap=int(f_dict.get("N_cap", 1)),
                    opt_mode=str(f_dict.get("OptMode", "weighted")),
                    D_obj=int(f_dict.get("D_obj", 1)),
                    T_budget=float(f_dict.get("T_budget", 30.0)),
                )
                self.confidence_estimator.record_observation(row.engine_selected, features)

        return {
            "status": "recalibrated",
            "recalibratedAt": utcnow().isoformat(),
            "observationsProcessed": count,
            "calibratedEngines": BUILTIN_CANDIDATE_ENGINES,
        }


_DEFAULT_ADAPTATION_MANAGER = AdaptationManager()


def get_adaptation_manager() -> AdaptationManager:
    return _DEFAULT_ADAPTATION_MANAGER

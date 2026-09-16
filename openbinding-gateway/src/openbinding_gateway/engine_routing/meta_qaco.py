"""Meta-QACO solver and ephemeral 1-task multi-criteria optimizer.

Evaluates hard constraints and applies Simple Additive Weighting (SAW)
to rank engine candidates according to user preferences:
    Maximize: w_Q * Q - w_L * (L / L_max) - w_R * (R / R_max) - w_F * F
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .capacity_model import get_capacity_model
from .client import get_meta_router_client
from .features import WorkloadFeatures
from .health_monitor import EngineHealthSnapshot
from .profiler import EngineProfile


@dataclass(frozen=True)
class CandidateEvaluationResult:
    engine: str
    mode: str
    admissible: bool
    rejection_reason: str | None
    utility: float | None
    predicted: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "engine": self.engine,
            "mode": self.mode,
            "admissible": self.admissible,
            "predicted": self.predicted,
        }
        if self.rejection_reason is not None:
            data["rejectionReason"] = self.rejection_reason
        if self.utility is not None:
            data["utility"] = self.utility
        return data


@dataclass(frozen=True)
class MetaQacoDecision:
    selected_engine: str
    selected_mode: str
    utility_score: float
    credits_cost: int
    fallback_engine: str | None
    candidate_evaluations: list[CandidateEvaluationResult]
    explanation: str


class MetaQacoSolver:
    """Solves 1-task engine selection problem with hard and soft goals."""

    def __init__(self) -> None:
        self.client = get_meta_router_client()

    async def solve(
        self,
        profiles: list[EngineProfile],
        health_snapshots: dict[str, EngineHealthSnapshot],
        confidences: dict[str, float],
        routing_options: dict[str, Any] | None = None,
        service_url: str | None = None,
        features: WorkloadFeatures | None = None,
    ) -> MetaQacoDecision:
        opts = routing_options or {}
        hard_constraints = opts.get("hardConstraints", {})
        soft_prefs = opts.get("softPreferences", {})
        weights = soft_prefs.get("weights", {})

        max_budget_ms = hard_constraints.get("maxTimeBudgetMs")
        max_time_s = float(max_budget_ms) / 1000.0 if max_budget_ms is not None else 3600.0
        max_credits = hard_constraints.get("maxCredits")
        max_credits_val = float(max_credits) if max_credits is not None else float("inf")
        min_quality = float(hard_constraints.get("minQuality", 0.0))
        require_exact = bool(hard_constraints.get("requireExact", False))
        min_confidence = float(hard_constraints.get("minConfidence", 0.0))
        max_failure_risk = float(hard_constraints.get("maxFailureRisk", 0.50))

        w_q = float(weights.get("quality", 0.40))
        w_l = float(weights.get("latency", 0.30))
        w_c = float(weights.get("costCredits", 0.20))
        w_r = float(weights.get("reliability", 0.10))

        capacity_model = get_capacity_model()

        # Build candidate request structures with active queue wait modeling
        candidates_payload = []
        effective_latencies: dict[str, tuple[float, float]] = {}  # engine -> (effective_latency, queue_wait)

        for p in profiles:
            health = health_snapshots.get(p.engine)
            is_available = health.available and health.health_status != "DEGRADED" if health else True
            conf = confidences.get(p.engine, 0.85)

            active_jobs = health.active_jobs if health else 0
            if active_jobs > 0:
                mst = capacity_model.estimate_sustainable_throughput(p.engine, features) if features else capacity_model.mst_max
                queue_wait = active_jobs / max(0.01, mst)
            else:
                queue_wait = 0.0

            effective_lat = p.latency + queue_wait
            effective_latencies[p.engine] = (effective_lat, queue_wait)

            candidates_payload.append({
                "engine": p.engine,
                "mode": p.mode,
                "latency": round(effective_lat, 3),
                "quality": p.quality,
                "failureRisk": p.failure_risk,
                "credits": p.credits,
                "confidence": conf,
                "isExact": p.is_exact,
                "isAvailable": is_available,
            })

        req_body = {
            "candidates": candidates_payload,
            "hardConstraints": {
                "maxTimeBudgetMs": max_budget_ms,
                "maxCredits": max_credits,
                "minQuality": min_quality,
                "requireExact": require_exact,
                "minConfidence": min_confidence,
                "maxFailureRisk": max_failure_risk,
            },
            "weights": {
                "quality": w_q,
                "latency": w_l,
                "costCredits": w_c,
                "reliability": w_r,
            },
        }

        # Attempt dispatch to MiniZinc meta-router-csp service if available
        remote_result = None
        if service_url:
            remote_result = await self.client.solve_routing(service_url, req_body)

        if remote_result and remote_result.get("termination") == "OPTIMAL" and remote_result.get("selected"):
            selected_raw = remote_result["selected"]
            fallback_raw = remote_result.get("fallback")
            evaluations = [
                CandidateEvaluationResult(
                    engine=item["engine"],
                    mode=item["mode"],
                    admissible=item["admissible"],
                    rejection_reason=item.get("rejectionReason"),
                    utility=item.get("utility"),
                    predicted=item.get("predicted", {}),
                )
                for item in remote_result.get("evaluations", [])
            ]
            return MetaQacoDecision(
                selected_engine=selected_raw["engine"],
                selected_mode=selected_raw["mode"],
                utility_score=float(selected_raw.get("utility", 0.90)),
                credits_cost=int(selected_raw.get("predicted", {}).get("credits", 1)),
                fallback_engine=fallback_raw.get("engine") if fallback_raw else None,
                candidate_evaluations=evaluations,
                explanation=remote_result.get("explanation", "Selected by MiniZinc meta-router-csp"),
            )

        # Local deterministic evaluation (exact fallback)
        max_obs_latency = max(1.0, max(effective_latencies.get(p.engine, (p.latency, 0.0))[0] for p in profiles)) if profiles else 1.0
        max_obs_credits = max(1.0, max(p.credits for p in profiles)) if profiles else 1.0

        evaluations_list: list[CandidateEvaluationResult] = []
        admissible_list: list[tuple[float, EngineProfile, CandidateEvaluationResult]] = []

        for p in profiles:
            health = health_snapshots.get(p.engine)
            is_available = health.available and health.health_status != "DEGRADED" if health else True
            conf = confidences.get(p.engine, 0.85)
            effective_lat, queue_wait = effective_latencies.get(p.engine, (p.latency, 0.0))

            reasons: list[str] = []
            if not is_available:
                status_str = health.health_status if health else "UNAVAILABLE"
                reasons.append(f"Engine health is {status_str}")
            if effective_lat > max_time_s:
                if queue_wait > 0.0:
                    reasons.append(
                        f"Predicted effective latency {effective_lat:.2f}s (solve: {p.latency:.2f}s, queue wait: {queue_wait:.2f}s) exceeds time budget {max_time_s:.2f}s"
                    )
                else:
                    reasons.append(f"Predicted latency {p.latency:.2f}s exceeds time budget {max_time_s:.2f}s")
            if p.credits > max_credits_val:
                reasons.append(f"Predicted credits {p.credits} exceeds maxCredits {max_credits_val}")
            if p.quality < min_quality:
                reasons.append(f"Expected quality {p.quality:.2f} below minimum {min_quality:.2f}")
            if p.failure_risk > max_failure_risk:
                reasons.append(f"Failure risk {p.failure_risk:.2f} exceeds threshold {max_failure_risk:.2f}")
            if conf < min_confidence:
                reasons.append(f"Confidence {conf:.2f} below minimum {min_confidence:.2f}")
            if require_exact and not p.is_exact:
                reasons.append("Exact algorithm required but engine is heuristic")

            is_adm = (len(reasons) == 0)
            predicted_data = {
                "latency": round(effective_lat, 3),
                "solveLatency": round(p.latency, 3),
                "queueWait": round(queue_wait, 3),
                "activeJobs": health.active_jobs if health else 0,
                "quality": round(p.quality, 3),
                "failureRisk": round(p.failure_risk, 3),
                "credits": p.credits,
                "confidence": round(conf, 3),
            }

            if not is_adm:
                eval_res = CandidateEvaluationResult(
                    engine=p.engine,
                    mode=p.mode,
                    admissible=False,
                    rejection_reason="; ".join(reasons),
                    utility=None,
                    predicted=predicted_data,
                )
                evaluations_list.append(eval_res)
            else:
                norm_lat = effective_lat / max_obs_latency
                norm_cred = p.credits / max_obs_credits
                utility = w_q * p.quality - w_l * norm_lat - w_c * norm_cred - w_r * p.failure_risk
                rounded_u = round(utility, 4)
                eval_res = CandidateEvaluationResult(
                    engine=p.engine,
                    mode=p.mode,
                    admissible=True,
                    rejection_reason=None,
                    utility=rounded_u,
                    predicted=predicted_data,
                )
                evaluations_list.append(eval_res)
                admissible_list.append((rounded_u, p, eval_res))

        if not admissible_list:
            # If all rejected, select safest baseline with lowest capacity cost
            safest = min(profiles, key=lambda p: p.credits)
            return MetaQacoDecision(
                selected_engine=safest.engine,
                selected_mode=safest.mode,
                utility_score=0.0,
                credits_cost=safest.credits,
                fallback_engine=None,
                candidate_evaluations=evaluations_list,
                explanation="All engines violated hard constraints; fallback to default",
            )

        # Sort descending by utility
        admissible_list.sort(key=lambda x: x[0], reverse=True)
        best_u, best_p, best_res = admissible_list[0]
        fallback_p = admissible_list[1][1] if len(admissible_list) > 1 else None

        reason_text = (
            f"Selected to optimize QoS preferences (expected quality: {best_p.quality:.0%}, "
            f"cost: {best_p.credits} CUs, latency: {best_p.latency:.2f}s)"
        )

        return MetaQacoDecision(
            selected_engine=best_p.engine,
            selected_mode=best_p.mode,
            utility_score=best_u,
            credits_cost=best_p.credits,
            fallback_engine=fallback_p.engine if fallback_p else None,
            candidate_evaluations=evaluations_list,
            explanation=reason_text,
        )


_DEFAULT_META_QACO = MetaQacoSolver()


def get_meta_qaco_solver() -> MetaQacoSolver:
    return _DEFAULT_META_QACO

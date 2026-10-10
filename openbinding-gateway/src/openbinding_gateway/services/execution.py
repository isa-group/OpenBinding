"""Execution of persisted jobs: claim, solve, reevaluate and settle."""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Mapping

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import space_client
from ..access import metering
from ..core.settings import get_settings
from ..db import base as db_base
from ..db.models import (
    EngineCredential,
    EngineRegistrationRevision,
    Job,
    JobState,
    utcnow,
)
from ..v1.canonical import digest
from ..v1.compiler import BindingProblem
from ..v1.remote import RemoteEngineError, RemoteRegistration, solve_remote
from .engines import (
    MANIFEST_DIR,
    builtin_engine_registration,
    installed_builtin_registration,
    persisted_engine_contract,
    persisted_mode_contract,
    registration_transport,
)

logger = logging.getLogger(__name__)


def candidate_ref(value: Any) -> tuple[str, str] | None:
    if not isinstance(value, dict) or set(value) != {"resource", "id"}:
        return None
    if not isinstance(value.get("resource"), str) or not isinstance(value.get("id"), str):
        return None
    return value["resource"], value["id"]


def binding_violations(problem: BindingProblem, binding: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        problem.validate_binding(binding)
    except (KeyError, TypeError, ValueError) as exc:
        return [{"code": "binding_invalid", "message": str(exc), "enforcement": "hard"}]
    return []


def authoritative_evaluation(
    problem: BindingProblem, binding: dict[str, Any], execution: Mapping[str, Any] | None = None
) -> tuple[dict[str, float], dict[str, Any], list[dict[str, Any]]]:
    """Reevaluate a returned decision against the gateway's canonical IR."""
    violations = binding_violations(problem, binding)
    feature_definitions = problem.document["spec"].get("application", {}).get("features", {})
    empty_features = (
        {feature_id: 0.0 for feature_id in feature_definitions}
        if isinstance(feature_definitions, dict)
        else {}
    )
    if violations:
        return empty_features, {}, violations
    try:
        evaluation = problem.evaluate(binding, execution)
        features = evaluation["features"]
        objectives = evaluation["objectives"]
        violations.extend(evaluation["violations"])
    except (ArithmeticError, KeyError, TypeError, ValueError) as exc:
        features = empty_features
        objectives = {}
        violations.append({"code": "binding_evaluation", "message": str(exc), "enforcement": "hard"})
    return features, objectives, violations


def reevaluate_result(
    problem: BindingProblem,
    result: dict[str, Any],
    execution: Mapping[str, Any] | None = None,
    allowed_terminations: list[str] | tuple[str, ...] | set[str] = ("FEASIBLE", "UNKNOWN"),
) -> dict[str, Any]:
    """Replace engine-reported QoS fields with authoritative gateway values."""
    solutions: list[dict[str, Any]] = []
    invalid = False
    for item in result.get("solutions", []) if isinstance(result.get("solutions"), list) else []:
        decision = item.get("decision") if isinstance(item, dict) else None
        binding = decision.get("binding") if isinstance(decision, dict) else None
        if (
            not isinstance(decision, dict)
            or decision.get("kind") != "binding"
            or not isinstance(binding, dict)
            or any(not isinstance(key, str) or candidate_ref(value) is None for key, value in binding.items())
        ):
            invalid = True
            continue
        features, objectives, violations = authoritative_evaluation(problem, binding, execution)
        if not objectives and (problem.document["spec"]["optimization"].get("criteria") or violations):
            invalid = True
            continue
        soft_by_ref = {
            candidate_ref(entry["constraint"]): float(entry.get("penalty", 0.0))
            for entry in violations
            if entry.get("enforcement") == "soft"
            and candidate_ref(entry.get("constraint")) is not None
        }
        penalties = [
            soft_by_ref.get(candidate_ref(item["constraint"]), 0.0) * float(item["weight"])
            for item in problem.document["spec"]["optimization"].get("penalties", [])
        ]
        solutions.append({
            "decision": {"kind": "binding", "binding": binding},
            "features": features,
            "objectives": objectives,
            "penalties": penalties,
            "violations": violations,
        })
        if any(entry.get("enforcement") == "hard" for entry in violations):
            invalid = True
    termination = result.get("termination")
    if termination not in {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"} or invalid:
        termination = "UNKNOWN"
    declared_terminations = {
        value
        for value in allowed_terminations
        if value in {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"}
    }
    if termination != "UNKNOWN" and termination not in declared_terminations:
        termination = "UNKNOWN"
    if not solutions and termination in {"OPTIMAL", "FEASIBLE"}:
        termination = "UNKNOWN"
    if termination == "INFEASIBLE" and solutions:
        termination = "UNKNOWN"
    return {"termination": termination, "solutions": solutions, "provenance": result.get("provenance", {})}


async def _settle_and_commit(
    session: AsyncSession, job_id: uuid.UUID, *, solver_seconds: float, outcome: str
) -> None:
    """Charge a job that just ended and make it durable at once.

    SPACE is told before the row is confirmed, so the commit follows the charge
    immediately; a failure to commit raises ``SettlementCommitFailed`` with the
    charge remembered. A SPACE refusal is only logged: the job keeps its outcome
    and the reconciler settles it later.
    """
    try:
        settled = await metering.settle(
            space_client.get_gate(), session, job_id, solver_seconds=solver_seconds
        )
    except metering.SettlementCommitFailed:
        raise
    except Exception as exc:
        logger.warning("Metering settlement failed for %s job %s: %s", outcome, job_id, exc)
        return
    if settled:
        await metering.commit_settlement(session)


async def fail_persisted_job(
    job: Job,
    session: AsyncSession,
    message: str,
    started: float,
) -> None:
    if not await metering.hold_lease(session, job.id, metering.held_token(session, job.id)):
        # The reconciler took the job back, so the outcome of this attempt is
        # not the job's outcome. Whatever was staged is discarded, unsettled.
        logger.warning("Lost the lease on job %s; not recording its failure", job.id)
        await session.rollback()
        return
    job.state = JobState.FAILED
    job.lease_token = None
    job.lease_until = None
    job.result = {
        "termination": "UNKNOWN",
        "solutions": [],
        "error": message,
        "provenance": job.provenance or {},
    }
    job.termination = "UNKNOWN"
    job.finished_at = utcnow()
    await _settle_and_commit(
        session, job.id, solver_seconds=max(0.0, time.monotonic() - started), outcome="failed"
    )
    from ..telemetry import record_job_failure
    try:
        await record_job_failure(session, job, message)
    except Exception:
        pass

    # Record MAPE-K failure observation if this was an auto-routed job
    prov = job.provenance or {}
    routing_admin = prov.get("engineRoutingAdmin")
    if isinstance(routing_admin, dict) and "adaptationLoopId" in routing_admin:
        try:
            from ..engine_routing import get_adaptation_manager

            adaptation_loop_id = routing_admin["adaptationLoopId"]
            features_dict = routing_admin.get("workloadFeatures", {})
            predicted = routing_admin.get("candidateEvaluations", [])
            pred_for_selected = next(
                (c.get("predicted", {}) for c in predicted if c.get("engine") == job.engine_id),
                {},
            )
            actual_latency = max(0.0, time.monotonic() - started)
            actual_credits = int(prov.get("engineRouting", {}).get("creditsCost", 1))

            await get_adaptation_manager().observe_execution(
                adaptation_loop_id=adaptation_loop_id,
                engine=job.engine_id,
                features_dict=features_dict,
                predicted_metrics=pred_for_selected,
                actual_latency=actual_latency,
                actual_quality=0.0,
                actual_credits=actual_credits,
                outcome="failed",
                candidate_evaluations=predicted,
                engine_health_snapshot=routing_admin.get("engineHealthSnapshot"),
                job_id=job.id,
                session=session,
            )
        except Exception as obs_exc:
            logger.warning("Failed to record adaptation observation for failed job %s: %s", job.id, obs_exc)

    await session.flush()


async def finish_persisted_job(job_id: str, session: AsyncSession) -> None:
    """Dispatch a persisted BIM v1 job using only its stored canonical IR."""
    try:
        parsed = uuid.UUID(job_id)
    except ValueError:
        return
    token = await metering.claim_job(session, parsed)
    if token is None:
        return
    try:
        await session.commit()
    except Exception:
        # Whether the claim reached the database is unknown, and this worker
        # must not act as if it held a lease it may not have: forget the token
        # and let the job be redelivered or its lease lapse.
        session.info.pop(metering.lease_key(parsed), None)
        try:
            await session.rollback()
        except Exception:
            logger.warning("Could not roll back after a failed claim of job %s", parsed, exc_info=True)
        raise

    # The lease runs out unless it is renewed, which is how the reconciler
    # tells a worker that died from one that is still solving.
    heartbeat = metering.start_heartbeat(session, parsed, token)
    try:
        await run_claimed_job(parsed, session)
        # The outcome is durable before the lease stops being renewed.
        await session.commit()
    finally:
        await metering.stop_heartbeat(heartbeat)


async def run_claimed_job(parsed: uuid.UUID, session: AsyncSession) -> None:
    if not await metering.hold_lease(session, parsed, metering.held_token(session, parsed)):
        logger.warning("Job %s is not held by this worker; not running it", parsed)
        await session.rollback()
        return
    job = await session.get(Job, parsed, populate_existing=True)
    if job is None:
        return
    if job.cancellation_requested:
        job.state = JobState.CANCELLED
        job.lease_token = None
        job.lease_until = None
        job.finished_at = utcnow()
        await _settle_and_commit(session, job.id, solver_seconds=0, outcome="cancelled")
        await session.flush()
        return
    started = time.monotonic()
    try:
        request = job.original_request or {}
        document = request.get("bindingProblem")
        if not isinstance(document, dict):
            await fail_persisted_job(job, session, "persisted BindingProblem is missing", started)
            return
        problem = BindingProblem(
            document=document,
            digest=job.provenance.get("irDigest", digest(document)) if isinstance(job.provenance, dict) else digest(document),
            source_map=document.get("spec", {}).get("sourceMap", {}) if isinstance(document.get("spec"), dict) else {},
        )
        mode_contract = persisted_mode_contract(request.get("mode"))
        if mode_contract is None:
            await fail_persisted_job(job, session, "Persisted Engine mode contract is invalid", started)
            return
        if not isinstance(job.options, dict):
            await fail_persisted_job(job, session, "Persisted Engine options must be an object", started)
            return
        provenance = job.provenance if isinstance(job.provenance, dict) else {}
        engine_ref = provenance.get("engine")
        manifest = await persisted_engine_contract(
            job.engine_id,
            engine_ref,
            mode_contract,
            session,
            job.owner_id,
        )
        if (
            manifest is None
            or provenance.get("engineDigest") != digest(manifest)
            or provenance.get("mode") != mode_contract["id"]
            or provenance.get("terminationGuarantees")
            != mode_contract["terminationGuarantees"]
        ):
            await fail_persisted_job(job, session, "Persisted Engine mode contract is inconsistent", started)
            return
        registration_ref = request.get("registration")
        if (
            not isinstance(registration_ref, dict)
            or set(registration_ref) != {"namespace", "name", "version", "digest"}
            or not all(isinstance(value, str) and value for value in registration_ref.values())
        ):
            await fail_persisted_job(job, session, "Persisted EngineRegistration reference is invalid", started)
            return

        registration: EngineRegistrationRevision | dict[str, Any] | None = None
        if registration_ref["namespace"] == "bim.builtin" and isinstance(engine_ref, dict):
            registration = installed_builtin_registration(
                manifest,
                get_settings().engine_urls.get(job.engine_id),
                registration_ref,
            )
        if registration is None:
            registration = (
                await session.execute(
                    select(EngineRegistrationRevision).where(
                        EngineRegistrationRevision.namespace == registration_ref["namespace"],
                        EngineRegistrationRevision.name == registration_ref["name"],
                        EngineRegistrationRevision.version == registration_ref["version"],
                        EngineRegistrationRevision.manifest_digest == registration_ref["digest"],
                        or_(
                            (
                                (EngineRegistrationRevision.owner_id == job.owner_id)
                                & EngineRegistrationRevision.is_active.is_(True)
                            ),
                            (
                                (EngineRegistrationRevision.owner_id != job.owner_id)
                                & (
                                    EngineRegistrationRevision.publication_status
                                    == "published"
                                )
                            ),
                        ),
                    )
                )
            ).scalars().first()
        if registration is None:
            await fail_persisted_job(job, session, "Engine registration is no longer active", started)
            return

        registered_engine_digest = (
            registration.engine_digest
            if isinstance(registration, EngineRegistrationRevision)
            else registration.get("document", {}).get("spec", {}).get("engine", {}).get("digest")
        )
        if registered_engine_digest != provenance.get("engineDigest"):
            await fail_persisted_job(job, session, "Engine registration no longer pins the persisted Engine", started)
            return

        credential_value = None
        if isinstance(registration, EngineRegistrationRevision):
            credential_value = None
            credential_row = (
                await session.execute(
                    select(EngineCredential).where(EngineCredential.registration_id == registration.id)
                )
            ).scalars().first()
            if credential_row is not None:
                from ..security.secrets import CredentialStore, SecretsUnavailable

                try:
                    credential_value = CredentialStore.from_settings(get_settings()).decrypt(credential_row.credential_encrypted)
                except SecretsUnavailable as exc:
                    await fail_persisted_job(job, session, str(exc), started)
                    return
            transport = RemoteRegistration(
                endpoint=registration.endpoint,
                mappings=registration.mappings,
                auth_scheme=registration.auth_scheme,
                credential=credential_value,
                allow_internal_http=not get_settings().federation_require_https,
            )
            protocol_digest = registration.protocol_digest
        else:
            try:
                transport = registration_transport(registration)
            except RemoteEngineError as exc:
                await fail_persisted_job(job, session, str(exc), started)
                return
            protocol_digest = registration["document"]["spec"]["protocol"]["digest"]
        if job.service_url != transport.endpoint:
            await fail_persisted_job(job, session, "Persisted EngineRegistration endpoint changed", started)
            return
        if provenance.get("registration") != registration_ref or provenance.get("protocolDigest") != protocol_digest:
            await fail_persisted_job(job, session, "Persisted EngineRegistration provenance is inconsistent", started)
            return
        # No transaction stays open (idle, holding the row lock) while the
        # engine works. The lease token lives in session.info, which a commit
        # leaves alone, and is checked again once the answer is back.
        await session.commit()
        try:
            remote_result = await solve_remote(
                transport,
                problem.document,
                job.options,
                request.get("optimization", provenance.get("optimization", {})),
                timeout_s=float(request.get("timeout", get_settings().engine_solve_timeout_s)),
            )
        except RemoteEngineError as exc:
            fallback_engine = provenance.get("engineRoutingAdmin", {}).get("fallbackEngine")
            if fallback_engine and fallback_engine != job.engine_id:
                logger.info(
                    "Primary engine %s failed (%s); activating planned fallback to %s",
                    job.engine_id,
                    exc,
                    fallback_engine,
                )
                try:
                    fallback_path = MANIFEST_DIR / f"{fallback_engine}.json"
                    fallback_endpoint = get_settings().engine_urls.get(fallback_engine)
                    if fallback_path.is_file() and fallback_endpoint:
                        fallback_manifest = json.loads(fallback_path.read_text(encoding="utf-8"))
                        fallback_reg = builtin_engine_registration(fallback_manifest, fallback_endpoint)
                        fallback_transport = registration_transport(fallback_reg)
                        remote_result = await solve_remote(
                            fallback_transport,
                            problem.document,
                            job.options,
                            request.get("optimization", provenance.get("optimization", {})),
                            timeout_s=float(request.get("timeout", get_settings().engine_solve_timeout_s)),
                        )
                        job.engine_id = fallback_engine
                        provenance["fallbackActivated"] = True
                        provenance["fallbackEngine"] = fallback_engine
                        if "engineRouting" in provenance and isinstance(provenance["engineRouting"], dict):
                            provenance["engineRouting"]["selectedEngine"] = fallback_engine
                            provenance["engineRouting"]["fallbackActivated"] = True
                    else:
                        await fail_persisted_job(job, session, str(exc), started)
                        return
                except Exception as fb_exc:
                    logger.warning("Fallback engine %s failed as well: %s", fallback_engine, fb_exc)
                    await fail_persisted_job(
                        job,
                        session,
                        f"Primary engine ({exc}) and fallback ({fb_exc}) both failed",
                        started,
                    )
                    return
            else:
                await fail_persisted_job(job, session, str(exc), started)
                return
        # Lock first, read second: the refresh then sees the row as it will stay
        # until this transaction ends.
        if not await metering.hold_lease(session, job.id, metering.held_token(session, job.id)):
            # The worker was presumed dead and the job went back in the queue
            # (or failed). The answer arrived too late to be the job's answer.
            logger.warning("Lost the lease on job %s; discarding its result", job.id)
            await session.rollback()
            return
        await session.refresh(job)
        if job.cancellation_requested:
            job.state = JobState.CANCELLED
            job.lease_token = None
            job.lease_until = None
            job.finished_at = utcnow()
            await _settle_and_commit(
                session, job.id, solver_seconds=max(0.0, time.monotonic() - started), outcome="cancelled"
            )
            await session.flush()
            return
        reevaluated = reevaluate_result(
            problem,
            remote_result,
            request.get("optimization", provenance.get("optimization", {})),
            mode_contract["terminationGuarantees"],
        )
        job.provenance = {
            **provenance,
            "registration": registration_ref,
            "protocolDigest": protocol_digest,
            "engineReported": remote_result.get("provenance", {}),
        }
        reevaluated["provenance"] = job.provenance
        job.result = reevaluated
        job.termination = reevaluated["termination"]
        job.state = JobState.COMPLETED
        job.lease_token = None
        job.lease_until = None
        job.finished_at = utcnow()
        routing_admin = provenance.get("engineRoutingAdmin")
        if isinstance(routing_admin, dict) and "adaptationLoopId" in routing_admin:
            try:
                from ..engine_routing import get_adaptation_manager

                adaptation_loop_id = routing_admin["adaptationLoopId"]
                features_dict = routing_admin.get("workloadFeatures", {})
                predicted = routing_admin.get("candidateEvaluations", [])
                pred_for_selected = next(
                    (c.get("predicted", {}) for c in predicted if c.get("engine") == job.engine_id),
                    {},
                )
                actual_latency = max(0.0, time.monotonic() - started)
                solutions = reevaluated.get("solutions") or []
                if not solutions or reevaluated.get("termination") not in ("OPTIMAL", "FEASIBLE"):
                    actual_quality = 0.0
                else:
                    raw_score = solutions[0].get("objectives", {}).get("score")
                    try:
                        score_float = float(raw_score) if raw_score is not None else 1.0
                        if 0.0 <= score_float <= 1.0:
                            actual_quality = score_float
                        else:
                            actual_quality = 1.0 if score_float <= 0 else max(0.0, min(1.0, 1.0 / (1.0 + score_float)))
                    except (ValueError, TypeError):
                        actual_quality = 0.5
                actual_credits = int(provenance.get("engineRouting", {}).get("creditsCost", 1))

                await get_adaptation_manager().observe_execution(
                    adaptation_loop_id=adaptation_loop_id,
                    engine=job.engine_id,
                    features_dict=features_dict,
                    predicted_metrics=pred_for_selected,
                    actual_latency=actual_latency,
                    actual_quality=actual_quality,
                    actual_credits=actual_credits,
                    outcome=job.termination or "completed",
                    candidate_evaluations=predicted,
                    engine_health_snapshot=routing_admin.get("engineHealthSnapshot"),
                    job_id=job.id,
                    session=session,
                )
            except Exception as exc:
                logger.warning("Failed to record adaptation observation for job %s: %s", job.id, exc)
        await _settle_and_commit(
            session, job.id, solver_seconds=time.monotonic() - started, outcome="completed"
        )
        await session.flush()
    except metering.SettlementCommitFailed:
        # The outcome is not durable and failing the job here would build on a
        # session in an unknown state; the caller rolls back and settles it.
        raise
    except Exception as exc:
        logger.exception("Unexpected error executing persisted job %s: %s", parsed, exc)
        await fail_persisted_job(job, session, f"Execution failed: {exc}", started)


async def run_persisted_job(job_id: str, request_session: AsyncSession | None = None) -> None:
    if request_session is not None:
        await finish_persisted_job(job_id, request_session)
        return
    if not db_base.is_configured():
        raise RuntimeError("A persisted job cannot run without an initialized database.")
    async with db_base.session_factory()() as session:
        try:
            await finish_persisted_job(job_id, session)
            await session.commit()
        except Exception as exc:
            # A charge SPACE took in the transaction being abandoned is not
            # lost with it: it is kept to be recorded with the failure below.
            metering.remember_staged_charges(session)
            await session.rollback()
            logger.exception("Job execution failed unexpectedly for %s: %s", job_id, exc)
            async with db_base.session_factory()() as fail_session:
                try:
                    parsed = uuid.UUID(job_id)
                    # Only the worker holding the lease may fail the job. One
                    # that never claimed it (or lost it) leaves the job to the
                    # queue and the reconciler, and the re-raise below makes
                    # Dramatiq redeliver.
                    token = metering.held_token(session, parsed)
                    failed_job = (
                        await fail_session.get(Job, parsed)
                        if await metering.hold_lease(fail_session, parsed, token)
                        else None
                    )
                    if failed_job is not None and failed_job.state not in (
                        JobState.COMPLETED,
                        JobState.FAILED,
                        JobState.CANCELLED,
                    ):
                        failed_job.state = JobState.FAILED
                        failed_job.lease_token = None
                        failed_job.lease_until = None
                        failed_job.result = {
                            "termination": "UNKNOWN",
                            "solutions": [],
                            "error": f"Internal execution error: {exc}",
                            "provenance": failed_job.provenance or {},
                        }
                        failed_job.termination = "UNKNOWN"
                        failed_job.finished_at = utcnow()
                        # If the worker's own settlement was charged but not
                        # committed, record it with the failure, in the same
                        # transaction, so the sweep does not charge it again.
                        await metering.record_unrecorded(fail_session, parsed)
                        from ..telemetry import record_job_failure
                        try:
                            await record_job_failure(fail_session, failed_job, str(exc))
                        except Exception:
                            pass
                        await metering.commit_settlement(fail_session)
                except Exception:
                    logger.exception("Failed to record failure for job %s", job_id)
            raise

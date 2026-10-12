"""Execution of persisted jobs: claim, solve, reevaluate and record the outcome."""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Mapping

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import get_settings
from ..db import base as db_base
from ..db.models import (
    EngineCredential,
    EngineRegistrationRevision,
    Job,
    JobState,
    utcnow,
)
from ..jobs import leases
from ..v1.canonical import digest
from ..v1.compiler import BindingProblem
from ..v1.remote import RemoteEngineError, RemoteRegistration, cancel_remote, solve_remote
from .engines import (
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


async def fail_persisted_job(
    job: Job,
    session: AsyncSession,
    message: str,
    started: float,
) -> None:
    if not await leases.hold_lease(session, job.id, leases.held_token(session, job.id)):
        # The reconciler took the job back, so the outcome of this attempt is
        # not the job's outcome. Whatever was staged is discarded.
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
    from ..telemetry import record_job_failure
    try:
        await record_job_failure(session, job, message)
    except Exception:
        pass

    await session.flush()


#: How long the best-effort cancellation of a remote job may take.
REMOTE_CANCEL_TIMEOUT_S = 3.0

#: Width of ``jobs.engine_job_id``.
ENGINE_JOB_ID_MAX = 128


async def record_engine_job_id(session: AsyncSession, job_id: uuid.UUID, engine_job_id: str) -> None:
    """Make the engine's id for this job durable before waiting for the result.

    A crash after this commit leaves the id on the row, so whoever recovers the
    job (or an operator) knows which remote job to look for or cancel. It is
    best effort: a failure here is logged and the attempt goes on, because
    failing a solve the engine has already accepted would not stop it.
    """
    if len(engine_job_id) > ENGINE_JOB_ID_MAX:
        logger.warning("The engine id for job %s is too long to store; not recording it", job_id)
        return
    try:
        if not await leases.hold_lease(session, job_id, leases.held_token(session, job_id)):
            await session.rollback()
            return  # The lease is gone; the check after the solve discards the answer.
        await session.execute(
            update(Job)
            .where(Job.id == job_id)
            .values(engine_job_id=engine_job_id)
            .execution_options(synchronize_session=False)
        )
        await session.commit()
    except Exception:
        logger.warning("Could not record the engine id for job %s", job_id, exc_info=True)
        try:
            await session.rollback()
        except Exception:
            logger.warning("Could not roll back after recording the engine id of job %s", job_id, exc_info=True)


async def cancel_engine_job(transport: RemoteRegistration, engine_job_id: str | None) -> None:
    """Best-effort cancellation of a remote job whose result the gateway no longer wants."""
    if engine_job_id is None:
        return
    try:
        await cancel_remote(transport, engine_job_id, timeout_s=REMOTE_CANCEL_TIMEOUT_S)
    except Exception:
        logger.warning("Could not cancel engine job %s", engine_job_id, exc_info=True)


async def finish_persisted_job(job_id: str, session: AsyncSession) -> None:
    """Dispatch a persisted BIM v1 job using only its stored canonical IR."""
    try:
        parsed = uuid.UUID(job_id)
    except ValueError:
        return
    token = await leases.claim_job(session, parsed)
    if token is None:
        return
    try:
        await session.commit()
    except Exception:
        # Whether the claim reached the database is unknown, and this worker
        # must not act as if it held a lease it may not have: forget the token
        # and let the job be redelivered or its lease lapse.
        session.info.pop(leases.lease_key(parsed), None)
        try:
            await session.rollback()
        except Exception:
            logger.warning("Could not roll back after a failed claim of job %s", parsed, exc_info=True)
        raise

    # The lease runs out unless it is renewed, which is how the reconciler
    # tells a worker that died from one that is still solving.
    heartbeat = leases.start_heartbeat(session, parsed, token)
    try:
        await run_claimed_job(parsed, session)
        # The outcome is durable before the lease stops being renewed.
        await session.commit()
    finally:
        await leases.stop_heartbeat(heartbeat)


async def run_claimed_job(parsed: uuid.UUID, session: AsyncSession) -> None:
    if not await leases.hold_lease(session, parsed, leases.held_token(session, parsed)):
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
        attempt = job.attempt
        await session.commit()
        engine = {"job_id": None}

        async def remember_engine_job(engine_job_id: str) -> None:
            engine["job_id"] = engine_job_id
            await record_engine_job_id(session, parsed, engine_job_id)

        try:
            remote_result = await solve_remote(
                transport,
                problem.document,
                job.options,
                request.get("optimization", provenance.get("optimization", {})),
                timeout_s=float(request.get("timeout", get_settings().engine_solve_timeout_s)),
                job_id=str(parsed),
                attempt=attempt,
                on_remote_id=remember_engine_job,
            )
        except RemoteEngineError as exc:
            # The gateway gives up on this attempt; the engine may still be working.
            await cancel_engine_job(transport, engine["job_id"])
            await fail_persisted_job(job, session, str(exc), started)
            return
        # Lock first, read second: the refresh then sees the row as it will stay
        # until this transaction ends.
        if not await leases.hold_lease(session, job.id, leases.held_token(session, job.id)):
            # The worker was presumed dead and the job went back in the queue
            # (or failed). The answer arrived too late to be the job's answer.
            logger.warning("Lost the lease on job %s; discarding its result", job.id)
            await session.rollback()
            await cancel_engine_job(transport, engine["job_id"])
            return
        await session.refresh(job)
        if job.cancellation_requested:
            job.state = JobState.CANCELLED
            job.lease_token = None
            job.lease_until = None
            job.finished_at = utcnow()
            await session.flush()
            # Durable first: the cancel call is a network round trip and must
            # not run inside the transaction that holds the row lock.
            await session.commit()
            await cancel_engine_job(transport, engine["job_id"])
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
        await session.flush()
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
            await session.rollback()
            logger.exception("Job execution failed unexpectedly for %s: %s", job_id, exc)
            async with db_base.session_factory()() as fail_session:
                try:
                    parsed = uuid.UUID(job_id)
                    # Only the worker holding the lease may fail the job. One
                    # that never claimed it (or lost it) leaves the job to the
                    # queue and the reconciler, and the re-raise below makes
                    # Dramatiq redeliver.
                    token = leases.held_token(session, parsed)
                    failed_job = (
                        await fail_session.get(Job, parsed)
                        if await leases.hold_lease(fail_session, parsed, token)
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
                        from ..telemetry import record_job_failure
                        try:
                            await record_job_failure(fail_session, failed_job, str(exc))
                        except Exception:
                            pass
                        await fail_session.commit()
                except Exception:
                    logger.exception("Failed to record failure for job %s", job_id)
            raise

"""Execution of persisted jobs: claim, solve, reevaluate and record the outcome."""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from bim_core.canonical import digest
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.public_errors import (
    classify_job_failure,
    current_correlation_id,
    job_failure_fields,
    log_internal_failure,
    scrub_text,
)
from ..core.settings import get_settings
from ..db import base as db_base
from ..db.models import (
    EngineCredential,
    EngineRegistrationRevision,
    Job,
    JobState,
    utcnow,
)
from ..integrations import bim
from ..jobs import leases
from ..v1.remote import RemoteEngineError, RemoteRegistration, cancel_remote, solve_remote
from .engines import (
    installed_builtin_registration,
    persisted_engine_contract,
    persisted_mode_contract,
    registration_transport,
    validate_engine_result,
)

logger = logging.getLogger(__name__)


async def fail_persisted_job(
    job: Job,
    session: AsyncSession,
    code: str,
    started: float,
    *,
    reason: str | None = None,
    cause: BaseException | None = None,
) -> None:
    """Record that the job failed for ``code`` (a key of ``JOB_FAILURES``).

    The job shows the fixed sentence of the catalog, the code and a correlation
    id; nothing the failure said about itself is stored. ``reason`` (a text the
    gateway wrote) and ``cause`` (the exception) go to the log with that id,
    masked and bounded.
    """
    if not await leases.hold_lease(session, job.id, leases.held_token(session, job.id)):
        # The reconciler took the job back, so the outcome of this attempt is
        # not the job's outcome. Whatever was staged is discarded.
        logger.warning("Lost the lease on job %s; not recording its failure", job.id)
        await session.rollback()
        return
    fields = job_failure_fields(code, current_correlation_id())
    _log_job_failure(job.id, fields, reason, cause)
    job.state = JobState.FAILED
    job.lease_token = None
    job.lease_until = None
    job.result = {
        "termination": "UNKNOWN",
        "solutions": [],
        **fields,
        "provenance": job.provenance or {},
    }
    job.termination = "UNKNOWN"
    job.finished_at = utcnow()
    from ..telemetry import record_job_failure
    try:
        await record_job_failure(session, job, f"{fields['code']}: {fields['error']}")
    except Exception:
        pass

    await session.flush()


def _log_job_failure(
    job_id: uuid.UUID | str,
    fields: dict[str, str],
    reason: str | None,
    cause: BaseException | None,
) -> None:
    """The internal side of a failed job: the code, the id, and whatever explains it."""
    if cause is not None:
        log_internal_failure(
            "job execution",
            cause,
            correlation=fields["correlationId"],
            job=job_id,
            code=fields["code"],
            **({"reason": scrub_text(reason)} if reason else {}),
        )
    else:
        logger.warning(
            "job execution failed: job=%s code=%s correlation_id=%s reason=%s",
            job_id,
            fields["code"],
            fields["correlationId"],
            scrub_text(reason or ""),
        )


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
            await fail_persisted_job(
                job, session, "job_input_invalid", started, reason="persisted BindingProblem is missing"
            )
            return
        mode_contract = persisted_mode_contract(request.get("mode"))
        if mode_contract is None:
            await fail_persisted_job(
                job, session, "job_input_invalid", started, reason="Persisted Engine mode contract is invalid"
            )
            return
        if not isinstance(job.options, dict):
            await fail_persisted_job(
                job, session, "job_input_invalid", started, reason="Persisted Engine options must be an object"
            )
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
            await fail_persisted_job(
                job, session, "registration_changed", started, reason="Persisted Engine mode contract is inconsistent"
            )
            return
        registration_ref = request.get("registration")
        if (
            not isinstance(registration_ref, dict)
            or set(registration_ref) != {"namespace", "name", "version", "digest"}
            or not all(isinstance(value, str) and value for value in registration_ref.values())
        ):
            await fail_persisted_job(
                job, session, "job_input_invalid", started, reason="Persisted EngineRegistration reference is invalid"
            )
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
            await fail_persisted_job(
                job, session, "registration_changed", started, reason="Engine registration is no longer active"
            )
            return

        registered_engine_digest = (
            registration.engine_digest
            if isinstance(registration, EngineRegistrationRevision)
            else registration.get("document", {}).get("spec", {}).get("engine", {}).get("digest")
        )
        if registered_engine_digest != provenance.get("engineDigest"):
            await fail_persisted_job(
                job,
                session,
                "registration_changed",
                started,
                reason="Engine registration no longer pins the persisted Engine",
            )
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
                    await fail_persisted_job(job, session, "credential_unavailable", started, cause=exc)
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
                await fail_persisted_job(job, session, classify_job_failure(exc), started, cause=exc)
                return
            protocol_digest = registration["document"]["spec"]["protocol"]["digest"]
        if job.service_url != transport.endpoint:
            await fail_persisted_job(
                job, session, "registration_changed", started, reason="Persisted EngineRegistration endpoint changed"
            )
            return
        if provenance.get("registration") != registration_ref or provenance.get("protocolDigest") != protocol_digest:
            await fail_persisted_job(
                job,
                session,
                "registration_changed",
                started,
                reason="Persisted EngineRegistration provenance is inconsistent",
            )
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
                document,
                job.options,
                request.get("optimization", provenance.get("optimization", {})),
                timeout_s=float(request.get("timeout", get_settings().engine_solve_timeout_s)),
                job_id=str(parsed),
                attempt=attempt,
                on_remote_id=remember_engine_job,
                validate_result=validate_engine_result,
            )
        except RemoteEngineError as exc:
            # The gateway gives up on this attempt; the engine may still be working.
            await cancel_engine_job(transport, engine["job_id"])
            await fail_persisted_job(job, session, classify_job_failure(exc), started, cause=exc)
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
        try:
            reevaluated = await bim.abim().reevaluate(
                document,
                remote_result,
                request.get("optimization", provenance.get("optimization", {})),
                mode_contract["terminationGuarantees"],
            )
        except Exception as exc:
            await fail_persisted_job(job, session, "bim_evaluation_failed", started, cause=exc)
            return
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
        await fail_persisted_job(job, session, classify_job_failure(exc), started, cause=exc)


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
            correlation = log_internal_failure("job execution", exc, job=job_id)
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
                        fields = job_failure_fields("internal_error", correlation)
                        failed_job.result = {
                            "termination": "UNKNOWN",
                            "solutions": [],
                            **fields,
                            "provenance": failed_job.provenance or {},
                        }
                        failed_job.termination = "UNKNOWN"
                        failed_job.finished_at = utcnow()
                        from ..telemetry import record_job_failure
                        try:
                            await record_job_failure(fail_session, failed_job, f"{fields['code']}: {fields['error']}")
                        except Exception:
                            pass
                        await fail_session.commit()
                except Exception:
                    logger.exception("Failed to record failure for job %s", job_id)
            raise

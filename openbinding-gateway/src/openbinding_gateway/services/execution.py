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
from ..jobs import evidence as job_evidence
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
    evidence: dict[str, str] | None = None,
) -> None:
    """Record that the job failed for ``code`` (a key of ``JOB_FAILURES``).

    The job shows the fixed sentence of the catalog, the code and a correlation
    id; nothing the failure said about itself is stored. ``reason`` (a text the
    gateway wrote) and ``cause`` (the exception) go to the log with that id,
    masked and bounded. ``evidence`` is the reference (id, digest, expiry, never
    the body) of the engine answer that was kept for a later evaluation.
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
        **({"evidence": evidence} if evidence else {}),
    }
    job.termination = "UNKNOWN"
    job.finished_at = utcnow()
    from ..telemetry import record_job_failure
    try:
        await record_job_failure(session, job, f"{fields['code']}: {fields['error']}")
    except Exception:
        pass

    await session.flush()


async def evaluate_engine_result(
    document: dict[str, Any],
    remote_result: dict[str, Any],
    optimization: Any,
    termination_guarantees: list[str],
    provenance: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """BIM's canonical evaluation of an engine answer: the provenance to keep and the job's result.

    The one path from a raw answer to a result, for the worker and for the
    re-evaluation of a kept answer. It raises when BIM cannot evaluate; nothing
    that was not evaluated is ever returned.
    """
    reevaluated = await bim.abim().reevaluate(document, remote_result, optimization, termination_guarantees)
    if not isinstance(reevaluated, dict) or "termination" not in reevaluated:
        raise ValueError("BIM returned an evaluation without a termination")
    final_provenance = {**provenance, "engineReported": remote_result.get("provenance", {})}
    reevaluated["provenance"] = final_provenance
    return final_provenance, reevaluated


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


async def keep_engine_answer(
    session: AsyncSession, job_id: uuid.UUID, attempt: int, answer: dict[str, Any]
) -> job_evidence.StoredEvidence | None:
    """Write the engine's raw answer and commit, which also releases the row lock taken by ``hold_lease``.

    Best effort: if the answer cannot be kept (over the bound, or the write
    fails) the evaluation goes on without it, and a BIM failure then leaves no
    evidence to retry from.
    """
    kept = None
    try:
        kept = await job_evidence.store(session, job_id, attempt, answer)
        await session.commit()
    except Exception:
        kept = None
        logger.warning("Could not keep the engine answer for job %s", job_id, exc_info=True)
        try:
            await session.rollback()
        except Exception:
            logger.warning("Could not roll back after keeping the answer of job %s", job_id, exc_info=True)
    return kept


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


async def settle_engine_answer(
    session: AsyncSession,
    job: Job,
    started: float,
    *,
    attempt: int,
    remote_result: dict[str, Any],
    document: dict[str, Any],
    optimization: Any,
    termination_guarantees: list[str],
    provenance: dict[str, Any],
    transport: RemoteRegistration | None,
    engine_job_id: str | None,
) -> None:
    """Turn the engine's answer into the job's outcome, in the order that loses nothing.

    The caller holds the lease token in ``session.info`` and no transaction is
    open. The row lock of the job is held only in short transactions: the raw
    answer is written and committed before BIM is called (which then runs with
    no transaction open), and the lease is taken again afterwards, with the
    cancellation checked once more, because a cancellation can arrive while BIM
    works. A job is COMPLETED only with an evaluated result; when BIM fails it
    is FAILED ``bim_evaluation_failed`` with a reference to the kept answer.
    """
    job_id = job.id
    # Lock first, read second: the refresh then sees the row as it will stay
    # until this transaction ends.
    if not await leases.hold_lease(session, job_id, leases.held_token(session, job_id)):
        # The worker was presumed dead and the job went back in the queue
        # (or failed). The answer arrived too late to be the job's answer.
        logger.warning("Lost the lease on job %s; discarding its result", job_id)
        await session.rollback()
        await cancel_engine_job(transport, engine_job_id)
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
        await cancel_engine_job(transport, engine_job_id)
        return
    # The raw answer is durable before BIM is asked about it, and the commit
    # also releases the row lock: BIM is a network call and neither its
    # failure nor its slowness may lose the solve or hold up a cancellation.
    kept = await keep_engine_answer(session, job_id, attempt, remote_result)
    try:
        final_provenance, reevaluated = await evaluate_engine_result(
            document, remote_result, optimization, termination_guarantees, provenance
        )
        evaluation_error = None
    except Exception as exc:
        final_provenance, reevaluated, evaluation_error = None, None, exc
    if not await leases.hold_lease(session, job_id, leases.held_token(session, job_id)):
        logger.warning("Lost the lease on job %s during its evaluation; discarding its result", job_id)
        await session.rollback()
        await job_evidence.discard_attempt(session, job_id, attempt)
        await cancel_engine_job(transport, engine_job_id)
        return
    await session.refresh(job)
    # The cancellation may have come in while BIM was working and the lock was free.
    if job.cancellation_requested:
        job.state = JobState.CANCELLED
        job.lease_token = None
        job.lease_until = None
        job.finished_at = utcnow()
        await job_evidence.delete_for_job(session, job_id)
        await session.flush()
        await session.commit()
        await cancel_engine_job(transport, engine_job_id)
        return
    if evaluation_error is not None:
        await fail_persisted_job(
            job,
            session,
            "bim_evaluation_failed",
            started,
            cause=evaluation_error,
            evidence=kept.reference() if kept is not None else None,
        )
        return
    job.provenance = final_provenance
    job.result = reevaluated
    job.termination = reevaluated["termination"]
    job.state = JobState.COMPLETED
    job.lease_token = None
    job.lease_until = None
    job.finished_at = utcnow()
    # A success leaves no raw answer behind, whichever attempt wrote it.
    await job_evidence.delete_for_job(session, job_id)
    await session.flush()


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
        await settle_engine_answer(
            session,
            job,
            started,
            attempt=attempt,
            remote_result=remote_result,
            document=document,
            optimization=request.get("optimization", provenance.get("optimization", {})),
            termination_guarantees=mode_contract["terminationGuarantees"],
            provenance={**provenance, "registration": registration_ref, "protocolDigest": protocol_digest},
            transport=transport,
            engine_job_id=engine["job_id"],
        )
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

"""Execution of persisted jobs: claim, solve, reevaluate and record the outcome."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
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
from ..jobs import leases, remote_attempts
from ..v1.remote import RemoteEngineError, RemoteRegistration, cancel_remote, solve_remote
from .engine_registry import CancellationCapability, cancellation_capability
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


#: How long a worker that is being cancelled waits for the write of an engine id that has already started.
RECORD_GRACE_S = 10.0


async def _write_engine_job_id(
    session: AsyncSession, job_id: uuid.UUID, engine_job_id: str, attempt: int | None, endpoint: str | None
) -> None:
    try:
        if not await leases.hold_lease(session, job_id, leases.held_token(session, job_id)):
            await session.rollback()
            # The lease is gone and the check after the solve discards the answer, but the engine is still
            # running this attempt: keep its id, already pending, so that it can be asked to stop.
            if attempt is not None and endpoint is not None:
                await remote_attempts.record(session, job_id, attempt, engine_job_id, endpoint, lost=True)
                await session.commit()
            return
        if attempt is None or endpoint is None:
            current = (await session.execute(select(Job.attempt, Job.service_url).where(Job.id == job_id))).one()
            attempt = current.attempt if attempt is None else attempt
            endpoint = current.service_url if endpoint is None else endpoint
        await session.execute(
            update(Job)
            .where(Job.id == job_id)
            .values(engine_job_id=engine_job_id)
            .execution_options(synchronize_session=False)
        )
        await remote_attempts.record(session, job_id, attempt, engine_job_id, endpoint)
        await session.commit()
    except Exception:
        logger.warning("Could not record the engine id for job %s", job_id, exc_info=True)
        try:
            await session.rollback()
        except Exception:
            logger.warning("Could not roll back after recording the engine id of job %s", job_id, exc_info=True)


async def record_engine_job_id(
    session: AsyncSession,
    job_id: uuid.UUID,
    engine_job_id: str,
    *,
    attempt: int | None = None,
    endpoint: str | None = None,
) -> None:
    """Make the engine's id for this attempt durable before waiting for the result.

    A crash after this commit leaves the id on the row, so whoever recovers the
    job (or an operator) knows which remote job to look for or cancel. Besides
    ``jobs.engine_job_id`` (the latest id, overwritten by the next attempt) it is
    written to ``job_engine_attempts`` with the endpoint it came from, one row per
    attempt, which is what a later cancellation reads. ``attempt`` and ``endpoint``
    default to the job's current claim and ``service_url``. It is best effort: a
    failure here is logged and the attempt goes on, because failing a solve the
    engine has already accepted would not stop it.

    The write runs shielded: if the worker is cancelled while it is in flight the
    write is allowed to finish first (a task cancelled in the middle of a query
    leaves the connection in an unusable state), and only then does the
    cancellation go on.
    """
    if len(engine_job_id) > ENGINE_JOB_ID_MAX:
        logger.warning("The engine id for job %s is too long to store; not recording it", job_id)
        return
    write = asyncio.ensure_future(_write_engine_job_id(session, job_id, engine_job_id, attempt, endpoint))
    try:
        await asyncio.shield(write)
    except asyncio.CancelledError:
        await asyncio.wait({write}, timeout=RECORD_GRACE_S)
        raise


# -- Remote cancellation: one guarded door ---------------------------------------------------------------


@dataclass(frozen=True)
class CancelContext:
    """What a cancellation needs to know of the registration an attempt used.

    ``capability`` is what the registration declares; ``endpoint`` is where it points *now*;
    ``load_transport`` produces the transport with its credential and is only called once every guard has
    passed, so a credential is never decrypted for a request that will not be made.
    """

    capability: CancellationCapability
    endpoint: str
    load_transport: Callable[[], Awaitable[RemoteRegistration]]


def attempt_cancel_context(
    capability: CancellationCapability | None, transport: RemoteRegistration | None
) -> CancelContext | None:
    """The context of a worker that holds the transport of its own attempt."""
    if capability is None or transport is None:
        return None

    async def load() -> RemoteRegistration:
        return transport

    return CancelContext(capability, transport.endpoint, load)


def registration_cancellation(registration: EngineRegistrationRevision | Mapping[str, Any]) -> CancellationCapability:
    """The cancellation a registration declares and its OpenAPI backs (see ``cancellation_capability``).

    A declaration the OpenAPI does not back is off, and that is logged here: the registration keeps its
    state. The built-in registrations declare nothing.
    """
    if isinstance(registration, EngineRegistrationRevision):
        document, openapi = registration.document, registration.openapi_document
    else:
        document = registration.get("document") if isinstance(registration, Mapping) else None
        built_in_spec = document.get("spec") if isinstance(document, Mapping) else None
        openapi = built_in_spec.get("openapi") if isinstance(built_in_spec, Mapping) else None
    spec = document.get("spec") if isinstance(document, Mapping) else None
    capability = cancellation_capability(spec, openapi)
    if capability.declared and not capability.supported:
        logger.warning("The registration declares cancellation but it is off: %s", capability.reason)
    return capability


async def find_registration_revision(
    session: AsyncSession, job: Job, registration_ref: Mapping[str, Any]
) -> EngineRegistrationRevision | None:
    """The stored revision a job's registration reference names, if the job's owner may still use it."""
    return (
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
                        & (EngineRegistrationRevision.publication_status == "published")
                    ),
                ),
            )
        )
    ).scalars().first()


async def revision_transport(session: AsyncSession, registration: EngineRegistrationRevision) -> RemoteRegistration:
    """The transport of a stored revision, with its credential decrypted. Raises ``SecretsUnavailable``."""
    credential_value = None
    credential_row = (
        await session.execute(select(EngineCredential).where(EngineCredential.registration_id == registration.id))
    ).scalars().first()
    if credential_row is not None:
        from ..security.secrets import CredentialStore

        credential_value = CredentialStore.from_settings(get_settings()).decrypt(credential_row.credential_encrypted)
    return RemoteRegistration(
        endpoint=registration.endpoint,
        mappings=registration.mappings,
        auth_scheme=registration.auth_scheme,
        credential=credential_value,
        allow_internal_http=not get_settings().federation_require_https,
    )


async def resolve_cancel_context(session: AsyncSession, job_id: uuid.UUID) -> CancelContext | None:
    """The context for cancelling an attempt of a job from the sweep, which holds no transport.

    The registration is the one the job names, as it is now: if it is gone or deactivated there is nothing
    to send the credential to. The built-in registrations declare nothing and have no context.
    """
    job = await session.get(Job, job_id, populate_existing=True)
    if job is None:
        return None
    reference = (job.original_request or {}).get("registration")
    if (
        not isinstance(reference, dict)
        or set(reference) != {"namespace", "name", "version", "digest"}
        or not all(isinstance(value, str) and value for value in reference.values())
        or reference["namespace"] == "bim.builtin"
    ):
        return None
    revision = await find_registration_revision(session, job, reference)
    if revision is None:
        return None

    async def load() -> RemoteRegistration:
        return await revision_transport(session, revision)

    return CancelContext(registration_cancellation(revision), revision.endpoint, load)


async def _plan_cancellation(
    session: AsyncSession, item: remote_attempts.ClaimedAttempt, context: CancelContext | None
) -> tuple[str | None, RemoteRegistration | None]:
    """``(state, None)`` to settle without sending, ``(None, transport)`` to send, ``(None, None)`` to wait."""
    if context is None:
        logger.info("Not cancelling attempt %s of job %s: its registration cannot be used", item.attempt, item.job_id)
        return remote_attempts.SKIPPED, None
    job = await remote_attempts.view(session, item.job_id)
    if job is None:
        return remote_attempts.SKIPPED, None
    decision = remote_attempts.decide(
        job,
        remote_attempts.AttemptView(item.attempt, item.engine_job_id, item.endpoint),
        supported=context.capability.supported,
        per_attempt=context.capability.per_attempt,
        current_endpoint=context.endpoint,
    )
    if decision.action is remote_attempts.Action.CANCEL:
        transport = await context.load_transport()
        if transport.endpoint != item.endpoint:  # the one that carries the credential is checked too
            logger.info("Not cancelling attempt %s of job %s: the endpoint changed", item.attempt, item.job_id)
            return remote_attempts.SKIPPED, None
        return None, transport
    if decision.action is remote_attempts.Action.DEFER:
        if item.cancel_attempts >= get_settings().remote_cancel_defer_limit:
            logger.warning(
                "Giving up cancelling attempt %s of job %s after %d deferrals: %s",
                item.attempt,
                item.job_id,
                item.cancel_attempts,
                decision.reason,
            )
            return remote_attempts.SKIPPED, None
        logger.info("Deferring the cancellation of attempt %s of job %s: %s", item.attempt, item.job_id, decision.reason)
        return None, None
    logger.info("Not cancelling attempt %s of job %s: %s", item.attempt, item.job_id, decision.reason)
    return remote_attempts.SKIPPED, None


async def _send_cancellation(item: remote_attempts.ClaimedAttempt, transport: RemoteRegistration) -> str:
    """The only place that asks an engine to stop a job. Returns the state the attempt ends in.

    ``sent`` means the engine *confirmed* the job is stopped or gone (200/204). A ``202`` only says the
    engine accepted the request and is still stopping the job: it is not a confirmation, so it is a
    recoverable failure that is retried with backoff, a bounded number of times, like a network error.
    """
    statuses: list[int] = []
    try:
        acknowledged = await cancel_remote(
            transport, item.engine_job_id, timeout_s=REMOTE_CANCEL_TIMEOUT_S, on_status=statuses.append
        )
    except Exception:
        logger.warning("Could not cancel attempt %s of job %s", item.attempt, item.job_id, exc_info=True)
        return remote_attempts.FAILED
    if acknowledged and statuses and statuses[-1] == 202:
        logger.info(
            "The engine accepted the cancellation of attempt %s of job %s but has not confirmed it (202)",
            item.attempt,
            item.job_id,
        )
        return remote_attempts.FAILED
    if acknowledged:
        return remote_attempts.SENT
    if statuses and statuses[-1] in (404, 405, 501):
        logger.info("The engine does not implement cancellation (attempt %s of job %s)", item.attempt, item.job_id)
        return remote_attempts.SKIPPED
    return remote_attempts.FAILED


async def cancel_engine_attempts(
    session: AsyncSession,
    claimed: Sequence[remote_attempts.ClaimedAttempt],
    *,
    context: CancelContext | None = None,
) -> int:
    """Carry out claimed cancellations of lost attempts, best effort. Returns how many engines acknowledged.

    The door every remote cancellation goes through (the worker's three paths and the reconciler's sweep).
    For each claim the engine id and the endpoint are read from the attempt's row, and ``remote_attempts.decide``
    says whether a ``DELETE`` may go out: only if the registration declares the capability, points at the
    endpoint the attempt used, and the attempt is not the one that runs the job. ``context`` is the worker's
    own; without it the registration of each job is resolved from the database. The claims are already
    committed; no transaction is open while the engines are asked (the requests run concurrently up to
    ``remote_cancel_concurrency``, each bounded by ``REMOTE_CANCEL_TIMEOUT_S``), and the outcomes are
    written afterwards. A failure to send leaves the row due again after its backoff, until its claims run out.
    """
    settings = get_settings()
    contexts: dict[uuid.UUID, CancelContext | None] = {}
    settled: list[tuple[remote_attempts.ClaimedAttempt, str]] = []
    to_send: list[tuple[remote_attempts.ClaimedAttempt, RemoteRegistration]] = []
    for item in claimed:
        try:
            item_context = context
            if item_context is None:
                if item.job_id not in contexts:
                    contexts[item.job_id] = await resolve_cancel_context(session, item.job_id)
                item_context = contexts[item.job_id]
            state, transport = await _plan_cancellation(session, item, item_context)
        except Exception:
            logger.warning("Could not plan the cancellation of attempt %s of job %s", item.attempt, item.job_id, exc_info=True)
            settled.append((item, remote_attempts.FAILED))
            continue
        if transport is not None:
            to_send.append((item, transport))
        elif state is not None:
            settled.append((item, state))
    await session.commit()  # reads only; nothing may stay open while the engines are asked

    gate = asyncio.Semaphore(settings.remote_cancel_concurrency)

    async def send(item: remote_attempts.ClaimedAttempt, transport: RemoteRegistration) -> tuple[remote_attempts.ClaimedAttempt, str]:
        async with gate:
            return item, await _send_cancellation(item, transport)

    settled.extend(await asyncio.gather(*(send(item, transport) for item, transport in to_send)))
    try:
        for item, state in settled:
            if state == remote_attempts.FAILED and item.cancel_attempts >= settings.remote_cancel_max_attempts:
                logger.warning(
                    "Giving up cancelling attempt %s of job %s after %d claims", item.attempt, item.job_id, item.cancel_attempts
                )
            await remote_attempts.settle(session, item, state)
        await session.commit()
    except Exception:
        logger.warning("Could not record the outcome of %d cancellation(s)", len(settled), exc_info=True)
        try:
            await session.rollback()
        except Exception:
            logger.warning("Could not roll back after recording cancellations", exc_info=True)
    return sum(1 for _, state in settled if state == remote_attempts.SENT)


async def cancel_engine_attempt(
    session: AsyncSession, job_id: uuid.UUID, attempt: int, context: CancelContext | None
) -> None:
    """The worker's side of the door: ask the engine to stop attempt ``attempt`` of the job, if that is allowed.

    Marks the attempt as lost if the sweep has not, claims its cancellation and goes through
    ``cancel_engine_attempts``; whatever the guards decide (an attempt that has to wait stays pending for the
    sweep). Never raises. The caller has committed the job's outcome and has no transaction open.
    """
    if context is None or not context.capability.supported:
        return
    try:
        claimed = await remote_attempts.claim_one(
            session, job_id, attempt, max_attempts=get_settings().remote_cancel_max_attempts
        )
        await session.commit()
        if claimed is not None:
            await cancel_engine_attempts(session, [claimed], context=context)
    except Exception:
        logger.warning("Could not cancel attempt %s of job %s", attempt, job_id, exc_info=True)
        try:
            await session.rollback()
        except Exception:
            logger.warning("Could not roll back after cancelling attempt %s of job %s", attempt, job_id, exc_info=True)


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
    engine_job_id: str | None = None,
    capability: CancellationCapability | None = None,
) -> None:
    """Turn the engine's answer into the job's outcome, in the order that loses nothing.

    Whatever remote job of this attempt is no longer wanted (the lease was lost, or the job was cancelled)
    is cancelled through ``cancel_engine_attempt``, which reads the attempt's id from its row and sends
    nothing unless ``capability`` says the registration declares cancellation. ``engine_job_id`` is not
    used any more and stays only so that existing callers keep working.

    The caller holds the lease token in ``session.info`` and no transaction is
    open. The row lock of the job is held only in short transactions: the raw
    answer is written and committed before BIM is called (which then runs with
    no transaction open), and the lease is taken again afterwards, with the
    cancellation checked once more, because a cancellation can arrive while BIM
    works. A job is COMPLETED only with an evaluated result; when BIM fails it
    is FAILED ``bim_evaluation_failed`` with a reference to the kept answer.
    """
    job_id = job.id
    cancel_context = attempt_cancel_context(capability, transport)
    # Lock first, read second: the refresh then sees the row as it will stay
    # until this transaction ends.
    if not await leases.hold_lease(session, job_id, leases.held_token(session, job_id)):
        # The worker was presumed dead and the job went back in the queue
        # (or failed). The answer arrived too late to be the job's answer.
        logger.warning("Lost the lease on job %s; discarding its result", job_id)
        await session.rollback()
        await cancel_engine_attempt(session, job_id, attempt, cancel_context)
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
        await cancel_engine_attempt(session, job_id, attempt, cancel_context)
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
        await cancel_engine_attempt(session, job_id, attempt, cancel_context)
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
        await cancel_engine_attempt(session, job_id, attempt, cancel_context)
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
            registration = await find_registration_revision(session, job, registration_ref)
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

        if isinstance(registration, EngineRegistrationRevision):
            from ..security.secrets import SecretsUnavailable

            try:
                transport = await revision_transport(session, registration)
            except SecretsUnavailable as exc:
                await fail_persisted_job(job, session, "credential_unavailable", started, cause=exc)
                return
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
        capability = registration_cancellation(registration)
        await session.commit()

        async def remember_engine_job(engine_job_id: str) -> None:
            await record_engine_job_id(session, parsed, engine_job_id, attempt=attempt, endpoint=transport.endpoint)

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
            # The gateway gives up on this attempt; the engine may still be working. The job is failed and
            # that is made durable first: an attempt is only cancelled once the job no longer runs it.
            await fail_persisted_job(job, session, classify_job_failure(exc), started, cause=exc)
            await session.commit()
            await cancel_engine_attempt(session, parsed, attempt, attempt_cancel_context(capability, transport))
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
            capability=capability,
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

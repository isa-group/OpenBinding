"""Manage, retry and observe durable jobs without changing the solve contract."""

from __future__ import annotations

import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import exists, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, session_dependency
from ..core.public_errors import (
    BIM_EVALUATION_UNAVAILABLE,
    CANCELLATION_REQUESTED,
    EVIDENCE_EXPIRED,
    JOB_ALREADY_RETRIED,
    JOB_IN_STUDY,
    JOB_NOT_REEVALUABLE,
    PublicProblem,
    log_internal_failure,
)
from ..db import base as db_base
from ..db.models import AuditEvent, InstanceSnapshot, Job, JobEngineEvidence, JobProvenance, JobState, User
from ..job_dispatch import dispatch_persisted_job
from ..jobs import clock as job_clock
from ..jobs import evidence as job_evidence
from ..jobs import lifecycle
from ..jobs import limits as job_limits
from ..models.errors import (
    CONFLICT_RESPONSE,
    FORBIDDEN_RESPONSE,
    NOT_FOUND_RESPONSE,
    UNAVAILABLE_RESPONSE,
    ErrorResponse,
    api_error,
)
from ..models.platform import JobView, job_view
from ..repositories import jobs as job_repository
from ..security.roles import require_work_role
from ..services.engines import persisted_mode_contract
from ..services.entitlements import EntitlementService, get_entitlements
from ..services.execution import evaluate_engine_result
from ..services.job_submission import _sharing_organizations
from bim_core.canonical import digest

router = APIRouter(prefix="/v1/jobs", tags=["Jobs"])


def _view(job: Job, viewer: User) -> JobView:
    return job_view(job, viewer)


def _audit(session: AsyncSession, user: User, action: str, target: Job, **detail: str) -> None:
    """One audit event of the job's organization (none for a job outside any), as the other routes do."""
    session.add(AuditEvent(
        organization_id=target.organization_id, actor_id=user.id, action=action,
        target_type=target.__class__.__name__, target_id=target.id, detail=detail,
    ))


async def _owned(
    session: AsyncSession,
    job_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    lock: bool = False,
    work_by: User | None = None,
) -> Job:
    """The caller's job, or 404. With ``work_by`` the job is also one that user may cancel or repeat.

    A job of an organization is work of that organization: a VIEWER only reads it, so
    this answers 403 ``insufficient_role`` before anything is changed.
    """
    job = await job_repository.get_owned(session, job_id, user_id, lock=lock)
    if job is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Job not found.")
    if work_by is not None:
        await require_work_role(session, work_by, [job.organization_id])
        if job.organization_id is None and job.instance_snapshot_id is not None:
            # Same rule as the launch: a snapshot shared by organizations is run with MEMBER in one of them.
            snapshot = await session.get(InstanceSnapshot, job.instance_snapshot_id)
            if snapshot is not None:
                await require_work_role(session, work_by, await _sharing_organizations(session, snapshot, work_by))
    return job


@router.get("", response_model=list[JobView], operation_id="listJobs")
async def list_jobs(
    state: JobState | None = None,
    limit: int = 100,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[JobView]:
    rows = await job_repository.list_owned(session, user.id, state=state, limit=limit)
    return [_view(row, user) for row in rows]


@router.post("/{job_id}/cancel", response_model=JobView, operation_id="cancelJob")
async def cancel_job(
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> JobView:
    # A study's job is cancelled under the lock of its run, taken before the job's.
    await lifecycle.lock_study_run(session, job_id, user.id)
    job = await _owned(session, job_id, user.id, lock=True, work_by=user)
    if job.state in {JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED}:
        raise api_error(status.HTTP_409_CONFLICT, "terminal_job", "The job is already terminal.")
    previous = job.state
    cancelled = await lifecycle.request_cancellation(session, job)
    _audit(
        session, user, "job.cancelled", job,
        jobId=str(job.id), ownerId=str(job.owner_id), previousState=previous.value,
        result="cancelled" if cancelled else "cancellation_requested",
    )
    await session.flush()
    return _view(job, user)


@router.post("/{job_id}/retry", response_model=JobView, status_code=202, operation_id="retryJob")
async def retry_job(
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    plans: EntitlementService = Depends(get_entitlements),
) -> JobView:
    original = await _owned(session, job_id, user.id, lock=True, work_by=user)
    if original.state not in {JobState.FAILED, JobState.CANCELLED}:
        raise api_error(status.HTTP_409_CONFLICT, "job_not_retryable", "Only failed or cancelled jobs may be retried.")
    existing = await job_repository.find_retry_of(session, user.id, original.id)
    if existing is not None:
        return _view(existing, user)
    provenance = dict(original.provenance or {})
    registration = provenance.get("registration")
    federated = (
        isinstance(registration, dict)
        and bool(registration)
        and registration.get("namespace") != "bim.builtin"
    )
    caps = await plans.caps_or_503(user.id)
    refusal = plans.feature_refusal(caps, "federatedEngines" if federated else "solve")
    if refusal is None:
        refusal = await job_limits.enforce_concurrency_limit(session, user.id)
    if refusal is not None:
        raise api_error(
            refusal.status,
            refusal.code,
            refusal.detail,
            headers=refusal.headers or None,
            **refusal.extra,
        )
    replacement = Job(
        owner_id=user.id, engine_id=original.engine_id, engine_job_id=str(uuid.uuid4()),
        service_url=original.service_url, state=JobState.QUEUED, verbose=original.verbose,
        original_request=original.original_request, options=original.options, warnings=original.warnings,
        instance_complexity=original.instance_complexity,
        instance_snapshot_id=original.instance_snapshot_id, provenance=provenance,
        idempotency_fingerprint=original.idempotency_fingerprint,
        requested_budget_s=original.requested_budget_s, retry_of_id=original.id,
        organization_id=original.organization_id, project_id=original.project_id,
    )
    session.add(replacement)
    await session.flush()
    replacement.engine_job_id = str(replacement.id)
    session.add(JobProvenance(job_id=replacement.id, document=provenance, digest=digest(provenance)))
    _audit(
        session, user, "job.retried", replacement,
        jobId=str(original.id), ownerId=str(original.owner_id), replacementJobId=str(replacement.id),
        result="retried",
    )
    await session.commit()
    # The job exists from here on. If dispatch fails, the redelivery sweep queues it again.
    await dispatch_persisted_job(str(replacement.id), None if db_base.is_configured() else session)
    return _view(replacement, user)


def _refuse(problem: PublicProblem) -> HTTPException:
    return api_error(problem.status, problem.code, problem.detail)


async def _reevaluable(
    session: AsyncSession, job: Job, user: User, evidence_id: uuid.UUID | None = None
) -> JobEngineEvidence:
    """The kept answer to evaluate again, or the reason this job cannot be.

    Every refusal is the same for the owner whatever else is true of the job, in
    this order. ``evidence_id`` pins the row read before BIM was called: if the
    job moved on in the meantime it is not the one this evaluation was made for.
    """
    if job.study_cell_id is not None:
        raise _refuse(JOB_IN_STUDY)
    if await job_repository.find_retry_of(session, user.id, job.id) is not None:
        raise _refuse(JOB_ALREADY_RETRIED)
    if job.cancellation_requested:
        raise _refuse(CANCELLATION_REQUESTED)
    result = job.result if isinstance(job.result, dict) else {}
    if job.state is not JobState.FAILED or result.get("code") != "bim_evaluation_failed":
        raise _refuse(JOB_NOT_REEVALUABLE)
    reference = result.get("evidence")
    row = await job_evidence.current(session, job.id, job.attempt)
    if (
        not isinstance(reference, dict)
        or row is None
        or str(row.id) != reference.get("id")
        or (evidence_id is not None and row.id != evidence_id)
        or not await job_evidence.is_current(session, row)
    ):
        raise _refuse(EVIDENCE_EXPIRED)
    return row


@router.post(
    "/{job_id}/reevaluate",
    response_model=JobView,
    operation_id="reevaluateJob",
    responses={
        403: FORBIDDEN_RESPONSE,
        404: NOT_FOUND_RESPONSE,
        409: CONFLICT_RESPONSE,
        410: {"model": ErrorResponse, "description": "The kept answer of the engine has expired."},
        503: UNAVAILABLE_RESPONSE,
    },
)
async def reevaluate_job(
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> JobView:
    """Evaluate again the engine answer kept for a job that failed with ``bim_evaluation_failed``.

    The engine does not run again. BIM is called with no transaction open; the
    job then goes FAILED -> COMPLETED in one conditional UPDATE, so of two
    simultaneous calls (or a call and a cancellation or a retry) one wins and the
    others answer 409. If BIM fails again the job and its evidence are untouched.
    """
    job = await _owned(session, job_id, user.id, work_by=user)
    row = await _reevaluable(session, job, user)
    request = job.original_request if isinstance(job.original_request, dict) else {}
    provenance = dict(job.provenance or {})
    document = request.get("bindingProblem")
    mode = persisted_mode_contract(request.get("mode"))
    if not isinstance(document, dict) or mode is None:
        raise _refuse(JOB_NOT_REEVALUABLE)
    optimization = request.get("optimization", provenance.get("optimization", {}))
    raw_result, evidence_id = row.raw_result, row.id
    await session.commit()  # no transaction is open while BIM works
    try:
        final_provenance, reevaluated = await evaluate_engine_result(
            document, raw_result, optimization, mode["terminationGuarantees"], provenance
        )
    except Exception as exc:
        log_internal_failure("job re-evaluation", exc, job=job_id, code=BIM_EVALUATION_UNAVAILABLE.code)
        raise _refuse(BIM_EVALUATION_UNAVAILABLE) from None

    job = await _owned(session, job_id, user.id, lock=True, work_by=user)
    await session.refresh(job)
    await _reevaluable(session, job, user, evidence_id)
    won = await session.execute(
        update(Job)
        .where(
            Job.id == job_id,
            Job.state == JobState.FAILED,
            Job.cancellation_requested.is_(False),
            Job.study_cell_id.is_(None),
            Job.result["code"].as_string() == "bim_evaluation_failed",
            exists()
            .where(
                JobEngineEvidence.id == evidence_id,
                JobEngineEvidence.job_id == Job.id,
                JobEngineEvidence.attempt == Job.attempt,
            )
            .correlate(Job),
        )
        .values(
            state=JobState.COMPLETED,
            result=reevaluated,
            termination=reevaluated["termination"],
            provenance=final_provenance,
            lease_token=None,
            lease_until=None,
            finished_at=job_clock.now(session),
        )
        .returning(Job.id)
        .execution_options(synchronize_session=False)
    )
    if won.first() is None:
        await session.rollback()
        raise _refuse(JOB_NOT_REEVALUABLE)
    await session.refresh(job)
    await job_evidence.delete_for_job(session, job_id)
    _audit(
        session, user, "job.reevaluated", job,
        jobId=str(job.id), ownerId=str(job.owner_id), evidenceId=str(evidence_id), result="completed",
    )
    await session.commit()
    return _view(job, user)


@router.get(
    "/{job_id}/events",
    operation_id="streamJobEvents",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}},
)
async def stream_job_events(
    job_id: uuid.UUID,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StreamingResponse:
    user_id = user.id
    first = await _owned(session, job_id, user_id)

    def snapshot(job: Job) -> dict:
        return {
            "id": str(job.id),
            "status": job.state.value,
            "cancellationRequested": job.cancellation_requested,
            "finishedAt": job.finished_at.isoformat() if job.finished_at else None,
        }

    initial = snapshot(first)

    async def events():
        last = None
        current = initial
        for attempt in range(900):
            if attempt:
                if await request.is_disconnected() or not db_base.is_configured():
                    return
                # A streaming response may outlive its dependency session.  Each
                # poll therefore owns a short read-only session and releases its
                # connection before waiting for the next event.
                async with db_base.session_factory()() as poll_session:
                    job = await _owned(poll_session, job_id, user_id)
                    current = snapshot(job)
            encoded = json.dumps(current, separators=(",", ":"))
            if encoded != last:
                yield f"event: job\ndata: {encoded}\n\n"
                last = encoded
            if current["status"] in {
                JobState.COMPLETED.value,
                JobState.FAILED.value,
                JobState.CANCELLED.value,
            }:
                return
            await asyncio.sleep(1)

    return StreamingResponse(
        events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )

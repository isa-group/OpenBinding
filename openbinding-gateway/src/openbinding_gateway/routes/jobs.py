"""Manage, retry and observe durable jobs without changing the solve contract."""

from __future__ import annotations

import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .. import space_client
from ..access.dependencies import get_current_user, session_dependency
from ..db import base as db_base
from ..db.models import AuditEvent, Job, JobProvenance, JobState, User
from ..domain import entitlements
from ..job_dispatch import dispatch_persisted_job
from ..jobs import lifecycle
from ..jobs import limits as job_limits
from ..models.errors import api_error
from ..models.platform import JobView, job_view
from ..repositories import jobs as job_repository
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
) -> Job:
    job = await job_repository.get_owned(session, job_id, user_id, lock=lock)
    if job is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Job not found.")
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
    job = await _owned(session, job_id, user.id, lock=True)
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
) -> JobView:
    original = await _owned(session, job_id, user.id, lock=True)
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
    try:
        caps = await space_client.get_gate().caps(user.id)
    except space_client.PricingUnavailable as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)) from exc
    refusal = entitlements.feature_refusal(caps, "federatedEngines" if federated else "solve")
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

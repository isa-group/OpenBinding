"""Manage, retry and observe durable jobs without changing the solve contract."""

from __future__ import annotations

import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import space_client
from ..access import metering
from ..access.dependencies import get_current_user, session_dependency
from ..db import base as db_base
from ..db.models import Job, JobProvenance, JobState, User, utcnow
from ..job_dispatch import dispatch_persisted_job
from ..models.errors import api_error
from ..models.platform import JobView
from ..v1.canonical import digest

router = APIRouter(prefix="/v1/jobs", tags=["Jobs"])


def _view(job: Job) -> JobView:
    return JobView(
        id=job.id, engine_id=job.engine_id, status=job.state.value,
        cancellation_requested=job.cancellation_requested,
        retry_of_id=job.retry_of_id, organization_id=job.organization_id,
        project_id=job.project_id, created_at=job.created_at, finished_at=job.finished_at,
    )


async def _owned(
    session: AsyncSession,
    job_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    lock: bool = False,
) -> Job:
    query = select(Job).where(Job.id == job_id, Job.owner_id == user_id)
    if lock:
        query = query.with_for_update()
    job = (await session.execute(query)).scalars().first()
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
    query = select(Job).where(Job.owner_id == user.id)
    if state is not None:
        query = query.where(Job.state == state)
    rows = (await session.execute(query.order_by(Job.created_at.desc()).limit(max(1, min(limit, 500))))).scalars().all()
    return [_view(row) for row in rows]


@router.post("/{job_id}/cancel", response_model=JobView, operation_id="cancelJob")
async def cancel_job(
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> JobView:
    job = await _owned(session, job_id, user.id, lock=True)
    if job.state in {JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED}:
        raise api_error(status.HTTP_409_CONFLICT, "terminal_job", "The job is already terminal.")
    job.cancellation_requested = True
    if job.state is JobState.QUEUED:
        job.state = JobState.CANCELLED
        job.finished_at = utcnow()
        await metering.settle(space_client.get_gate(), session, job.id, solver_seconds=0)
    await session.flush()
    return _view(job)


@router.post("/{job_id}/retry", response_model=JobView, status_code=202, operation_id="retryJob")
async def retry_job(
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> JobView:
    original = await _owned(session, job_id, user.id, lock=True)
    if original.state not in {JobState.FAILED, JobState.CANCELLED}:
        raise api_error(status.HTTP_409_CONFLICT, "job_not_retryable", "Only failed or cancelled jobs may be retried.")
    existing = (
        await session.execute(
            select(Job)
            .where(Job.owner_id == user.id, Job.retry_of_id == original.id)
            .order_by(Job.created_at.desc())
            .limit(1)
        )
    ).scalars().first()
    if existing is not None:
        return _view(existing)
    provenance = dict(original.provenance or {})
    registration = provenance.get("registration")
    federated = (
        isinstance(registration, dict)
        and bool(registration)
        and registration.get("namespace") != "bim.builtin"
    )
    try:
        verdict, reservation = await metering.reserve(
            space_client.get_gate(), user.id, federated=federated, session=session
        )
    except space_client.PricingUnavailable as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)) from exc
    if not verdict.allowed:
        raise api_error(status.HTTP_429_TOO_MANY_REQUESTS, "quota_exhausted", verdict.reason or "Solve quota exhausted.")
    replacement = Job(
        owner_id=user.id, engine_id=original.engine_id, engine_job_id=str(uuid.uuid4()),
        service_url=original.service_url, state=JobState.QUEUED, verbose=original.verbose,
        original_request=original.original_request, options=original.options, warnings=original.warnings,
        instance_complexity=original.instance_complexity,
        instance_snapshot_id=original.instance_snapshot_id, provenance=provenance,
        idempotency_fingerprint=original.idempotency_fingerprint,
        requested_budget_s=original.requested_budget_s, retry_of_id=original.id,
        organization_id=original.organization_id, project_id=original.project_id,
        billing_sponsor_user_id=original.billing_sponsor_user_id,
    )
    session.add(replacement)
    await session.flush()
    replacement.engine_job_id = str(replacement.id)
    session.add(JobProvenance(job_id=replacement.id, document=provenance, digest=digest(provenance)))
    await session.commit()
    try:
        await dispatch_persisted_job(str(replacement.id), None if db_base.is_configured() else session)
    except Exception:
        await metering.release(space_client.get_gate(), reservation)
        raise
    return _view(replacement)


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

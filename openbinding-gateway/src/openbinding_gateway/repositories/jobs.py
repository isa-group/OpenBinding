"""Job queries by owner and project; callers decide how a missing row is reported."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from ..db.models import Job, JobState


async def get_owned(
    session: AsyncSession,
    job_id: uuid.UUID,
    owner_id: uuid.UUID,
    *,
    lock: bool = False,
) -> Job | None:
    query = select(Job).where(Job.id == job_id, Job.owner_id == owner_id)
    if lock:
        query = query.with_for_update()
    return (await session.execute(query)).scalars().first()


async def list_owned(
    session: AsyncSession,
    owner_id: uuid.UUID,
    *,
    state: JobState | None = None,
    limit: int = 100,
) -> list[Job]:
    query = select(Job).where(Job.owner_id == owner_id)
    if state is not None:
        query = query.where(Job.state == state)
    rows = await session.execute(query.order_by(Job.created_at.desc()).limit(max(1, min(limit, 500))))
    return list(rows.scalars().all())


async def find_retry_of(
    session: AsyncSession,
    owner_id: uuid.UUID,
    original_id: uuid.UUID,
) -> Job | None:
    return (
        await session.execute(
            select(Job)
            .where(Job.owner_id == owner_id, Job.retry_of_id == original_id)
            .order_by(Job.created_at.desc())
            .limit(1)
        )
    ).scalars().first()


async def list_for_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    job_id: uuid.UUID | None = None,
    include_results: bool = True,
) -> list[Job]:
    query = select(Job).where(Job.project_id == project_id).order_by(Job.created_at.desc())
    if job_id is not None:
        query = query.where(Job.id == job_id)
    if not include_results:
        query = query.options(defer(Job.result), defer(Job.original_request), defer(Job.provenance))
    return list((await session.execute(query)).scalars().all())

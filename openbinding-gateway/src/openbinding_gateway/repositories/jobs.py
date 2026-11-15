"""Job queries by owner and project; callers decide how a missing row is reported."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from ..db.models import BindingCase, BindingCaseRevision, Job, JobState, Organization, ProblemCompilation


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


async def refs_for(session: AsyncSession, jobs: list[Job]) -> dict[uuid.UUID, dict]:
    """What each run is of, in one query: its organization, problem, revision and compilation.

    The values are the ``refs`` of ``models.platform.job_view``.
    """
    ids = [job.id for job in jobs]
    if not ids:
        return {}
    rows = (await session.execute(
        select(
            Job.id,
            Organization.id, Organization.slug,
            BindingCase.id, BindingCase.slug, BindingCase.name,
            BindingCaseRevision.id, BindingCaseRevision.revision,
            ProblemCompilation.id, ProblemCompilation.compilation_digest, ProblemCompilation.ir_digest,
        )
        .join(BindingCaseRevision, BindingCaseRevision.id == Job.revision_id)
        .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
        .join(Organization, Organization.id == BindingCase.organization_id)
        .join(ProblemCompilation, ProblemCompilation.id == Job.compilation_id)
        .where(Job.id.in_(ids))
    )).all()
    return {
        row[0]: {
            "organization": {"id": row[1], "slug": row[2]},
            "problem": {"id": row[3], "slug": row[4], "name": row[5]},
            "revision": {"id": row[6], "revision": row[7]},
            "compilation": {"id": row[8], "compilation_digest": row[9], "ir_digest": row[10]},
        }
        for row in rows
    }

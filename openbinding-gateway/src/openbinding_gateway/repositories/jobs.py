"""Run queries within an organization; callers decide how a missing row is reported."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from ..db.models import BindingCase, BindingCaseRevision, Job, JobState, Organization, ProblemCompilation, User


#: The columns a run list leaves unread: a result can be hundreds of megabytes.
HEAVY_COLUMNS = (Job.result, Job.original_request, Job.provenance)


async def get_in_org(
    session: AsyncSession,
    organization_id: uuid.UUID,
    run_id: uuid.UUID,
    *,
    lock: bool = False,
) -> Job | None:
    """The run of this organization with this id, or ``None`` (the caller answers 404)."""
    query = select(Job).where(Job.id == run_id, Job.organization_id == organization_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    return (await session.execute(query)).scalars().first()


def in_org_query(
    organization_id: uuid.UUID,
    *,
    state: JobState | None = None,
    problem: str | None = None,
    revision: uuid.UUID | None = None,
    engine: str | None = None,
) -> Select:
    """The runs of an organization that match the filters, newest first.

    ``problem`` is a problem slug or id; ``revision`` a revision id; ``engine`` the engine name.
    """
    query = select(Job).where(Job.organization_id == organization_id)
    if state is not None:
        query = query.where(Job.state == state)
    if revision is not None:
        query = query.where(Job.revision_id == revision)
    if engine:
        query = query.where(Job.engine_id == engine)
    if problem:
        try:
            problem_id: uuid.UUID | None = uuid.UUID(problem)
        except ValueError:
            problem_id = None
        cases = select(BindingCase.id).where(
            BindingCase.organization_id == organization_id,
            BindingCase.id == problem_id if problem_id is not None else BindingCase.slug == problem,
        )
        query = query.where(
            Job.revision_id.in_(select(BindingCaseRevision.id).where(BindingCaseRevision.binding_case_id.in_(cases)))
        )
    return query.order_by(Job.created_at.desc(), Job.id.desc())


async def list_in_org(
    session: AsyncSession,
    organization_id: uuid.UUID,
    *,
    state: JobState | None = None,
    problem: str | None = None,
    revision: uuid.UUID | None = None,
    engine: str | None = None,
    limit: int | None = 50,
    offset: int = 0,
    visible: Callable[[Any], bool] | None = None,
) -> tuple[list[Job], int]:
    """A page of the organization's runs and how many match; the heavy columns stay unread.

    ``visible`` keeps only the runs whose provenance it accepts (an API key's engine
    boundary). Only the ids and provenances of the matching runs are read to apply
    it; the rows of the page are loaded afterwards.
    """
    query = in_org_query(organization_id, state=state, problem=problem, revision=revision, engine=engine)
    deferred = [defer(column) for column in HEAVY_COLUMNS]
    if visible is not None:
        candidates = (await session.execute(query.with_only_columns(Job.id, Job.provenance))).all()
        ids = [run_id for run_id, provenance in candidates if visible(provenance)]
        page = ids[offset:] if limit is None else ids[offset:offset + limit]
        if not page:
            return [], len(ids)
        loaded = (await session.execute(select(Job).where(Job.id.in_(page)).options(*deferred))).scalars().all()
        position = {run_id: index for index, run_id in enumerate(page)}
        return sorted(loaded, key=lambda job: position[job.id]), len(ids)
    total = int(await session.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0)
    query = query.options(*deferred)
    if limit is not None:
        query = query.limit(limit).offset(offset)
    return list((await session.execute(query)).scalars().all()), total


async def find_retry_of(session: AsyncSession, original_id: uuid.UUID) -> Job | None:
    """The newest retry of a run, whoever launched it: a run is retried once for the organization."""
    return (
        await session.execute(
            select(Job)
            .where(Job.retry_of_id == original_id)
            .order_by(Job.created_at.desc())
            .limit(1)
        )
    ).scalars().first()


async def refs_for(session: AsyncSession, jobs: list[Job]) -> dict[uuid.UUID, dict]:
    """What each run is of, in one query: its organization, problem, revision and compilation, and who launched it.

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
            User.id, User.username,
        )
        .join(BindingCaseRevision, BindingCaseRevision.id == Job.revision_id)
        .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
        .join(Organization, Organization.id == BindingCase.organization_id)
        .join(ProblemCompilation, ProblemCompilation.id == Job.compilation_id)
        .outerjoin(User, User.id == Job.owner_id)
        .where(Job.id.in_(ids))
    )).all()
    return {
        row[0]: {
            "organization": {"id": row[1], "slug": row[2]},
            "problem": {"id": row[3], "slug": row[4], "name": row[5]},
            "revision": {"id": row[6], "revision": row[7]},
            "compilation": {"id": row[8], "compilation_digest": row[9], "ir_digest": row[10]},
            "created_by": {"id": row[11], "username": row[12]} if row[11] is not None else None,
        }
        for row in rows
    }

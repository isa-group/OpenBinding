"""State changes shared by the routes and the reconciler."""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Job, JobState, StudyCell, utcnow

logger = logging.getLogger(__name__)

TERMINAL_STATES = frozenset({JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED})


async def sync_study_cell(session: AsyncSession, job_id: uuid.UUID) -> None:
    """Let the study cell of a job that just changed state catch up. Never raises.

    A failure rolls back to a savepoint, which expires what the session holds:
    callers that go on using their objects refresh them first.
    """
    from ..study_jobs import sync_study_job

    try:
        async with session.begin_nested():
            await sync_study_job(str(job_id), session)
    except Exception:
        logger.warning("Could not sync the study cell of job %s", job_id, exc_info=True)


async def lock_study_run(session: AsyncSession, job_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    """Row-lock the study run behind a job of ``owner_id``, if there is one.

    Call it before locking the job: cancelling a study's job synchronises its
    cell, which locks the run, and cancelling the whole run locks the run before
    its jobs. Taking the locks in the same order keeps the two from deadlocking.
    """
    from ..study_jobs import lock_run

    run_id = await session.scalar(
        select(StudyCell.study_run_id)
        .join(Job, Job.study_cell_id == StudyCell.id)
        .where(Job.id == job_id, Job.owner_id == owner_id)
    )
    if run_id is not None:
        await lock_run(session, run_id)


async def request_cancellation(session: AsyncSession, job: Job, *, sync_cell: bool = True) -> bool:
    """Ask for a job to stop, and cancel it on the spot when nobody is running it.

    The caller holds the row lock. A running job is left to its worker, which
    sees the request before it writes an outcome; a queued one has no worker, so
    it becomes CANCELLED here and, unless the caller takes care of the cell
    itself, its study cell is synchronised. Returns whether the job is now
    CANCELLED.
    """
    job.cancellation_requested = True
    if job.state is not JobState.QUEUED:
        return False
    job.state = JobState.CANCELLED
    job.lease_token = None
    job.lease_until = None
    job.finished_at = utcnow()
    await session.flush()
    if sync_cell and job.study_cell_id is not None:
        await sync_study_cell(session, job.id)
        await session.refresh(job)
    return True

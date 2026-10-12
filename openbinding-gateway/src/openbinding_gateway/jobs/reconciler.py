"""Recovering jobs whose worker is gone, and the periodic housekeeping around it.

A job can end without anybody watching. The client that started an asynchronous
solve may never poll for the result; the gateway may restart mid-flight; the
engine may die. Any of those leaves a job queued or running forever, so a
reconciler sweeps for jobs that have outlived their lease or their budget:
a lost worker's job goes back in the queue once and is failed the second time.
Failing a job is an ordinary state change: nothing is charged anywhere.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import Settings
from ..db import base as db_base
from ..db.models import Job, JobState, RunState, StudyCell, utcnow
from .leases import MAX_ATTEMPTS, aware
from .lifecycle import sync_study_cell

logger = logging.getLogger(__name__)

ERROR_EVENT_PURGE_INTERVAL_S = 3600.0
# time.monotonic() of the last error-event purge; None until the first sweep.
_last_purge: float | None = None

#: How often the reconciler looks for jobs that have outlived their budget.
SWEEP_INTERVAL_S = 60.0

#: How long past its budget a job without a lease is left alone before being
#: failed. Covers the engine answering slightly late and the client polling
#: slightly later.
ABANDONED_GRACE_S = 120.0

#: How many terminal jobs whose study cell never caught up one sweep resyncs.
STUDY_RESYNC_BATCH = 100


def _still_as_read(job: Job, now: datetime) -> list:
    """Conditions that hold only while nobody has touched the job since it was read.

    A heartbeat or a claim landing between the read and the write changes the
    token or pushes the lease forward, and the sweep then leaves the job alone.
    """
    conditions = [Job.id == job.id, Job.state == job.state]
    if job.lease_token is None:
        conditions.append(Job.lease_token.is_(None))
    else:
        conditions += [Job.lease_token == job.lease_token, Job.lease_until < now]
    return conditions


async def _requeue(session: AsyncSession, job: Job, now: datetime) -> bool:
    """Put a job whose worker was lost back in the queue."""
    requeued = await session.execute(
        update(Job)
        .where(*_still_as_read(job, now))
        .values(state=JobState.QUEUED, lease_token=None)
        .returning(Job.id)
        .execution_options(synchronize_session=False)
    )
    if requeued.first() is None:
        return False
    await session.refresh(job)
    return True


async def _fail_abandoned(session: AsyncSession, job: Job, now: datetime) -> bool:
    """Fail an abandoned job, or leave it exactly as it was.

    One conditioned UPDATE: if a heartbeat or a claim touched the job since it
    was read, nothing matches and the next sweep looks at it again.
    """
    failed = await session.execute(
        update(Job)
        .where(*_still_as_read(job, now))
        .values(state=JobState.FAILED, lease_token=None, lease_until=None, finished_at=utcnow())
        .returning(Job.id)
        .execution_options(synchronize_session=False)
    )
    if failed.first() is None:
        return False
    await session.refresh(job)
    return True


async def _resync_study_cells(session: AsyncSession) -> int:
    """Catch up the study cells of jobs that ended without their cell hearing of it.

    A job ended by the sweep, or by a worker that died after writing the
    outcome, leaves its cell RUNNING and its study run never finishing. Returns
    how many cells were synced; one job failing is logged and does not stop the rest.
    """
    from ..study_jobs import sync_study_job

    terminal_jobs = [JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED]
    terminal_cells = [RunState.COMPLETED, RunState.PARTIAL, RunState.FAILED, RunState.CANCELLED]
    stale = (
        await session.execute(
            select(Job.id)
            .join(StudyCell, StudyCell.job_id == Job.id)
            .where(Job.state.in_(terminal_jobs), StudyCell.state.not_in(terminal_cells))
            .order_by(Job.id)
            .limit(STUDY_RESYNC_BATCH)
        )
    ).scalars().all()
    synced = 0
    for job_id in stale:
        try:
            async with session.begin_nested():
                await sync_study_job(str(job_id), session)
            await session.commit()
            synced += 1
        except Exception:
            logger.warning("Could not resync the study cell of job %s", job_id, exc_info=True)
            await session.rollback()
    return synced


async def sweep_abandoned(session: AsyncSession) -> int:
    """Deal with jobs whose worker is gone, and say how many were failed.

    A job still queued or running long after the time it was allowed is either
    finished and unwatched, or gone with its worker.

    A running job is told from a dead one by its lease. A lapsed lease means
    the worker died, and the first time the job goes back in the queue and
    somebody else runs it. The second time it is failed.

    A job with no lease to judge by (never claimed, or claimed before leases
    existed) is failed once its budget and the grace period have passed,
    counted from when it was claimed or else created.

    The caller commits.
    """
    now = utcnow()
    failed = 0
    unfinished = await session.execute(
        select(Job)
        .where(Job.state.in_([JobState.QUEUED, JobState.RUNNING]))
        .order_by(Job.id)
        .with_for_update(skip_locked=True)
    )

    for job in unfinished.scalars().all():
        budget = job.requested_budget_s or 0.0
        if job.state is JobState.RUNNING and job.lease_token is not None and job.lease_until is not None:
            if aware(job.lease_until) > now:
                continue
            if job.attempt < MAX_ATTEMPTS:
                if await _requeue(session, job, now):
                    logger.warning("Lost the worker of job %s; queued it again", job.id)
                continue
        else:
            started = aware(job.claimed_at or job.created_at)
            if now < started + timedelta(seconds=budget + ABANDONED_GRACE_S):
                continue

        job_id = job.id
        if await _fail_abandoned(session, job, now):
            await sync_study_cell(session, job_id)
            failed += 1
    return failed


async def run_reconciler(
    interval_s: float = SWEEP_INTERVAL_S,
    settings: Settings | None = None,
) -> None:
    """Sweep for abandoned jobs until cancelled. Started by the lifespan.

    Errors are logged and the loop continues: a reconciler that dies on a
    transient database hiccup would leave every abandoned job where it is, and
    nothing would say so.
    """
    global _last_purge
    while True:
        try:
            await asyncio.sleep(interval_s)
            if not db_base.is_configured():
                continue
            async with db_base.session_factory()() as session:
                failed = await sweep_abandoned(session)
                try:
                    await _resync_study_cells(session)
                except Exception:
                    logger.warning("Resyncing study cells failed; continuing", exc_info=True)
                    try:
                        await session.rollback()  # leave a usable transaction for the rest
                    except Exception:
                        logger.warning("Could not roll back after resyncing study cells", exc_info=True)
                # Requeued and failed jobs must be visible to whoever reads
                # next, and the redelivery below reaches out to the broker.
                await session.commit()
                from ..access.contracts import archive_drained_pricings, sweep_contract_renewals
                from ..job_dispatch import redeliver_queued_jobs

                redelivered = await redeliver_queued_jobs(session)
                migrated = await sweep_contract_renewals(session)
                archived = await archive_drained_pricings(session, settings) if settings else 0
                from ..sponsor_proposals import sweep_expired

                proposals_expired = await sweep_expired(session)
                purged = 0
                if _last_purge is None or time.monotonic() - _last_purge >= ERROR_EVENT_PURGE_INTERVAL_S:
                    from ..telemetry import purge_old_error_events

                    _last_purge = time.monotonic()
                    try:
                        purged = await purge_old_error_events(session, days=90)
                    except Exception:
                        logger.warning("Purging old error events failed; continuing", exc_info=True)
                await session.commit()
            # Analysis recovery commits before dispatch; isolate it from the sweep's transaction.
            from ..analysis_jobs import redeliver_analysis
            async with db_base.session_factory()() as analysis_session:
                await redeliver_analysis(analysis_session)
            if failed:
                logger.info("Failed %d abandoned job(s)", failed)
            if migrated:
                logger.info("Migrated %d expired contract(s) to LIVE", migrated)
            if archived:
                logger.info("Archived %d drained pricing release(s)", archived)
            if redelivered:
                logger.info("Redelivered %d queued job(s)", redelivered)
            if proposals_expired:
                logger.info("Expired %d sponsorship proposal(s)", proposals_expired)
            if purged:
                logger.info("Purged %d old error event(s)", purged)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("The job reconciler sweep failed; continuing")

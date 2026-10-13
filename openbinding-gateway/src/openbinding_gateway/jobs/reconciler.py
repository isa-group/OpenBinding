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
import uuid
from datetime import timedelta

from sqlalchemy import BigInteger, func, literal, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.public_errors import current_correlation_id, job_failure_fields
from ..core.settings import get_settings
from ..db import base as db_base
from ..db.models import Job, JobState, RunState, StudyCell
from . import clock
from .leases import MAX_ATTEMPTS, aware
from .lifecycle import sync_study_cell

logger = logging.getLogger(__name__)

#: The key of the PostgreSQL advisory lock that makes one replica at a time run a
#: reconciliation cycle. Fixed, and not derived from anything else in the database.
RECONCILER_LOCK_KEY = 0x0B1D_5EC0_0001

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


async def acquire_cycle_lock(session: AsyncSession) -> bool:
    """Whether this replica is the one that runs the reconciliation cycle.

    On PostgreSQL a transaction-level advisory lock on a fixed key: the replica
    that gets it keeps the lock for as long as ``session``'s transaction stays
    open, which the caller arranges to be the whole cycle, and every other
    replica skips the cycle. Losing the lock early (the connection drops) only
    costs the exclusivity, never correctness: every step of the cycle is a
    conditioned UPDATE. SQLite has a single process and no lock to take.
    """
    if not clock.uses_db_clock(session):
        return True
    # A BigInteger parameter: the key does not fit in the 32 bits a plain int is sent as.
    key = literal(RECONCILER_LOCK_KEY, BigInteger)
    return bool(await session.scalar(select(func.pg_try_advisory_xact_lock(key))))


def _still_as_read(session: AsyncSession, job: Job) -> list:
    """Conditions that hold only while nobody has touched the job since it was read.

    A heartbeat or a claim landing between the read and the write changes the
    token or pushes the lease forward, and the sweep then leaves the job alone.
    The deadline is compared by the database clock, in the statement itself.
    """
    conditions = [Job.id == job.id, Job.state == job.state]
    if job.lease_token is None:
        conditions.append(Job.lease_token.is_(None))
    else:
        conditions += [Job.lease_token == job.lease_token, Job.lease_until < clock.now(session)]
    return conditions


async def _requeue(session: AsyncSession, job: Job) -> bool:
    """Put a job whose worker was lost back in the queue, due for publication now."""
    requeued = await session.execute(
        update(Job)
        .where(*_still_as_read(session, job))
        .values(
            state=JobState.QUEUED,
            lease_token=None,
            publish_attempts=0,
            next_publish_at=clock.now(session),
        )
        .returning(Job.id)
        .execution_options(synchronize_session=False)
    )
    if requeued.first() is None:
        return False
    await session.refresh(job)
    return True


async def _fail_abandoned(session: AsyncSession, job: Job) -> bool:
    """Fail an abandoned job, or leave it exactly as it was.

    One conditioned UPDATE: if a heartbeat or a claim touched the job since it
    was read, nothing matches and the next sweep looks at it again.

    The job gets a stable ``code`` like any other failed job: ``lease_lost``
    when its worker stopped renewing the lease, ``job_abandoned`` when it never
    had one and outlived its budget.
    """
    code = "lease_lost" if job.lease_token is not None else "job_abandoned"
    result = {
        "termination": "UNKNOWN",
        "solutions": [],
        **job_failure_fields(code, current_correlation_id()),
        "provenance": getattr(job, "provenance", None) or {},
    }
    failed = await session.execute(
        update(Job)
        .where(*_still_as_read(session, job))
        .values(
            state=JobState.FAILED,
            result=result,
            termination="UNKNOWN",
            lease_token=None,
            lease_until=None,
            finished_at=clock.now(session),
        )
        .returning(Job.id)
        .execution_options(synchronize_session=False)
    )
    if failed.first() is None:
        return False
    logger.warning(
        "Failed abandoned job %s: code=%s correlation_id=%s", job.id, code, result["correlationId"]
    )
    await session.refresh(job)
    return True


def queued_since():
    """When a queued job started waiting: its requeue (the lapsed lease), else its creation."""
    return func.coalesce(Job.lease_until, Job.claimed_at, Job.created_at)


async def _fail_queue_timeout(session: AsyncSession, job: Job, timeout_s: float) -> bool:
    """Fail a job no worker claimed within ``timeout_s``, or leave it as it was."""
    result = {
        "termination": "UNKNOWN",
        "solutions": [],
        "code": "queue_timeout",
        "error": f"queue_timeout: no worker claimed the job within {timeout_s:g} s",
        "provenance": job.provenance or {},
    }
    failed = await session.execute(
        update(Job)
        .where(
            Job.id == job.id,
            Job.state == JobState.QUEUED,
            Job.lease_token.is_(None),
            queued_since() < clock.before(session, timeout_s),
        )
        .values(
            state=JobState.FAILED,
            result=result,
            termination="UNKNOWN",
            lease_until=None,
            finished_at=clock.now(session),
        )
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

    A running job with no lease to judge by (claimed before leases existed) is
    failed once its budget and the grace period have passed, counted from when
    it was claimed or else created.

    A queued job is not running, so its budget does not apply: it is failed with
    ``queue_timeout`` once it has waited ``QUEUE_TIMEOUT_S`` for a worker.

    Every comparison with the clock uses the database's (see ``clock``), so
    replicas whose own clocks disagree cannot take a live job back.

    The job rows are locked only while their state is decided and written. That
    transaction is committed before any study cell is synchronised, because
    syncing locks the run and cancelling a run locks run, cells, then jobs: a
    sweep holding a job while it waited for the run could deadlock with it. A
    commit here is the one exception to "the caller commits", made only when
    some job was ended; the study cells are synced, and committed, after it.
    """
    now = await clock.read_now(session)
    queue_timeout_s = get_settings().queue_timeout_s
    ended: list[uuid.UUID] = []
    unfinished = await session.execute(
        select(Job)
        .where(Job.state.in_([JobState.QUEUED, JobState.RUNNING]))
        .order_by(Job.id)
        .with_for_update(skip_locked=True)
    )

    for job in unfinished.scalars().all():
        job_id = job.id
        if job.state is JobState.QUEUED:
            since = aware(job.lease_until or job.claimed_at or job.created_at)
            if now < since + timedelta(seconds=queue_timeout_s):
                continue
            if await _fail_queue_timeout(session, job, queue_timeout_s):
                logger.warning("Job %s waited %g s in the queue; failed it", job_id, queue_timeout_s)
                ended.append(job_id)
            continue
        budget = job.requested_budget_s or 0.0
        if job.lease_token is not None and job.lease_until is not None:
            if aware(job.lease_until) > now:
                continue
            if job.attempt < MAX_ATTEMPTS:
                if await _requeue(session, job):
                    logger.warning("Lost the worker of job %s; queued it again", job_id)
                continue
        else:
            started = aware(job.claimed_at or job.created_at)
            if now < started + timedelta(seconds=budget + ABANDONED_GRACE_S):
                continue

        if await _fail_abandoned(session, job):
            ended.append(job_id)

    if not ended:
        return 0
    await session.commit()  # releases the job locks before the run's are taken
    for job_id in ended:
        await sync_study_cell(session, job_id)
        await session.commit()
    return len(ended)


async def _reconcile_cycle(factory) -> None:
    """One pass: sweep, resync cells, publish due jobs, then the other housekeeping."""
    global _last_purge
    async with factory() as session:
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
        from ..job_dispatch import redeliver_queued_jobs

        redelivered = await redeliver_queued_jobs(session)
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

    async with factory() as analysis_session:
        await redeliver_analysis(analysis_session)
    if failed:
        logger.info("Failed %d abandoned job(s)", failed)
    if redelivered:
        logger.info("Redelivered %d queued job(s)", redelivered)
    if proposals_expired:
        logger.info("Expired %d sponsorship proposal(s)", proposals_expired)
    if purged:
        logger.info("Purged %d old error event(s)", purged)


async def run_reconciler(interval_s: float = SWEEP_INTERVAL_S) -> None:
    """Sweep for abandoned jobs until cancelled. Started by the lifespan.

    Errors are logged and the loop continues: a reconciler that dies on a
    transient database hiccup would leave every abandoned job where it is, and
    nothing would say so. On PostgreSQL only the replica holding the cycle lock
    works; the others skip the cycle.
    """
    while True:
        try:
            await asyncio.sleep(interval_s)
            if not db_base.is_configured():
                continue
            factory = db_base.session_factory()
            # The cycle lock lives in the transaction of its own session, which
            # stays open (and idle) until the cycle is over; the work below
            # commits as often as it needs on other sessions.
            async with factory() as lock_session:
                if not await acquire_cycle_lock(lock_session):
                    logger.debug("Another replica is reconciling; skipping this cycle")
                    continue
                await _reconcile_cycle(factory)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("The job reconciler sweep failed; continuing")

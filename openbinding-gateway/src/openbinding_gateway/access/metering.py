"""Charging for a solve, and making sure an abandoned one is not free.

A solve is expensive and its cost is not known until it is over, so the
accounting happens in two moves. Before dispatch the gateway asks whether the
plan allows another solve and takes what it can already count: one task, and one
concurrency slot. Afterwards it reports the seconds the engine actually spent
and gives the slot back.

Two things make that harder than it sounds, and both are handled here.

A job can end without anybody watching. The client that started an asynchronous
solve may never poll for the result; the gateway may restart mid-flight; the
engine may die. Any of those leaves a slot taken forever, which for an account
allowed one concurrent solve means it can never solve again. SPACE's own
``revert`` is no help - it expires after a couple of minutes, and these solves
run for up to half an hour - so a reconciler sweeps for jobs that have outlived
their budget and settles them.

And a job must not be settled twice. A client polling twice at once, or a poll
racing the reconciler, would otherwise charge the same solve twice or release a
slot that somebody else has since taken. The ``metered`` and
``concurrency_released`` columns are flipped with a compare-and-set, so exactly
one of the racers does the work.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..db import base as db_base
from ..db.models import Job, JobState, RunState, StudyCell, User, utcnow
from ..core.settings import Settings
from ..space_client import PricingGate, PricingUnavailable, Verdict

logger = logging.getLogger(__name__)

ERROR_EVENT_PURGE_INTERVAL_S = 3600.0
# time.monotonic() of the last error-event purge; None until the first sweep.
_last_purge: float | None = None

#: How often the reconciler looks for jobs that have outlived their budget.
SWEEP_INTERVAL_S = 60.0

#: How long past its budget a job is left alone before being settled. Covers
#: the engine answering slightly late and the client polling slightly later.
SETTLEMENT_GRACE_S = 120.0

#: How long a claim is good for without being renewed. A worker that dies
#: leaves a lease that simply runs out, which is how it is told from a slow one.
LEASE_S = 60.0

#: How often a live worker renews its lease: three chances per lease.
HEARTBEAT_S = 20.0

#: How many times a job may be claimed. A worker lost mid-solve gets the job
#: put back once; the second loss fails it, so a job that kills its worker
#: cannot circle the queue forever.
MAX_ATTEMPTS = 2

#: How many unsettled terminal jobs one sweep retries.
SETTLE_RETRY_BATCH = 100

#: How many terminal jobs whose study cell never caught up one sweep resyncs.
STUDY_RESYNC_BATCH = 100

#: What a solve costs before anybody knows how long it took.
TASK_COST = {"taskStarts": 1, "concurrentJobs": 1}
FEDERATED_TASK_COST = {"federatedTaskStarts": 1, "concurrentJobs": 1}

#: Charges SPACE accepted whose ``metered`` flag never reached the database,
#: by job. The next ``settle`` of the job records the flag without asking SPACE
#: again. Memory of this process only: a restart before the job is settled again
#: forgets it, and then only the ERROR log and ``usage/resync`` remain.
_unrecorded: dict[uuid.UUID, dict] = {}


class SettlementCommitFailed(RuntimeError):
    """SPACE took a charge but the database did not keep the job's settlement.

    The charge is remembered in ``_unrecorded`` so that settling the job again
    does not take it twice.
    """

    def __init__(self, job_ids: list[uuid.UUID]):
        super().__init__(f"Could not record the settlement of job(s) {', '.join(map(str, job_ids))}")
        self.job_ids = job_ids


@dataclass(frozen=True)
class Reservation:
    """What was taken on a solve's behalf, so it can be given back."""

    user_id: uuid.UUID
    increments: dict

    @property
    def refund(self) -> dict:
        return {name: -amount for name, amount in self.increments.items()}


async def reserve(
    gate: PricingGate,
    user_id: uuid.UUID,
    *,
    federated: bool = False,
    session: AsyncSession | None = None,
) -> tuple[Verdict, Optional[Reservation]]:
    """Ask whether another solve is allowed, and take what it costs up front.

    A request transaction locks the actor row before asking and taking, so two
    gateway replicas cannot both consume the final slot. Solver time is not
    taken here because nobody knows it until the Engine returns.
    """
    if session is not None:
        await session.execute(select(User.id).where(User.id == user_id).with_for_update())

    feature = "federatedEngines" if federated else "solve"
    caps = await gate.caps(user_id)
    has_capacity_units = "capacityUnits" in caps.limits

    if has_capacity_units and "taskStarts" not in caps.limits:
        expected = {"capacityUnits": 1, "concurrentJobs": 1}
        verdict = await gate.evaluate(user_id, feature, expected)
        if not verdict.allowed:
            return verdict, None
        increments = {"capacityUnits": 1, "concurrentJobs": 1}
    else:
        verdict = await gate.evaluate(user_id, feature)
        if not verdict.allowed:
            return verdict, None
        increments = dict(FEDERATED_TASK_COST if federated else TASK_COST)

    await gate.adjust_usage(user_id, increments)
    return verdict, Reservation(user_id=user_id, increments=increments)


async def release(gate: PricingGate, reservation: Optional[Reservation]) -> None:
    """Give back everything a reservation took, for work that never happened."""
    if reservation is None or not reservation.increments:
        return
    try:
        await gate.adjust_usage(reservation.user_id, reservation.refund)
    except PricingUnavailable:
        # The reconciler will not find this job, because it never became one.
        # Losing a task from somebody's monthly allowance is the least bad
        # outcome available, and it is visible in their usage.
        logger.warning("Could not refund a failed solve for %s", reservation.user_id)


def _aware(moment: datetime) -> datetime:
    """SQLite hands timestamps back naive; they were written as UTC."""
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def lease_key(job_id: uuid.UUID) -> str:
    """Where a worker keeps its lease token inside its session."""
    return f"job-lease:{job_id}"


async def claim_job(session: AsyncSession, job_id: uuid.UUID) -> Optional[str]:
    """Take a queued job for this worker, and return the token proving it.

    One UPDATE decides the race: of two workers claiming the same job, exactly
    one finds it still queued. Nothing is returned for the other.
    """
    token = str(uuid.uuid4())
    now = utcnow()
    claimed = await session.execute(
        update(Job)
        .where(Job.id == job_id, Job.state == JobState.QUEUED)
        .values(
            state=JobState.RUNNING,
            lease_token=token,
            lease_until=now + timedelta(seconds=LEASE_S),
            claimed_at=now,
            attempt=Job.attempt + 1,
        )
        .returning(Job.id)
    )
    if claimed.first() is None:
        return None
    session.info[lease_key(job_id)] = token
    return token


def held_token(session: AsyncSession, job_id: uuid.UUID) -> Optional[str]:
    return session.info.get(lease_key(job_id))


async def hold_lease(session: AsyncSession, job_id: uuid.UUID, token: Optional[str]) -> bool:
    """Whether this worker still owns the job, locking the row if it does.

    The lock is what makes the answer last: the reconciler cannot take the job
    back between this check and the commit that writes the outcome.
    """
    if token is None:
        return False
    held = await session.execute(
        select(Job.id)
        .where(Job.id == job_id, Job.state == JobState.RUNNING, Job.lease_token == token)
        .with_for_update()
    )
    return held.first() is not None


async def renew_lease(factory: async_sessionmaker, job_id: uuid.UUID, token: str) -> bool:
    """Push the lease forward, but only for the worker that holds it."""
    async with factory() as session:
        renewed = await session.execute(
            update(Job)
            .where(Job.id == job_id, Job.state == JobState.RUNNING, Job.lease_token == token)
            .values(lease_until=utcnow() + timedelta(seconds=LEASE_S))
            .returning(Job.id)
            .execution_options(synchronize_session=False)
        )
        held = renewed.first() is not None
        await session.commit()
        return held


async def _heartbeat(
    factory: async_sessionmaker, job_id: uuid.UUID, token: str, interval_s: float
) -> None:
    while True:
        await asyncio.sleep(interval_s)
        try:
            if not await renew_lease(factory, job_id, token):
                return  # The job was taken back; there is nothing left to keep alive.
        except asyncio.CancelledError:
            raise
        except Exception:
            # One missed beat is survivable, the lease allows for three.
            logger.warning("Could not renew the lease on job %s", job_id, exc_info=True)


def start_heartbeat(
    session: AsyncSession,
    job_id: uuid.UUID,
    token: str,
    interval_s: float | None = None,
) -> Optional[asyncio.Task]:
    """Keep a claimed job's lease alive until the returned task is stopped.

    The beat uses its own connection: the worker's session is busy running the
    solve and a session cannot be shared between coroutines.
    """
    if db_base.is_configured():
        factory = db_base.session_factory()
    elif session.bind is not None:
        factory = async_sessionmaker(session.bind, expire_on_commit=False)
    else:
        return None
    return asyncio.create_task(
        _heartbeat(factory, job_id, token, HEARTBEAT_S if interval_s is None else interval_s)
    )


async def stop_heartbeat(task: Optional[asyncio.Task]) -> None:
    """Stop renewing a lease.

    Commit the job's outcome first and stop the heartbeat afterwards: the
    lease is the only thing keeping the reconciler off a running job, and
    stopping the beat before the outcome is durable opens a window in which a
    lapsed lease lets the reconciler take back a job that has already finished.
    """
    if task is None:
        return
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


def _charge_key(job_id: uuid.UUID) -> str:
    """Where a session keeps a charge SPACE took that its transaction has yet to record."""
    return f"job-charge:{job_id}"


def _remember_staged(session: AsyncSession) -> list[uuid.UUID]:
    """Move the charges this session staged into process memory, and say for which jobs.

    Called when the transaction that was to record them did not survive: SPACE
    keeps the charge whatever happens to the database.
    """
    remembered = []
    for key in [k for k in session.info if isinstance(k, str) and k.startswith("job-charge:")]:
        job_id = uuid.UUID(key.removeprefix("job-charge:"))
        delta = session.info.pop(key)
        _unrecorded[job_id] = delta
        logger.error(
            "SPACE took the settlement of job %s but the database did not record it "
            "(job_id=%s delta=%s); it will not be charged again, correct drift with usage/resync "
            "if this process restarts first",
            job_id, job_id, delta,
            extra={"job_id": str(job_id), "delta": delta},
        )
        remembered.append(job_id)
    return remembered


def remember_staged_charges(session: AsyncSession) -> list[uuid.UUID]:
    """For a caller whose transaction is being abandoned: keep what SPACE already took."""
    return _remember_staged(session)


def _forget_staged(session: AsyncSession) -> None:
    for key in [k for k in session.info if isinstance(k, str) and k.startswith("job-charge:")]:
        session.info.pop(key)


async def commit_settlement(session: AsyncSession) -> None:
    """Commit what ``settle`` staged, without losing a charge if the commit fails.

    ``settle`` tells SPACE before the row is confirmed, so the commit is the
    moment the settlement becomes real. If it fails, the charges are kept in
    memory (``_unrecorded``) and ``SettlementCommitFailed`` is raised.
    """
    try:
        await session.commit()
    except Exception as exc:
        jobs = _remember_staged(session)
        if not jobs:
            raise
        raise SettlementCommitFailed(jobs) from exc
    _forget_staged(session)


async def _record(
    session: AsyncSession, job: Job, charged: dict, concurrency_released: bool
) -> None:
    """Mark a job settled; a failed flush after a real charge is remembered, not lost."""
    if charged:
        session.info[_charge_key(job.id)] = charged
    job.metered = True
    job.concurrency_released = concurrency_released
    job.finished_at = utcnow()
    try:
        await session.flush()
    except Exception as exc:
        if not charged:
            raise
        _remember_staged(session)
        raise SettlementCommitFailed([job.id]) from exc


async def record_unrecorded(session: AsyncSession, job_id: uuid.UUID) -> bool:
    """Record, in the caller's transaction, a charge SPACE took earlier. Never calls SPACE.

    For a worker that is failing a job whose settlement it could not commit.
    """
    if job_id not in _unrecorded:
        return False
    result = await session.execute(
        select(Job).where(Job.id == job_id, Job.metered.is_(False)).with_for_update()
    )
    job = result.scalar_one_or_none()
    if job is None:
        _unrecorded.pop(job_id, None)
        return False
    charged = _unrecorded.pop(job_id)
    await _record(session, job, charged, "concurrentJobs" in charged)
    return True


async def settle(
    gate: PricingGate,
    session: AsyncSession,
    job_id: uuid.UUID,
    *,
    solver_seconds: float,
    release_slot: bool = True,
) -> bool:
    """Charge a finished solve for what it spent, exactly once.

    Returns whether this caller was the one that settled it. The row lock keeps
    concurrent callers out until SPACE has accepted the usage update; a SPACE
    outage therefore leaves the job retryable instead of silently losing use.

    SPACE is told before the row is confirmed, so the caller must commit right
    after a successful settle (``commit_settlement``). A charge whose row did
    not survive is in ``_unrecorded``, and settling the job again records it
    without asking SPACE a second time. ``SettlementCommitFailed`` is raised if
    the flush fails after the charge.
    """
    result = await session.execute(
        select(Job).where(Job.id == job_id, Job.metered.is_(False)).with_for_update()
    )
    job = result.scalar_one_or_none()
    if job is None:
        _unrecorded.pop(job_id, None)  # settled by somebody else since
        return False

    pending = _unrecorded.pop(job_id, None)
    if pending is not None:
        await _record(session, job, pending, "concurrentJobs" in pending)
        return True

    increments: dict = {}
    if job.owner_id is not None:
        if solver_seconds > 0:
            increments["solverSeconds"] = round(solver_seconds, 3)
        if release_slot:
            increments["concurrentJobs"] = -1
        if increments:
            await gate.adjust_usage(job.owner_id, increments)

    await _record(session, job, increments, release_slot)
    return True


def _observed_seconds(job: Job, budget: float, now: datetime) -> float:
    """How long an abandoned job was seen running, never more than its budget.

    The last sign of life is the last renewal of the lease, which is a lease
    length before ``lease_until``. A running job nobody ever saw start (no
    ``claimed_at``, from before leases) is charged the whole budget, as every
    abandoned job once was. A queued job nobody ever claimed never held an
    engine and costs nothing.
    """
    if job.claimed_at is None:
        return 0.0 if job.state is JobState.QUEUED else budget
    last_seen = now
    if job.lease_until is not None:
        last_seen = min(now, _aware(job.lease_until) - timedelta(seconds=LEASE_S))
    return min(budget, max(0.0, (last_seen - _aware(job.claimed_at)).total_seconds()))


def _ran_for(job: Job) -> float:
    """What a job that reached a terminal state spent, for a settlement retried later."""
    if job.claimed_at is None or job.finished_at is None:
        return 0.0
    seconds = max(0.0, (_aware(job.finished_at) - _aware(job.claimed_at)).total_seconds())
    return min(seconds, job.requested_budget_s) if job.requested_budget_s else seconds


def _still_as_read(job: Job, now: datetime) -> list:
    """Conditions that hold only while nobody has touched the job since it was read.

    A heartbeat or a claim landing between the read and the write changes the
    token or pushes the lease forward, and the sweep then leaves the job alone.
    """
    conditions = [Job.id == job.id, Job.state == job.state, Job.metered.is_(False)]
    if job.lease_token is None:
        conditions.append(Job.lease_token.is_(None))
    else:
        conditions += [Job.lease_token == job.lease_token, Job.lease_until < now]
    return conditions


async def _requeue(session: AsyncSession, job: Job, now: datetime) -> bool:
    """Put a job whose worker was lost back in the queue, free of charge."""
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


async def _fail_abandoned(
    gate: PricingGate, session: AsyncSession, job: Job, seconds: float, now: datetime
) -> bool:
    """Fail an abandoned job and charge it, or leave it exactly as it was.

    The savepoint makes the two inseparable: if SPACE cannot take the charge,
    the job is still running with a lapsed lease and the next sweep tries again.
    """
    try:
        async with session.begin_nested():
            failed = await session.execute(
                update(Job)
                .where(*_still_as_read(job, now))
                .values(state=JobState.FAILED, lease_token=None, lease_until=None)
                .returning(Job.id)
                .execution_options(synchronize_session=False)
            )
            if failed.first() is None:
                return False
            settled = await settle(gate, session, job.id, solver_seconds=seconds)
    except Exception as exc:
        _remember_staged(session)
        logger.warning("Could not settle abandoned job %s yet: %s", job.id, exc)
        return False
    await session.refresh(job)
    return settled


async def _commit_settled(session: AsyncSession) -> bool:
    """Make one job's settlement durable, or say that it could not be.

    One short transaction per job: SPACE has already been told by the time this
    runs, so the longer the settlement waits to be committed the more of them a
    single failure can lose. After a failure the session is rolled back and the
    charge is remembered (and logged at ERROR); the caller stops its sweep.
    """
    try:
        await commit_settlement(session)
        return True
    except Exception:
        logger.exception("Could not commit a settlement; stopping this sweep")
        try:
            await session.rollback()
        except Exception:
            logger.warning("Could not roll back after a failed settlement commit", exc_info=True)
        return False


async def _sync_study_cell(session: AsyncSession, job_id: uuid.UUID) -> None:
    """Let the study cell of a job the sweep just ended catch up. Never raises."""
    from ..study_jobs import sync_study_job

    try:
        async with session.begin_nested():
            await sync_study_job(str(job_id), session)
    except Exception:
        logger.warning("Could not sync the study cell of job %s", job_id, exc_info=True)


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


async def _settle_finished(gate: PricingGate, session: AsyncSession) -> tuple[int, bool]:
    """Settle jobs that ended but whose charge never went through.

    A worker writes the outcome first and settles second; if SPACE was down for
    the second, nobody else would ever look at the job again. Says how many were
    settled and whether the sweep may go on (False after a failed commit).
    """
    unsettled = await session.execute(
        select(Job)
        .where(
            Job.metered.is_(False),
            Job.state.in_([JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED]),
        )
        .order_by(Job.id)
        .limit(SETTLE_RETRY_BATCH)
        .with_for_update(skip_locked=True)
    )
    settled = 0
    # Read everything up front: a rolled-back savepoint expires what it touched.
    work = [(job.id, _ran_for(job)) for job in unsettled.scalars().all()]
    for job_id, ran_for in work:
        try:
            async with session.begin_nested():
                done = await settle(gate, session, job_id, solver_seconds=ran_for)
        except Exception as exc:
            # One refusal from SPACE must not hide the jobs behind it.
            _remember_staged(session)
            logger.warning("Could not settle finished job %s yet: %s", job_id, exc)
            continue
        if done:
            if not await _commit_settled(session):
                return settled, False
            settled += 1
    return settled, True


async def sweep_abandoned(gate: PricingGate, session: AsyncSession) -> int:
    """Deal with jobs whose worker is gone, and say how many were settled.

    A job still queued or running long after the time it was allowed is either
    finished and unwatched, or gone with its worker. Either way its slot is
    doing nothing but stopping its owner from solving again.

    A running job is told from a dead one by its lease. A lapsed lease means
    the worker died, and the first time that costs nothing: the job goes back in
    the queue and somebody else runs it. The second time it is failed and
    charged for the time it was seen running, up to its budget.

    A job with no lease to judge by (never claimed, or claimed before leases
    existed) is failed once its budget and the grace period have passed,
    counted from when it was claimed or else created. A queued one nobody ever
    claimed is charged nothing; a running one from before leases, its budget.

    Each settlement is committed on its own as soon as it is made, because SPACE
    has been told by then. If a commit fails the sweep stops there: the charge is
    remembered and logged, and the next sweep records it without charging again.
    """
    now = utcnow()
    settled = 0
    unfinished = await session.execute(
        select(Job)
        .where(
            Job.metered.is_(False),
            Job.state.in_([JobState.QUEUED, JobState.RUNNING]),
        )
        .order_by(Job.id)
        .with_for_update(skip_locked=True)
    )

    for job in unfinished.scalars().all():
        budget = job.requested_budget_s or 0.0
        if job.state is JobState.RUNNING and job.lease_token is not None and job.lease_until is not None:
            if _aware(job.lease_until) > now:
                continue
            if job.attempt < MAX_ATTEMPTS:
                if await _requeue(session, job, now):
                    logger.warning("Lost the worker of job %s; queued it again", job.id)
                continue
        else:
            started = _aware(job.claimed_at or job.created_at)
            if now < started + timedelta(seconds=budget + SETTLEMENT_GRACE_S):
                continue

        # Charged for what it was seen to spend rather than for nothing: the
        # engine was holding it, and an abandoned solve that costs nothing is
        # an invitation to abandon every solve.
        job_id = job.id
        if await _fail_abandoned(gate, session, job, _observed_seconds(job, budget, now), now):
            await _sync_study_cell(session, job_id)
            if not await _commit_settled(session):
                return settled
            settled += 1

    finished, _ = await _settle_finished(gate, session)
    return settled + finished


async def run_reconciler(
    gate: PricingGate,
    interval_s: float = SWEEP_INTERVAL_S,
    settings: Settings | None = None,
) -> None:
    """Sweep for abandoned jobs until cancelled. Started by the lifespan.

    Errors are logged and the loop continues: a reconciler that dies on a
    transient database hiccup would leave every subsequent job unsettled, and
    nothing would say so.
    """
    global _last_purge
    while True:
        try:
            await asyncio.sleep(interval_s)
            if not db_base.is_configured():
                continue
            async with db_base.session_factory()() as session:
                settled = await sweep_abandoned(gate, session)
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
                from .contracts import archive_drained_pricings, sweep_contract_renewals
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
            # Analysis recovery commits before dispatch; isolate it from billing transactions.
            from ..analysis_jobs import redeliver_analysis
            async with db_base.session_factory()() as analysis_session:
                await redeliver_analysis(analysis_session)
            if settled:
                logger.info("Settled %d abandoned job(s)", settled)
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

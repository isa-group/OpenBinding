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
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import base as db_base
from ..db.models import Job, JobState, User, utcnow
from ..core.settings import Settings
from ..space_client import PricingGate, PricingUnavailable, Verdict

logger = logging.getLogger(__name__)

#: How often the reconciler looks for jobs that have outlived their budget.
SWEEP_INTERVAL_S = 60.0

#: How long past its budget a job is left alone before being settled. Covers
#: the engine answering slightly late and the client polling slightly later.
SETTLEMENT_GRACE_S = 120.0

#: What a solve costs before anybody knows how long it took.
TASK_COST = {"taskStarts": 1, "concurrentJobs": 1}
FEDERATED_TASK_COST = {"federatedTaskStarts": 1, "concurrentJobs": 1}


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
    verdict = await gate.evaluate(user_id, "federatedEngines" if federated else "solve")
    if not verdict.allowed:
        return verdict, None

    increments = dict(FEDERATED_TASK_COST if federated else TASK_COST)
    await gate.adjust_usage(user_id, increments)
    return verdict, Reservation(user_id=user_id, increments=increments)


async def release(gate: PricingGate, reservation: Optional[Reservation]) -> None:
    """Give back everything a reservation took, for work that never happened."""
    if reservation is None:
        return
    try:
        await gate.adjust_usage(reservation.user_id, reservation.refund)
    except PricingUnavailable:
        # The reconciler will not find this job, because it never became one.
        # Losing a task from somebody's monthly allowance is the least bad
        # outcome available, and it is visible in their usage.
        logger.warning("Could not refund a failed solve for %s", reservation.user_id)


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
    """
    result = await session.execute(
        select(Job).where(Job.id == job_id, Job.metered.is_(False)).with_for_update()
    )
    job = result.scalar_one_or_none()
    if job is None:
        return False

    if job.owner_id is not None:
        increments = {}
        if solver_seconds > 0:
            increments["solverSeconds"] = round(solver_seconds, 3)
        if release_slot:
            increments["concurrentJobs"] = -1
        await gate.adjust_usage(job.owner_id, increments)

    job.metered = True
    job.concurrency_released = release_slot
    job.finished_at = utcnow()
    await session.flush()
    return True


async def sweep_abandoned(gate: PricingGate, session: AsyncSession) -> int:
    """Settle jobs that have outlived their budget, and say how many.

    A job still queued or running long after the time it was allowed is either
    finished and unwatched, or gone with its engine. Either way its slot is
    doing nothing but stopping its owner from solving again.
    """
    settled = 0
    unfinished = await session.execute(
        select(Job).where(
            Job.metered.is_(False),
            Job.state.in_([JobState.QUEUED, JobState.RUNNING]),
        )
    )

    for job in unfinished.scalars().all():
        budget = job.requested_budget_s or 0.0
        created_at = job.created_at
        if created_at.tzinfo is None:
            from datetime import timezone

            created_at = created_at.replace(tzinfo=timezone.utc)

        deadline = created_at + timedelta(seconds=budget + SETTLEMENT_GRACE_S)
        if utcnow() < deadline:
            continue

        job.state = JobState.FAILED
        # Charged for the budget it was given rather than for nothing: the
        # engine was holding it, and an abandoned solve that costs nothing is
        # an invitation to abandon every solve.
        if await settle(gate, session, job.id, solver_seconds=budget):
            settled += 1

    return settled


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
    while True:
        try:
            await asyncio.sleep(interval_s)
            if not db_base.is_configured():
                continue
            async with db_base.session_factory()() as session:
                settled = await sweep_abandoned(gate, session)
                from .contracts import archive_drained_pricings, sweep_contract_renewals
                from ..job_dispatch import redeliver_queued_jobs

                redelivered = await redeliver_queued_jobs(session)
                migrated = await sweep_contract_renewals(session)
                archived = await archive_drained_pricings(session, settings) if settings else 0
                await session.commit()
            if settled:
                logger.info("Settled %d abandoned job(s)", settled)
            if migrated:
                logger.info("Migrated %d expired contract(s) to LIVE", migrated)
            if archived:
                logger.info("Archived %d drained pricing release(s)", archived)
            if redelivered:
                logger.info("Redelivered %d queued job(s)", redelivered)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("The job reconciler sweep failed; continuing")

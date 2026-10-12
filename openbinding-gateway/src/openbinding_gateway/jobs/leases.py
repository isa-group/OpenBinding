"""Claiming a queued job and keeping the claim alive while it is solved.

A worker that dies leaves a lease that simply runs out, which is how it is told
from a slow one. The reconciler (``reconciler.py``) acts on lapsed leases; this
module is the worker's side: claim, heartbeat and the check that it still owns
the job before it writes an outcome.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..db import base as db_base
from ..db.models import Job, JobState
from . import clock

logger = logging.getLogger(__name__)

#: How long a claim is good for without being renewed. A worker that dies
#: leaves a lease that simply runs out, which is how it is told from a slow one.
LEASE_S = 60.0

#: How often a live worker renews its lease: three chances per lease.
HEARTBEAT_S = 20.0

#: How many times a job may be claimed. A worker lost mid-solve gets the job
#: put back once; the second loss fails it, so a job that kills its worker
#: cannot circle the queue forever.
MAX_ATTEMPTS = 2


def aware(moment: datetime) -> datetime:
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
    now = clock.now(session)
    claimed = await session.execute(
        update(Job)
        .where(Job.id == job_id, Job.state == JobState.QUEUED)
        .values(
            state=JobState.RUNNING,
            lease_token=token,
            lease_until=clock.after(session, LEASE_S, since=now),
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
    back between this check and the commit that writes the outcome. The token is
    what decides ownership, not the deadline: a lease that lapsed without the
    reconciler having acted is still this worker's, and the same statement that
    takes the row lock pushes the deadline forward (by the database clock) so
    the outcome can be written without racing the sweep. Once the reconciler has
    put the job back the token is gone and the answer is no; that is how the
    result of a superseded holder gets discarded.
    """
    if token is None:
        return False
    held = await session.execute(
        update(Job)
        .where(Job.id == job_id, Job.state == JobState.RUNNING, Job.lease_token == token)
        .values(lease_until=clock.after(session, LEASE_S))
        .returning(Job.id)
        .execution_options(synchronize_session=False)
    )
    return held.first() is not None


async def renew_lease(factory: async_sessionmaker, job_id: uuid.UUID, token: str) -> bool:
    """Push the lease forward, but only for the worker that holds it."""
    async with factory() as session:
        renewed = await session.execute(
            update(Job)
            .where(Job.id == job_id, Job.state == JobState.RUNNING, Job.lease_token == token)
            .values(lease_until=clock.after(session, LEASE_S))
            .returning(Job.id)
            .execution_options(synchronize_session=False)
        )
        held = renewed.first() is not None
        await session.commit()
        return held


async def beat(renew: Callable[[], Awaitable[bool]], interval_s: float, label: str) -> None:
    """Call ``renew`` every ``interval_s`` until it says the lease was lost."""
    while True:
        await asyncio.sleep(interval_s)
        try:
            if not await renew():
                return  # The work was taken back; there is nothing left to keep alive.
        except asyncio.CancelledError:
            raise
        except Exception:
            # One missed beat is survivable, the lease allows for three.
            logger.warning("Could not renew the lease on %s", label, exc_info=True)


def start_beat(
    renew: Callable[[], Awaitable[bool]], interval_s: float | None = None, label: str = "a task"
) -> asyncio.Task:
    """Renew an arbitrary lease in the background; stop it with ``stop_heartbeat``."""
    return asyncio.create_task(beat(renew, HEARTBEAT_S if interval_s is None else interval_s, label))


async def _heartbeat(
    factory: async_sessionmaker, job_id: uuid.UUID, token: str, interval_s: float
) -> None:
    # ``renew_lease`` is looked up on every beat, not captured, so it can be replaced.
    await beat(lambda: renew_lease(factory, job_id, token), interval_s, f"job {job_id}")


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

"""The technical limit on how many jobs one account may have in flight.

It protects the engines and does not depend on SPACE or on the plan: the number
comes from ``MAX_CONCURRENT_JOBS_PER_USER``. Every entry point that creates a job
(``POST /v1/jobs``, retry, study cells) goes through ``enforce_concurrency_limit``
inside the transaction that inserts the job.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import get_settings
from ..db.models import Job, JobState, User
from ..domain.entitlements import Refusal, concurrency_refusal

#: States that hold a slot: the job has not reached a terminal state.
IN_FLIGHT = (JobState.QUEUED, JobState.RUNNING)


async def lock_owner(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Serialise job creation for one account until the transaction ends.

    ``FOR UPDATE`` on the user's row makes a second creation wait here, so it
    counts the first one's job instead of racing it past the limit. SQLite has
    no row locks and ignores the clause; there the count alone is the check.
    """
    await session.execute(select(User.id).where(User.id == user_id).with_for_update())


async def count_in_flight(session: AsyncSession, user_id: uuid.UUID) -> int:
    return int(
        await session.scalar(
            select(func.count()).select_from(Job).where(Job.owner_id == user_id, Job.state.in_(IN_FLIGHT))
        )
        or 0
    )


async def enforce_concurrency_limit(
    session: AsyncSession, user_id: uuid.UUID, *, limit: int | None = None
) -> Refusal | None:
    """The 429 ``concurrency_limit_exceeded`` refusal when the account is at its limit.

    Counts the account's queued and running jobs, those added earlier in the
    caller's own transaction included, so call it in the transaction that will
    insert the new job and after any idempotent replay has been ruled out:
    a replay returns the existing job and does not take a second slot.
    """
    await lock_owner(session, user_id)
    allowed = get_settings().max_concurrent_jobs_per_user if limit is None else limit
    active = await count_in_flight(session, user_id)
    if active >= allowed:
        return concurrency_refusal(allowed, active)
    return None

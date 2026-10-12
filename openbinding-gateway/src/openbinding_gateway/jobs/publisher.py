"""Handing queued jobs to the broker without losing or flooding them.

The job row is the outbox. ``POST /v1/jobs`` commits it as QUEUED and then sends
the message straight away; if that send is lost (the process dies, Redis is
down) the row is still there, and this module is the safety net that sends it
again. A batch of due rows is claimed in one UPDATE that also pushes each row's
``next_publish_at`` forward by an exponential backoff, the claim is committed,
and only then is anything sent to the broker. A crash after the commit loses at
most one backoff interval of republication; it never holds a lock across the
network and never publishes the same row from two replicas at once.

The queue is at-least-once: a row can be published more than once and the claim
in ``leases.claim_job`` makes the extra messages harmless.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy import and_, func, literal_column, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Job, JobState
from . import clock

logger = logging.getLogger(__name__)

#: How long a queued job that was never republished is left to its immediate
#: publication before the sweep takes over.
PUBLISH_AFTER_S = 30.0

#: Rows claimed per batch.
BATCH_SIZE = 100

#: Backoff between publications of one row: 15 s, 30 s, 60 s ... up to 300 s.
BACKOFF_BASE_S = 15.0
BACKOFF_MAX_S = 300.0
#: 15 * 2**10 is already past the cap; bounding the exponent keeps SQL ``power`` finite.
_MAX_EXPONENT = 10


def backoff_s(attempts: int) -> float:
    """Seconds to wait after the publication numbered ``attempts`` (0-based)."""
    return min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** min(max(attempts, 0), _MAX_EXPONENT))


def _is_due(session: AsyncSession, after_s: float):
    return or_(
        and_(Job.next_publish_at.is_(None), Job.created_at < clock.before(session, after_s)),
        Job.next_publish_at <= clock.now(session),
    )


async def claim_due(
    session: AsyncSession, *, limit: int = BATCH_SIZE, after_s: float = PUBLISH_AFTER_S
) -> list[uuid.UUID]:
    """Claim up to ``limit`` queued jobs that are due for publication.

    Counts the publication, schedules the next one and returns the ids; the
    caller commits and then sends. Rows with fewer publications come first, so a
    large backlog cannot starve the rows behind it. On PostgreSQL the batch is
    chosen with ``FOR UPDATE SKIP LOCKED``: two replicas claiming at once get
    disjoint batches. SQLite has no row locks (and one process), so each row is
    claimed by an UPDATE that only matches while it is as it was read.
    """
    if clock.uses_db_clock(session):
        batch = (
            select(Job.id)
            .where(Job.state == JobState.QUEUED, _is_due(session, after_s))
            .order_by(Job.publish_attempts, Job.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        exponent = func.least(Job.publish_attempts, literal_column(str(_MAX_EXPONENT)))
        delay = func.least(
            literal_column(repr(BACKOFF_MAX_S)),
            literal_column(repr(BACKOFF_BASE_S)) * func.power(literal_column("2"), exponent),
        )
        claimed = await session.execute(
            update(Job)
            .where(Job.id.in_(batch))
            .values(
                publish_attempts=Job.publish_attempts + 1,
                next_publish_at=clock.after(session, delay),
            )
            .returning(Job.id)
            .execution_options(synchronize_session=False)
        )
        return list(claimed.scalars().all())

    rows = (
        await session.execute(
            select(Job.id, Job.publish_attempts)
            .where(Job.state == JobState.QUEUED, _is_due(session, after_s))
            .order_by(Job.publish_attempts, Job.id)
            .limit(limit)
        )
    ).all()
    ids: list[uuid.UUID] = []
    for job_id, attempts in rows:
        won = await session.execute(
            update(Job)
            .where(Job.id == job_id, Job.state == JobState.QUEUED, Job.publish_attempts == attempts)
            .values(
                publish_attempts=attempts + 1,
                next_publish_at=clock.after(session, backoff_s(attempts)),
            )
            .returning(Job.id)
            .execution_options(synchronize_session=False)
        )
        if won.first() is not None:
            ids.append(job_id)
    return ids


async def publish_due(
    session: AsyncSession,
    send: Callable[[str], Awaitable[bool]],
    *,
    limit: int = BATCH_SIZE,
    after_s: float = PUBLISH_AFTER_S,
) -> int:
    """Claim a batch, commit the claim, and only then send it. Returns how many were sent.

    ``send`` returns False when the broker did not take the message; the rest of
    the batch is then left to its backoff instead of hammering a broker that is down.
    """
    ids = await claim_due(session, limit=limit, after_s=after_s)
    await session.commit()
    sent = 0
    for job_id in ids:
        if not await send(str(job_id)):
            logger.warning("The broker refused job %s; %d of %d claimed jobs left to backoff",
                           job_id, len(ids) - sent, len(ids))
            break
        sent += 1
    return sent

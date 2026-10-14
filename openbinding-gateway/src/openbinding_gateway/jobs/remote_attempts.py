"""The engine's id of every attempt of a job, and the fencing of their best-effort cancellation.

An attempt that loses its lease may leave a job running in the engine. This
module keeps what is needed to ask the engine to stop it (the id and the endpoint
of each attempt, ``job_engine_attempts``) and decides, from rows alone, whether
a ``DELETE`` may be sent. It never touches the network: ``services.execution``
sends, after the claim here has been committed.

The one thing a cancellation must never do is stop the execution that is meant to
produce the job's result. ``decide`` is the whole of that rule and is a pure
function of the rows, so it can be tested exhaustively:

* nothing is sent unless the registration declares the capability (D1/D2);
* nothing is sent to an endpoint other than the one the attempt used (R3), because
  the request carries the credential;
* an id that a newer attempt also holds is never cancelled (an engine that
  deduplicates by ``X-Openbinding-Job-Id`` would hand the same id out again);
* attempt ``k`` is cancelled only when the job is terminal, or when the job is
  not running (``k`` is the last claim and it was lost: nothing else can hold the
  id), or when the attempt that is running now has already registered a different
  id (R1). If the running attempt has not registered an id yet the cancellation is
  deferred, with backoff, and after ``remote_cancel_defer_limit`` deferrals it is
  skipped: it is never sent blind;
* without ``idScope: attempt`` only a terminal job allows it (R2);
* one exception to the running attempt being untouchable: when the job's ``cancellation_requested`` is set, the
  attempt that runs it is the one to stop (``services.execution.CancelWatch``, and the sweep retrying that claim).

What ``sent`` promises is the engine's confirmation (200/204), not that a request left: a ``202`` (accepted,
still stopping) settles as ``failed`` and is retried with backoff within the same bounded number of claims,
and 404/405/501 end as ``skipped`` without a retry. The cancellation is best effort in the end: when the
claims run out the row stays ``failed`` and the gateway has not got the engine's confirmation.

Claims are compare-and-swap UPDATEs on ``cancel_state`` and ``cancel_attempts``
(and, on PostgreSQL, ``FOR UPDATE SKIP LOCKED``), so two replicas never send the
same cancellation at once. A replica that dies after claiming leaves the row due
again after its backoff; the number of claims is bounded.
"""

from __future__ import annotations

import enum
import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import and_, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Job, JobEngineAttempt, JobState
from . import clock
from .publisher import backoff_s

logger = logging.getLogger(__name__)

NONE = "none"
PENDING = "pending"
SENT = "sent"
SKIPPED = "skipped"
FAILED = "failed"

#: States in which a cancellation may still be claimed.
OPEN_STATES = (PENDING, FAILED)

TERMINAL_STATES = frozenset({JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED})


class Action(str, enum.Enum):
    CANCEL = "cancel"
    DEFER = "defer"
    SKIP = "skip"


@dataclass(frozen=True)
class Decision:
    action: Action
    reason: str


@dataclass(frozen=True)
class AttemptView:
    attempt: int
    engine_job_id: str
    endpoint: str


@dataclass(frozen=True)
class JobView:
    """The rows a decision is taken from: the job's state and claim counter, and an id per attempt."""

    state: JobState
    attempt: int
    attempts: tuple[AttemptView, ...]
    #: Somebody asked for the job to stop (the flag a running job's worker watches).
    cancellation_requested: bool = False


@dataclass(frozen=True)
class ClaimedAttempt:
    """An attempt whose cancellation this replica has claimed (and committed) and may now carry out."""

    id: uuid.UUID
    job_id: uuid.UUID
    attempt: int
    engine_job_id: str
    endpoint: str
    #: Claims including this one.
    cancel_attempts: int


def decide(
    job: JobView,
    target: AttemptView,
    *,
    supported: bool,
    per_attempt: bool,
    current_endpoint: str | None,
) -> Decision:
    """Whether the remote job of ``target`` (a lost attempt) may be sent a ``DELETE`` now."""
    if not supported:
        return Decision(Action.SKIP, "the registration does not declare cancellation")
    if current_endpoint != target.endpoint:
        return Decision(Action.SKIP, "the registration no longer points at the endpoint the attempt used")
    if job.attempt < target.attempt:
        return Decision(Action.SKIP, "the attempt is newer than the job's claims")
    newer = [other for other in job.attempts if other.attempt > target.attempt]
    if any(other.engine_job_id == target.engine_job_id for other in newer):
        return Decision(Action.SKIP, "a newer attempt holds the same engine id")
    if job.state in TERMINAL_STATES:
        return Decision(Action.CANCEL, "the job is terminal")
    if job.cancellation_requested and job.state is JobState.RUNNING and job.attempt == target.attempt:
        # The one case in which the attempt that runs the job is stopped: the job itself is not wanted any
        # more, whoever claims this asks on behalf of the worker that holds the lease (the worker, when it
        # sees the flag while it waits for the engine; the sweep, to retry that same claim). No newer attempt
        # exists (job.attempt == target.attempt) and the check above on shared ids has passed, so nothing
        # that is still wanted can hold this id, whatever the scope of the engine's ids.
        return Decision(Action.CANCEL, "the job was cancelled and this is the attempt that runs it")
    if not per_attempt:
        return Decision(Action.DEFER, "the engine does not scope its ids per attempt: waiting for the job to end")
    if job.state is not JobState.RUNNING:
        # Queued again: the last claim is the lost one and no attempt is running.
        return Decision(Action.CANCEL, "the job is not running and the attempt was lost")
    if job.attempt == target.attempt:
        return Decision(Action.DEFER, "the attempt is the one running now")
    if any(other.attempt == job.attempt for other in newer):
        return Decision(Action.CANCEL, "the running attempt registered a different engine id")
    return Decision(Action.DEFER, "the running attempt has not registered an engine id yet")


async def record(
    session: AsyncSession,
    job_id: uuid.UUID,
    attempt: int,
    engine_job_id: str,
    endpoint: str,
    *,
    lost: bool = False,
) -> None:
    """Stage the engine's id for ``attempt`` in the caller's transaction (the caller commits).

    ``lost`` says the worker already knows it no longer holds the lease (the id arrived after the sweep
    took the job back, which is when the sweep marked the attempts it knew of): the row is then born
    pending so that it is cancelled too. Nothing of the job itself is written.
    """
    state = PENDING if lost else NONE
    existing = (
        await session.execute(
            select(JobEngineAttempt.id).where(JobEngineAttempt.job_id == job_id, JobEngineAttempt.attempt == attempt)
        )
    ).scalar_one_or_none()
    if existing is None:
        await session.execute(
            insert(JobEngineAttempt).values(
                id=uuid.uuid4(),
                job_id=job_id,
                attempt=attempt,
                engine_job_id=engine_job_id,
                endpoint=endpoint,
                registered_at=clock.now(session),
                cancel_state=state,
            )
        )
        return
    values: dict = {"engine_job_id": engine_job_id, "endpoint": endpoint, "registered_at": clock.now(session)}
    await session.execute(
        update(JobEngineAttempt)
        .where(JobEngineAttempt.id == existing)
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if lost:
        await session.execute(
            update(JobEngineAttempt)
            .where(JobEngineAttempt.id == existing, JobEngineAttempt.cancel_state == NONE)
            .values(cancel_state=PENDING)
            .execution_options(synchronize_session=False)
        )


async def mark_lost(session: AsyncSession, job_id: uuid.UUID, up_to_attempt: int) -> int:
    """Mark the attempts up to ``up_to_attempt`` of a job whose worker was lost as due for cancellation.

    Only a row update, in the caller's transaction: the sweep that calls this holds locks and must not
    wait for a network. Returns how many rows changed.
    """
    marked = await session.execute(
        update(JobEngineAttempt)
        .where(
            JobEngineAttempt.job_id == job_id,
            JobEngineAttempt.attempt <= up_to_attempt,
            JobEngineAttempt.cancel_state == NONE,
        )
        .values(cancel_state=PENDING)
        .execution_options(synchronize_session=False)
    )
    return marked.rowcount or 0


def _due(session: AsyncSession, max_attempts: int):
    return and_(
        JobEngineAttempt.cancel_state.in_(OPEN_STATES),
        JobEngineAttempt.cancel_attempts < max_attempts,
        or_(JobEngineAttempt.next_cancel_at.is_(None), JobEngineAttempt.next_cancel_at <= clock.now(session)),
    )


async def _claim_row(
    session: AsyncSession, row, max_attempts: int
) -> ClaimedAttempt | None:
    """One compare-and-swap: wins only while the row is still as it was read and due."""
    won = await session.execute(
        update(JobEngineAttempt)
        .where(
            JobEngineAttempt.id == row.id,
            JobEngineAttempt.cancel_attempts == row.cancel_attempts,
            _due(session, max_attempts),
        )
        .values(
            cancel_attempts=row.cancel_attempts + 1,
            next_cancel_at=clock.after(session, backoff_s(row.cancel_attempts)),
        )
        .returning(JobEngineAttempt.id)
        .execution_options(synchronize_session=False)
    )
    if won.first() is None:
        return None
    return ClaimedAttempt(
        id=row.id,
        job_id=row.job_id,
        attempt=row.attempt,
        engine_job_id=row.engine_job_id,
        endpoint=row.endpoint,
        cancel_attempts=row.cancel_attempts + 1,
    )


_COLUMNS = (
    JobEngineAttempt.id,
    JobEngineAttempt.job_id,
    JobEngineAttempt.attempt,
    JobEngineAttempt.engine_job_id,
    JobEngineAttempt.endpoint,
    JobEngineAttempt.cancel_attempts,
)


async def claim_due(session: AsyncSession, *, limit: int, max_attempts: int) -> list[ClaimedAttempt]:
    """Claim up to ``limit`` due cancellations. Counts the claim and schedules the next one; the caller commits.

    Rows with fewer claims come first, so a few failing engines cannot starve the rest. A row another
    replica holds (``SKIP LOCKED``) or claimed first (the compare-and-swap) is left to it.
    """
    rows = (
        await session.execute(
            select(*_COLUMNS)
            .where(_due(session, max_attempts))
            .order_by(JobEngineAttempt.cancel_attempts, JobEngineAttempt.registered_at, JobEngineAttempt.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
    ).all()
    claimed: list[ClaimedAttempt] = []
    for row in rows:
        won = await _claim_row(session, row, max_attempts)
        if won is not None:
            claimed.append(won)
    return claimed


async def claim_one(
    session: AsyncSession, job_id: uuid.UUID, attempt: int, *, max_attempts: int
) -> ClaimedAttempt | None:
    """Mark one attempt as lost (if it was not yet) and claim its cancellation; the caller commits.

    ``None`` when there is no id recorded for the attempt, when it is already settled, when another
    replica holds the claim, or when its backoff has not elapsed.
    """
    await session.execute(
        update(JobEngineAttempt)
        .where(
            JobEngineAttempt.job_id == job_id,
            JobEngineAttempt.attempt == attempt,
            JobEngineAttempt.cancel_state == NONE,
        )
        .values(cancel_state=PENDING)
        .execution_options(synchronize_session=False)
    )
    row = (
        await session.execute(
            select(*_COLUMNS)
            .where(JobEngineAttempt.job_id == job_id, JobEngineAttempt.attempt == attempt, _due(session, max_attempts))
            .with_for_update(skip_locked=True)
        )
    ).first()
    if row is None:
        return None
    return await _claim_row(session, row, max_attempts)


async def view(session: AsyncSession, job_id: uuid.UUID) -> JobView | None:
    """The job's state and the id of each attempt, read fresh from the rows."""
    job = (
        await session.execute(select(Job.state, Job.attempt, Job.cancellation_requested).where(Job.id == job_id))
    ).first()
    if job is None:
        return None
    rows = (
        await session.execute(
            select(JobEngineAttempt.attempt, JobEngineAttempt.engine_job_id, JobEngineAttempt.endpoint)
            .where(JobEngineAttempt.job_id == job_id)
            .order_by(JobEngineAttempt.attempt)
        )
    ).all()
    return JobView(
        state=job.state,
        attempt=job.attempt,
        attempts=tuple(AttemptView(row.attempt, row.engine_job_id, row.endpoint) for row in rows),
        cancellation_requested=bool(job.cancellation_requested),
    )


async def confirm_stopped(session: AsyncSession, job_id: uuid.UUID, attempt: int) -> None:
    """Record that the engine itself reported the attempt's job stopped (the caller commits).

    For a worker that read the confirmation off its own poll (``failed``, ``cancelled: ...``) instead of
    from the answer to a ``DELETE``: nothing is left to send. A row that is already final is not touched.
    """
    await session.execute(
        update(JobEngineAttempt)
        .where(
            JobEngineAttempt.job_id == job_id,
            JobEngineAttempt.attempt == attempt,
            JobEngineAttempt.cancel_state.in_((NONE, *OPEN_STATES)),
        )
        .values(cancel_state=SENT, next_cancel_at=None)
        .execution_options(synchronize_session=False)
    )


async def settle(session: AsyncSession, claimed: ClaimedAttempt, state: str) -> None:
    """Record how a claimed cancellation ended (the caller commits).

    ``sent`` and ``skipped`` are final. ``failed`` keeps the backoff the claim scheduled: the row is due
    again then, until the claims run out.
    """
    values: dict = {"cancel_state": state}
    if state in (SENT, SKIPPED):
        values["next_cancel_at"] = None
    await session.execute(
        update(JobEngineAttempt)
        .where(JobEngineAttempt.id == claimed.id, JobEngineAttempt.cancel_state.in_(OPEN_STATES))
        .values(**values)
        .execution_options(synchronize_session=False)
    )

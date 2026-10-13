"""Two replicas running the cancellation step of the reconciler at once, on PostgreSQL.

Needs ``TEST_DATABASE_URL`` (the ``two_sessions`` fixture skips anywhere else): row locks and ``SKIP LOCKED``
mean nothing on SQLite. The claim of a cancellation is a ``SELECT ... FOR UPDATE SKIP LOCKED`` followed by a
compare-and-swap on ``cancel_attempts`` (committed before any request), so an attempt is sent a ``DELETE`` by
one replica only, and whatever the interleaving the id of the attempt that runs the job is never sent one.
The step of each replica is the real ``reconciler.cancel_lost_attempts``; only the engines' HTTP side is a double.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select

from _pricing import pricing_catalog
from analysis_b3_b4_b6._helpers import PER_ATTEMPT_CANCELLATION, a_job, a_registration
from openbinding_gateway.db.models import Job, JobEngineAttempt, JobState, User, UserRole
from openbinding_gateway.jobs import reconciler
from openbinding_gateway.services import execution
from openbinding_gateway.v1 import remote

TIMEOUT_S = 30


async def _owner(session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    session.add(user)
    await session.commit()
    return user


async def _attempt(session, job: Job, attempt: int, engine_job_id: str, endpoint: str, state: str) -> None:
    session.add(
        JobEngineAttempt(
            job_id=job.id, attempt=attempt, engine_job_id=engine_job_id, endpoint=endpoint, cancel_state=state
        )
    )
    await session.commit()


class Engines:
    """Records the DELETEs of both replicas; each one takes a moment so that the replicas overlap."""

    def __init__(self) -> None:
        self.deleted: list[str] = []

    async def cancel(self, _registration, engine_job_id, **_kwargs) -> bool:
        self.deleted.append(engine_job_id)
        await asyncio.sleep(0.2)
        return True


@pytest.fixture
def engines(monkeypatch) -> Engines:
    double = Engines()

    async def transport(_session, revision):
        return remote.RemoteRegistration(endpoint=revision.endpoint, mappings=revision.mappings, allow_internal_http=True)

    monkeypatch.setattr(execution, "cancel_remote", double.cancel)
    monkeypatch.setattr(execution, "revision_transport", transport)
    return double


async def _both_replicas(first, second) -> list:
    return await asyncio.wait_for(
        asyncio.gather(
            reconciler.cancel_lost_attempts(first),
            reconciler.cancel_lost_attempts(second),
            return_exceptions=True,
        ),
        TIMEOUT_S,
    )


@pytest.mark.asyncio
async def test_two_replicas_never_send_two_deletes_for_one_attempt(two_sessions, engines):
    first, second = two_sessions
    owner = await _owner(first)
    deployment = await a_registration(first, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(first, owner, registration=deployment, state=JobState.FAILED, attempt=1)
    await _attempt(first, job, 1, "engine-job-A", deployment.endpoint, "pending")

    outcome = await _both_replicas(first, second)

    assert sorted(outcome) == [0, 1], outcome  # one replica sent it, the other found nothing to claim
    assert engines.deleted == ["engine-job-A"]
    states = (await second.execute(select(JobEngineAttempt.cancel_state, JobEngineAttempt.cancel_attempts))).all()
    assert [tuple(row) for row in states] == [("sent", 1)]


@pytest.mark.asyncio
async def test_many_attempts_are_shared_between_replicas_and_each_is_sent_once(two_sessions, engines):
    first, second = two_sessions
    owner = await _owner(first)
    deployment = await a_registration(first, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    expected = []
    for number in range(6):
        job = await a_job(first, owner, registration=deployment, state=JobState.FAILED, attempt=1)
        await _attempt(first, job, 1, f"engine-job-{number}", deployment.endpoint, "pending")
        expected.append(f"engine-job-{number}")

    outcome = await _both_replicas(first, second)

    assert not [item for item in outcome if isinstance(item, BaseException)], outcome
    assert sum(outcome) == len(expected)
    assert sorted(engines.deleted) == expected  # no id twice, none left out


@pytest.mark.asyncio
async def test_the_running_attempt_is_not_cancelled_by_either_replica(two_sessions, engines):
    first, second = two_sessions
    owner = await _owner(first)
    deployment = await a_registration(first, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(first, owner, registration=deployment, state=JobState.RUNNING, attempt=2)
    await _attempt(first, job, 1, "engine-job-A", deployment.endpoint, "pending")
    await _attempt(first, job, 2, "engine-job-B", deployment.endpoint, "none")

    outcome = await _both_replicas(first, second)

    assert not [item for item in outcome if isinstance(item, BaseException)], outcome
    assert engines.deleted == ["engine-job-A"]  # the lost attempt, once; the running one never
    rows = (
        await second.execute(
            select(JobEngineAttempt.attempt, JobEngineAttempt.cancel_state).order_by(JobEngineAttempt.attempt)
        )
    ).all()
    assert [tuple(row) for row in rows] == [(1, "sent"), (2, "none")]

"""A job's outcome is only real once it is committed, and a lost commit never strands the job.

(The file keeps the name it had when it guarded a charge SPACE had accepted;
nothing is charged any more and what is left is the durability of the outcome.
The reconciler's own tests are in ``test_job_reconciler.py``.)

A worker writes the outcome and commits; if that commit fails the fallback in
``run_persisted_job`` fails the job from a fresh session. A sweep commits the
jobs it ended before it syncs their study cells, so a rollback afterwards undoes
nothing of them; a requeue it leaves to the caller's commit, and if that
transaction is lost the next sweep does the work. That two
sweeps in two transactions skip each other's rows needs PostgreSQL and lives in
``tests/concurrency/test_job_leases_pg.py``.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker

from _pricing import pricing_catalog
from openbinding_gateway.db import base as db_base
from openbinding_gateway.db.models import Job, JobState, User, UserRole, utcnow
from openbinding_gateway.jobs import leases, reconciler
from openbinding_gateway.services import execution

OVERDUE_S = 60.0 + reconciler.ABANDONED_GRACE_S + 1


@pytest_asyncio.fixture
async def owner(db_session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    db_session.add(user)
    await db_session.commit()
    return user


async def a_job(session, owner, *, state=JobState.RUNNING, age_s=OVERDUE_S, **extra) -> Job:
    job = Job(
        owner_id=owner.id,
        engine_id="random-search",
        engine_job_id="engine-1",
        service_url="http://engine",
        state=state,
        requested_budget_s=60.0,
        created_at=utcnow() - timedelta(seconds=age_s),
        **extra,
    )
    session.add(job)
    await session.commit()
    return job


async def test_a_sweep_whose_requeue_is_lost_changes_nothing_and_the_next_one_does_the_work(
    db_session, owner
):
    job = await a_job(
        db_session, owner, lease_token="lost", lease_until=utcnow() - timedelta(seconds=5)
    )
    job_id = job.id

    # A requeue ends no job, so the sweep leaves it to the caller's commit.
    assert await reconciler.sweep_abandoned(db_session) == 0
    await db_session.rollback()  # the commit that was to make it durable never happened

    db_session.expire_all()
    lost = await db_session.get(Job, job_id)
    assert lost.state is JobState.RUNNING and lost.lease_token == "lost"

    assert await reconciler.sweep_abandoned(db_session) == 0
    await db_session.commit()
    db_session.expire_all()
    requeued = await db_session.get(Job, job_id)
    assert requeued.state is JobState.QUEUED and requeued.lease_token is None


async def test_a_sweep_commits_the_jobs_it_ended_before_it_syncs_their_cells(db_session, owner):
    job = await a_job(db_session, owner)
    job_id = job.id

    assert await reconciler.sweep_abandoned(db_session) == 1
    # Rolling back now undoes only what the sweep did not commit, which is nothing.
    await db_session.rollback()

    db_session.expire_all()
    failed = await db_session.get(Job, job_id)
    assert failed.state is JobState.FAILED and failed.finished_at is not None
    assert await reconciler.sweep_abandoned(db_session) == 0


async def test_a_worker_whose_commit_fails_has_its_job_failed_by_the_fallback(
    db_session, owner, monkeypatch
):
    job = await a_job(db_session, owner, state=JobState.QUEUED)
    job_id = job.id
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    monkeypatch.setattr(db_base, "is_configured", lambda: True)
    monkeypatch.setattr(db_base, "session_factory", lambda: factory)

    async def worker(job_id_text, session):
        parsed = uuid.UUID(job_id_text)
        assert await leases.claim_job(session, parsed) is not None
        await session.commit()  # the claim is durable; the outcome is not

        async def broken():
            raise RuntimeError("commit failed")

        session.commit = broken
        await session.commit()

    monkeypatch.setattr(execution, "finish_persisted_job", worker)

    with pytest.raises(RuntimeError, match="commit failed"):
        await execution.run_persisted_job(str(job_id))

    await db_session.refresh(job)
    assert job.state is JobState.FAILED
    assert job.result["error"].startswith("Internal execution error")
    assert job.lease_token is None and job.lease_until is None

    # Nothing left for the reconciler to do with it.
    assert await reconciler.sweep_abandoned(db_session) == 0


async def test_a_worker_that_never_claimed_the_job_leaves_it_to_the_queue(db_session, owner, monkeypatch):
    job = await a_job(db_session, owner, state=JobState.QUEUED)
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    monkeypatch.setattr(db_base, "is_configured", lambda: True)
    monkeypatch.setattr(db_base, "session_factory", lambda: factory)

    async def worker(job_id_text, session):
        raise RuntimeError("died before claiming")

    monkeypatch.setattr(execution, "finish_persisted_job", worker)

    with pytest.raises(RuntimeError, match="died before claiming"):
        await execution.run_persisted_job(str(job.id))

    await db_session.refresh(job)
    assert job.state is JobState.QUEUED  # only the lease holder may fail a job

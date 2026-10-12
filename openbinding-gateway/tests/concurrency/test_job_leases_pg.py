"""Two workers racing for one queued job, and two sweeps racing for one abandoned one.

Both need row locks, which SQLite ignores, so the ``two_sessions`` fixture skips
them unless ``TEST_DATABASE_URL`` names a PostgreSQL test database.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from _pricing import pricing_catalog
from openbinding_gateway.db.models import Job, JobState, User, UserRole, utcnow
from openbinding_gateway.jobs import leases, limits, reconciler


async def an_abandoned_job(session) -> Job:
    owner = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    session.add(owner)
    await session.flush()
    job = Job(
        owner_id=owner.id,
        engine_id="random-search",
        engine_job_id="engine-1",
        service_url="http://engine",
        state=JobState.RUNNING,
        requested_budget_s=60.0,
        created_at=utcnow() - timedelta(seconds=60 + reconciler.ABANDONED_GRACE_S + 1),
    )
    session.add(job)
    await session.commit()
    return job


@pytest.mark.asyncio
async def test_two_concurrent_claims_of_one_job_have_one_winner(two_sessions):
    first, second = two_sessions
    job = Job(
        engine_id="random-search",
        engine_job_id="engine-1",
        service_url="http://engine",
        state=JobState.QUEUED,
    )
    first.add(job)
    await first.commit()

    async def claim(session):
        token = await leases.claim_job(session, job.id)
        await session.commit()
        return token

    tokens = await asyncio.gather(claim(first), claim(second))

    winners = [token for token in tokens if token is not None]
    assert len(winners) == 1
    await first.refresh(job)
    assert job.state is JobState.RUNNING
    assert job.lease_token == winners[0]
    assert job.attempt == 1


@pytest.mark.asyncio
async def test_two_concurrent_sweeps_fail_an_abandoned_job_once(two_sessions):
    first, second = two_sessions
    job = await an_abandoned_job(first)

    async def sweep(session):
        failed = await reconciler.sweep_abandoned(session)
        await session.commit()
        return failed

    failed = await asyncio.gather(sweep(first), sweep(second))

    assert sum(failed) == 1
    await first.refresh(job)
    assert job.state is JobState.FAILED and job.finished_at is not None


@pytest.mark.asyncio
async def test_a_sweep_skips_a_job_another_transaction_holds_and_gets_it_later(two_sessions):
    first, second = two_sessions
    job = await an_abandoned_job(first)

    # A worker (or another sweep) is in the middle of something with the row.
    await first.execute(select(Job.id).where(Job.id == job.id).with_for_update())
    # The sweep must not queue up behind the lock: the guard is only a timeout.
    assert await asyncio.wait_for(reconciler.sweep_abandoned(second), timeout=10) == 0

    await first.rollback()
    assert await asyncio.wait_for(reconciler.sweep_abandoned(second), timeout=10) == 1
    await second.commit()
    await first.refresh(job)
    assert job.state is JobState.FAILED


@pytest.mark.asyncio
async def test_two_concurrent_creations_cannot_pass_the_last_slot(two_sessions):
    first, second = two_sessions
    owner = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    first.add(owner)
    await first.commit()

    async def create(session):
        # The limit is checked, and the job inserted, in one transaction.
        refusal = await limits.enforce_concurrency_limit(session, owner.id, limit=1)
        if refusal is None:
            session.add(Job(
                owner_id=owner.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()),
                service_url="http://engine", state=JobState.QUEUED,
            ))
        await session.commit()
        return refusal

    refusals = await asyncio.gather(create(first), create(second))

    assert sorted(refusal is None for refusal in refusals) == [False, True]
    assert await limits.count_in_flight(first, owner.id) == 1

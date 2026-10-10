"""Two workers racing for one queued job, and two sweeps racing for one abandoned one.

Both need row locks, which SQLite ignores, so the ``two_sessions`` fixture skips
them anywhere but PostgreSQL.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from _pricing import pricing_catalog
from openbinding_gateway.access import metering
from openbinding_gateway.db.models import Job, JobState, User, UserRole, utcnow
from openbinding_gateway.space_client import FakePricingGate


class CountingGate(FakePricingGate):
    def __init__(self) -> None:
        super().__init__(pricing_catalog())
        self.adjustments: list[dict] = []

    async def adjust_usage(self, user_id, increments) -> None:
        await super().adjust_usage(user_id, increments)
        self.adjustments.append(dict(increments))


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
        created_at=utcnow() - timedelta(seconds=60 + metering.SETTLEMENT_GRACE_S + 1),
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
        token = await metering.claim_job(session, job.id)
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
async def test_two_concurrent_sweeps_settle_an_abandoned_job_once(two_sessions):
    first, second = two_sessions
    job = await an_abandoned_job(first)
    gate = CountingGate()

    settled = await asyncio.gather(
        metering.sweep_abandoned(gate, first), metering.sweep_abandoned(gate, second)
    )

    assert sum(settled) == 1
    assert [entry for entry in gate.adjustments if entry.get("concurrentJobs") == -1] == [
        {"solverSeconds": 60.0, "concurrentJobs": -1}
    ]
    await first.refresh(job)
    assert job.state is JobState.FAILED and job.metered is True


@pytest.mark.asyncio
async def test_a_sweep_skips_a_job_another_transaction_holds_and_gets_it_later(two_sessions):
    first, second = two_sessions
    job = await an_abandoned_job(first)
    gate = CountingGate()

    # A worker (or another sweep) is in the middle of something with the row.
    await first.execute(select(Job.id).where(Job.id == job.id).with_for_update())
    # The sweep must not queue up behind the lock: the guard is only a timeout.
    assert await asyncio.wait_for(metering.sweep_abandoned(gate, second), timeout=10) == 0
    assert gate.adjustments == []

    await first.rollback()
    assert await asyncio.wait_for(metering.sweep_abandoned(gate, second), timeout=10) == 1
    assert len(gate.adjustments) == 1

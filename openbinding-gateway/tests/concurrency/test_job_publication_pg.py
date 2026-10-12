"""Publishing queued jobs from several replicas: disjoint batches, backoff, queue limit, one reconciler.

These need row locks, ``now()`` and advisory locks, which SQLite does not have,
so the ``two_sessions`` fixture skips them unless ``TEST_DATABASE_URL`` names a
PostgreSQL test database. They were written together with the code they test and
have NOT been run against PostgreSQL yet; see docs/IDEMPOTENCY.md.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from openbinding_gateway.db import base as db_base
from openbinding_gateway.db.models import Job, JobState, utcnow
from openbinding_gateway.jobs import clock, publisher, reconciler


async def queued_jobs(session, count: int, *, age_s: float = 120.0) -> list[Job]:
    jobs = [
        Job(
            engine_id="random-search",
            engine_job_id=f"engine-{index}",
            service_url="http://engine",
            state=JobState.QUEUED,
            requested_budget_s=60.0,
            created_at=utcnow() - timedelta(seconds=age_s),
        )
        for index in range(count)
    ]
    session.add_all(jobs)
    await session.commit()
    return jobs


async def seconds_until_next_publication(session, job: Job) -> float:
    delay = await session.scalar(
        select(func.extract("epoch", Job.next_publish_at - func.now())).where(Job.id == job.id)
    )
    return float(delay)


@pytest.mark.asyncio
async def test_two_replicas_claim_disjoint_batches(two_sessions):
    first, second = two_sessions
    jobs = await queued_jobs(first, 6)

    # The first batch is claimed and not yet committed: its rows are locked.
    mine = await publisher.claim_due(first, limit=3)
    # The second replica must neither wait for those locks nor take those rows.
    theirs = await asyncio.wait_for(publisher.claim_due(second, limit=3), timeout=10)

    assert len(mine) == len(theirs) == 3
    assert not set(mine) & set(theirs)
    assert set(mine) | set(theirs) == {job.id for job in jobs}
    await first.commit()
    await second.commit()
    assert await publisher.claim_due(first) == []  # all six are backing off now


@pytest.mark.asyncio
async def test_a_batch_that_overlaps_a_locked_row_skips_it_and_gets_the_rest(two_sessions):
    first, second = two_sessions
    jobs = await queued_jobs(first, 3)
    # Plain ids: a rollback expires the ORM objects and reading them would need I/O.
    locked_id, *other_ids = (job.id for job in jobs)
    await first.execute(select(Job.id).where(Job.id == locked_id).with_for_update())

    claimed = await asyncio.wait_for(publisher.claim_due(second, limit=10), timeout=10)
    await second.commit()

    assert set(claimed) == set(other_ids)
    await first.rollback()
    assert await publisher.claim_due(second) == [locked_id]


@pytest.mark.asyncio
async def test_the_database_applies_the_backoff_and_its_cap(two_sessions):
    first, second = two_sessions
    (job,) = await queued_jobs(first, 1)

    assert await publisher.claim_due(first) == [job.id]
    await first.commit()
    assert 10 < await seconds_until_next_publication(first, job) <= 15
    assert await publisher.claim_due(second) == []  # still backing off
    await second.rollback()

    await first.execute(text("UPDATE jobs SET next_publish_at = now() - interval '1 second'"))
    await first.commit()
    assert await publisher.claim_due(second) == [job.id]
    await second.commit()
    assert 25 < await seconds_until_next_publication(first, job) <= 30
    attempts = await first.scalar(select(Job.publish_attempts).where(Job.id == job.id))
    assert attempts == 2

    # A job published a thousand times must neither overflow power() nor wait past the cap.
    await first.execute(text("UPDATE jobs SET publish_attempts = 1000, next_publish_at = now() - interval '1 second'"))
    await first.commit()
    assert await publisher.claim_due(second) == [job.id]
    await second.commit()
    assert 290 < await seconds_until_next_publication(first, job) <= 300


@pytest.mark.asyncio
async def test_a_fresh_job_is_not_due_until_it_is_scheduled_for_publication(two_sessions):
    first, _second = two_sessions
    (fresh,) = await queued_jobs(first, 1, age_s=2.0)

    assert await publisher.claim_due(first) == []

    await first.execute(text("UPDATE jobs SET next_publish_at = now()"))
    await first.commit()
    assert await publisher.claim_due(first) == [fresh.id]


@pytest.mark.asyncio
async def test_a_process_clock_far_ahead_publishes_nothing_early(two_sessions, monkeypatch):
    first, second = two_sessions
    await queued_jobs(first, 2, age_s=2.0)
    real = clock.utcnow
    monkeypatch.setattr(clock, "utcnow", lambda: real() + timedelta(hours=2))

    assert await publisher.claim_due(second) == []


@pytest.mark.asyncio
async def test_a_queued_job_past_the_limit_fails_with_queue_timeout(two_sessions):
    first, second = two_sessions
    waiting = (await queued_jobs(first, 1, age_s=600.0))[0]
    expired = (await queued_jobs(first, 1, age_s=1800.0 + 60.0))[0]

    assert await reconciler.sweep_abandoned(second) == 1
    await second.commit()

    await first.refresh(waiting)
    await first.refresh(expired)
    assert waiting.state is JobState.QUEUED
    assert expired.state is JobState.FAILED
    assert expired.result["code"] == "queue_timeout" and expired.finished_at is not None


@pytest.mark.asyncio
async def test_a_process_clock_far_ahead_fails_no_queued_job(two_sessions, monkeypatch):
    first, second = two_sessions
    (job,) = await queued_jobs(first, 1, age_s=5.0)
    real = clock.utcnow
    monkeypatch.setattr(clock, "utcnow", lambda: real() + timedelta(hours=5))

    assert await reconciler.sweep_abandoned(second) == 0
    await second.commit()

    await first.refresh(job)
    assert job.state is JobState.QUEUED


@pytest.mark.asyncio
async def test_the_second_reconciler_skips_the_cycle_while_the_first_holds_it(two_sessions):
    first, second = two_sessions

    assert await reconciler.acquire_cycle_lock(first) is True
    assert await reconciler.acquire_cycle_lock(second) is False

    await first.commit()  # the lock lives and dies with the transaction
    assert await reconciler.acquire_cycle_lock(second) is True


@pytest.mark.asyncio
async def test_run_reconciler_does_not_run_a_cycle_without_the_lock(two_sessions, monkeypatch):
    first, second = two_sessions
    factory = async_sessionmaker(first.bind, expire_on_commit=False)
    cycles: list[int] = []
    sleeps = 0

    async def cycle(_factory) -> None:
        cycles.append(1)

    async def sleep(_interval) -> None:
        nonlocal sleeps
        sleeps += 1
        if sleeps > 1:
            raise asyncio.CancelledError

    monkeypatch.setattr(db_base, "is_configured", lambda: True)
    monkeypatch.setattr(db_base, "session_factory", lambda: factory)
    monkeypatch.setattr(reconciler, "_reconcile_cycle", cycle)
    monkeypatch.setattr(
        reconciler, "asyncio", SimpleNamespace(sleep=sleep, CancelledError=asyncio.CancelledError)
    )

    assert await reconciler.acquire_cycle_lock(second) is True  # another replica is mid-cycle
    with pytest.raises(asyncio.CancelledError):
        await reconciler.run_reconciler(interval_s=0)
    assert cycles == []

    await second.commit()
    sleeps = 0
    with pytest.raises(asyncio.CancelledError):
        await reconciler.run_reconciler(interval_s=0)
    assert cycles == [1]

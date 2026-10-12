"""The QUEUED row is the outbox: claimed in batches, with a backoff, committed before it is sent.

SQLite proves the arithmetic, the ordering of claim and send, and the shape of
the PostgreSQL statement (compiled, not run). That two replicas get disjoint
batches under ``FOR UPDATE SKIP LOCKED`` needs PostgreSQL and lives in
``tests/concurrency/test_job_publication_pg.py``.
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytest_asyncio

from _pricing import pricing_catalog
from openbinding_gateway import job_dispatch
from openbinding_gateway.db.models import Job, JobState, User, UserRole, utcnow
from openbinding_gateway.jobs import clock, publisher


class Frozen:
    def __init__(self, moment: datetime) -> None:
        self.moment = moment

    def __call__(self) -> datetime:
        return self.moment

    def advance(self, seconds: float) -> None:
        self.moment += timedelta(seconds=seconds)


@pytest.fixture
def frozen(monkeypatch) -> Frozen:
    moments = Frozen(utcnow())
    monkeypatch.setattr(clock, "utcnow", moments)
    return moments


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


async def a_job(session, owner, *, age_s: float = 60.0, state=JobState.QUEUED, **extra) -> Job:
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


def at(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


# -- The backoff --------------------------------------------------------------


def test_the_backoff_doubles_from_fifteen_seconds_up_to_five_minutes():
    assert [publisher.backoff_s(n) for n in range(7)] == [15, 30, 60, 120, 240, 300, 300]
    assert publisher.backoff_s(10_000) == 300
    assert publisher.backoff_s(-3) == 15


# -- Which rows are due ------------------------------------------------------


async def test_a_job_is_due_thirty_seconds_after_it_was_created(db_session, owner, frozen):
    fresh = await a_job(db_session, owner, age_s=5)
    old = await a_job(db_session, owner, age_s=31)

    assert await publisher.claim_due(db_session) == [old.id]

    frozen.advance(26)  # the fresh one is now 31 s old (the old one is out of its backoff too)
    assert fresh.id in await publisher.claim_due(db_session)


async def test_only_queued_jobs_are_published(db_session, owner):
    for state in (JobState.RUNNING, JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED):
        await a_job(db_session, owner, state=state)
    queued = await a_job(db_session, owner)

    assert await publisher.claim_due(db_session) == [queued.id]


async def test_claiming_counts_the_publication_and_schedules_the_next_one(db_session, owner, frozen):
    job = await a_job(db_session, owner)

    assert await publisher.claim_due(db_session) == [job.id]
    await db_session.refresh(job)

    assert job.publish_attempts == 1
    assert at(job.next_publish_at) == at(frozen.moment) + timedelta(seconds=15)


async def test_a_claimed_job_is_not_due_again_before_its_backoff_ends(db_session, owner, frozen):
    job = await a_job(db_session, owner)
    await publisher.claim_due(db_session)

    assert await publisher.claim_due(db_session) == []
    frozen.advance(14)
    assert await publisher.claim_due(db_session) == []
    frozen.advance(2)
    assert await publisher.claim_due(db_session) == [job.id]


async def test_each_publication_waits_longer_than_the_last_until_the_cap(db_session, owner, frozen):
    job = await a_job(db_session, owner)

    waits = []
    for _ in range(8):
        assert await publisher.claim_due(db_session) == [job.id]
        await db_session.refresh(job)
        wait = (at(job.next_publish_at) - at(frozen.moment)).total_seconds()
        waits.append(wait)
        frozen.advance(wait)

    assert waits == [15, 30, 60, 120, 240, 300, 300, 300]
    assert job.publish_attempts == 8


async def test_a_requeued_job_is_due_at_once_whatever_its_age(db_session, owner, frozen):
    job = await a_job(db_session, owner, age_s=1, next_publish_at=utcnow())
    frozen.advance(1)

    assert await publisher.claim_due(db_session) == [job.id]


async def test_a_batch_is_bounded_and_the_rows_published_least_come_first(db_session, owner, frozen):
    jobs = [await a_job(db_session, owner) for _ in range(5)]
    first = await publisher.claim_due(db_session, limit=3)
    assert len(first) == 3
    frozen.advance(20)  # all five are due now; three of them have been published once

    second = await publisher.claim_due(db_session, limit=3)

    assert set(second) >= {job.id for job in jobs} - set(first)  # the two never published come first
    assert len(second) == 3


async def test_the_publisher_does_not_touch_anything_but_the_publication_columns(db_session, owner):
    job = await a_job(db_session, owner)
    before = (job.state, job.attempt, job.lease_token, job.lease_until, job.claimed_at)

    await publisher.claim_due(db_session)
    await db_session.refresh(job)

    assert (job.state, job.attempt, job.lease_token, job.lease_until, job.claimed_at) == before


# -- Commit first, send afterwards ---------------------------------------------


async def test_the_claim_is_committed_before_anything_is_sent(db_session, owner, frozen):
    jobs = [await a_job(db_session, owner) for _ in range(3)]
    events: list[tuple] = []

    async def send(job_id: str) -> bool:
        # No open transaction: the claim is durable and no row lock is held across the network.
        events.append(("send", job_id, db_session.in_transaction()))
        return True

    sent = await publisher.publish_due(db_session, send)

    assert sent == 3
    assert {job_id for _, job_id, _ in events} == {str(job.id) for job in jobs}
    assert all(not in_transaction for _, _, in_transaction in events)
    for job in jobs:
        await db_session.refresh(job)
        assert job.publish_attempts == 1


async def test_a_broker_that_refuses_stops_the_batch_and_leaves_the_rest_to_their_backoff(
    db_session, owner, frozen
):
    jobs = [await a_job(db_session, owner) for _ in range(3)]
    tried: list[str] = []

    async def send(job_id: str) -> bool:
        tried.append(job_id)
        return False

    assert await publisher.publish_due(db_session, send) == 0
    assert len(tried) == 1  # the others were not sent into a broker that just refused

    assert await publisher.publish_due(db_session, send) == 0
    assert len(tried) == 1  # nothing is due until the backoff ends
    for job in jobs:
        await db_session.refresh(job)
        assert job.state is JobState.QUEUED and job.publish_attempts == 1


async def test_a_send_that_never_happens_loses_nothing(db_session, owner, frozen):
    """A crash between the commit and the send: the row is still QUEUED and comes due again."""
    job = await a_job(db_session, owner)

    class Crash(Exception):
        pass

    async def send(_job_id: str) -> bool:
        raise Crash

    with pytest.raises(Crash):
        await publisher.publish_due(db_session, send)

    await db_session.refresh(job)
    assert job.state is JobState.QUEUED
    frozen.advance(15)
    assert await publisher.claim_due(db_session) == [job.id]


# -- The dispatch module hands over to the publisher ---------------------------


async def test_redelivery_publishes_through_the_one_dispatch_path(db_session, owner, monkeypatch):
    job = await a_job(db_session, owner)
    sent: list[str] = []

    async def dispatch(job_id, _request_session=None):
        sent.append(job_id)
        return True

    monkeypatch.setattr(job_dispatch, "get_settings", lambda: SimpleNamespace(job_dispatch_mode="dramatiq"))
    monkeypatch.setattr(job_dispatch, "dispatch_persisted_job", dispatch)

    assert await job_dispatch.redeliver_queued_jobs(db_session) == 1
    assert sent == [str(job.id)]
    assert await job_dispatch.redeliver_queued_jobs(db_session) == 0  # backing off now
    assert sent == [str(job.id)]


async def test_inline_mode_has_nothing_to_republish(db_session, owner, monkeypatch):
    job = await a_job(db_session, owner)
    monkeypatch.setattr(job_dispatch, "get_settings", lambda: SimpleNamespace(job_dispatch_mode="inline"))

    assert await job_dispatch.redeliver_queued_jobs(db_session) == 0
    await db_session.refresh(job)
    assert job.publish_attempts == 0 and job.next_publish_at is None


# -- The migration --------------------------------------------------------------

ROOT = Path(__file__).parents[1]
PREVIOUS_REVISION = "e1f2a3b4c5d6"


def alembic(database: Path, *arguments: str) -> None:
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    done = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", *arguments],
        cwd=ROOT, env=environment, capture_output=True, text=True, check=False,
    )
    assert done.returncode == 0, done.stdout + done.stderr


def columns(database: Path, table: str) -> dict[str, tuple]:
    with sqlite3.connect(database) as connection:
        return {row[1]: row for row in connection.execute(f"PRAGMA table_info({table})")}


def job_triggers(database: Path) -> set[str]:
    with sqlite3.connect(database) as connection:
        rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs'")
        return {name for (name,) in rows}


def test_the_migration_adds_the_publication_and_attempt_columns_and_keeps_the_job_triggers(tmp_path):
    database = tmp_path / "publication.db"

    alembic(database, "upgrade", PREVIOUS_REVISION)
    triggers = job_triggers(database)
    assert {"protect_jobs", "pin_job_configuration"} <= triggers
    assert not {"publish_attempts", "next_publish_at"} & set(columns(database, "jobs"))
    assert "attempts" not in columns(database, "analysis_tasks")

    alembic(database, "upgrade", "head")
    jobs = columns(database, "jobs")
    assert jobs["publish_attempts"][3] == 1 and jobs["publish_attempts"][4].strip("'\"") == "0"  # NOT NULL, 0
    assert jobs["next_publish_at"][3] == 0  # nullable
    tasks = columns(database, "analysis_tasks")
    assert tasks["attempts"][3] == 1 and tasks["attempts"][4].strip("'\"") == "0"
    assert job_triggers(database) == triggers  # no table rebuild dropped them

    alembic(database, "downgrade", PREVIOUS_REVISION)
    assert not {"publish_attempts", "next_publish_at"} & set(columns(database, "jobs"))
    assert "attempts" not in columns(database, "analysis_tasks")
    assert job_triggers(database) == triggers

    alembic(database, "upgrade", "head")
    assert {"publish_attempts", "next_publish_at"} <= set(columns(database, "jobs"))


# -- The PostgreSQL statement -------------------------------------------------


async def postgres_statements(limit: int = 7) -> list[str]:
    from sqlalchemy.dialects import postgresql

    seen: list[str] = []

    class Result:
        def scalars(self):
            return SimpleNamespace(all=lambda: [])

    class Session:
        sync_session = SimpleNamespace(
            get_bind=lambda: SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        )

        async def execute(self, statement):
            seen.append(str(statement.compile(dialect=postgresql.dialect())))
            return Result()

    await publisher.claim_due(Session(), limit=limit)
    return seen


async def test_on_postgresql_one_statement_claims_a_locked_batch_and_schedules_it(monkeypatch):
    def forbidden():
        raise AssertionError("the process clock was read on PostgreSQL")

    monkeypatch.setattr(clock, "utcnow", forbidden)

    (statement,) = await postgres_statements()
    flat = " ".join(statement.split())

    assert flat.startswith("UPDATE jobs SET publish_attempts=")
    assert "WHERE jobs.id IN (SELECT jobs.id FROM jobs WHERE" in flat
    assert "FOR UPDATE SKIP LOCKED)" in flat
    assert "LIMIT" in flat and "ORDER BY jobs.publish_attempts, jobs.id" in flat
    assert "jobs.next_publish_at IS NULL AND jobs.created_at < now() + make_interval(" in flat
    assert "jobs.next_publish_at <= now()" in flat
    assert "next_publish_at=(now() + make_interval(" in flat
    assert "least(300.0, 15.0 * power(2, least(jobs.publish_attempts, 10)))" in flat
    assert "RETURNING jobs.id" in flat

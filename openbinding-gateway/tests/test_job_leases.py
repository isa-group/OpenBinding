"""A running job belongs to the worker that claimed it, for as long as it keeps saying so.

Before leases a job that was running looked the same whether its worker was
solving or dead, so the reconciler could only wait out the budget. These tests
pin the replacement: a claim carries a token and a deadline, a live worker
pushes the deadline forward, a lost worker's job is put back once and then
failed, and a worker that lost its lease cannot write anything afterwards.
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from _pricing import pricing_catalog
from _repo import REPO_ROOT as EXAMPLES_ROOT
from openbinding_gateway.core.public_errors import JOB_FAILURES
from openbinding_gateway.db.models import Job, JobState, User, UserRole, utcnow
from openbinding_gateway.jobs import clock, leases, reconciler
from openbinding_gateway.services import execution
from openbinding_gateway.services.engine_registry import CancellationCapability
from bim_core.package import load_package

ROOT = Path(__file__).parents[1]
EXAMPLE = EXAMPLES_ROOT / "examples/demo/01_simple_seq"


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


async def a_job(session, owner, *, budget_s=600.0, age_s=0.0, state=JobState.QUEUED, **extra) -> Job:
    job = Job(
        owner_id=owner.id,
        engine_id="random-search",
        engine_job_id="engine-1",
        service_url="http://engine",
        state=state,
        requested_budget_s=budget_s,
        created_at=utcnow() - timedelta(seconds=age_s),
        **extra,
    )
    session.add(job)
    # Committed, because a worker that loses its lease rolls its session back.
    await session.commit()
    return job


async def lose_the_worker(session, job: Job, *, ran_for_s: float) -> None:
    """Make a claimed job look like its worker beat for ``ran_for_s`` and then died."""
    lease_until = utcnow() - timedelta(seconds=1)
    job.lease_until = lease_until
    job.claimed_at = lease_until - timedelta(seconds=leases.LEASE_S + ran_for_s)
    await session.commit()


def at(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


# -- Claiming ---------------------------------------------------------------


async def test_claiming_a_queued_job_takes_a_lease(db_session, owner):
    job = await a_job(db_session, owner)
    before = utcnow()

    token = await leases.claim_job(db_session, job.id)
    await db_session.refresh(job)

    assert token is not None
    assert job.state is JobState.RUNNING
    assert job.lease_token == token
    assert job.attempt == 1
    assert at(job.claimed_at) >= before
    assert (at(job.lease_until) - at(job.claimed_at)).total_seconds() == leases.LEASE_S
    assert leases.held_token(db_session, job.id) == token


async def test_a_job_is_claimed_by_one_worker_only(db_session, owner):
    job = await a_job(db_session, owner)

    first = await leases.claim_job(db_session, job.id)
    second = await leases.claim_job(db_session, job.id)
    await db_session.refresh(job)

    assert first is not None and second is None
    assert job.lease_token == first
    assert job.attempt == 1


async def test_only_the_holder_of_the_token_holds_the_lease(db_session, owner):
    job = await a_job(db_session, owner)
    token = await leases.claim_job(db_session, job.id)

    assert await leases.hold_lease(db_session, job.id, token) is True
    assert await leases.hold_lease(db_session, job.id, str(uuid.uuid4())) is False
    assert await leases.hold_lease(db_session, job.id, None) is False


# -- Heartbeat --------------------------------------------------------------


async def test_a_heartbeat_renews_the_lease_only_for_its_holder(db_session, owner):
    job = await a_job(db_session, owner)
    token = await leases.claim_job(db_session, job.id)
    job.lease_until = utcnow() + timedelta(seconds=1)
    await db_session.commit()
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)

    assert await leases.renew_lease(factory, job.id, str(uuid.uuid4())) is False
    await db_session.refresh(job)
    assert at(job.lease_until) < utcnow() + timedelta(seconds=5)

    assert await leases.renew_lease(factory, job.id, token) is True
    await db_session.refresh(job)
    assert at(job.lease_until) > utcnow() + timedelta(seconds=leases.LEASE_S - 5)


async def test_each_renewal_pushes_the_lease_further(db_session, owner, monkeypatch):
    job = await a_job(db_session, owner)
    token = await leases.claim_job(db_session, job.id)
    await db_session.commit()
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    base = utcnow()
    moments = iter([base + timedelta(seconds=10 * step) for step in range(1, 4)])
    monkeypatch.setattr(clock, "utcnow", lambda: next(moments))

    deadlines = []
    for _ in range(3):
        # Called one after another, never alongside the test's own session:
        # an in-memory SQLite database is one connection shared by all of them.
        assert await leases.renew_lease(factory, job.id, token) is True
        await db_session.refresh(job)
        deadlines.append(at(job.lease_until))

    assert deadlines == sorted(set(deadlines))
    assert deadlines[1] - deadlines[0] == timedelta(seconds=10)


class Ticks:
    """Replaces asyncio.sleep in the heartbeat loop: each beat waits to be let through."""

    def __init__(self) -> None:
        self.intervals: list[float] = []
        self.allowed = asyncio.Semaphore(0)

    async def sleep(self, interval: float) -> None:
        self.intervals.append(interval)
        await self.allowed.acquire()


@pytest.fixture
def ticks(monkeypatch) -> Ticks:
    clock = Ticks()
    # Only the module's view of asyncio is swapped, so nothing else is slowed or sped up.
    monkeypatch.setattr(
        leases,
        "asyncio",
        SimpleNamespace(
            sleep=clock.sleep,
            create_task=asyncio.create_task,
            gather=asyncio.gather,
            CancelledError=asyncio.CancelledError,
        ),
    )
    return clock


@pytest.fixture
def renewals(monkeypatch) -> asyncio.Queue:
    """Replaces the renewal itself, so a beat touches no database at all."""
    seen: asyncio.Queue = asyncio.Queue()
    outcomes: list = []

    async def renew(_factory, job_id, token) -> bool:
        seen.put_nowait((job_id, token))
        outcome = outcomes.pop(0) if outcomes else True
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    seen.outcomes = outcomes  # type: ignore[attr-defined]
    monkeypatch.setattr(leases, "renew_lease", renew)
    return seen


async def one_beat(ticks: Ticks, renewals: asyncio.Queue):
    ticks.allowed.release()
    return await asyncio.wait_for(renewals.get(), timeout=5)  # a guard, not a delay


async def test_the_heartbeat_keeps_beating_until_it_is_stopped(db_session, ticks, renewals):
    job_id, token = uuid.uuid4(), str(uuid.uuid4())

    beat = leases.start_heartbeat(db_session, job_id, token, interval_s=7.0)
    seen = [await one_beat(ticks, renewals) for _ in range(3)]
    assert seen == [(job_id, token)] * 3
    assert ticks.intervals[:3] == [7.0] * 3
    assert not beat.done()

    await leases.stop_heartbeat(beat)
    ticks.allowed.release()
    await asyncio.sleep(0)

    assert beat.done() and beat.cancelled()
    assert renewals.empty()


async def test_the_heartbeat_beats_at_the_default_interval(db_session, ticks, renewals):
    beat = leases.start_heartbeat(db_session, uuid.uuid4(), "token")
    await one_beat(ticks, renewals)
    await leases.stop_heartbeat(beat)

    assert ticks.intervals[0] == leases.HEARTBEAT_S


async def test_the_heartbeat_ends_when_the_job_was_taken_back(db_session, ticks, renewals):
    renewals.outcomes.append(False)  # type: ignore[attr-defined]

    beat = leases.start_heartbeat(db_session, uuid.uuid4(), "token", interval_s=1.0)
    await one_beat(ticks, renewals)
    await asyncio.wait_for(beat, timeout=5)

    assert beat.done() and not beat.cancelled()


async def test_a_missed_beat_does_not_end_the_heartbeat(db_session, ticks, renewals):
    renewals.outcomes.append(RuntimeError("database hiccup"))  # type: ignore[attr-defined]

    beat = leases.start_heartbeat(db_session, uuid.uuid4(), "token", interval_s=1.0)
    await one_beat(ticks, renewals)
    await one_beat(ticks, renewals)
    still_beating = not beat.done()
    await leases.stop_heartbeat(beat)

    assert still_beating


async def test_a_session_with_nothing_to_connect_to_has_no_heartbeat(monkeypatch):
    monkeypatch.setattr(leases.db_base, "is_configured", lambda: False)
    session = SimpleNamespace(bind=None)

    assert leases.start_heartbeat(session, uuid.uuid4(), "token") is None
    await leases.stop_heartbeat(None)


# -- A worker that lost its lease writes nothing ----------------------------


async def test_a_failure_without_the_lease_is_not_recorded(db_session, owner):
    job = await a_job(db_session, owner)
    await leases.claim_job(db_session, job.id)
    await db_session.commit()
    # Another worker's claim, as far as this session is concerned.
    db_session.info.pop(leases.lease_key(job.id))

    await execution.fail_persisted_job(job, db_session, "engine_timeout", time.monotonic())

    await db_session.refresh(job)
    assert job.state is JobState.RUNNING
    assert job.result is None


async def test_a_failure_with_the_lease_is_recorded(db_session, owner):
    job = await a_job(db_session, owner)
    await leases.claim_job(db_session, job.id)
    await db_session.commit()

    await execution.fail_persisted_job(job, db_session, "engine_timeout", time.monotonic())

    await db_session.refresh(job)
    assert job.state is JobState.FAILED
    assert job.result["error"] == JOB_FAILURES["engine_timeout"]
    assert job.result["code"] == "engine_timeout"
    assert job.lease_token is None and job.lease_until is None
    assert job.finished_at is not None


async def _account_with_snapshot(client, registration) -> tuple[dict[str, str], str]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    headers = {"Authorization": f"Bearer {logged.json()['access_token']}"}
    snapshot = await client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=load_package(EXAMPLE).to_zip(),
    )
    assert snapshot.status_code == 201, snapshot.text
    return headers, snapshot.json()["id"]


async def _submit(client, headers, snapshot_id) -> None:
    response = await client.post(
        "/v1/jobs",
        headers=headers,
        json={
            "snapshot": snapshot_id,
            "engine": "random-search",
            "mode": "seeded",
            "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"},
        },
    )
    assert response.status_code == 202, response.text


def _answer() -> dict:
    return {
        "termination": "FEASIBLE",
        "solutions": [
            {
                "decision": {
                    "kind": "binding",
                    "binding": {
                        "t1": {"resource": "catalog", "id": "c1a"},
                        "t2": {"resource": "catalog", "id": "c2a"},
                        "t3": {"resource": "catalog", "id": "c3a"},
                    },
                }
            }
        ],
    }


async def test_a_job_that_finishes_is_completed_and_unleased(
    api_client, db_session, registration, monkeypatch
):
    async def solve(*_args, **_kwargs):
        return _answer()

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    await db_session.refresh(job)
    assert job.state is JobState.COMPLETED
    assert job.attempt == 1
    assert job.claimed_at is not None
    assert job.lease_token is None and job.lease_until is None
    assert job.finished_at is not None


async def test_a_cancellation_that_arrives_during_the_solve_wins_over_its_late_result(
    api_client, db_session, registration, monkeypatch
):
    async def solve(*_args, **_kwargs):
        job = (await db_session.execute(select(Job))).scalars().one()
        job.cancellation_requested = True
        await db_session.flush()
        return _answer()

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    await db_session.refresh(job)
    assert job.state is JobState.CANCELLED
    assert job.result is None
    assert job.lease_token is None
    assert job.finished_at is not None


async def test_a_result_that_arrives_after_the_job_was_taken_back_is_discarded(
    api_client, db_session, registration, monkeypatch
):
    async def solve(*_args, **_kwargs):
        # While the engine works, the worker's lease lapses and the reconciler
        # puts the job back in the queue.
        job = (await db_session.execute(select(Job))).scalars().one()
        job.lease_until = utcnow() - timedelta(seconds=1)
        await db_session.commit()
        assert await reconciler.sweep_abandoned(db_session) == 0
        await db_session.commit()
        return _answer()

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    await db_session.refresh(job)
    assert job.state is JobState.QUEUED
    assert job.result is None
    assert job.attempt == 1


def fail_once(session, name: str, monkeypatch) -> None:
    """Make the session's next ``name`` call raise, and later calls behave normally."""
    real = getattr(session, name)
    failed = []

    async def wrapper(*args, **kwargs):
        if not failed:
            failed.append(True)
            raise RuntimeError(f"{name} failed")
        return await real(*args, **kwargs)

    monkeypatch.setattr(session, name, wrapper)


async def test_a_claim_that_cannot_be_committed_is_given_up(db_session, owner, monkeypatch):
    job = await a_job(db_session, owner)
    fail_once(db_session, "commit", monkeypatch)

    with pytest.raises(RuntimeError, match="commit failed"):
        await execution.finish_persisted_job(str(job.id), db_session)

    await db_session.refresh(job)
    assert leases.held_token(db_session, job.id) is None
    assert job.state is JobState.QUEUED and job.lease_token is None and job.attempt == 0


async def test_a_worker_that_does_not_hold_the_lease_does_not_run_the_job(db_session, owner, monkeypatch):
    async def solve(*_args, **_kwargs):
        raise AssertionError("a job nobody claimed was run")

    monkeypatch.setattr(execution, "solve_remote", solve)
    job = await a_job(db_session, owner)

    await execution.run_claimed_job(job.id, db_session)

    await db_session.refresh(job)
    assert job.state is JobState.QUEUED and job.result is None


async def test_the_session_is_idle_during_the_solve_and_committed_before_the_heartbeat_stops(
    api_client, db_session, registration, monkeypatch
):
    events: list[tuple] = []

    async def solve(*_args, **_kwargs):
        has_token = any(str(key).startswith("job-lease:") for key in db_session.info)
        events.append(("solve", db_session.in_transaction(), has_token))
        return _answer()

    real_stop, real_hold, real_refresh = leases.stop_heartbeat, leases.hold_lease, db_session.refresh

    async def stop(task):
        events.append(("stop", db_session.in_transaction()))
        await real_stop(task)

    async def hold(*args, **kwargs):
        events.append(("hold",))
        return await real_hold(*args, **kwargs)

    async def refresh(*args, **kwargs):
        events.append(("refresh",))
        return await real_refresh(*args, **kwargs)

    monkeypatch.setattr(execution, "solve_remote", solve)
    monkeypatch.setattr(leases, "stop_heartbeat", stop)
    monkeypatch.setattr(leases, "hold_lease", hold)
    monkeypatch.setattr(db_session, "refresh", refresh)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    solved = events.index(("solve", False, True))  # no open transaction, lease token kept
    after = events[solved + 1 :]
    assert after.index(("hold",)) < after.index(("refresh",))  # lock, then read
    assert ("stop", False) in events  # nothing left uncommitted when the beat stops


# -- The reconciler ---------------------------------------------------------


async def test_a_job_with_a_live_lease_is_left_alone(db_session, owner):
    job = await a_job(db_session, owner, budget_s=1.0, age_s=10_000)
    await leases.claim_job(db_session, job.id)

    assert await reconciler.sweep_abandoned(db_session) == 0
    await db_session.refresh(job)
    assert job.state is JobState.RUNNING


async def test_a_lost_worker_gets_the_job_requeued_once_and_then_it_fails(db_session, owner):
    job = await a_job(db_session, owner, budget_s=600.0)

    await leases.claim_job(db_session, job.id)
    await lose_the_worker(db_session, job, ran_for_s=30)
    assert await reconciler.sweep_abandoned(db_session) == 0

    await db_session.refresh(job)
    assert job.state is JobState.QUEUED and job.lease_token is None
    assert job.attempt == 1

    assert await leases.claim_job(db_session, job.id) is not None
    await lose_the_worker(db_session, job, ran_for_s=45)
    assert await reconciler.sweep_abandoned(db_session) == 1

    await db_session.refresh(job)
    assert job.state is JobState.FAILED and job.attempt == 2
    assert job.lease_token is None and job.lease_until is None
    assert job.finished_at is not None


async def test_a_running_job_nobody_saw_start_is_failed_after_its_budget_and_grace(db_session, owner):
    job = await a_job(
        db_session, owner, budget_s=60.0, age_s=60 + reconciler.ABANDONED_GRACE_S + 1, state=JobState.RUNNING
    )

    assert await reconciler.sweep_abandoned(db_session) == 1
    await db_session.refresh(job)
    assert job.state is JobState.FAILED


async def test_the_deadline_of_a_claimed_job_counts_from_its_claim(db_session, owner):
    job = await a_job(db_session, owner, budget_s=60.0, age_s=10_000, claimed_at=utcnow() - timedelta(seconds=10))

    assert await reconciler.sweep_abandoned(db_session) == 0
    await db_session.refresh(job)
    assert job.state is JobState.QUEUED


async def test_a_finished_job_is_never_swept(db_session, owner):
    job = await a_job(
        db_session, owner, budget_s=1.0, age_s=reconciler.ABANDONED_GRACE_S + 10, state=JobState.COMPLETED
    )

    assert await reconciler.sweep_abandoned(db_session) == 0
    await db_session.refresh(job)
    assert job.state is JobState.COMPLETED


# -- The clock ----------------------------------------------------------------


class Frozen:
    """A process clock that only moves when the test says so."""

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


def postgres_session():
    """Enough of a session for the clock helpers to believe the database is PostgreSQL."""
    dialect = SimpleNamespace(name="postgresql")
    return SimpleNamespace(sync_session=SimpleNamespace(get_bind=lambda: SimpleNamespace(dialect=dialect)))


def compiled(expression) -> str:
    from sqlalchemy.dialects import postgresql

    return str(expression.compile(dialect=postgresql.dialect()))


def test_on_postgresql_the_clock_is_the_databases_and_the_arithmetic_stays_in_sql(monkeypatch):
    def forbidden():
        raise AssertionError("the process clock was read on PostgreSQL")

    monkeypatch.setattr(clock, "utcnow", forbidden)
    session = postgres_session()

    assert compiled(clock.now(session)) == "now()"
    plus = compiled(clock.after(session, 60))
    assert plus.startswith("now() + make_interval(") and "60" not in plus  # the amount is a bound parameter
    assert "make_interval" in compiled(clock.before(session, 30))


async def test_every_lease_statement_uses_the_database_clock_on_postgresql(monkeypatch):
    seen: list[str] = []

    class Result:
        def first(self):
            return None

    class Session:
        sync_session = postgres_session().sync_session
        info: dict = {}

        async def execute(self, statement):
            seen.append(compiled(statement))
            return Result()

    def forbidden():
        raise AssertionError("the process clock was read on PostgreSQL")

    monkeypatch.setattr(clock, "utcnow", forbidden)
    job_id = uuid.uuid4()
    lost = SimpleNamespace(id=job_id, state=JobState.RUNNING, lease_token="t")

    await leases.claim_job(Session(), job_id)
    await leases.hold_lease(Session(), job_id, "token")
    await leases.renew_lease(lambda: _Factory(Session()), job_id, "token")
    await reconciler._requeue(Session(), lost)
    await reconciler._fail_abandoned(Session(), lost)

    claim, hold, renew, requeue, fail = seen
    for statement in (claim, hold, renew):
        assert "now() + make_interval(" in statement
    assert "claimed_at=now()" in claim
    assert "lease_until < now()" in requeue and "next_publish_at=now()" in requeue
    assert "lease_until < now()" in fail and "finished_at=now()" in fail


class _Factory:
    """An async context manager handing out one session, like ``async_sessionmaker()()``."""

    def __init__(self, session) -> None:
        self.session = session

    async def __aenter__(self):
        self.session.commit = _noop
        return self.session

    async def __aexit__(self, *_exc) -> None:
        return None


async def _noop() -> None:
    return None


async def test_a_claim_is_stamped_by_the_controlled_clock(db_session, owner, frozen):
    job = await a_job(db_session, owner)

    await leases.claim_job(db_session, job.id)
    await db_session.refresh(job)

    assert at(job.claimed_at) == at(frozen.moment)
    assert at(job.lease_until) == at(frozen.moment) + timedelta(seconds=leases.LEASE_S)


async def test_a_lease_lapses_by_the_controlled_clock_and_not_before(db_session, owner, frozen):
    job = await a_job(db_session, owner)
    await leases.claim_job(db_session, job.id)
    await db_session.commit()

    frozen.advance(leases.LEASE_S - 1)
    assert await reconciler.sweep_abandoned(db_session) == 0
    await db_session.refresh(job)
    assert job.state is JobState.RUNNING

    frozen.advance(2)
    assert await reconciler.sweep_abandoned(db_session) == 0  # requeued, not failed
    await db_session.refresh(job)
    assert job.state is JobState.QUEUED and job.lease_token is None
    assert at(job.next_publish_at) == at(frozen.moment)  # a requeued job is due at once
    assert job.publish_attempts == 0


async def test_a_renewal_keeps_a_lease_alive_past_its_first_deadline(db_session, owner, frozen):
    job = await a_job(db_session, owner)
    token = await leases.claim_job(db_session, job.id)
    await db_session.commit()
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)

    frozen.advance(leases.LEASE_S - 5)
    assert await leases.renew_lease(factory, job.id, token) is True
    frozen.advance(10)  # past the first deadline, inside the renewed one

    assert await reconciler.sweep_abandoned(db_session) == 0
    await db_session.refresh(job)
    assert job.state is JobState.RUNNING and job.lease_token == token


async def test_holding_the_lease_pushes_the_deadline_forward_while_it_locks_the_row(db_session, owner, frozen):
    job = await a_job(db_session, owner)
    token = await leases.claim_job(db_session, job.id)
    await db_session.commit()

    frozen.advance(leases.LEASE_S + 30)  # lapsed, but nobody has taken the job back yet
    assert await leases.hold_lease(db_session, job.id, token) is True
    await db_session.commit()
    await db_session.refresh(job)

    assert at(job.lease_until) == at(frozen.moment) + timedelta(seconds=leases.LEASE_S)


async def test_the_holder_of_a_lapsed_lease_loses_it_only_when_the_job_was_taken_back(db_session, owner, frozen):
    job = await a_job(db_session, owner)
    token = await leases.claim_job(db_session, job.id)
    await db_session.commit()
    frozen.advance(leases.LEASE_S + 1)
    await reconciler.sweep_abandoned(db_session)
    await db_session.commit()

    assert await leases.hold_lease(db_session, job.id, token) is False


# -- Engine ids and remote cancellation ---------------------------------------


class RemoteStub:
    """Stands in for solve_remote and cancel_remote, recording what the worker asked of them."""

    def __init__(self) -> None:
        self.kwargs: dict = {}
        self.cancelled: list[str] = []

    async def cancel(self, _registration, engine_job_id, **_kwargs) -> bool:
        self.cancelled.append(engine_job_id)
        return True


@pytest.fixture
def declared_cancellation(monkeypatch) -> CancellationCapability:
    """These jobs run on a built-in engine, which declares no cancellation: this makes it declare the per-attempt kind.

    Remote cancellation goes through one guarded door that sends nothing to an engine whose registration
    does not declare the capability, so a test that expects a ``DELETE`` has to say who declares it.
    """
    capability = CancellationCapability(declared=True, supported=True, id_scope="attempt")
    monkeypatch.setattr(execution, "registration_cancellation", lambda _registration: capability)
    return capability


@pytest.fixture
def remote_stub(monkeypatch, declared_cancellation) -> RemoteStub:
    stub = RemoteStub()
    monkeypatch.setattr(execution, "cancel_remote", stub.cancel)
    return stub


async def test_the_engine_job_id_is_committed_before_the_worker_waits_for_the_result(
    api_client, db_session, registration, monkeypatch, remote_stub
):
    seen: dict = {"commits": 0}
    real_commit = db_session.commit

    async def counting_commit():
        seen["commits"] += 1
        await real_commit()

    monkeypatch.setattr(db_session, "commit", counting_commit)

    async def solve(*_args, on_remote_id=None, job_id=None, attempt=None, **_kwargs):
        before = seen["commits"]
        await on_remote_id("engine-job-7")
        # Committed, and nothing left open: the id is durable before the wait starts.
        seen["committed_by_callback"] = seen["commits"] - before
        seen["in_transaction"] = db_session.in_transaction()
        seen["stored"] = (await db_session.execute(select(Job.engine_job_id))).scalar_one()
        await db_session.commit()
        seen["job_id"], seen["attempt"] = job_id, attempt
        return _answer()

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    assert seen["committed_by_callback"] == 1 and seen["in_transaction"] is False
    assert seen["stored"] == "engine-job-7"
    assert seen["job_id"] == str(job.id) and seen["attempt"] == 1
    assert job.state is JobState.COMPLETED and job.engine_job_id == "engine-job-7"
    assert remote_stub.cancelled == []


async def test_a_result_discarded_because_the_lease_was_lost_cancels_the_remote_job(
    api_client, db_session, registration, monkeypatch, remote_stub
):
    async def solve(*_args, on_remote_id=None, **_kwargs):
        await on_remote_id("engine-job-8")
        job = (await db_session.execute(select(Job))).scalars().one()
        job.lease_until = utcnow() - timedelta(seconds=1)
        await db_session.commit()
        assert await reconciler.sweep_abandoned(db_session) == 0
        await db_session.commit()
        return _answer()

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    await db_session.refresh(job)
    assert job.state is JobState.QUEUED and job.result is None
    assert remote_stub.cancelled == ["engine-job-8"]


async def test_a_cancellation_noticed_after_the_solve_cancels_the_remote_job(
    api_client, db_session, registration, monkeypatch, remote_stub
):
    async def solve(*_args, on_remote_id=None, **_kwargs):
        await on_remote_id("engine-job-9")
        job = (await db_session.execute(select(Job))).scalars().one()
        job.cancellation_requested = True
        await db_session.commit()
        return _answer()

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    await db_session.refresh(job)
    assert job.state is JobState.CANCELLED
    assert remote_stub.cancelled == ["engine-job-9"]


async def test_an_engine_failure_after_acceptance_cancels_the_remote_job_and_fails_the_job(
    api_client, db_session, registration, monkeypatch, remote_stub
):
    async def solve(*_args, on_remote_id=None, **_kwargs):
        await on_remote_id("engine-job-10")
        raise execution.RemoteEngineError("remote engine timed out")

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    await db_session.refresh(job)
    assert job.state is JobState.FAILED and job.engine_job_id == "engine-job-10"
    assert remote_stub.cancelled == ["engine-job-10"]


async def test_a_cancellation_that_cannot_be_delivered_does_not_change_the_outcome(
    api_client, db_session, registration, monkeypatch, declared_cancellation
):
    async def broken(*_args, **_kwargs):
        raise RuntimeError("engine unreachable")

    async def solve(*_args, on_remote_id=None, **_kwargs):
        await on_remote_id("engine-job-11")
        job = (await db_session.execute(select(Job))).scalars().one()
        job.cancellation_requested = True
        await db_session.commit()
        return _answer()

    monkeypatch.setattr(execution, "cancel_remote", broken)
    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    await db_session.refresh(job)
    assert job.state is JobState.CANCELLED


async def test_an_engine_id_that_cannot_be_stored_does_not_fail_the_solve(
    api_client, db_session, registration, monkeypatch, remote_stub
):
    async def solve(*_args, on_remote_id=None, **_kwargs):
        await on_remote_id("x" * (execution.ENGINE_JOB_ID_MAX + 1))
        return _answer()

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    await db_session.refresh(job)
    assert job.state is JobState.COMPLETED


# -- The migration ----------------------------------------------------------

PREVIOUS_REVISION = "d1e2f3a4b5c6"
LEASE_COLUMNS = {"lease_token", "lease_until", "claimed_at", "attempt"}


def alembic(database: Path, *arguments: str) -> subprocess.CompletedProcess:
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    return subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", *arguments],
        cwd=ROOT, env=environment, capture_output=True, text=True, check=False,
    )


def job_columns(database: Path) -> dict[str, tuple]:
    with sqlite3.connect(database) as connection:
        return {row[1]: row for row in connection.execute("PRAGMA table_info(jobs)")}


def job_triggers(database: Path) -> set[str]:
    with sqlite3.connect(database) as connection:
        rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs'")
        return {name for (name,) in rows}


def job_indexes(database: Path) -> set[str]:
    with sqlite3.connect(database) as connection:
        return {row[1] for row in connection.execute("PRAGMA index_list(jobs)")}


def run(database: Path, *arguments: str) -> None:
    done = alembic(database, *arguments)
    assert done.returncode == 0, done.stdout + done.stderr


def test_the_migration_adds_the_lease_columns_and_keeps_the_job_triggers(tmp_path):
    database = tmp_path / "leases.db"

    run(database, "upgrade", PREVIOUS_REVISION)
    triggers = job_triggers(database)
    assert {"protect_jobs", "pin_job_configuration"} <= triggers
    assert not LEASE_COLUMNS & set(job_columns(database))

    run(database, "upgrade", "head")
    columns = job_columns(database)
    assert LEASE_COLUMNS <= set(columns)
    assert columns["attempt"][3] == 1  # NOT NULL
    assert columns["attempt"][4].strip("'\"") == "0"  # SQLite reports the default as "'0'"
    assert columns["lease_token"][3] == 0 and columns["lease_until"][3] == 0
    assert "ix_jobs_state_lease_until" in job_indexes(database)
    assert job_triggers(database) == triggers

    run(database, "downgrade", PREVIOUS_REVISION)
    assert not LEASE_COLUMNS & set(job_columns(database))
    assert "ix_jobs_state_lease_until" not in job_indexes(database)
    assert job_triggers(database) == triggers

    run(database, "upgrade", "head")
    assert LEASE_COLUMNS <= set(job_columns(database))
    assert job_triggers(database) == triggers

"""An analysis task is claimed at most three times, and its lease is renewed while it runs.

Before, a task whose worker kept dying went back in the queue forever, and its
lease was only pushed forward when the computation reported progress, so a long
load or one long layer let it lapse under a live worker.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker

from openbinding_gateway import analysis_jobs
from openbinding_gateway.db import base
from openbinding_gateway.db.models import AnalysisTask, User, utcnow
from openbinding_gateway.jobs import clock, leases
from openbinding_gateway.models.analysis import AnalysisQuery
from openbinding_gateway.routes import analysis as analysis_routes


def at(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


@pytest_asyncio.fixture
async def owner(db_session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        is_active=True,
        plan_cache="BASIC",
    )
    db_session.add(user)
    await db_session.commit()
    return user


@pytest.fixture(autouse=True)
def worker_database(db_session, monkeypatch):
    """The worker opens its own sessions: point it at the test database."""
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    monkeypatch.setattr(base, "session_factory", lambda: factory)
    monkeypatch.setattr(base, "is_configured", lambda: True)


@pytest.fixture
def dispatched(monkeypatch) -> list[str]:
    sent: list[str] = []

    async def dispatch(task_id: str) -> None:
        sent.append(task_id)

    monkeypatch.setattr(analysis_jobs, "dispatch_analysis", dispatch)
    return sent


async def a_task(session, owner, **fields) -> AnalysisTask:
    values = {
        "owner_id": owner.id,
        "fingerprint": "sha256-" + uuid.uuid4().hex,
        "revision": "r1",
        "request": AnalysisQuery(sources=["source"]).model_dump(),
        "state": "queued",
        **fields,
    }
    task = AnalysisTask(**values)
    session.add(task)
    await session.commit()
    return task


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


# -- The cap on attempts --------------------------------------------------------


async def test_claiming_a_task_counts_the_attempt(db_session, owner, monkeypatch):
    async def stop(*_args, **_kwargs):
        raise RuntimeError("stop after the claim")

    monkeypatch.setattr(analysis_routes, "load_archive", stop)
    task = await a_task(db_session, owner)
    assert task.attempts == 0

    await analysis_jobs.execute_analysis(str(task.id))

    await db_session.refresh(task)
    assert task.attempts == 1
    assert task.state == "failed" and task.error == "stop after the claim"


async def test_a_task_that_was_not_claimed_is_not_counted(db_session, owner):
    task = await a_task(db_session, owner, state="completed")

    await analysis_jobs.execute_analysis(str(task.id))

    await db_session.refresh(task)
    assert task.attempts == 0


@pytest.mark.parametrize("claims", [1, 2])
async def test_a_lost_worker_gets_the_task_back_until_its_third_claim(db_session, owner, dispatched, claims):
    task = await a_task(
        db_session, owner, state="running", attempts=claims, lease_token="lost",
        lease_until=utcnow() - timedelta(seconds=1), progress=0.5,
    )

    await analysis_jobs.redeliver_analysis(db_session)

    await db_session.refresh(task)
    assert task.state == "queued" and task.lease_token is None and task.lease_until is None
    assert task.progress == 0 and task.error is None and task.attempts == claims


async def test_the_third_lost_worker_fails_the_task_as_abandoned(db_session, owner, dispatched):
    task = await a_task(
        db_session, owner, state="running", attempts=analysis_jobs.MAX_ATTEMPTS, lease_token="lost",
        lease_until=utcnow() - timedelta(seconds=1),
    )

    await analysis_jobs.redeliver_analysis(db_session)

    await db_session.refresh(task)
    assert analysis_jobs.MAX_ATTEMPTS == 3
    assert task.state == "failed" and task.error == "analysis_abandoned"
    assert task.lease_token is None and task.lease_until is None
    assert task.result is None
    assert dispatched == []  # a failed task is not sent to the broker again


async def test_a_task_is_requeued_twice_and_failed_the_third_time_through_real_claims(
    db_session, owner, dispatched, monkeypatch
):
    async def die(*_args, **_kwargs):
        raise asyncio.CancelledError  # the worker is gone: nothing is written, the claim stays

    monkeypatch.setattr(analysis_routes, "load_archive", die)
    task = await a_task(db_session, owner)

    for claim in (1, 2, 3):
        with pytest.raises(asyncio.CancelledError):
            await analysis_jobs.execute_analysis(str(task.id))
        await db_session.refresh(task)
        assert task.state == "running" and task.attempts == claim
        task.lease_until = utcnow() - timedelta(seconds=1)  # its lease lapses with nobody to renew it
        await db_session.commit()
        await analysis_jobs.redeliver_analysis(db_session)
        await db_session.refresh(task)

    assert task.state == "failed" and task.error == "analysis_abandoned" and task.attempts == 3


@pytest.mark.parametrize("state", ["failed", "cancelled"])
async def test_resubmitting_a_failed_or_cancelled_task_resets_its_attempts(
    db_session, owner, dispatched, monkeypatch, state
):
    from types import SimpleNamespace

    async def load(*_args, **_kwargs):
        return SimpleNamespace(revision="r1")

    async def compute(*_args, **_kwargs):
        return None

    monkeypatch.setattr(analysis_routes, "load_archive", load)
    monkeypatch.setattr(analysis_routes, "compute", compute)
    payload = AnalysisQuery(sources=["source"])
    task = await a_task(
        db_session, owner, state=state, attempts=analysis_jobs.MAX_ATTEMPTS, error="analysis_abandoned",
        fingerprint=analysis_routes.task_fingerprint("r1", payload),
    )

    view = await analysis_routes.start_pareto(payload, owner, db_session)

    await db_session.refresh(task)
    assert view.id == str(task.id) and task.state == "queued"
    assert task.attempts == 0 and task.error is None
    assert dispatched == [str(task.id)]


async def test_a_live_lease_is_left_alone(db_session, owner, dispatched):
    task = await a_task(
        db_session, owner, state="running", attempts=3, lease_token="alive",
        lease_until=utcnow() + timedelta(seconds=30),
    )

    await analysis_jobs.redeliver_analysis(db_session)

    await db_session.refresh(task)
    assert task.state == "running" and task.lease_token == "alive"


async def test_the_lease_lapses_by_the_controlled_clock(db_session, owner, dispatched, frozen):
    task = await a_task(
        db_session, owner, state="running", attempts=1, lease_token="t",
        lease_until=frozen.moment + timedelta(seconds=30),
    )

    frozen.advance(29)
    await analysis_jobs.redeliver_analysis(db_session)
    await db_session.refresh(task)
    assert task.state == "running"

    frozen.advance(2)
    await analysis_jobs.redeliver_analysis(db_session)
    await db_session.refresh(task)
    assert task.state == "queued"


async def test_queued_tasks_are_republished_thirty_seconds_after_they_last_changed(
    db_session, owner, dispatched, frozen
):
    old = await a_task(db_session, owner, updated_at=frozen.moment - timedelta(seconds=31))
    await a_task(db_session, owner, updated_at=frozen.moment - timedelta(seconds=5))

    await analysis_jobs.redeliver_analysis(db_session)

    assert dispatched == [str(old.id)]


# -- The lease ----------------------------------------------------------------


async def test_only_the_holder_of_the_token_renews_the_lease(db_session, owner, frozen):
    task = await a_task(
        db_session, owner, state="running", lease_token="mine", lease_until=frozen.moment + timedelta(seconds=5),
    )

    assert await analysis_jobs.renew_analysis_lease(task.id, "somebody else") is False
    await db_session.refresh(task)
    assert at(task.lease_until) == at(frozen.moment) + timedelta(seconds=5)

    assert await analysis_jobs.renew_analysis_lease(task.id, "mine") is True
    await db_session.refresh(task)
    assert at(task.lease_until) == at(frozen.moment) + timedelta(seconds=analysis_jobs.LEASE_S)


async def test_a_cancelled_or_finished_task_is_not_renewed(db_session, owner):
    cancelled = await a_task(
        db_session, owner, state="running", lease_token="t", cancellation_requested=True,
        lease_until=utcnow(),
    )
    finished = await a_task(db_session, owner, state="completed", lease_token="t", lease_until=utcnow())

    assert await analysis_jobs.renew_analysis_lease(cancelled.id, "t") is False
    assert await analysis_jobs.renew_analysis_lease(finished.id, "t") is False


async def test_the_lease_is_renewed_in_the_background_while_the_task_loads_and_stops_with_it(
    db_session, owner, monkeypatch
):
    renewals: list[tuple[uuid.UUID, str]] = []
    enough = asyncio.Event()

    async def renew(task_id, token) -> bool:
        renewals.append((task_id, token))
        if len(renewals) >= 3:
            enough.set()
        return True

    async def slow_load(*_args, **_kwargs):
        # No progress is reported while the archive loads: only the background beat can keep the lease.
        await asyncio.wait_for(enough.wait(), timeout=5)
        raise RuntimeError("loaded enough")

    monkeypatch.setattr(leases, "HEARTBEAT_S", 0.01)
    monkeypatch.setattr(analysis_jobs, "renew_analysis_lease", renew)
    monkeypatch.setattr(analysis_routes, "load_archive", slow_load)
    task = await a_task(db_session, owner)

    await analysis_jobs.execute_analysis(str(task.id))

    assert len(renewals) >= 3
    assert {task_id for task_id, _ in renewals} == {task.id}
    assert len({token for _, token in renewals}) == 1
    stopped_at = len(renewals)
    await asyncio.sleep(0.05)
    assert len(renewals) == stopped_at  # the beat stopped when the task ended
    await db_session.refresh(task)
    assert task.state == "failed" and task.error == "loaded enough" and task.lease_token is None


async def test_the_beat_stops_when_the_task_is_taken_back(db_session, owner, monkeypatch):
    calls = 0
    done = asyncio.Event()

    async def renew(_task_id, _token) -> bool:
        nonlocal calls
        calls += 1
        done.set()
        return False  # cancelled, or claimed by somebody else

    async def slow_load(*_args, **_kwargs):
        await asyncio.wait_for(done.wait(), timeout=5)
        await asyncio.sleep(0.05)  # several more intervals pass
        raise RuntimeError("done")

    monkeypatch.setattr(leases, "HEARTBEAT_S", 0.01)
    monkeypatch.setattr(analysis_jobs, "renew_analysis_lease", renew)
    monkeypatch.setattr(analysis_routes, "load_archive", slow_load)
    task = await a_task(db_session, owner)

    await analysis_jobs.execute_analysis(str(task.id))

    assert calls == 1


async def test_redelivery_compares_with_the_database_clock_on_postgresql():
    from types import SimpleNamespace

    from sqlalchemy.dialects import postgresql

    seen: list[str] = []

    class Result:
        rowcount = 0

        def first(self):
            return None

        def scalars(self):
            return SimpleNamespace(all=lambda: [])

    class Session:
        sync_session = SimpleNamespace(
            get_bind=lambda: SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        )

        async def execute(self, statement):
            seen.append(str(statement.compile(dialect=postgresql.dialect())))
            return Result()

        async def commit(self):
            return None

    await analysis_jobs.redeliver_analysis(Session())

    assert len(seen) == 3
    assert all("now()" in statement for statement in seen)
    assert "lease_until < now()" in seen[0] and "attempts >=" in seen[0]
    assert "lease_until < now()" in seen[1]
    assert "updated_at < now() + make_interval(" in seen[2]

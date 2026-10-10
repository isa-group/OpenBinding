"""A running job belongs to the worker that claimed it, for as long as it keeps saying so.

Before leases a job that was running looked the same whether its worker was
solving or dead, so the reconciler could only wait out the budget and then
charge all of it. These tests pin the replacement: a claim carries a token and
a deadline, a live worker pushes the deadline forward, a lost worker's job is
put back once and then failed for the time it was actually seen running, and a
worker that lost its lease cannot write anything afterwards.
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

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from _pricing import fake_pricing_gate, pricing_catalog
from _repo import REPO_ROOT as EXAMPLES_ROOT
from openbinding_gateway import space_client
from openbinding_gateway.access import metering
from openbinding_gateway.db.models import Job, JobState, User, UserRole, utcnow
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.space_client import FakePricingGate
from openbinding_gateway.v1.package import load_package

ROOT = Path(__file__).parents[1]
SOLVER_TIME = "solverSeconds"
CONCURRENT = "concurrentJobs"
EXAMPLE = EXAMPLES_ROOT / "examples/demo/01_simple_seq"


@pytest.fixture
def gate() -> FakePricingGate:
    return fake_pricing_gate()


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
    job.claimed_at = lease_until - timedelta(seconds=metering.LEASE_S + ran_for_s)
    await session.commit()


def at(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


# -- Claiming ---------------------------------------------------------------


async def test_claiming_a_queued_job_takes_a_lease(db_session, owner):
    job = await a_job(db_session, owner)
    before = utcnow()

    token = await metering.claim_job(db_session, job.id)
    await db_session.refresh(job)

    assert token is not None
    assert job.state is JobState.RUNNING
    assert job.lease_token == token
    assert job.attempt == 1
    assert at(job.claimed_at) >= before
    assert (at(job.lease_until) - at(job.claimed_at)).total_seconds() == metering.LEASE_S
    assert metering.held_token(db_session, job.id) == token


async def test_a_job_is_claimed_by_one_worker_only(db_session, owner):
    job = await a_job(db_session, owner)

    first = await metering.claim_job(db_session, job.id)
    second = await metering.claim_job(db_session, job.id)
    await db_session.refresh(job)

    assert first is not None and second is None
    assert job.lease_token == first
    assert job.attempt == 1


async def test_only_the_holder_of_the_token_holds_the_lease(db_session, owner):
    job = await a_job(db_session, owner)
    token = await metering.claim_job(db_session, job.id)

    assert await metering.hold_lease(db_session, job.id, token) is True
    assert await metering.hold_lease(db_session, job.id, str(uuid.uuid4())) is False
    assert await metering.hold_lease(db_session, job.id, None) is False


# -- Heartbeat --------------------------------------------------------------


async def test_a_heartbeat_renews_the_lease_only_for_its_holder(db_session, owner):
    job = await a_job(db_session, owner)
    token = await metering.claim_job(db_session, job.id)
    job.lease_until = utcnow() + timedelta(seconds=1)
    await db_session.commit()
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)

    assert await metering.renew_lease(factory, job.id, str(uuid.uuid4())) is False
    await db_session.refresh(job)
    assert at(job.lease_until) < utcnow() + timedelta(seconds=5)

    assert await metering.renew_lease(factory, job.id, token) is True
    await db_session.refresh(job)
    assert at(job.lease_until) > utcnow() + timedelta(seconds=metering.LEASE_S - 5)


async def test_the_heartbeat_keeps_beating_until_it_is_stopped(db_session, owner):
    job = await a_job(db_session, owner)
    token = await metering.claim_job(db_session, job.id)
    job.lease_until = utcnow() + timedelta(seconds=1)
    await db_session.commit()

    beat = metering.start_heartbeat(db_session, job.id, token, interval_s=0.01)
    await asyncio.sleep(0.2)
    await metering.stop_heartbeat(beat)

    assert beat.done()
    await db_session.refresh(job)
    assert at(job.lease_until) > utcnow() + timedelta(seconds=metering.LEASE_S - 5)


# -- A worker that lost its lease writes nothing ----------------------------


async def test_a_failure_without_the_lease_is_not_recorded(gate, db_session, owner):
    await metering.reserve(gate, owner.id)
    space_client.set_gate(gate)
    job = await a_job(db_session, owner)
    await metering.claim_job(db_session, job.id)
    await db_session.commit()
    # Another worker's claim, as far as this session is concerned.
    db_session.info.pop(metering.lease_key(job.id))

    await routes._fail_persisted_job(job, db_session, "boom", time.monotonic())

    await db_session.refresh(job)
    assert job.state is JobState.RUNNING
    assert job.result is None
    assert job.metered is False
    assert (await gate.usage(owner.id)).limits[CONCURRENT].used == 1


async def test_a_failure_with_the_lease_is_recorded_and_settled(gate, db_session, owner):
    await metering.reserve(gate, owner.id)
    space_client.set_gate(gate)
    job = await a_job(db_session, owner)
    await metering.claim_job(db_session, job.id)
    await db_session.commit()

    await routes._fail_persisted_job(job, db_session, "boom", time.monotonic())

    await db_session.refresh(job)
    assert job.state is JobState.FAILED
    assert job.result["error"] == "boom"
    assert job.lease_token is None and job.lease_until is None
    assert job.metered is True
    assert (await gate.usage(owner.id)).limits[CONCURRENT].used == 0


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


async def test_a_job_that_finishes_is_completed_settled_and_unleased(
    api_client, db_session, registration, monkeypatch
):
    async def solve(*_args, **_kwargs):
        return _answer()

    monkeypatch.setattr(routes, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    await db_session.refresh(job)
    assert job.state is JobState.COMPLETED
    assert job.attempt == 1
    assert job.claimed_at is not None
    assert job.lease_token is None and job.lease_until is None
    assert job.metered is True


async def test_a_cancellation_that_arrives_during_the_solve_wins_over_its_late_result(
    api_client, db_session, registration, monkeypatch
):
    async def solve(*_args, **_kwargs):
        job = (await db_session.execute(select(Job))).scalars().one()
        job.cancellation_requested = True
        await db_session.flush()
        return _answer()

    monkeypatch.setattr(routes, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    await db_session.refresh(job)
    assert job.state is JobState.CANCELLED
    assert job.result is None
    assert job.lease_token is None
    assert job.metered is True


async def test_a_result_that_arrives_after_the_job_was_taken_back_is_discarded(
    api_client, db_session, registration, monkeypatch
):
    async def solve(*_args, **_kwargs):
        # While the engine works, the worker's lease lapses and the reconciler
        # puts the job back in the queue.
        job = (await db_session.execute(select(Job))).scalars().one()
        job.lease_until = utcnow() - timedelta(seconds=1)
        await db_session.commit()
        assert await metering.sweep_abandoned(space_client.get_gate(), db_session) == 0
        await db_session.commit()
        return _answer()

    monkeypatch.setattr(routes, "solve_remote", solve)
    headers, snapshot_id = await _account_with_snapshot(api_client, registration)

    await _submit(api_client, headers, snapshot_id)

    job = (await db_session.execute(select(Job))).scalars().one()
    await db_session.refresh(job)
    assert job.state is JobState.QUEUED
    assert job.result is None
    assert job.metered is False
    assert job.attempt == 1


# -- The reconciler ---------------------------------------------------------


async def test_a_job_with_a_live_lease_is_left_alone(gate, db_session, owner):
    job = await a_job(db_session, owner, budget_s=1.0, age_s=10_000)
    await metering.claim_job(db_session, job.id)

    assert await metering.sweep_abandoned(gate, db_session) == 0
    await db_session.refresh(job)
    assert job.state is JobState.RUNNING


async def test_a_lost_worker_gets_the_job_requeued_once_and_then_it_fails(gate, db_session, owner):
    await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner, budget_s=600.0)

    await metering.claim_job(db_session, job.id)
    await lose_the_worker(db_session, job, ran_for_s=30)
    assert await metering.sweep_abandoned(gate, db_session) == 0

    await db_session.refresh(job)
    usage = await gate.usage(owner.id)
    assert job.state is JobState.QUEUED and job.lease_token is None
    assert job.attempt == 1 and job.metered is False
    assert usage.limits[SOLVER_TIME].used == 0
    assert usage.limits[CONCURRENT].used == 1

    assert await metering.claim_job(db_session, job.id) is not None
    await lose_the_worker(db_session, job, ran_for_s=45)
    assert await metering.sweep_abandoned(gate, db_session) == 1

    await db_session.refresh(job)
    usage = await gate.usage(owner.id)
    assert job.state is JobState.FAILED and job.attempt == 2
    assert job.metered is True and job.lease_token is None
    assert usage.limits[SOLVER_TIME].used == pytest.approx(45.0, abs=0.01)
    assert usage.limits[CONCURRENT].used == 0


async def test_the_charge_for_a_lost_job_never_exceeds_the_observed_time(gate, db_session, owner):
    await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner, budget_s=600.0)
    await metering.claim_job(db_session, job.id)
    await lose_the_worker(db_session, job, ran_for_s=5)
    job.attempt = metering.MAX_ATTEMPTS
    await db_session.commit()

    await metering.sweep_abandoned(gate, db_session)

    charged = (await gate.usage(owner.id)).limits[SOLVER_TIME].used
    assert 0 < charged <= 5.01


async def test_the_charge_for_a_lost_job_never_exceeds_its_budget(gate, db_session, owner):
    await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner, budget_s=60.0)
    await metering.claim_job(db_session, job.id)
    await lose_the_worker(db_session, job, ran_for_s=10_000)
    job.attempt = metering.MAX_ATTEMPTS
    await db_session.commit()

    await metering.sweep_abandoned(gate, db_session)

    assert (await gate.usage(owner.id)).limits[SOLVER_TIME].used == 60.0


async def test_a_running_job_nobody_saw_start_is_charged_its_whole_budget(gate, db_session, owner):
    await metering.reserve(gate, owner.id)
    await a_job(
        db_session, owner, budget_s=60.0, age_s=60 + metering.SETTLEMENT_GRACE_S + 1, state=JobState.RUNNING
    )

    assert await metering.sweep_abandoned(gate, db_session) == 1
    assert (await gate.usage(owner.id)).limits[SOLVER_TIME].used == 60.0


async def test_the_deadline_of_a_claimed_job_counts_from_its_claim(gate, db_session, owner):
    job = await a_job(db_session, owner, budget_s=60.0, age_s=10_000, claimed_at=utcnow() - timedelta(seconds=10))

    assert await metering.sweep_abandoned(gate, db_session) == 0
    await db_session.refresh(job)
    assert job.state is JobState.QUEUED


async def test_a_finished_job_whose_settlement_failed_is_settled_once_when_the_gate_returns(
    gate, db_session, owner
):
    await metering.reserve(gate, owner.id)
    finished = utcnow()
    job = await a_job(
        db_session,
        owner,
        budget_s=600.0,
        state=JobState.COMPLETED,
        claimed_at=finished - timedelta(seconds=20),
        finished_at=finished,
    )

    gate.unavailable = True
    # A refusal from SPACE does not abort the sweep.
    assert await metering.sweep_abandoned(gate, db_session) == 0
    await db_session.refresh(job)
    assert job.metered is False

    gate.unavailable = False
    assert await metering.sweep_abandoned(gate, db_session) == 1
    assert await metering.sweep_abandoned(gate, db_session) == 0

    await db_session.refresh(job)
    usage = await gate.usage(owner.id)
    assert job.metered is True and job.state is JobState.COMPLETED
    assert usage.limits[SOLVER_TIME].used == pytest.approx(20.0, abs=0.01)
    assert usage.limits[CONCURRENT].used == 0


async def test_a_space_outage_leaves_a_lost_job_to_be_failed_by_the_next_sweep(gate, db_session, owner):
    await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner, budget_s=600.0)
    await metering.claim_job(db_session, job.id)
    await lose_the_worker(db_session, job, ran_for_s=15)
    job.attempt = metering.MAX_ATTEMPTS
    await db_session.commit()

    gate.unavailable = True
    assert await metering.sweep_abandoned(gate, db_session) == 0
    await db_session.refresh(job)
    assert job.state is JobState.RUNNING and job.metered is False

    gate.unavailable = False
    assert await metering.sweep_abandoned(gate, db_session) == 1
    await db_session.refresh(job)
    assert job.state is JobState.FAILED and job.metered is True
    assert (await gate.usage(owner.id)).limits[SOLVER_TIME].used == pytest.approx(15.0, abs=0.01)


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

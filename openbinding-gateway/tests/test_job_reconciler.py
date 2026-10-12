"""The reconciler fails what nobody is running anymore, and charges nothing for it.

An asynchronous solve can end without an audience: the client never polls, the
gateway restarts, the engine dies. The sweep puts the job of a lost worker back
once, fails a job nobody claimed or that outlived its budget, and lets the
study cell of every job it ends catch up. None of it talks to a pricing
service: the tests turn the fake one off to prove it.

That two sweeps in two transactions skip each other's rows needs PostgreSQL and
lives in ``tests/concurrency/test_job_leases_pg.py``.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker

from _pricing import pricing_catalog
from openbinding_gateway import analysis_jobs, job_dispatch, space_client, sponsor_proposals, study_jobs, telemetry
from openbinding_gateway.access import contracts
from openbinding_gateway.db import base as db_base
from openbinding_gateway.db.models import (
    Job,
    JobState,
    RunState,
    StudyCell,
    StudyRun,
    User,
    UserRole,
    utcnow,
)
from openbinding_gateway.jobs import reconciler

OVERDUE_S = 60.0 + reconciler.ABANDONED_GRACE_S + 1


@pytest.fixture
def logs(caplog, monkeypatch) -> pytest.LogCaptureFixture:
    """Capture the reconciler logger even after a test that configured logging in-process.

    Running alembic in-process applies ``fileConfig``, which disables every
    logger that existed at the time and silently drops what they emit.
    """
    monkeypatch.setattr(reconciler.logger, "disabled", False)
    caplog.set_level(logging.WARNING, logger=reconciler.logger.name)
    return caplog


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


async def a_job(session, owner, *, state=JobState.RUNNING, age_s=OVERDUE_S, budget_s=60.0, **extra) -> Job:
    job = Job(
        owner_id=owner.id if owner else None,
        engine_id="random-search",
        engine_job_id="engine-1",
        service_url="http://engine",
        state=state,
        requested_budget_s=budget_s,
        created_at=utcnow() - timedelta(seconds=age_s),
        **extra,
    )
    session.add(job)
    await session.commit()
    return job


# -- Sweeping abandoned jobs ------------------------------------------------


async def test_a_job_still_within_its_budget_is_left_alone(db_session, owner):
    await a_job(db_session, owner, state=JobState.QUEUED, budget_s=300.0, age_s=10.0)

    assert await reconciler.sweep_abandoned(db_session) == 0


async def test_a_job_within_the_grace_period_is_left_alone(db_session, owner):
    # The engine may answer slightly late and the client poll later still.
    await a_job(db_session, owner, state=JobState.QUEUED, budget_s=60.0, age_s=61.0)

    assert await reconciler.sweep_abandoned(db_session) == 0


async def test_a_job_past_its_budget_and_grace_is_failed(db_session, owner):
    job = await a_job(db_session, owner, state=JobState.RUNNING)

    assert await reconciler.sweep_abandoned(db_session) == 1

    await db_session.refresh(job)
    assert job.state is JobState.FAILED
    assert job.finished_at is not None
    assert job.lease_token is None and job.lease_until is None


async def test_a_queued_job_nobody_claimed_is_failed(db_session, owner):
    job = await a_job(db_session, owner, state=JobState.QUEUED)
    assert job.claimed_at is None

    assert await reconciler.sweep_abandoned(db_session) == 1

    await db_session.refresh(job)
    assert job.state is JobState.FAILED


async def test_a_failed_job_frees_its_owner_to_create_another(db_session, owner):
    from openbinding_gateway.jobs import limits

    for _ in range(2):
        await a_job(db_session, owner, state=JobState.QUEUED)
    assert await limits.count_in_flight(db_session, owner.id) == 2

    await reconciler.sweep_abandoned(db_session)

    assert await limits.count_in_flight(db_session, owner.id) == 0


async def test_a_finished_job_is_not_swept(db_session, owner):
    job = await a_job(db_session, owner, state=JobState.COMPLETED)

    assert await reconciler.sweep_abandoned(db_session) == 0

    await db_session.refresh(job)
    assert job.state is JobState.COMPLETED


async def test_a_sweep_fails_every_stale_job_it_finds(db_session, owner):
    for _ in range(3):
        await a_job(db_session, owner, state=JobState.QUEUED)

    assert await reconciler.sweep_abandoned(db_session) == 3
    assert await reconciler.sweep_abandoned(db_session) == 0


async def test_a_job_without_an_owner_is_swept_like_any_other(db_session):
    job = await a_job(db_session, None, state=JobState.QUEUED)

    assert await reconciler.sweep_abandoned(db_session) == 1

    await db_session.refresh(job)
    assert job.state is JobState.FAILED


async def test_the_sweep_needs_no_pricing_service(db_session, owner):
    space_client.get_gate().unavailable = True
    job = await a_job(db_session, owner, state=JobState.QUEUED)

    assert await reconciler.sweep_abandoned(db_session) == 1

    await db_session.refresh(job)
    assert job.state is JobState.FAILED


async def test_the_sweep_leaves_the_commit_to_its_caller(db_session, owner, monkeypatch):
    for _ in range(3):
        await a_job(db_session, owner, state=JobState.QUEUED)
    commits: list[str] = []
    real_commit = db_session.commit

    async def counting_commit():
        commits.append("commit")
        await real_commit()

    monkeypatch.setattr(db_session, "commit", counting_commit)

    assert await reconciler.sweep_abandoned(db_session) == 3

    assert commits == []


async def test_a_job_whose_lease_was_renewed_since_it_was_read_is_not_failed(db_session, owner):
    # A heartbeat landing between the read and the write: the conditioned
    # UPDATE matches nothing, so the job is neither failed nor counted.
    job = await a_job(
        db_session, owner, state=JobState.RUNNING, lease_token="token",
        lease_until=utcnow() - timedelta(seconds=5),
    )
    stale_read = await db_session.get(Job, job.id, populate_existing=True)
    await db_session.execute(
        Job.__table__.update().where(Job.id == job.id).values(lease_until=utcnow() + timedelta(seconds=60))
    )

    assert await reconciler._fail_abandoned(db_session, stale_read, utcnow()) is False

    await db_session.refresh(job)
    assert job.state is JobState.RUNNING


# -- Study cells of jobs the reconciler ends --------------------------------


@pytest.fixture
def sqlite_only(db_session):
    # The cell's foreign keys point at rows this test does not build.
    if db_session.bind.dialect.name != "sqlite":
        pytest.skip("builds study cells without their parent rows")


async def a_cell(session, owner, job_id, state=RunState.RUNNING) -> uuid.UUID:
    run = StudyRun(
        study_id=uuid.uuid4(),
        definition_version_id=uuid.uuid4(),
        run_number=1,
        state=RunState.RUNNING,
        matrix_digest="sha256-" + "0" * 64,
        created_by_id=owner.id,
    )
    session.add(run)
    await session.flush()
    cell = StudyCell(
        study_run_id=run.id,
        ordinal=0,
        binding_case_revision_id=uuid.uuid4(),
        engine_ref={"namespace": "bim.builtin", "name": "random-search", "version": "1.0.0"},
        parameters={},
        seed=0,
        fingerprint="sha256-" + "6" * 64,
        job_id=job_id,
        state=state,
    )
    session.add(cell)
    await session.commit()
    return cell.id


async def cell_state(session, cell_id) -> RunState:
    return (await session.get(StudyCell, cell_id, populate_existing=True)).state


async def test_a_job_failed_by_the_sweep_fails_its_study_cell(sqlite_only, db_session, owner):
    job = await a_job(db_session, owner)
    cell_id = await a_cell(db_session, owner, job.id)

    assert await reconciler.sweep_abandoned(db_session) == 1

    assert await cell_state(db_session, cell_id) is RunState.FAILED


async def test_a_job_that_ended_without_its_cell_hearing_of_it_is_resynced(
    sqlite_only, db_session, owner
):
    finished = utcnow()
    job = await a_job(db_session, owner, state=JobState.COMPLETED, claimed_at=finished, finished_at=finished)
    live = await a_job(db_session, owner, state=JobState.RUNNING)
    ended_id, live_id = job.id, live.id
    ended_cell = await a_cell(db_session, owner, ended_id)
    live_cell = await a_cell(db_session, owner, live_id)
    db_session.expire_all()

    assert await reconciler._resync_study_cells(db_session) == 1

    assert await cell_state(db_session, ended_cell) is RunState.COMPLETED
    assert await cell_state(db_session, live_cell) is RunState.RUNNING  # its job is still running


async def test_one_cell_that_cannot_be_synced_does_not_stop_the_others(
    sqlite_only, db_session, owner, monkeypatch, logs
):
    finished = utcnow()
    cells = {}
    for _ in range(2):
        job = await a_job(db_session, owner, state=JobState.FAILED, claimed_at=finished, finished_at=finished)
        cells[job.id] = await a_cell(db_session, owner, job.id)
    broken = min(cells, key=str)
    db_session.expire_all()
    real_sync = study_jobs.sync_study_job

    async def sync(job_id, session=None):
        if job_id == str(broken):
            raise RuntimeError("cannot sync this one")
        await real_sync(job_id, session)

    monkeypatch.setattr(study_jobs, "sync_study_job", sync)

    assert await reconciler._resync_study_cells(db_session) == 1

    assert await cell_state(db_session, cells[broken]) is RunState.RUNNING
    healthy = next(cell for job, cell in cells.items() if job != broken)
    assert await cell_state(db_session, healthy) is RunState.FAILED
    assert str(broken) in logs.text


# -- The loop ---------------------------------------------------------------


@pytest.fixture
def one_pass(db_session, monkeypatch):
    """One pass of the reconciler over the test database, with everything else stubbed."""
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    passes = SimpleNamespace(redelivered=0, sleeps=0)

    async def sleep(_interval):
        passes.sleeps += 1
        if passes.sleeps > 1:
            raise asyncio.CancelledError

    async def zero(*_args, **_kwargs):
        return 0

    async def redeliver(*_args, **_kwargs):
        passes.redelivered += 1
        return 0

    monkeypatch.setattr(reconciler, "_last_purge", 0.0)
    monkeypatch.setattr(reconciler, "time", SimpleNamespace(monotonic=lambda: 1.0))
    monkeypatch.setattr(
        reconciler, "asyncio", SimpleNamespace(sleep=sleep, CancelledError=asyncio.CancelledError)
    )
    monkeypatch.setattr(db_base, "is_configured", lambda: True)
    monkeypatch.setattr(db_base, "session_factory", lambda: factory)
    monkeypatch.setattr(contracts, "archive_drained_pricings", zero)
    monkeypatch.setattr(contracts, "sweep_contract_renewals", zero)
    monkeypatch.setattr(job_dispatch, "redeliver_queued_jobs", redeliver)
    monkeypatch.setattr(sponsor_proposals, "sweep_expired", zero)
    monkeypatch.setattr(analysis_jobs, "redeliver_analysis", zero)
    monkeypatch.setattr(telemetry, "purge_old_error_events", zero)
    return passes


async def test_the_reconciler_fails_abandoned_jobs_and_redelivers_after_its_sweep(
    one_pass, db_session, owner
):
    job = await a_job(db_session, owner, state=JobState.QUEUED)

    with pytest.raises(asyncio.CancelledError):
        await reconciler.run_reconciler(interval_s=0)

    await db_session.refresh(job)
    assert job.state is JobState.FAILED
    assert one_pass.redelivered == 1


async def test_the_reconciler_resyncs_study_cells_after_its_sweep(
    sqlite_only, one_pass, db_session, owner
):
    finished = utcnow()
    job = await a_job(db_session, owner, state=JobState.COMPLETED, claimed_at=finished, finished_at=finished)
    cell_id = await a_cell(db_session, owner, job.id)
    db_session.expire_all()

    with pytest.raises(asyncio.CancelledError):
        await reconciler.run_reconciler(interval_s=0)

    assert await cell_state(db_session, cell_id) is RunState.COMPLETED


async def test_a_resync_that_fails_does_not_stop_the_rest_of_the_reconciler(one_pass, monkeypatch):
    async def broken(_session):
        raise RuntimeError("resync failed")

    monkeypatch.setattr(reconciler, "_resync_study_cells", broken)

    with pytest.raises(asyncio.CancelledError):
        await reconciler.run_reconciler(interval_s=0)

    assert one_pass.redelivered == 1

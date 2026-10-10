"""A charge SPACE accepted is never taken twice, whatever happens to the database.

``settle`` tells SPACE before the job row is confirmed, and the commit comes
later. If that commit (or the flush before it) fails after SPACE said yes, the
row goes back to unsettled while SPACE keeps the charge, and the next sweep
would charge and release the slot a second time. These tests inject the
failures - a gate that counts every call, a commit or flush that fails once -
and assert that SPACE hears about each job exactly once.

Only the ordering and the bookkeeping are checked here. That two sweeps in two
transactions skip each other's rows needs PostgreSQL and lives in
``tests/concurrency/test_job_leases_pg.py``.
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
from openbinding_gateway import analysis_jobs, job_dispatch, sponsor_proposals, study_jobs, telemetry
from openbinding_gateway.access import contracts, metering
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
from openbinding_gateway.services import execution
from openbinding_gateway.space_client import FakePricingGate, PricingUnavailable

CONCURRENT = "concurrentJobs"
SOLVER_TIME = "solverSeconds"
OVERDUE_S = 60.0 + metering.SETTLEMENT_GRACE_S + 1


class CountingGate(FakePricingGate):
    """A pricing gate that remembers every usage update it was asked to apply."""

    def __init__(self) -> None:
        super().__init__(pricing_catalog())
        self.adjustments: list[dict] = []

    async def adjust_usage(self, user_id, increments) -> None:
        await super().adjust_usage(user_id, increments)
        self.adjustments.append(dict(increments))

    @property
    def releases(self) -> list[dict]:
        return [entry for entry in self.adjustments if entry.get(CONCURRENT) == -1]

    @property
    def solver_charges(self) -> list[dict]:
        return [entry for entry in self.adjustments if SOLVER_TIME in entry]


@pytest.fixture
def gate() -> CountingGate:
    return CountingGate()


@pytest.fixture
def logs(caplog, monkeypatch) -> pytest.LogCaptureFixture:
    """Capture the metering logger even after a test that configured logging in-process.

    Running alembic in-process applies ``fileConfig``, which disables every
    logger that existed at the time and silently drops what they emit.
    """
    monkeypatch.setattr(metering.logger, "disabled", False)
    caplog.set_level(logging.WARNING, logger=metering.logger.name)
    return caplog


@pytest.fixture(autouse=True)
def nothing_remembered():
    metering._unrecorded.clear()
    yield
    metering._unrecorded.clear()


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


async def real_transaction(session) -> None:
    """Open a transaction the way a server does, so that a savepoint is not the outermost one.

    SQLite's driver does not issue BEGIN before SAVEPOINT, and RELEASE of the
    outermost savepoint then commits for real, which no failed commit could undo.
    """
    if session.bind.dialect.name == "sqlite":
        connection = await session.connection()
        await connection.exec_driver_sql("BEGIN")


def fail_once(session, name: str, monkeypatch) -> list:
    """Make the next ``name`` call fail, then behave normally; returns the calls seen."""
    real = getattr(session, name)
    calls: list = []

    async def wrapper(*args, **kwargs):
        calls.append(name)
        if len(calls) == 1:
            raise RuntimeError(f"{name} failed")
        return await real(*args, **kwargs)

    monkeypatch.setattr(session, name, wrapper)
    return calls


# -- A commit that fails after SPACE accepted the charge ----------------------


async def test_a_commit_that_fails_after_a_charge_does_not_charge_the_next_sweep_again(
    gate, db_session, owner, monkeypatch, logs
):
    await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner)
    job_id = job.id
    fail_once(db_session, "commit", monkeypatch)

    await real_transaction(db_session)
    first = await metering.sweep_abandoned(gate, db_session)

    assert first == 0
    assert len(gate.releases) == 1 and len(gate.solver_charges) == 1
    expected = {SOLVER_TIME: 60.0, CONCURRENT: -1}
    logged = [record for record in logs.records if getattr(record, "job_id", None) == str(job_id)]
    assert len(logged) == 1 and logged[0].levelno == logging.ERROR
    assert logged[0].delta == expected
    assert metering._unrecorded == {job_id: expected}
    await db_session.refresh(job)
    assert job.metered is False  # the row did not survive; SPACE's charge did

    await real_transaction(db_session)
    second = await metering.sweep_abandoned(gate, db_session)

    assert second == 1
    assert len(gate.releases) == 1 and len(gate.solver_charges) == 1
    await db_session.refresh(job)
    assert job.state is JobState.FAILED and job.metered is True and job.concurrency_released is True
    assert metering._unrecorded == {}

    assert await metering.sweep_abandoned(gate, db_session) == 0
    assert len(gate.releases) == 1


async def test_a_sweep_commits_each_settlement_on_its_own(gate, db_session, owner, monkeypatch):
    for _ in range(3):
        await a_job(db_session, owner, state=JobState.QUEUED)
    commits: list[str] = []
    real_commit = db_session.commit

    async def counting_commit():
        commits.append("commit")
        await real_commit()

    monkeypatch.setattr(db_session, "commit", counting_commit)

    assert await metering.sweep_abandoned(gate, db_session) == 3

    assert len(commits) == 3
    assert len(gate.releases) == 3


async def test_a_failed_commit_stops_the_sweep_before_it_charges_more(gate, db_session, owner, monkeypatch):
    finished = utcnow()
    owner_id = owner.id  # a rollback expires the fixture's user
    for _ in range(2):
        await metering.reserve(gate, owner_id)
        await a_job(
            db_session,
            owner,
            state=JobState.COMPLETED,
            claimed_at=finished - timedelta(seconds=20),
            finished_at=finished,
        )
    fail_once(db_session, "commit", monkeypatch)

    await real_transaction(db_session)
    assert await metering.sweep_abandoned(gate, db_session) == 0
    assert len(gate.releases) == 1  # the second job waits for the next sweep

    await real_transaction(db_session)
    assert await metering.sweep_abandoned(gate, db_session) == 2
    assert len(gate.releases) == 2
    assert len(gate.solver_charges) == 2
    assert (await gate.usage(owner_id)).limits[CONCURRENT].used == 0


async def test_a_flush_that_fails_after_a_charge_is_remembered(gate, db_session, owner, monkeypatch):
    await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner)
    job_id = job.id
    fail_once(db_session, "flush", monkeypatch)

    with pytest.raises(metering.SettlementCommitFailed) as raised:
        await metering.settle(gate, db_session, job_id, solver_seconds=12.0)
    await db_session.rollback()

    assert raised.value.job_ids == [job_id]
    assert metering._unrecorded == {job_id: {SOLVER_TIME: 12.0, CONCURRENT: -1}}

    # Settling again - however long the job is now said to have run - records
    # the charge SPACE already has instead of making another.
    assert await metering.settle(gate, db_session, job_id, solver_seconds=99.0) is True
    await metering.commit_settlement(db_session)

    await db_session.refresh(job)
    assert job.metered is True and job.concurrency_released is True
    assert gate.adjustments[1:] == [{SOLVER_TIME: 12.0, CONCURRENT: -1}]
    assert metering._unrecorded == {}


async def test_a_refusal_from_space_remembers_nothing(gate, db_session, owner):
    job = await a_job(db_session, owner)
    gate.unavailable = True

    with pytest.raises(PricingUnavailable):
        await metering.settle(gate, db_session, job.id, solver_seconds=1.0)

    assert metering._unrecorded == {}
    assert gate.adjustments == []


async def test_a_charge_remembered_for_a_job_somebody_else_settled_is_dropped(gate, db_session, owner):
    job = await a_job(db_session, owner, metered=True)
    metering._unrecorded[job.id] = {CONCURRENT: -1}

    assert await metering.settle(gate, db_session, job.id, solver_seconds=1.0) is False

    assert metering._unrecorded == {}
    assert gate.adjustments == []


async def test_a_charge_that_was_committed_is_not_kept_in_the_session(gate, db_session, owner):
    await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner)

    await metering.settle(gate, db_session, job.id, solver_seconds=3.0)
    assert any(str(key).startswith("job-charge:") for key in db_session.info)
    await metering.commit_settlement(db_session)

    assert not any(str(key).startswith("job-charge:") for key in db_session.info)
    assert metering._unrecorded == {}


# -- The worker whose commit failed ---------------------------------------


async def test_a_failed_job_records_the_charge_its_worker_could_not_commit(
    gate, db_session, owner, monkeypatch
):
    await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner, state=JobState.QUEUED)
    job_id = job.id
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    monkeypatch.setattr(db_base, "is_configured", lambda: True)
    monkeypatch.setattr(db_base, "session_factory", lambda: factory)

    async def worker(job_id_text, session):
        parsed = uuid.UUID(job_id_text)
        assert await metering.claim_job(session, parsed) is not None
        await session.commit()
        assert await metering.settle(gate, session, parsed, solver_seconds=5.0) is True

        async def broken():
            raise RuntimeError("commit failed")

        session.commit = broken
        await metering.commit_settlement(session)

    monkeypatch.setattr(execution, "finish_persisted_job", worker)

    with pytest.raises(metering.SettlementCommitFailed):
        await execution.run_persisted_job(str(job_id))

    await db_session.refresh(job)
    assert job.state is JobState.FAILED
    assert job.result["error"].startswith("Internal execution error")
    assert job.metered is True and job.concurrency_released is True
    assert metering._unrecorded == {}

    # The reconciler has nothing left to charge for this job.
    assert await metering.sweep_abandoned(gate, db_session) == 0
    assert len(gate.releases) == 1 and len(gate.solver_charges) == 1


async def test_a_failed_job_without_a_remembered_charge_is_left_to_the_sweep(gate, db_session, owner):
    job = await a_job(db_session, owner)

    assert await metering.record_unrecorded(db_session, job.id) is False

    await db_session.refresh(job)
    assert job.metered is False


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


async def test_a_job_failed_by_the_sweep_fails_its_study_cell(
    sqlite_only, gate, db_session, owner
):
    await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner)
    cell_id = await a_cell(db_session, owner, job.id)

    assert await metering.sweep_abandoned(gate, db_session) == 1

    assert await cell_state(db_session, cell_id) is RunState.FAILED


async def test_a_job_that_ended_without_its_cell_hearing_of_it_is_resynced(
    sqlite_only, db_session, owner
):
    finished = utcnow()
    job = await a_job(
        db_session, owner, state=JobState.COMPLETED, metered=True, claimed_at=finished, finished_at=finished
    )
    live = await a_job(db_session, owner, state=JobState.RUNNING)
    ended_id, live_id = job.id, live.id
    ended_cell = await a_cell(db_session, owner, ended_id)
    live_cell = await a_cell(db_session, owner, live_id)
    db_session.expire_all()

    assert await metering._resync_study_cells(db_session) == 1

    assert await cell_state(db_session, ended_cell) is RunState.COMPLETED
    assert await cell_state(db_session, live_cell) is RunState.RUNNING  # its job is still running


async def test_one_cell_that_cannot_be_synced_does_not_stop_the_others(
    sqlite_only, db_session, owner, monkeypatch, logs
):
    finished = utcnow()
    cells = {}
    for _ in range(2):
        job = await a_job(
            db_session, owner, state=JobState.FAILED, metered=True, claimed_at=finished, finished_at=finished
        )
        cells[job.id] = await a_cell(db_session, owner, job.id)
    broken = min(cells, key=str)
    db_session.expire_all()
    real_sync = study_jobs.sync_study_job

    async def sync(job_id, session=None):
        if job_id == str(broken):
            raise RuntimeError("cannot sync this one")
        await real_sync(job_id, session)

    monkeypatch.setattr(study_jobs, "sync_study_job", sync)

    assert await metering._resync_study_cells(db_session) == 1

    assert await cell_state(db_session, cells[broken]) is RunState.RUNNING
    healthy = next(cell for job, cell in cells.items() if job != broken)
    assert await cell_state(db_session, healthy) is RunState.FAILED
    assert str(broken) in logs.text


@pytest.fixture
def reconciler(db_session, monkeypatch):
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

    monkeypatch.setattr(metering, "_last_purge", 0.0)
    monkeypatch.setattr(metering, "time", SimpleNamespace(monotonic=lambda: 1.0))
    monkeypatch.setattr(
        metering, "asyncio", SimpleNamespace(sleep=sleep, CancelledError=asyncio.CancelledError)
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


async def test_the_reconciler_resyncs_study_cells_after_its_sweep(
    sqlite_only, reconciler, gate, db_session, owner
):
    finished = utcnow()
    job = await a_job(
        db_session, owner, state=JobState.COMPLETED, metered=True, claimed_at=finished, finished_at=finished
    )
    cell_id = await a_cell(db_session, owner, job.id)
    db_session.expire_all()

    with pytest.raises(asyncio.CancelledError):
        await metering.run_reconciler(gate, interval_s=0)

    assert await cell_state(db_session, cell_id) is RunState.COMPLETED


async def test_a_resync_that_fails_does_not_stop_the_rest_of_the_reconciler(
    reconciler, gate, monkeypatch
):
    async def broken(_session):
        raise RuntimeError("resync failed")

    monkeypatch.setattr(metering, "_resync_study_cells", broken)

    with pytest.raises(asyncio.CancelledError):
        await metering.run_reconciler(gate, interval_s=0)

    assert reconciler.redelivered == 1

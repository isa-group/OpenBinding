"""Cancelling, retrying and syncing the cells of one study run, from two sessions at once.

Needs PostgreSQL (``TEST_DATABASE_URL``): the ``two_sessions`` fixture skips
anywhere else, because SQLite ignores row locks. Each test makes one session
hold the run lock (``study_jobs.lock_run``) while the other one arrives, which is
the window the unlocked code left open.
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from openbinding_gateway import study_jobs
from openbinding_gateway.db.models import (
    AuditEvent,
    Job,
    JobState,
    Organization,
    Project,
    RunState,
    Study,
    StudyCell,
    StudyRun,
    User,
)
from openbinding_gateway.routes import jobs as job_routes
from openbinding_gateway.routes import studies as study_routes

from .test_study_cells_pg import _seed

LIVE = (JobState.QUEUED, JobState.RUNNING)


async def _world(session, **kwargs) -> SimpleNamespace:
    """``_seed``'s run (cell 0 finished, cell 1 waiting) with the ids the tests need."""
    finished_id, waiting_id = await _seed(session, **kwargs)
    return SimpleNamespace(
        finished_id=finished_id,
        waiting_id=waiting_id,
        run_id=await session.scalar(select(StudyRun.id)),
        user_id=await session.scalar(select(User.id)),
        organization_id=await session.scalar(select(Organization.id)),
        project_id=await session.scalar(select(Project.id)),
        study_id=await session.scalar(select(Study.id)),
        first_cell_id=await session.scalar(select(StudyCell.id).where(StudyCell.ordinal == 0)),
    )


def _launcher(launched: list[uuid.UUID], entered: asyncio.Event | None = None, pause: float = 0.2):
    """A ``launch_study_cell`` that takes a while to create its job, as the real one does."""

    async def launch(session, cell, user, organization, project_id):
        launched.append(cell.id)
        if entered is not None:
            entered.set()
        await asyncio.sleep(pause)  # long enough for the other session to arrive
        job = Job(
            owner_id=user.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()),
            service_url="http://engine", state=JobState.QUEUED, study_cell_id=cell.id,
            organization_id=organization.id, project_id=project_id,
        )
        session.add(job)
        await session.flush()
        cell.job_id = job.id
        await session.flush()
        return job

    return launch


async def _states(session, world) -> SimpleNamespace:
    """What was committed, read with plain column queries so no stale object gets in the way."""
    return SimpleNamespace(
        run=await session.scalar(select(StudyRun.state).where(StudyRun.id == world.run_id)),
        cells=dict((await session.execute(select(StudyCell.ordinal, StudyCell.state))).all()),
        live_jobs=await session.scalar(
            select(func.count()).select_from(Job).where(Job.state.in_(LIVE))
        ),
    )


async def _jobs_of_cell(session, cell_id) -> int:
    return await session.scalar(select(func.count()).select_from(Job).where(Job.study_cell_id == cell_id))


@pytest.mark.asyncio
async def test_a_cancellation_that_waits_for_a_sync_cancels_the_cell_it_launched(two_sessions, monkeypatch):
    first, second = two_sessions
    world = await _world(first)
    launching = asyncio.Event()
    launched: list[uuid.UUID] = []
    order: list[str] = []
    monkeypatch.setattr(study_jobs, "launch_study_cell", _launcher(launched, launching))

    async def sync():
        await study_jobs._sync(first, world.finished_id)
        order.append("sync done")
        await first.commit()

    async def cancel():
        await launching.wait()  # the sync is inside the launch, holding the run
        await study_jobs.cancel_run(second, world.run_id)
        order.append("cancel locked")
        await second.commit()

    await asyncio.gather(sync(), cancel())

    assert order == ["sync done", "cancel locked"]
    assert launched == [world.waiting_id]
    state = await _states(first, world)
    assert state.run is RunState.CANCELLED
    assert state.cells == {0: RunState.COMPLETED, 1: RunState.CANCELLED}
    assert state.live_jobs == 0
    assert await first.scalar(select(Job.state).where(Job.study_cell_id == world.waiting_id)) is JobState.CANCELLED


@pytest.mark.asyncio
async def test_a_sync_that_waits_for_a_cancellation_launches_no_cell(two_sessions, monkeypatch):
    first, second = two_sessions
    world = await _world(first)
    cancelling = asyncio.Event()
    launched: list[uuid.UUID] = []
    monkeypatch.setattr(study_jobs, "launch_study_cell", _launcher(launched))

    async def cancel():
        await study_jobs.cancel_run(first, world.run_id)
        cancelling.set()  # the run is cancelled but not committed, and locked
        await asyncio.sleep(0.3)
        await first.commit()

    async def sync():
        await cancelling.wait()
        await study_jobs._sync(second, world.finished_id)
        await second.commit()

    await asyncio.gather(cancel(), sync())

    assert launched == []
    assert await _jobs_of_cell(first, world.waiting_id) == 0
    state = await _states(first, world)
    assert state.run is RunState.CANCELLED
    assert state.cells == {0: RunState.COMPLETED, 1: RunState.CANCELLED}
    assert state.live_jobs == 0


@pytest.mark.asyncio
async def test_two_retries_of_one_cell_create_one_job_and_the_second_gets_it(two_sessions, monkeypatch):
    first, second = two_sessions
    world = await _world(first)
    # Cell 0 failed: its job is the one a retry replaces.
    failed = await first.get(Job, world.finished_id)
    failed_id = failed.id
    failed.state = JobState.FAILED
    (await first.get(StudyCell, world.first_cell_id)).state = RunState.FAILED
    (await first.get(StudyRun, world.run_id)).state = RunState.PARTIAL
    await first.commit()
    launched: list[uuid.UUID] = []
    monkeypatch.setattr(study_routes, "launch_study_cell", _launcher(launched))

    async def context(session, *args, **kwargs):
        return SimpleNamespace(id=world.organization_id), SimpleNamespace(id=world.project_id)

    async def study(session, project_id, reference, user, **kwargs):
        return SimpleNamespace(id=world.study_id)

    async def run(session, study_id, run_id, user):
        return await session.get(StudyRun, run_id)

    monkeypatch.setattr(study_routes, "_context", context)
    monkeypatch.setattr(study_routes, "_study", study)
    monkeypatch.setattr(study_routes, "_run", run)

    async def retry(session):
        return await study_routes.retry_study_cell(
            org="o", project="p", study="s", run_id=world.run_id, cell_id=world.first_cell_id,
            user=SimpleNamespace(id=world.user_id), session=session,
        )

    answers = await asyncio.gather(retry(first), retry(second))

    assert sorted(answer["idempotent"] for answer in answers) == [False, True]
    assert answers[0]["jobId"] == answers[1]["jobId"]
    assert launched == [world.first_cell_id]
    assert await _jobs_of_cell(first, world.first_cell_id) == 1
    replacements = await first.scalar(select(func.count()).select_from(Job).where(Job.retry_of_id == failed_id))
    assert replacements == 1
    audited = await first.scalar(
        select(func.count()).select_from(AuditEvent).where(AuditEvent.action == "study.cell.retried")
    )
    assert audited == 1
    assert (await _states(first, world)).cells[0] is RunState.QUEUED


@pytest.mark.asyncio
async def test_two_syncs_of_the_last_two_jobs_leave_the_run_finished(two_sessions):
    """Each sync alone sees the other job as running; the second must wait and see it finished."""
    first, second = two_sessions
    world = await _world(first)
    running = Job(
        owner_id=world.user_id, engine_id="random-search", engine_job_id="engine-2", service_url="http://engine",
        state=JobState.RUNNING, organization_id=world.organization_id, project_id=world.project_id,
        study_cell_id=world.waiting_id,
    )
    first.add(running)
    await first.flush()
    last_cell = await first.get(StudyCell, world.waiting_id)
    last_cell.job_id, last_cell.state = running.id, RunState.RUNNING
    running_id = running.id
    await first.commit()
    synced = asyncio.Event()

    async def finish_first():
        await study_jobs._sync(first, world.finished_id)  # cell 1 is still running: the run runs
        synced.set()
        await asyncio.sleep(0.3)  # the other job ends meanwhile
        await first.commit()

    async def finish_last():
        await synced.wait()
        job = await second.get(Job, running_id)
        job.state = JobState.COMPLETED
        await second.flush()
        await study_jobs._sync(second, running_id)
        await second.commit()

    await asyncio.gather(finish_first(), finish_last())

    state = await _states(first, world)
    assert state.cells == {0: RunState.COMPLETED, 1: RunState.COMPLETED}
    assert state.run is RunState.COMPLETED
    assert await first.scalar(select(StudyRun.finished_at).where(StudyRun.id == world.run_id)) is not None


@pytest.mark.asyncio
async def test_cancelling_a_study_job_and_its_run_at_once_does_not_deadlock(two_sessions, monkeypatch):
    first, second = two_sessions
    world = await _world(first)
    queued = Job(
        owner_id=world.user_id, engine_id="random-search", engine_job_id="engine-2", service_url="http://engine",
        state=JobState.QUEUED, organization_id=world.organization_id, project_id=world.project_id,
        study_cell_id=world.waiting_id,
    )
    first.add(queued)
    await first.flush()
    (await first.get(StudyCell, world.waiting_id)).job_id = queued.id
    queued_id = queued.id
    await first.commit()
    holding = asyncio.Event()
    real_lock_cells = study_jobs.lock_cells

    async def slow_lock_cells(session, run_id):
        holding.set()  # the run lock is held; the jobs are not locked yet
        await asyncio.sleep(0.3)
        return await real_lock_cells(session, run_id)

    monkeypatch.setattr(study_jobs, "lock_cells", slow_lock_cells)

    async def cancel_run():
        await study_jobs.cancel_run(first, world.run_id)
        await first.commit()

    async def cancel_job():
        await holding.wait()
        owner = await second.get(User, world.user_id)
        try:
            return await job_routes.cancel_job(job_id=queued_id, user=owner, session=second)
        finally:
            await second.commit()

    outcome = await asyncio.gather(cancel_run(), cancel_job(), return_exceptions=True)

    # The job cancel queued behind the run lock and found the job already cancelled.
    assert outcome[0] is None
    assert isinstance(outcome[1], HTTPException) and outcome[1].status_code == 409, outcome
    state = await _states(first, world)
    assert state.run is RunState.CANCELLED
    assert state.live_jobs == 0
    assert await first.scalar(select(Job.state).where(Job.id == queued_id)) is JobState.CANCELLED

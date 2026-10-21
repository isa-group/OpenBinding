"""Cancelling, retrying and syncing the cells of one study run take the same locks in the same order.

SQLite ignores row locks, so these tests cannot show two writers waiting for each
other. They pin what can be seen anywhere: the statements that ask for
``FOR UPDATE`` go run, then cells, then jobs; a cancelled run launches nothing;
a second retry of a cell is answered with the first one's job. The two-session
versions against PostgreSQL are in ``tests/concurrency/test_study_cancel_pg.py``.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import event, func, select

from _b1_helpers import gate  # noqa: F401
from openbinding_gateway import study_jobs
from openbinding_gateway.db.models import AuditEvent, Job, JobState, RunState, StudyRun
from test_b1_cell_result import BASE, build_world


@pytest.fixture
async def world(api_client, db_session, registration, gate, monkeypatch):  # noqa: F811
    return await build_world(
        api_client, db_session, registration, gate, monkeypatch, parameter_sets=[{}], seeds=[1, 2]
    )


def record_locks(session) -> list[str]:
    """The entities of every ``SELECT ... FOR UPDATE`` the session issues from now on, in order."""

    taken: list[str] = []

    def listener(state) -> None:
        statement = state.statement
        if state.is_select and getattr(statement, "_for_update_arg", None) is not None:
            taken.append(statement.column_descriptions[0]["entity"].__name__)

    event.listen(session.sync_session, "do_orm_execute", listener)
    return taken


def first_locks(taken: list[str]) -> list[str]:
    """The run, cell and job locks in the order they were first taken (others, such as accounts, are ignored)."""
    return [name for name in dict.fromkeys(taken) if name in {"StudyRun", "StudyCell", "Job"}]


async def reopen(db_session, world, *, launched: bool) -> StudyRun:
    """Turn the finished run into one whose first cell finished and whose second is waiting.

    ``launched=False`` leaves the second cell queued without a job, as it is
    while the run waits for the first one to end; otherwise its job is queued.
    """

    run = await db_session.get(StudyRun, uuid.UUID(world.run["id"]))
    first, second = world.cells
    first_job, second_job = world.jobs
    run.state, run.finished_at = RunState.RUNNING, None
    second.state = RunState.QUEUED
    second.metrics = {}
    if launched:
        second_job.state, second_job.finished_at, second_job.result = JobState.QUEUED, None, None
    else:
        second_job.study_cell_id = None
        second.job_id = None
    assert first.state is RunState.COMPLETED and first_job.state is JobState.COMPLETED
    await db_session.flush()
    return run


async def jobs_of(db_session, cell) -> int:
    return await db_session.scalar(
        select(func.count()).select_from(Job).where(Job.study_cell_id == cell.id)
    )


async def test_cancelling_a_run_locks_the_run_then_its_cells_then_their_jobs(api_client, db_session, world):
    run = await reopen(db_session, world, launched=True)
    taken = record_locks(db_session)

    response = await api_client.post(f"{BASE}/studies/compare/runs/{run.id}/cancel", headers=world.headers)

    assert response.status_code == 200, response.text
    assert response.json()["state"] == "cancelled"
    assert first_locks(taken) == ["StudyRun", "StudyCell", "Job"]
    first, second = world.cells
    await db_session.refresh(second)
    await db_session.refresh(world.jobs[1])
    assert (first.state, second.state) == (RunState.COMPLETED, RunState.CANCELLED)
    assert world.jobs[1].state is JobState.CANCELLED


async def test_a_cancelled_run_launches_no_cell_when_a_job_finishes(db_session, world, monkeypatch):
    run = await reopen(db_session, world, launched=False)
    second = world.cells[1]
    launched: list[uuid.UUID] = []

    async def launch(*args, **kwargs):
        launched.append(args[1].id)
        raise AssertionError("a cancelled run must not launch a cell")

    monkeypatch.setattr(study_jobs, "launch_study_cell", launch)
    await study_jobs.cancel_run(db_session, run.id)
    # What a sync that read the run before the cancellation would otherwise do:
    # the cell is still waiting, only the run says it is over.
    second.state = RunState.QUEUED
    await db_session.flush()

    await study_jobs._sync(db_session, world.jobs[0].id)

    assert launched == []
    assert await jobs_of(db_session, second) == 0
    assert run.state is RunState.CANCELLED


async def test_a_cell_of_a_cancelled_run_stays_cancelled_when_its_abandoned_job_is_synced(
    db_session, world, monkeypatch
):
    run = await reopen(db_session, world, launched=True)
    second, second_job = world.cells[1], world.jobs[1]

    async def launch(*args, **kwargs):
        raise AssertionError("a cancelled run must not launch a cell")

    monkeypatch.setattr(study_jobs, "launch_study_cell", launch)
    await study_jobs.cancel_run(db_session, run.id)
    # What the sweep leaves behind when it fails the job before the worker saw the request.
    second_job.state, second_job.finished_at = JobState.FAILED, second_job.created_at
    await db_session.flush()

    await study_jobs._sync(db_session, second_job.id)

    assert second.state is RunState.CANCELLED
    assert world.cells[0].state is RunState.COMPLETED
    assert run.state is RunState.CANCELLED


async def test_a_sync_locks_the_run_and_its_cells_before_it_launches_the_next_cell(db_session, world, monkeypatch):
    await reopen(db_session, world, launched=False)
    second = world.cells[1]
    taken = record_locks(db_session)
    order: list[str] = []

    async def launch(session, cell, user, organization, project_id):
        order.extend(first_locks(taken))
        order.append("launch")
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

    monkeypatch.setattr(study_jobs, "launch_study_cell", launch)

    await study_jobs._sync(db_session, world.jobs[0].id)

    assert order == ["StudyRun", "StudyCell", "launch"]
    assert await jobs_of(db_session, second) == 1


async def test_a_sync_recomputes_the_run_from_the_cells_it_locked(db_session, world):
    run = await reopen(db_session, world, launched=True)
    second_job = world.jobs[1]
    second_job.state, second_job.finished_at = JobState.COMPLETED, second_job.created_at
    second_job.result = world.jobs[0].result
    await db_session.flush()

    await study_jobs._sync(db_session, second_job.id)

    assert world.cells[1].state is RunState.COMPLETED
    assert run.state is RunState.COMPLETED
    assert run.finished_at is not None


async def test_a_second_retry_of_a_cell_is_answered_with_the_first_ones_job(api_client, db_session, world):
    run = await reopen(db_session, world, launched=True)
    second = world.cells[1]
    failed_job = world.jobs[1]
    failed_job.state, failed_job.finished_at = JobState.FAILED, failed_job.created_at
    second.state = RunState.FAILED
    await db_session.flush()
    url = f"{BASE}/studies/compare/runs/{run.id}/cells/{second.id}/retry"
    taken = record_locks(db_session)

    one = await api_client.post(url, headers=world.headers)
    two = await api_client.post(url, headers=world.headers)

    assert one.status_code == two.status_code == 200, (one.text, two.text)
    assert one.json()["idempotent"] is False and two.json()["idempotent"] is True
    assert one.json()["jobId"] == two.json()["jobId"]
    assert first_locks(taken)[:2] == ["StudyRun", "StudyCell"]
    replacements = (
        await db_session.execute(select(Job).where(Job.retry_of_id == failed_job.id))
    ).scalars().all()
    assert [job.id for job in replacements] == [uuid.UUID(one.json()["jobId"])]
    events = (
        await db_session.execute(select(AuditEvent).where(AuditEvent.action == "study.cell.retried"))
    ).scalars().all()
    assert len(events) == 1


async def test_cancelling_a_cancelled_run_is_refused_and_changes_nothing(api_client, db_session, world):
    run = await reopen(db_session, world, launched=True)
    url = f"{BASE}/studies/compare/runs/{run.id}/cancel"

    first = await api_client.post(url, headers=world.headers)
    second = await api_client.post(url, headers=world.headers)

    assert first.status_code == 200 and second.status_code == 409, (first.text, second.text)
    assert second.json()["detail"]["code"] == "terminal_run"
    events = (
        await db_session.execute(select(AuditEvent).where(AuditEvent.action == "study.run.cancelled"))
    ).scalars().all()
    assert len(events) == 1

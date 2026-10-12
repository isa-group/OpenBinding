"""Cancelling or retrying a job is audited, and cancelling a study's queued job settles its cell."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from _b1_helpers import gate, make_account  # noqa: F401
from openbinding_gateway.db.models import AuditEvent, Job, JobState, RunState, StudyRun
from test_b1_cell_result import build_world
from test_study_run_concurrency import first_locks, record_locks


@pytest.fixture
async def world(api_client, db_session, registration, gate, monkeypatch):  # noqa: F811
    return await build_world(
        api_client, db_session, registration, gate, monkeypatch, parameter_sets=[{}], seeds=[1, 2]
    )


async def events(db_session, action: str) -> list[AuditEvent]:
    return list(
        (await db_session.execute(select(AuditEvent).where(AuditEvent.action == action))).scalars().all()
    )


async def unfinish(db_session, world, state: JobState) -> Job:
    """The first cell's job back in ``state`` (queued or running), its cell and run as they would be."""

    job, cell = world.jobs[0], world.cells[0]
    job.state, job.finished_at, job.result, job.termination = state, None, None, None
    cell.state = RunState.QUEUED if state is JobState.QUEUED else RunState.RUNNING
    cell.metrics = {}
    run = await db_session.get(StudyRun, uuid.UUID(world.run["id"]))
    run.state, run.finished_at = RunState.RUNNING, None
    await db_session.flush()
    return job


async def test_cancelling_a_queued_study_job_cancels_its_cell_and_is_audited(api_client, db_session, world):
    job = await unfinish(db_session, world, JobState.QUEUED)
    cell = world.cells[0]
    taken = record_locks(db_session)

    response = await api_client.post(f"/v1/jobs/{job.id}/cancel", headers=world.headers)

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"
    assert first_locks(taken)[:2] == ["StudyRun", "Job"]
    await db_session.refresh(job)
    await db_session.refresh(cell)
    assert job.state is JobState.CANCELLED
    assert cell.state is RunState.CANCELLED
    assert cell.metrics["status"] == "failed"
    run = await db_session.get(StudyRun, uuid.UUID(world.run["id"]))
    assert run.state is RunState.PARTIAL  # the other cell finished, so the run is over
    [event] = await events(db_session, "job.cancelled")
    assert event.actor_id == job.owner_id
    assert event.target_type == "Job" and event.target_id == job.id
    assert event.organization_id == job.organization_id
    assert event.detail == {
        "jobId": str(job.id), "ownerId": str(job.owner_id),
        "previousState": "queued", "result": "cancelled",
    }


async def test_cancelling_a_running_study_job_only_requests_it(api_client, db_session, world):
    job = await unfinish(db_session, world, JobState.RUNNING)
    cell = world.cells[0]

    response = await api_client.post(f"/v1/jobs/{job.id}/cancel", headers=world.headers)

    assert response.status_code == 200, response.text
    await db_session.refresh(job)
    await db_session.refresh(cell)
    assert job.state is JobState.RUNNING and job.cancellation_requested is True
    assert cell.state is RunState.RUNNING
    [event] = await events(db_session, "job.cancelled")
    assert event.detail["previousState"] == "running"
    assert event.detail["result"] == "cancellation_requested"


async def test_a_refused_cancellation_leaves_no_audit_event(api_client, db_session, registration, gate, world):  # noqa: F811
    finished = world.jobs[1]
    _, stranger = await make_account(api_client, registration, db_session, gate)

    terminal = await api_client.post(f"/v1/jobs/{finished.id}/cancel", headers=world.headers)
    foreign = await api_client.post(f"/v1/jobs/{finished.id}/cancel", headers=stranger)

    assert terminal.status_code == 409 and foreign.status_code == 404
    assert await events(db_session, "job.cancelled") == []


async def test_retrying_a_job_is_audited_once(api_client, db_session, world):
    original = world.jobs[1]
    original.state = JobState.FAILED
    await db_session.flush()

    first = await api_client.post(f"/v1/jobs/{original.id}/retry", headers=world.headers)
    replay = await api_client.post(f"/v1/jobs/{original.id}/retry", headers=world.headers)

    assert first.status_code == 202, first.text
    assert replay.status_code == 202, replay.text
    assert replay.json()["id"] == first.json()["id"]
    [event] = await events(db_session, "job.retried")
    assert event.actor_id == original.owner_id
    assert event.target_type == "Job" and event.target_id == uuid.UUID(first.json()["id"])
    assert event.organization_id == original.organization_id
    assert event.detail == {
        "jobId": str(original.id), "ownerId": str(original.owner_id),
        "replacementJobId": first.json()["id"], "result": "retried",
    }


async def test_a_refused_retry_leaves_no_audit_event(api_client, db_session, world):
    completed = world.jobs[1]

    response = await api_client.post(f"/v1/jobs/{completed.id}/retry", headers=world.headers)

    assert response.status_code == 409
    assert await events(db_session, "job.retried") == []

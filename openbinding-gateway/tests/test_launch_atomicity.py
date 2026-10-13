"""Launching a job for a study cell is one transaction: job and link stand or fall together."""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from test_idempotency_jobs import _body, _login, _snapshot
from test_job_dispatch import _account
from test_study_cell_launch import BASE, _cells, _study

from openbinding_gateway import study_jobs
from openbinding_gateway.db.models import (
    Job,
    JobState,
    Organization,
    Project,
    RunState,
    StudyCell,
    User,
    utcnow,
)
from openbinding_gateway.routes import jobs as job_routes
from openbinding_gateway.routes import studies as study_routes
from openbinding_gateway.routes import v1


async def _queued_run(api_client, registration, monkeypatch, seeds, code="concurrency_limit_exceeded"):
    """A study run whose cells are all still queued, because every launch was refused for now."""

    async def refuse(*args, **kwargs):
        raise study_jobs.StudyLaunchError(code, "not now")

    with monkeypatch.context() as patch:
        patch.setattr(study_routes, "launch_study_cell", refuse)
        headers = await _study(api_client, registration, seeds)
        run = await api_client.post(BASE, headers=headers)
    assert run.status_code == 202, run.text
    return headers, run.json()["id"]


async def _actors(db_session):
    user = (await db_session.execute(select(User))).scalars().one()
    organization = (await db_session.execute(select(Organization).where(Organization.slug == "lab"))).scalars().one()
    project = (await db_session.execute(select(Project).where(Project.slug == "routing"))).scalars().one()
    return user, organization, project


async def _jobs_of(db_session, cell_id) -> int:
    return await db_session.scalar(select(func.count()).select_from(Job).where(Job.study_cell_id == cell_id))


@pytest.fixture
def dispatched(monkeypatch):
    """Replace the dispatcher; each call records the job and whether the session was still in a transaction."""
    seen: list[tuple[str, bool]] = []

    def install(session: AsyncSession) -> list[tuple[str, bool]]:
        async def dispatch(job_id, request_session=None):
            seen.append((job_id, session.in_transaction()))

        monkeypatch.setattr(v1, "dispatch_persisted_job", dispatch)
        return seen

    return install


async def test_launch_links_the_cell_in_one_transaction_and_dispatches_after_the_commit(
    api_client, db_session, registration, monkeypatch, dispatched
) -> None:
    _, run_id = await _queued_run(api_client, registration, monkeypatch, [1])
    user, organization, project = await _actors(db_session)
    (cell,) = await _cells(db_session, run_id)
    seen = dispatched(db_session)

    job = await study_jobs.launch_study_cell(db_session, cell, user, organization, project.id)

    # Written by the job's own INSERT, nothing committed and nothing queued yet.
    assert job.study_cell_id == cell.id
    assert cell.job_id == job.id
    assert job.project_id == project.id
    assert seen == []
    assert v1.pending_launches(db_session) == [job.id]

    await study_jobs.commit_launched(db_session)

    assert seen == [(str(job.id), False)]
    assert v1.pending_launches(db_session) == []
    assert await _jobs_of(db_session, cell.id) == 1


async def test_a_second_launch_of_the_same_cell_returns_the_first_job(
    api_client, db_session, registration, monkeypatch, dispatched
) -> None:
    _, run_id = await _queued_run(api_client, registration, monkeypatch, [1])
    user, organization, project = await _actors(db_session)
    (cell,) = await _cells(db_session, run_id)
    seen = dispatched(db_session)
    payloads: list[dict] = []
    real_request = study_jobs._job_request

    def spy(payload, key=None):
        payloads.append(payload)
        return real_request(payload, key)

    monkeypatch.setattr(study_jobs, "_job_request", spy)

    first = await study_jobs.launch_study_cell(db_session, cell, user, organization, project.id)
    await study_jobs.commit_launched(db_session)

    # A launch that did not see the first one (no key to replay by) loses the cell's unique index.
    again = study_jobs._response_payload(
        await v1._create_job_core(
            real_request(payloads[0]), user, db_session, commit=False, dispatch=False, study_cell_id=cell.id
        )
    )
    # And a plain launch of a cell that already has a job is a replay.
    cell.job_id = None
    await db_session.flush()
    replay = await study_jobs.launch_study_cell(db_session, cell, user, organization, project.id)

    assert again["id"] == str(first.id)
    assert again["idempotent"] is True
    assert replay.id == first.id
    assert await _jobs_of(db_session, cell.id) == 1
    assert v1.pending_launches(db_session) == []
    assert [job_id for job_id, _ in seen] == [str(first.id)]


async def test_a_retry_launch_after_detaching_the_old_job_creates_a_new_one(
    api_client, db_session, registration, monkeypatch, dispatched
) -> None:
    _, run_id = await _queued_run(api_client, registration, monkeypatch, [1])
    user, organization, project = await _actors(db_session)
    (cell,) = await _cells(db_session, run_id)
    dispatched(db_session)

    first = await study_jobs.launch_study_cell(db_session, cell, user, organization, project.id)
    await study_jobs.commit_launched(db_session)
    first.study_cell_id = None  # what retry_study_cell does to the superseded job
    cell.job_id = None
    await db_session.flush()
    second = await study_jobs.launch_study_cell(db_session, cell, user, organization, project.id)
    await study_jobs.commit_launched(db_session)

    assert second.id != first.id
    assert second.study_cell_id == cell.id
    assert first.idempotency_key == f"study-cell:{cell.id}"
    assert second.idempotency_key is None


async def test_a_failed_flush_after_the_job_is_created_leaves_no_job(
    api_client, db_session, registration, monkeypatch, dispatched
) -> None:
    _, run_id = await _queued_run(api_client, registration, monkeypatch, [1])
    user, organization, project = await _actors(db_session)
    (cell,) = await _cells(db_session, run_id)
    cell_id = cell.id
    seen = dispatched(db_session)
    real_flush = AsyncSession.flush

    async def flush(self, *args, **kwargs):
        # The one that comes after the job was created and the cell pointed at it.
        if self is db_session and cell.job_id is not None:
            raise RuntimeError("flush failed")
        return await real_flush(self, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, "flush", flush)

    with pytest.raises(RuntimeError, match="flush failed"):
        await study_jobs.launch_study_cell(db_session, cell, user, organization, project.id)

    monkeypatch.setattr(AsyncSession, "flush", real_flush)
    assert await db_session.scalar(select(func.count()).select_from(Job)) == 0
    assert await db_session.scalar(select(StudyCell.job_id).where(StudyCell.id == cell_id)) is None
    assert v1.pending_launches(db_session) == []
    assert seen == []


@pytest.mark.parametrize("failing", ["commit", "persist_snapshot", "job_flush"])
async def test_a_failure_between_the_limit_check_and_the_commit_leaves_no_job(
    api_client, db_session, registration, monkeypatch, failing
) -> None:
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)
    user = (await db_session.execute(select(User))).scalars().one()
    real_flush = AsyncSession.flush

    async def commit(self, *args, **kwargs):
        raise RuntimeError("commit failed")

    async def flush(self, *args, **kwargs):
        if any(isinstance(item, Job) for item in self.new):
            raise RuntimeError("flush failed")
        return await real_flush(self, *args, **kwargs)

    async def persist(*args, **kwargs):
        raise RuntimeError("snapshot failed")

    patches = {
        "commit": (AsyncSession, "commit", commit),
        "job_flush": (AsyncSession, "flush", flush),
        "persist_snapshot": (v1, "persist_snapshot", persist),
    }
    target, name, replacement = patches[failing]
    request = study_jobs._job_request(_body(snapshot))

    with monkeypatch.context() as patch:
        patch.setattr(target, name, replacement)
        with pytest.raises(RuntimeError, match="failed"):
            await v1.create_job(request, caller=user, session=db_session)

    await db_session.rollback()
    assert await db_session.scalar(select(func.count()).select_from(Job)) == 0


async def test_a_retry_whose_dispatch_fails_keeps_its_committed_job(
    api_client, db_session, registration, monkeypatch
) -> None:
    user_id, headers = await _account(api_client, registration)
    original = Job(
        owner_id=user_id, engine_id="random-search", engine_job_id="failed", service_url="http://engine",
        state=JobState.FAILED, original_request={}, options={}, provenance={},
    )
    db_session.add(original)
    await db_session.flush()

    async def broken(*args, **kwargs):
        raise RuntimeError("broker down")

    monkeypatch.setattr(job_routes, "dispatch_persisted_job", broken)
    with pytest.raises(RuntimeError, match="broker down"):
        await api_client.post(f"/v1/jobs/{original.id}/retry", headers=headers)

    retries = await db_session.scalar(select(func.count(Job.id)).where(Job.retry_of_id == original.id))
    assert retries == 1


async def _attach_job(db_session, cell, user, organization, project, state=JobState.QUEUED) -> Job:
    job = Job(
        owner_id=user.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="http://engine",
        state=state, original_request={}, options={}, provenance={}, result={"termination": "FEASIBLE", "solutions": []},
        organization_id=organization.id, project_id=project.id, study_cell_id=cell.id,
    )
    db_session.add(job)
    await db_session.flush()
    cell.job_id = job.id
    await db_session.flush()
    return job


async def _stored(db_session, job_id):
    return (
        await db_session.execute(select(Job.state, Job.cancellation_requested).where(Job.id == job_id))
    ).one()


@pytest.mark.parametrize(
    ("behind_its_back", "state", "cancellation"),
    [
        (JobState.COMPLETED, JobState.COMPLETED, False),
        (JobState.RUNNING, JobState.RUNNING, True),
        (None, JobState.CANCELLED, True),
    ],
)
async def test_cancelling_a_run_respects_the_state_of_each_job(
    api_client, db_session, registration, monkeypatch, behind_its_back, state, cancellation
) -> None:
    headers, run_id = await _queued_run(api_client, registration, monkeypatch, [1])
    user, organization, project = await _actors(db_session)
    (cell,) = await _cells(db_session, run_id)
    job = await _attach_job(db_session, cell, user, organization, project)
    if behind_its_back is not None:
        # A worker moved the job on; this session still holds it as queued.
        await db_session.execute(
            update(Job)
            .where(Job.id == job.id)
            .values(state=behind_its_back, finished_at=utcnow() if behind_its_back is JobState.COMPLETED else None)
            .execution_options(synchronize_session=False)
        )

    cancelled = await api_client.post(f"{BASE}/{run_id}/cancel", headers=headers)

    assert cancelled.status_code == 200, cancelled.text
    assert tuple(await _stored(db_session, job.id)) == (state, cancellation)


async def test_cancelling_a_queued_cell_job_through_the_job_route_cancels_its_cell(
    api_client, db_session, registration, monkeypatch
) -> None:
    headers, run_id = await _queued_run(api_client, registration, monkeypatch, [1])
    user, organization, project = await _actors(db_session)
    (cell,) = await _cells(db_session, run_id)
    job = await _attach_job(db_session, cell, user, organization, project)

    cancelled = await api_client.post(f"/v1/jobs/{job.id}/cancel", headers=headers)

    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"
    await db_session.refresh(cell)
    assert cell.state is RunState.CANCELLED


async def _launched_run(api_client, db_session, registration, monkeypatch, code):
    """Three cells: the first has a finished job, the others wait. Returns what a sync needs."""
    _, run_id = await _queued_run(api_client, registration, monkeypatch, [1, 2, 3])
    user, organization, project = await _actors(db_session)
    first, second, third = await _cells(db_session, run_id)
    done = await _attach_job(db_session, first, user, organization, project, JobState.COMPLETED)
    first.state = RunState.RUNNING
    await db_session.flush()
    calls: list[int] = []

    async def launch(session, cell, user_, organization_, project_id):
        calls.append(cell.ordinal)
        if cell.ordinal == second.ordinal:
            raise study_jobs.StudyLaunchError(code, "refused")
        job = Job(
            owner_id=user_.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()),
            service_url="http://engine", state=JobState.QUEUED, study_cell_id=cell.id,
            organization_id=organization_.id, project_id=project_id,
        )
        session.add(job)
        await session.flush()
        cell.job_id = job.id
        await session.flush()
        return job

    monkeypatch.setattr(study_jobs, "launch_study_cell", launch)
    return done, (first, second, third), calls


async def test_a_cell_that_can_never_launch_is_failed_and_the_next_one_is_tried(
    api_client, db_session, registration, monkeypatch
) -> None:
    done, (first, second, third), calls = await _launched_run(
        api_client, db_session, registration, monkeypatch, "invalid_engine"
    )

    await study_jobs._sync(db_session, done.id)

    assert calls == [second.ordinal, third.ordinal]
    assert first.state is RunState.COMPLETED
    assert second.state is RunState.FAILED
    assert second.job_id is None
    assert second.metrics["status"] == "failed"
    assert second.metrics["code"] == "invalid_engine"
    assert second.metrics["detail"] == "refused"
    assert set(second.metrics) >= {"engine", "seed"}
    assert third.job_id is not None


@pytest.mark.parametrize("code", sorted(study_jobs.RETRYABLE_LAUNCH_CODES))
async def test_a_cell_refused_for_now_stays_queued_and_the_ones_behind_it_wait(
    api_client, db_session, registration, monkeypatch, code
) -> None:
    done, (_, second, third), calls = await _launched_run(api_client, db_session, registration, monkeypatch, code)

    await study_jobs._sync(db_session, done.id)

    assert calls == [second.ordinal]
    assert second.state is RunState.QUEUED
    assert second.job_id is None
    assert third.job_id is None


@pytest.mark.parametrize("code", ["concurrency_limit_exceeded", "pricing_unavailable"])
async def test_run_study_leaves_cells_queued_on_the_codes_the_pipeline_really_emits(
    api_client, db_session, registration, monkeypatch, code
) -> None:
    _, run_id = await _queued_run(api_client, registration, monkeypatch, [1, 2], code=code)

    assert {cell.state for cell in await _cells(db_session, run_id)} == {RunState.QUEUED}


@pytest.fixture
def env_probe(monkeypatch):
    """A variable the environment file may define; it is absent before and after the test."""
    monkeypatch.delenv("OPENBINDING_ENV_FILE", raising=False)
    monkeypatch.setenv("OB_ENV_PROBE", "unset")
    monkeypatch.delenv("OB_ENV_PROBE")
    return "OB_ENV_PROBE"


def test_environment_file_is_not_searched_in_parent_directories(tmp_path, monkeypatch, env_probe) -> None:
    from openbinding_gateway import main

    (tmp_path / ".env").write_text(f"{env_probe}=from-parent\n")
    child = tmp_path / "child"
    child.mkdir()
    monkeypatch.chdir(child)

    main.load_environment_file()

    assert env_probe not in os.environ


def test_a_directory_without_an_environment_file_is_fine(tmp_path, monkeypatch, env_probe) -> None:
    from openbinding_gateway import main

    monkeypatch.chdir(tmp_path)

    main.load_environment_file()

    assert env_probe not in os.environ


def test_the_working_directory_and_an_explicit_environment_file_are_read(tmp_path, monkeypatch, env_probe) -> None:
    from openbinding_gateway import main

    (tmp_path / ".env").write_text(f"{env_probe}=from-cwd\n")
    monkeypatch.chdir(tmp_path)
    main.load_environment_file()
    assert os.environ[env_probe] == "from-cwd"

    monkeypatch.delenv(env_probe)
    explicit = tmp_path / "explicit.env"
    explicit.write_text(f"{env_probe}=from-explicit\n")
    monkeypatch.setenv("OPENBINDING_ENV_FILE", str(explicit))
    main.load_environment_file()
    assert os.environ[env_probe] == "from-explicit"


def test_an_environment_file_that_cannot_be_opened_is_skipped(tmp_path, monkeypatch, env_probe) -> None:
    from openbinding_gateway import main

    (tmp_path / ".env").write_text(f"{env_probe}=unreadable\n")
    monkeypatch.chdir(tmp_path)

    def refuse(*args, **kwargs):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(main, "load_dotenv", refuse)

    main.load_environment_file()

    assert env_probe not in os.environ


def test_an_environment_file_that_cannot_be_inspected_is_skipped(tmp_path, monkeypatch, env_probe) -> None:
    from pathlib import Path

    from openbinding_gateway import main

    monkeypatch.chdir(tmp_path)

    def refuse(self):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(Path, "is_file", refuse)

    main.load_environment_file()

    assert env_probe not in os.environ

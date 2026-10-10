"""A study cell is launched into at most one job, however often it is asked for."""

from __future__ import annotations

import uuid

import pytest_asyncio
from sqlalchemy import func, select

from _repo import REPO_ROOT

from openbinding_gateway import space_client
from openbinding_gateway import study_jobs
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import Job, Organization, RunState, StudyCell, User
from openbinding_gateway.routes import studies as study_routes
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services import execution
from openbinding_gateway.v1.package import load_package
from _pricing import fake_pricing_gate

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
BASE = "/v1/organizations/lab/projects/routing/studies/compare/runs"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}


@pytest_asyncio.fixture
async def study_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


async def _solve(*args, **kwargs):
    return {
        "termination": "FEASIBLE",
        "solutions": [{
            "decision": {
                "kind": "binding",
                "binding": {
                    "t1": {"resource": "catalog", "id": "c1a"},
                    "t2": {"resource": "catalog", "id": "c2a"},
                    "t3": {"resource": "catalog", "id": "c3a"},
                },
            }
        }],
    }


async def _study(client, registration, seeds):
    """Create org, project, case and a study with one cell per seed; return headers."""
    details = registration()
    assert (await client.post("/v1/auth/register", json=details)).status_code == 201
    login = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    package = load_package(EXAMPLE)
    snapshot = await client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )
    await client.post("/v1/organizations", headers=headers, json={"slug": "lab", "name": "Lab"})
    await client.post(
        "/v1/organizations/lab/projects",
        headers=headers,
        json={"slug": "routing", "name": "Routing", "visibility": "private"},
    )
    await client.post(
        "/v1/organizations/lab/projects/routing/cases",
        headers=headers,
        json={"slug": "checkout", "name": "Checkout"},
    )
    revision = await client.post(
        "/v1/organizations/lab/projects/routing/cases/checkout/revisions",
        headers=headers,
        json={"document": package.instance(), "source_snapshot_id": snapshot.json()["id"]},
    )
    assert revision.status_code == 201, revision.text
    reference = routes._engine_ref(routes._manifest("random-search"), "bim.builtin")
    created = await client.post(
        "/v1/organizations/lab/projects/routing/studies",
        headers=headers,
        json={
            "slug": "compare",
            "name": "Compare",
            "definition": {
                "case_revision_ids": [revision.json()["id"]],
                "engines": [{**reference, "mode": "seeded", "optimization": dict(OPTIMIZATION)}],
                "parameter_sets": [{}],
                "seeds": seeds,
            },
        },
    )
    assert created.status_code == 201, created.text
    return headers


async def _cells(db_session, run_id):
    return (
        await db_session.execute(
            select(StudyCell).where(StudyCell.study_run_id == uuid.UUID(run_id)).order_by(StudyCell.ordinal)
        )
    ).scalars().all()


async def _job_count(db_session) -> int:
    return await db_session.scalar(select(func.count()).select_from(Job))


async def test_launching_the_same_cell_again_returns_the_same_job(
    api_client, db_session, registration, study_gate, monkeypatch
) -> None:
    monkeypatch.setattr(get_settings(), "job_dispatch_mode", "inline")
    monkeypatch.setattr(execution, "solve_remote", _solve)
    headers = await _study(api_client, registration, [1])
    run = await api_client.post(BASE, headers=headers)
    assert run.status_code == 202, run.text
    (cell,) = await _cells(db_session, run.json()["id"])
    job = await db_session.get(Job, cell.job_id)
    assert job.study_cell_id == cell.id
    assert job.idempotency_key == f"study-cell:{cell.id}"

    user = await db_session.get(User, job.owner_id)
    organization = await db_session.get(Organization, job.organization_id)
    jobs_before = await _job_count(db_session)

    # Forget the link on the cell side, as a lost race would leave it.
    cell.job_id = None
    await db_session.flush()
    again = await study_jobs.launch_study_cell(db_session, cell, user, organization, job.project_id)

    assert again.id == job.id
    assert cell.job_id == job.id
    assert await _job_count(db_session) == jobs_before


async def test_sync_does_not_launch_a_cell_that_already_has_a_job(
    api_client, db_session, registration, study_gate, monkeypatch
) -> None:
    monkeypatch.setattr(get_settings(), "job_dispatch_mode", "inline")
    monkeypatch.setattr(execution, "solve_remote", _solve)
    headers = await _study(api_client, registration, [1, 2])
    run = await api_client.post(BASE, headers=headers)
    assert run.status_code == 202, run.text
    first, second = await _cells(db_session, run.json()["id"])
    assert first.job_id is not None and second.job_id is not None
    finished = first.job_id
    claimed = second.job_id

    # The second cell still looks unlaunched, although its job exists.
    second.job_id = None
    second.state = RunState.QUEUED
    await db_session.flush()
    jobs_before = await _job_count(db_session)

    await study_jobs._sync(db_session, finished)
    await study_jobs._sync(db_session, finished)

    assert await _job_count(db_session) == jobs_before
    assert second.job_id == claimed


async def test_sync_of_a_single_cell_run_never_adds_a_job(
    api_client, db_session, registration, study_gate, monkeypatch
) -> None:
    monkeypatch.setattr(get_settings(), "job_dispatch_mode", "inline")
    monkeypatch.setattr(execution, "solve_remote", _solve)
    headers = await _study(api_client, registration, [1])
    run = await api_client.post(BASE, headers=headers)
    (cell,) = await _cells(db_session, run.json()["id"])
    jobs_before = await _job_count(db_session)

    await study_jobs._sync(db_session, cell.job_id)

    assert await _job_count(db_session) == jobs_before


async def test_the_study_run_charge_is_returned_once_when_every_cell_fails(
    api_client, db_session, registration, study_gate, monkeypatch
) -> None:
    async def reject(session, cell, user, organization, project_id):
        raise study_jobs.StudyLaunchError("invalid_engine", "no such engine")

    adjustments: list[dict] = []
    original = study_gate.adjust_usage

    async def record(user_id, increments):
        adjustments.append(dict(increments))
        await original(user_id, increments)

    monkeypatch.setattr(study_routes, "launch_study_cell", reject)
    monkeypatch.setattr(study_gate, "adjust_usage", record)
    headers = await _study(api_client, registration, [1, 2])

    run = await api_client.post(BASE, headers=headers)

    assert run.status_code == 202, run.text
    assert {cell.state for cell in await _cells(db_session, run.json()["id"])} == {RunState.FAILED}
    assert adjustments == [{"studyRuns": 1}, {"studyRuns": -1}]

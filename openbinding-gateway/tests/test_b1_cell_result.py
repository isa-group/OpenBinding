"""B1 #4: a job is attached to a study cell only if it is an execution of that cell."""

from __future__ import annotations

import copy
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from _b1_helpers import gate, make_account, put_member  # noqa: F401
from _repo import REPO_ROOT
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import Job, JobState, StudyCell
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services import execution
from openbinding_gateway.v1.package import load_package

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
BASE = "/v1/organizations/lab/projects/routing"


async def build_world(api_client, db_session, registration, gate, monkeypatch, *, parameter_sets, seeds):
    """An executed two-cell study run owned by one account."""

    async def solve(*args, **kwargs):
        return {
            "termination": "FEASIBLE",
            "solutions": [{"decision": {"kind": "binding", "binding": {
                "t1": {"resource": "catalog", "id": "c1a"},
                "t2": {"resource": "catalog", "id": "c2a"},
                "t3": {"resource": "catalog", "id": "c3a"},
            }}}],
        }

    monkeypatch.setattr(get_settings(), "job_dispatch_mode", "inline")
    monkeypatch.setattr(execution, "solve_remote", solve)
    owner, headers = await make_account(api_client, registration, db_session, gate)
    package = load_package(EXAMPLE)
    snapshot = await api_client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )
    assert snapshot.status_code == 201, snapshot.text
    exact_engine = {
        **routes._engine_ref(routes._manifest("random-search"), "bim.builtin"),
        "mode": "seeded",
        "optimization": dict(OPTIMIZATION),
    }
    for path, body in (
        ("/v1/organizations", {"slug": "lab", "name": "Binding Lab"}),
        ("/v1/organizations/lab/projects", {"slug": "routing", "name": "Routing", "visibility": "private"}),
        (f"{BASE}/cases", {"slug": "checkout", "name": "Checkout"}),
    ):
        created = await api_client.post(path, headers=headers, json=body)
        assert created.status_code == 201, created.text
    revision = await api_client.post(
        f"{BASE}/cases/checkout/revisions",
        headers=headers,
        json={"document": package.instance(), "source_snapshot_id": snapshot.json()["id"]},
    )
    assert revision.status_code == 201, revision.text
    study = await api_client.post(
        f"{BASE}/studies",
        headers=headers,
        json={"slug": "compare", "name": "Compare", "definition": {
            "case_revision_ids": [revision.json()["id"]],
            "engines": [exact_engine],
            "parameter_sets": parameter_sets,
            "seeds": seeds,
        }},
    )
    assert study.status_code == 201, study.text
    run = await api_client.post(f"{BASE}/studies/compare/runs", headers=headers)
    assert run.status_code == 202, run.text
    cells = (await db_session.execute(
        select(StudyCell).where(StudyCell.study_run_id == uuid.UUID(run.json()["id"])).order_by(StudyCell.ordinal)
    )).scalars().all()
    assert len(cells) == 2 and all(cell.job_id for cell in cells), [c.metrics for c in cells]
    jobs = [await db_session.get(Job, cell.job_id) for cell in cells]
    return SimpleNamespace(
        owner=owner, headers=headers, run=run.json(), cells=cells, jobs=jobs, revision=revision.json(),
        engine=exact_engine, package=package,
        url=lambda cell: f"{BASE}/studies/compare/runs/{run.json()['id']}/cells/{cell.id}/result",
    )


async def clone_job(db_session, source: Job, *, owner_id=None, patch=None, **fields) -> Job:
    """A fresh terminal job with the source's recorded identity, optionally altered."""
    provenance = copy.deepcopy(source.provenance)
    options = copy.deepcopy(source.options)
    for dotted, value in (patch or {}).items():
        target = options if dotted.startswith("options.") else provenance
        keys = dotted.removeprefix("options.").split(".")
        for key in keys[:-1]:
            target = target[key]
        if value is DELETE:
            target.pop(keys[-1], None)
        else:
            target[keys[-1]] = value
    values = dict(
        owner_id=owner_id or source.owner_id, engine_id=source.engine_id,
        engine_job_id=str(uuid.uuid4()), service_url=source.service_url,
        state=source.state, original_request=source.original_request, options=options,
        provenance=provenance, result=source.result, termination=source.termination,
        instance_snapshot_id=source.instance_snapshot_id, finished_at=source.finished_at,
        created_at=source.created_at,
    )
    values.update(fields)
    clone = Job(**values)
    db_session.add(clone)
    await db_session.flush()
    return clone


DELETE = object()


async def attach(api_client, world, cell, job, headers=None):
    return await api_client.post(
        world.url(cell), headers=headers or world.headers, json={"job_id": str(job.id)}
    )


@pytest.fixture
async def world(api_client, db_session, registration, gate, monkeypatch):
    return await build_world(
        api_client, db_session, registration, gate, monkeypatch, parameter_sets=[{}], seeds=[1, 2]
    )


async def test_the_recorded_identity_of_a_real_job_matches_its_cell(world):
    # The fixture the mismatch tests rely on: what a job records for a cell.
    cell, job = world.cells[0], world.jobs[0]
    assert job.provenance["packageDigest"]
    assert job.provenance["engine"] == {key: cell.engine_ref[key] for key in ("namespace", "name", "version", "digest")}
    assert job.provenance["mode"] == "seeded"
    assert job.options["seed"] == cell.seed == 1


async def test_a_job_that_executed_the_cell_can_be_attached(api_client, db_session, world):
    cell = world.cells[0]
    twin = await clone_job(db_session, world.jobs[0])

    response = await attach(api_client, world, cell, twin)

    assert response.status_code == 200, response.text
    assert response.json()["id"] == str(cell.id) and response.json()["state"] == "completed"
    await db_session.refresh(cell)
    assert cell.job_id == twin.id
    assert cell.metrics["seed"] == 1


async def test_reattaching_the_cells_own_job_is_idempotent(api_client, world):
    response = await attach(api_client, world, world.cells[0], world.jobs[0])
    assert response.status_code == 200, response.text


async def test_a_failed_job_of_the_cell_is_attached_as_a_failed_cell(api_client, db_session, world):
    failed = await clone_job(
        db_session, world.jobs[0], state=JobState.FAILED, result={"error": "engine crashed"}
    )
    response = await attach(api_client, world, world.cells[0], failed)
    assert response.status_code == 200, response.text
    assert response.json()["state"] == "failed"


@pytest.mark.parametrize(
    ("patch", "fields"),
    [
        ({"options.seed": 2}, ["seed"]),
        ({"engine.digest": "sha256-" + "e" * 64}, ["engine"]),
        ({"engine.version": "9.9.9"}, ["engine"]),
        ({"engine.name": "another-engine"}, ["engine"]),
        ({"mode": "another-mode"}, ["mode"]),
        ({"packageDigest": "sha256-" + "c" * 64}, ["case_revision"]),
        (
            {"options.seed": 2, "packageDigest": "sha256-" + "c" * 64, "engine.namespace": "other.ns"},
            ["case_revision", "engine", "seed"],
        ),
    ],
)
async def test_a_job_of_another_case_engine_mode_or_seed_is_refused(
    api_client, db_session, world, patch, fields
):
    cell = world.cells[0]
    before = cell.job_id
    impostor = await clone_job(db_session, world.jobs[0], patch=patch)

    response = await attach(api_client, world, cell, impostor)

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "cell_job_mismatch"
    assert detail["fields"] == fields
    assert set(detail["details"]) == set(fields)
    for field in fields:
        assert "cell" in detail["details"][field] and "job" in detail["details"][field]
        assert detail["details"][field]["cell"] != detail["details"][field]["job"]
    assert all(field in detail["error"] for field in fields)
    await db_session.refresh(cell)
    assert cell.job_id == before


async def test_the_job_of_a_sibling_cell_is_a_seed_mismatch(api_client, world):
    response = await attach(api_client, world, world.cells[0], world.jobs[1])
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "cell_job_mismatch"
    assert response.json()["detail"]["fields"] == ["seed"]
    assert response.json()["detail"]["details"]["seed"] == {"cell": 1, "job": 2}


async def test_a_job_without_a_recorded_seed_cannot_stand_for_a_seeded_cell(api_client, db_session, world):
    unseeded = await clone_job(
        db_session, world.jobs[0],
        patch={"options.seed": DELETE, "requestedOptions.seed": DELETE},
    )
    response = await attach(api_client, world, world.cells[0], unseeded)
    assert response.status_code == 409
    assert response.json()["detail"]["fields"] == ["seed"]
    assert response.json()["detail"]["details"]["seed"] == {"cell": 1, "job": None}


async def test_a_job_whose_package_is_unknown_is_a_case_mismatch(api_client, db_session, world):
    unknown = await clone_job(
        db_session, world.jobs[0], patch={"packageDigest": DELETE}, instance_snapshot_id=None
    )
    response = await attach(api_client, world, world.cells[0], unknown)
    assert response.status_code == 409
    assert response.json()["detail"]["fields"] == ["case_revision"]


async def test_other_peoples_jobs_are_not_found(api_client, db_session, registration, gate, world):
    stranger, _ = await make_account(api_client, registration, db_session, gate)
    foreign = await clone_job(db_session, world.jobs[0], owner_id=uuid.UUID(stranger["id"]))

    response = await attach(api_client, world, world.cells[0], foreign)
    missing = await api_client.post(
        world.url(world.cells[0]), headers=world.headers, json={"job_id": str(uuid.uuid4())}
    )

    assert response.status_code == missing.status_code == 404
    assert response.json() == missing.json()


@pytest.mark.parametrize(
    ("fields", "code"),
    [
        ({"state": JobState.RUNNING}, "job_not_finished"),
        ({"state": JobState.QUEUED}, "job_not_finished"),
        ({"state": JobState.COMPLETED, "result": None}, "job_result_missing"),
    ],
)
async def test_unfinished_or_resultless_jobs_are_refused(api_client, db_session, world, fields, code):
    job = await clone_job(db_session, world.jobs[0], **fields)
    response = await attach(api_client, world, world.cells[0], job)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == code


async def test_a_job_cannot_be_the_result_of_two_cells(api_client, db_session, registration, gate, monkeypatch):
    # Same case, engine and seed in both cells, so only the parameters differ.
    twin_world = await build_world(
        api_client, db_session, registration, gate, monkeypatch,
        parameter_sets=[{}, {"iterations": 100}], seeds=[1],
    )
    first, second = twin_world.cells
    assert first.seed == second.seed == 1

    response = await attach(api_client, twin_world, second, twin_world.jobs[0])

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "job_already_attached"
    await db_session.refresh(second)
    assert second.job_id == twin_world.jobs[1].id


async def test_roles_and_credentials_decide_who_may_attach(api_client, db_session, registration, gate, world):
    viewer, viewer_headers = await make_account(api_client, registration, db_session, gate)
    member, member_headers = await make_account(api_client, registration, db_session, gate)
    outsider, outsider_headers = await make_account(api_client, registration, db_session, gate)
    for account, role in ((viewer, "VIEWER"), (member, "MEMBER")):
        added = await put_member(api_client, world.headers, "lab", account["id"], role)
        assert added.status_code == 200, added.text
    cell = world.cells[0]
    own = await clone_job(db_session, world.jobs[0], owner_id=uuid.UUID(member["id"]))
    owners = await clone_job(db_session, world.jobs[0])

    as_viewer = await attach(api_client, world, cell, owners, viewer_headers)
    as_outsider = await attach(api_client, world, cell, owners, outsider_headers)
    anonymous = await api_client.post(world.url(cell), json={"job_id": str(owners.id)})
    others_job_as_member = await attach(api_client, world, cell, owners, member_headers)
    own_job_as_member = await attach(api_client, world, cell, own, member_headers)

    assert as_viewer.status_code == 403
    assert as_viewer.json()["detail"]["code"] == "organization_forbidden"
    assert as_outsider.status_code == 403
    assert anonymous.status_code == 401
    assert others_job_as_member.status_code == 404
    assert own_job_as_member.status_code == 200, own_job_as_member.text


async def test_a_run_sealed_into_a_report_still_refuses_results(api_client, db_session, world):
    cell = world.cells[0]
    twin = await clone_job(db_session, world.jobs[0])
    report = await api_client.post(f"{BASE}/reports", headers=world.headers, json={
        "slug": "run-evidence", "title": "Run evidence", "study_run_id": world.run["id"],
        "document": {"provenance": {
            "study": {"runId": world.run["id"], "matrixDigest": world.run["matrix_digest"]},
            "datasets": [{"reference": world.revision["id"], "digest": world.revision["digest"]}],
            "software": [{"name": "test-evaluator", "version": "1", "digest": "sha256-" + "a" * 64}],
            "bimVersion": "bim/v1", "engineRevisions": [world.engine], "parameters": {},
        }},
    })
    assert report.status_code == 201, report.text
    frozen = await api_client.post(f"{BASE}/reports/run-evidence/freeze", headers=world.headers)
    assert frozen.status_code == 200, frozen.text

    response = await attach(api_client, world, cell, twin)

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "sealed_evidence"
    await db_session.refresh(cell)
    assert cell.job_id == world.jobs[0].id

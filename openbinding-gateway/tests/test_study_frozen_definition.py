"""A study run freezes its definition and the compilation of each problem revision (D7).

``studies.definition`` is the editable matrix; ``study_runs.definition`` and ``definition_digest`` are the
copy a run wrote when it was created, and every cell pins the compilation its revision runs on
(``study_cells.compilation_id``), so neither an edit of the study nor a toolchain release while the cells
launch changes what a run ran.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from bim_core.canonical import digest
from sqlalchemy import select, update
from sqlalchemy.exc import DBAPIError

from _pricing import fake_pricing_gate, largest_plan
from _problem_helpers import upload_problem
from openbinding_gateway import space_client, study_jobs
from openbinding_gateway.db.models import (
    BindingCaseRevision, Job, Organization, ProblemCompilation, StudyCell, StudyRun, User,
)
from openbinding_gateway.integrations import bim
from openbinding_gateway.modules.problems.application import compile_or_get
from openbinding_gateway.routes import studies as study_routes
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services.engines import engine_ref
from openbinding_gateway.services.job_submission import discard_pending_launches
from openbinding_gateway.study_jobs import StudyLaunchError

OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
OTHER_COMPILER = "sha256-" + "e" * 64


class OtherToolchain:
    """The installed toolchain, reporting another ``compilerDigest``: what a bim-toolchain release looks like."""

    def __init__(self, inner) -> None:
        self._inner = inner

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def capabilities(self):
        return {**self._inner.capabilities(), "compilerDigest": OTHER_COMPILER}

    def compile(self, archive, registered=()):
        result = dict(self._inner.compile(archive, registered))
        result["toolchain"] = {**dict(result.get("toolchain") or {}), "compilerDigest": OTHER_COMPILER}
        result["compilationDigest"] = "sha256-" + "d" * 64
        return result


@pytest_asyncio.fixture
async def study_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


@pytest.fixture
def queued_cells(monkeypatch):
    """``runStudy`` launches nothing: every cell stays queued, as behind a concurrency limit."""

    async def refuse(session, cell, user, organization):
        raise StudyLaunchError("concurrency_limit_exceeded", "Not now.")

    monkeypatch.setattr(study_routes, "launch_study_cell", refuse)


async def _signed_in(client, registration, gate) -> dict[str, str]:
    details = registration()
    assert (await client.post("/v1/auth/register", json=details)).status_code == 201
    login = await client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]}
    )
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    profile = await client.get("/v1/users/me", headers=headers)
    gate.plans[uuid.UUID(profile.json()["id"])] = largest_plan()
    return headers


def _definition(revision_ids, seeds=(0,)) -> dict:
    reference = engine_ref(routes._manifest("random-search"), "bim.builtin")
    return {
        "revision_ids": list(revision_ids),
        "engines": [{**reference, "mode": "seeded", "optimization": dict(OPTIMIZATION)}],
        "parameter_sets": [{}],
        "seeds": list(seeds),
    }


async def _study(client, headers, org: str, revision_ids, seeds=(0,), slug: str = "frozen") -> dict:
    created = await client.post(
        f"/v1/organizations/{org}/studies", headers=headers,
        json={"slug": slug, "name": "Frozen", "definition": _definition(revision_ids, seeds)},
    )
    assert created.status_code == 201, created.text
    return created.json()


async def test_editing_the_study_leaves_its_runs_definitions_unchanged(
    api_client, db_session, registration, study_gate, queued_cells
) -> None:
    headers = await _signed_in(api_client, registration, study_gate)
    revision = await upload_problem(api_client, headers)
    org = revision["org"]
    await _study(api_client, headers, org, [revision["revision_id"]], seeds=[1, 2])
    run = await api_client.post(f"/v1/organizations/{org}/studies/frozen/runs", headers=headers)
    assert run.status_code == 202, run.text
    frozen, frozen_digest = run.json()["definition"], run.json()["definition_digest"]
    assert frozen_digest == digest(frozen)
    assert frozen["problems"] == [{
        "revisionId": revision["revision_id"],
        "problemId": revision["problem"]["id"],
        "revision": 1,
        "packageDigest": revision["revision"]["package_digest"],
        "compilationId": frozen["problems"][0]["compilationId"],
        "compilationDigest": frozen["problems"][0]["compilationDigest"],
        "irDigest": frozen["problems"][0]["irDigest"],
    }]

    tag = (await api_client.get(f"/v1/organizations/{org}/studies/frozen", headers=headers)).headers["ETag"]
    edited = await api_client.patch(
        f"/v1/organizations/{org}/studies/frozen", headers={**headers, "If-Match": tag},
        json={"definition": _definition([revision["revision_id"]], seeds=[7])},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["definition"]["seeds"] == [7]
    assert edited.json()["definition_digest"] != (await db_session.get(StudyRun, uuid.UUID(run.json()["id"]))).definition_digest

    row = await db_session.get(StudyRun, uuid.UUID(run.json()["id"]))
    await db_session.refresh(row)
    assert row.definition == frozen and row.definition_digest == frozen_digest
    read = await api_client.get(f"/v1/organizations/{org}/studies/frozen/runs/{run.json()['id']}", headers=headers)
    assert read.status_code == 200
    assert read.json()["definition"] == frozen and read.json()["definition_digest"] == frozen_digest


async def test_the_frozen_definition_and_the_pinned_compilation_cannot_be_updated(
    api_client, db_session, registration, study_gate, queued_cells
) -> None:
    headers = await _signed_in(api_client, registration, study_gate)
    revision = await upload_problem(api_client, headers)
    org = revision["org"]
    await _study(api_client, headers, org, [revision["revision_id"]])
    run = await api_client.post(f"/v1/organizations/{org}/studies/frozen/runs", headers=headers)
    run_id = uuid.UUID(run.json()["id"])
    with bim.bim_override(OtherToolchain(bim.get_bim())):
        other = await compile_or_get(
            db_session, await db_session.get(BindingCaseRevision, uuid.UUID(revision["revision_id"]))
        )
    await db_session.commit()

    for statement in (
        update(StudyRun).where(StudyRun.id == run_id).values(definition={"apiVersion": "changed"}),
        update(StudyRun).where(StudyRun.id == run_id).values(definition_digest="sha256-" + "0" * 64),
        update(StudyCell).where(StudyCell.study_run_id == run_id).values(compilation_id=other.id),
    ):
        with pytest.raises(DBAPIError, match="protected columns"):
            async with db_session.begin_nested():
                await db_session.execute(statement)


async def test_cells_launched_after_a_toolchain_release_keep_the_pinned_compilation(
    api_client, db_session, registration, study_gate, queued_cells
) -> None:
    headers = await _signed_in(api_client, registration, study_gate)
    revision = await upload_problem(api_client, headers)
    org = revision["org"]
    await _study(api_client, headers, org, [revision["revision_id"]], seeds=[1, 2])
    run = await api_client.post(f"/v1/organizations/{org}/studies/frozen/runs", headers=headers)
    assert run.status_code == 202, run.text
    pinned = uuid.UUID(run.json()["definition"]["problems"][0]["compilationId"])
    cells = (await db_session.scalars(
        select(StudyCell).where(StudyCell.study_run_id == uuid.UUID(run.json()["id"])).order_by(StudyCell.ordinal)
    )).all()
    assert [cell.job_id for cell in cells] == [None, None]
    assert {cell.compilation_id for cell in cells} == {pinned}
    user = await db_session.get(User, (await db_session.get(StudyRun, uuid.UUID(run.json()["id"]))).created_by_id)
    organization = await db_session.scalar(select(Organization).where(Organization.slug == org))

    first = await study_jobs.launch_study_cell(db_session, cells[0], user, organization)
    with bim.bim_override(OtherToolchain(bim.get_bim())):
        # A plain run of the revision now compiles it with the new toolchain ...
        current = await compile_or_get(
            db_session, await db_session.get(BindingCaseRevision, uuid.UUID(revision["revision_id"]))
        )
        # ... but the run's next cell runs the compilation its run pinned.
        second = await study_jobs.launch_study_cell(db_session, cells[1], user, organization)
    discard_pending_launches(db_session)

    assert current.id != pinned and current.compiler_digest == OTHER_COMPILER
    assert first.compilation_id == second.compilation_id == pinned
    assert (await db_session.get(ProblemCompilation, pinned)).compiler_digest != OTHER_COMPILER


async def test_a_cell_whose_pinned_compilation_is_not_installed_fails_for_good(
    api_client, db_session, registration, study_gate, queued_cells, monkeypatch
) -> None:
    headers = await _signed_in(api_client, registration, study_gate)
    revision = await upload_problem(api_client, headers)
    org = revision["org"]
    await _study(api_client, headers, org, [revision["revision_id"]])
    run = await api_client.post(f"/v1/organizations/{org}/studies/frozen/runs", headers=headers)
    (cell,) = (await db_session.scalars(
        select(StudyCell).where(StudyCell.study_run_id == uuid.UUID(run.json()["id"]))
    )).all()
    user = await db_session.get(User, (await db_session.get(StudyRun, uuid.UUID(run.json()["id"]))).created_by_id)
    organization = await db_session.scalar(select(Organization).where(Organization.slug == org))
    monkeypatch.setattr(bim, "ir_is_installed", lambda ir: False)

    with pytest.raises(StudyLaunchError) as refused:
        await study_jobs.launch_study_cell(db_session, cell, user, organization)

    assert refused.value.code == "contract_not_installed"
    assert refused.value.code not in study_jobs.RETRYABLE_LAUNCH_CODES
    assert await db_session.scalar(select(Job.id).where(Job.study_cell_id == cell.id)) is None


async def test_a_revision_of_another_organization_is_refused(
    api_client, registration, study_gate
) -> None:
    headers = await _signed_in(api_client, registration, study_gate)
    mine = await upload_problem(api_client, headers)
    theirs = await upload_problem(api_client, headers)

    created = await api_client.post(
        f"/v1/organizations/{mine['org']}/studies", headers=headers,
        json={"slug": "mixed", "name": "Mixed", "definition": _definition([mine["revision_id"], theirs["revision_id"]])},
    )
    assert created.status_code == 422
    assert created.json()["code"] == "foreign_case_revision"

    await _study(api_client, headers, mine["org"], [mine["revision_id"]])
    edited = await api_client.patch(
        f"/v1/organizations/{mine['org']}/studies/frozen", headers=headers,
        json={"definition": _definition([theirs["revision_id"]])},
    )
    assert edited.status_code == 422
    assert edited.json()["code"] == "foreign_case_revision"


async def test_an_old_definition_runs_again_through_a_patch_from_its_run(
    api_client, db_session, registration, study_gate, queued_cells
) -> None:
    headers = await _signed_in(api_client, registration, study_gate)
    revision = await upload_problem(api_client, headers)
    org = revision["org"]
    base = f"/v1/organizations/{org}/studies/frozen"
    await _study(api_client, headers, org, [revision["revision_id"]], seeds=[1, 2])
    first = await api_client.post(f"{base}/runs", headers=headers)
    await api_client.patch(base, headers=headers, json={"definition": _definition([revision["revision_id"]], seeds=[9])})

    old = (await api_client.get(f"{base}/runs/{first.json()['id']}", headers=headers)).json()["definition"]
    restored = await api_client.patch(base, headers=headers, json={"definition": {
        "revision_ids": [item["revisionId"] for item in old["problems"]],
        "engines": old["engines"],
        "parameter_sets": old["parameterSets"],
        "seeds": old["seeds"],
    }})
    assert restored.status_code == 200, restored.text
    again = await api_client.post(f"{base}/runs", headers=headers)

    assert again.status_code == 202, again.text
    assert again.json()["run_number"] == 2
    assert again.json()["definition"] == old
    assert again.json()["definition_digest"] == first.json()["definition_digest"]
    assert again.json()["matrix_digest"] == first.json()["matrix_digest"]


async def test_an_organization_with_a_study_run_cannot_be_deleted(
    api_client, registration, study_gate, queued_cells
) -> None:
    headers = await _signed_in(api_client, registration, study_gate)
    revision = await upload_problem(api_client, headers)
    org = revision["org"]
    await _study(api_client, headers, org, [revision["revision_id"]])
    run = await api_client.post(f"/v1/organizations/{org}/studies/frozen/runs", headers=headers)
    assert run.status_code == 202, run.text

    refused = await api_client.delete(f"/v1/organizations/{org}", headers=headers)

    assert refused.status_code == 409
    assert refused.json()["code"] == "historical_references"
    assert (await api_client.get(f"/v1/organizations/{org}/studies/frozen", headers=headers)).status_code == 200


async def test_an_organization_whose_studies_never_ran_can_be_deleted(
    api_client, registration, study_gate
) -> None:
    headers = await _signed_in(api_client, registration, study_gate)
    revision = await upload_problem(api_client, headers)
    org = revision["org"]
    await _study(api_client, headers, org, [revision["revision_id"]])

    removed = await api_client.delete(f"/v1/organizations/{org}", headers=headers)

    assert removed.status_code == 204, removed.text

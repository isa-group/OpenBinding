"""The F0b walk at the API: upload, run and study, with the IR kept in one place.

The same path a person takes through the interface (``frontend/e2e/f0b-walk.spec.ts``), against SQLite and a
fake engine:

1. the demo package (the template the Workbench starts from) is checked by ``POST /v1/bim/validate`` and uploaded
   as a problem with the same ``packageDigest``; a changed copy becomes its revision 2;
2. a run of revision 2 is accepted queued, and the worker's runner (``dispatch_persisted_job``, the code the
   Dramatiq actor awaits) settles it;
3. a study of both revisions x 2 engine modes x 2 seeds is created and run, and its cells settle the same way;
4. no IR is stored outside ``problem_compilations``, which holds exactly one row per revision (D5, D6, D7).
"""

from __future__ import annotations

import json

import pytest
from bim_core.canonical import digest
from sqlalchemy import func, select

from _b1_helpers import gate, make_account  # noqa: F401
from _problem_helpers import ZIP, make_org
from analysis_b3_b4_b6._helpers import persisted_anywhere
from openbinding_gateway import job_dispatch, study_jobs
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import BindingCaseRevision, Job, JobState, ProblemCompilation, StudyCell
from openbinding_gateway.integrations import packages
from openbinding_gateway.modules.execution.adapters import routes as runs_routes
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services import execution
from openbinding_gateway.services.engines import engine_ref

pytestmark = pytest.mark.asyncio

TEMPLATE = "demo/01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
#: Two modes of two built-in engines that both run the demo problem.
ENGINE_MODES = (("random-search", "seeded"), ("evolutionary-heuristics", "elitist-genetic"))
SEEDS = [1, 2]
#: The parts of an IR that name the toolchain that compiled it, which a run's provenance records too.
DESCRIPTORS = frozenset({"profile", "dialects"})
BINDING = {
    "t1": {"resource": "catalog", "id": "c1a"},
    "t2": {"resource": "catalog", "id": "c2a"},
    "t3": {"resource": "catalog", "id": "c3a"},
}


@pytest.fixture
def worker(monkeypatch):
    """Runs and cells are queued instead of run in the request; ``settle`` is the worker taking them."""
    queued: list[str] = []

    async def enqueue(job_id: str, request_session=None) -> bool:
        queued.append(str(job_id))
        return True

    async def solve(*args, **kwargs):
        return {"termination": "FEASIBLE", "solutions": [{"decision": {"kind": "binding", "binding": BINDING}}]}

    monkeypatch.setattr(runs_routes, "dispatch_persisted_job", enqueue)
    monkeypatch.setattr(study_jobs, "dispatch_persisted_job", enqueue)
    monkeypatch.setattr(execution, "solve_remote", solve)
    # The runner awaited inline is the one the Dramatiq actor awaits (``job_dispatch._execute``).
    monkeypatch.setattr(get_settings(), "job_dispatch_mode", "inline")

    async def settle(session) -> list[str]:
        taken = list(queued)
        queued.clear()
        for job_id in taken:
            await job_dispatch.dispatch_persisted_job(job_id, session)
        return taken

    return queued, settle


def changed_copy(archive: bytes) -> bytes:
    """The demo package with one candidate value changed: what a save from the Workbench uploads."""
    files = packages.read_files(archive)
    candidates = json.loads(files["candidates.json"])
    candidates["spec"]["candidates"]["c1b"]["features"]["latency"] = 12
    files["candidates.json"] = json.dumps(candidates).encode()
    return packages.zip_files(files)


def study_engine(name: str, mode: str) -> dict:
    return {**engine_ref(routes._manifest(name), "bim.builtin"), "mode": mode, "optimization": dict(OPTIMIZATION)}


async def test_upload_run_and_study_end_to_end(api_client, db_session, registration, gate, worker):  # noqa: F811
    queued, settle = worker
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)

    # 1. The template is checked, then uploaded: the problem's revision is the package that was checked.
    template = await api_client.get(f"/v1/bim/templates/{TEMPLATE}")
    assert template.status_code == 200, template.text
    archive = template.content
    checked = await api_client.post("/v1/bim/validate", content=archive, headers={**headers, **ZIP})
    assert checked.status_code == 200, checked.text
    assert checked.json()["valid"] is True
    uploaded = await api_client.post(
        f"/v1/organizations/{org}/problems", params={"slug": "simple-seq"}, content=archive, headers={**headers, **ZIP}
    )
    assert uploaded.status_code == 201, uploaded.text
    assert uploaded.json()["revision"]["package_digest"] == checked.json()["packageDigest"]
    assert uploaded.json()["revision"]["revision"] == 1

    edited = changed_copy(archive)
    rechecked = await api_client.post("/v1/bim/validate", content=edited, headers={**headers, **ZIP})
    assert rechecked.status_code == 200 and rechecked.json()["valid"] is True, rechecked.text
    second = await api_client.post(
        f"/v1/organizations/{org}/problems/simple-seq/revisions", content=edited, headers={**headers, **ZIP}
    )
    assert second.status_code == 201, second.text
    assert second.json()["revision"]["revision"] == 2
    assert second.json()["revision"]["package_digest"] == rechecked.json()["packageDigest"]
    revisions = [uploaded.json()["revision"]["id"], second.json()["revision"]["id"]]

    # 2. A run of revision 2: accepted queued, then settled by the worker.
    created = await api_client.post(
        f"/v1/organizations/{org}/runs", headers=headers,
        json={"revision": revisions[1], "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
    )
    assert created.status_code == 202, created.text
    run_id = created.json()["id"]
    assert queued == [run_id]
    waiting = (await api_client.get(f"/v1/organizations/{org}/runs/{run_id}", headers=headers)).json()
    assert waiting["status"] == "queued"
    assert await settle(db_session) == [run_id]
    finished = (await api_client.get(f"/v1/organizations/{org}/runs/{run_id}", headers=headers)).json()
    assert finished["status"] == "completed", finished
    assert finished["revision"] == {"id": revisions[1], "revision": 2}
    assert finished["result"]["solutions"], finished["result"]

    # 3. A study of both revisions x 2 engine modes x 2 seeds: its run freezes the definition, and every cell settles.
    study = await api_client.post(
        f"/v1/organizations/{org}/studies", headers=headers,
        json={"slug": "walk", "name": "Walk", "definition": {
            "revision_ids": revisions,
            "engines": [study_engine(name, mode) for name, mode in ENGINE_MODES],
            "parameter_sets": [{}],
            "seeds": SEEDS,
        }},
    )
    assert study.status_code == 201, study.text
    started = await api_client.post(f"/v1/organizations/{org}/studies/walk/runs", headers=headers)
    assert started.status_code == 202, started.text
    study_run = started.json()
    assert study_run["definition_digest"] == digest(study_run["definition"])
    assert sorted(item["revisionId"] for item in study_run["definition"]["problems"]) == sorted(revisions)
    cells_url = f"/v1/organizations/{org}/studies/walk/runs/{study_run['id']}/cells"
    cells = (await api_client.get(cells_url, headers=headers)).json()
    assert len(cells) == len(revisions) * len(ENGINE_MODES) * len(SEEDS) == 8
    launched = await settle(db_session)
    assert len(launched) == 8
    cells = (await api_client.get(cells_url, headers=headers)).json()
    assert {cell["state"] for cell in cells} == {"completed"}, [cell["metrics"] for cell in cells]
    read = (await api_client.get(f"/v1/organizations/{org}/studies/walk/runs/{study_run['id']}", headers=headers)).json()
    assert read["state"] == "completed", read
    assert read["definition_digest"] == study_run["definition_digest"]

    # 4. One compilation per revision, which every run and cell points at, and the IR nowhere else.
    compilations = (await db_session.scalars(select(ProblemCompilation))).all()
    assert len(compilations) == len(revisions)
    assert sorted(str(row.revision_id) for row in compilations) == sorted(revisions)
    by_revision = {str(row.revision_id): row for row in compilations}
    jobs = (await db_session.scalars(select(Job))).all()
    assert len(jobs) == 9 and all(job.state is JobState.COMPLETED for job in jobs)
    for job in jobs:
        assert job.compilation_id == by_revision[str(job.revision_id)].id
        assert job.provenance["irDigest"] == by_revision[str(job.revision_id)].ir_digest
    for cell in (await db_session.scalars(select(StudyCell))).all():
        assert cell.compilation_id == by_revision[str(cell.binding_case_revision_id)].id
    assert await db_session.scalar(select(func.count()).select_from(BindingCaseRevision)) == len(revisions)
    for compilation in compilations:
        # Every sizeable part of the problem the IR carries: a copy anywhere else would hold it verbatim. The profile
        # and dialect descriptors are not the problem: a run's provenance records which ones compiled it.
        spec = compilation.ir.get("spec", {})
        parts = {key: value for key, value in spec.items() if key not in DESCRIPTORS and len(repr(value)) > 40}
        assert {"instance", "application", "candidates", "optimization"} <= set(parts), sorted(spec)
        for key, part in parts.items():
            assert not await persisted_anywhere(db_session, repr(part), exclude={"problem_compilations"}), key

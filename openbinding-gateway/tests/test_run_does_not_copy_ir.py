"""A run references its revision's compilation and never copies the IR (D5).

A synthetic marker is planted in a resource of the uploaded package (a feature value, which lowering
carries into the IR body and nothing else stores: no digest, id or descriptor). After runs of it, the
marker is in ``problem_compilations`` and nowhere else.
"""

from __future__ import annotations

import json
import uuid

import pytest
from bim_core.compiler import ir_digest
from sqlalchemy import func, select

from _b1_helpers import gate, make_account  # noqa: F401,F811
from _problem_helpers import EXAMPLE, run_url, runs_url_for, upload_problem
from analysis_b3_b4_b6._helpers import persisted_anywhere
from openbinding_gateway.db.models import Job, JobState, ProblemCompilation
from openbinding_gateway.integrations import packages
from openbinding_gateway.job_dispatch import dispatch_persisted_job
from openbinding_gateway.modules.execution.adapters import routes as runs_routes
from openbinding_gateway.services import execution
from openbinding_gateway.v1.remote import RemoteEngineError

pytestmark = pytest.mark.asyncio

MARKER = 4242.4242
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}


def marked_package() -> bytes:
    files = packages.directory_files(EXAMPLE)
    candidates = json.loads(files["candidates.json"])
    candidates["spec"]["candidates"]["c1b"]["features"]["latency"] = MARKER
    files["candidates.json"] = json.dumps(candidates).encode()
    return packages.zip_files(files)


@pytest.fixture
def engine(monkeypatch):
    """The engine call: what it was sent is recorded, and it answers with a failure (no engine runs here)."""
    sent: list[dict] = []

    async def solve_remote(transport, document, *args, **kwargs):
        sent.append(document)
        raise RemoteEngineError("no engine in the test")

    monkeypatch.setattr(execution, "solve_remote", solve_remote)
    return sent


async def submit(api_client, headers, revision_id: str):
    response = await api_client.post(
        runs_url_for(revision_id), headers=headers,
        json={"revision": revision_id, "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
    )
    assert response.status_code == 202, response.text
    return uuid.UUID(response.json()["id"])


async def test_runs_reference_the_compilation_and_the_ir_is_stored_once(
    api_client, registration, db_session, gate, engine  # noqa: F811
):
    _, headers = await make_account(api_client, registration, db_session, gate)
    uploaded = await upload_problem(api_client, headers, archive=marked_package())
    assert await persisted_anywhere(db_session, repr(MARKER))

    job_ids = [await submit(api_client, headers, uploaded["revision_id"]) for _ in range(3)]

    compilation = await db_session.scalar(select(ProblemCompilation))
    assert await db_session.scalar(select(func.count()).select_from(ProblemCompilation)) == 1
    assert not await persisted_anywhere(db_session, repr(MARKER), exclude={"problem_compilations"})
    for job_id in job_ids:
        job = await db_session.get(Job, job_id)
        await db_session.refresh(job)
        assert job.compilation_id == compilation.id
        assert str(job.revision_id) == uploaded["revision_id"]
        assert set(job.original_request) <= {"timeout", "mode", "optimization", "registration"}
        assert job.provenance["compilationId"] == str(compilation.id)
        assert job.provenance["irDigest"] == compilation.ir_digest
    detail = (await api_client.get(run_url(job_ids[0], org=uploaded["org"]), headers=headers)).json()
    assert detail["organization"]["slug"] == uploaded["org"]
    assert detail["problem"]["slug"] == uploaded["problem"]["slug"]
    assert detail["revision"] == {"id": uploaded["revision_id"], "revision": 1}
    assert detail["compilation"]["id"] == str(compilation.id)
    assert len(engine) == 3
    assert all(document == compilation.ir for document in engine)
    assert ir_digest(engine[0]) == compilation.ir_digest


async def test_a_retry_keeps_the_compilation(api_client, registration, db_session, gate, engine):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    uploaded = await upload_problem(api_client, headers)
    original_id = await submit(api_client, headers, uploaded["revision_id"])
    original = await db_session.get(Job, original_id)
    await db_session.refresh(original)
    assert original.state is JobState.FAILED

    retried = await api_client.post(run_url(original_id, "/retry", org=uploaded["org"]), headers=headers)

    assert retried.status_code == 202, retried.text
    replacement = await db_session.get(Job, uuid.UUID(retried.json()["id"]))
    assert (replacement.revision_id, replacement.compilation_id) == (original.revision_id, original.compilation_id)
    assert retried.json()["compilation"]["id"] == str(original.compilation_id)


async def test_a_compilation_whose_ir_digest_differs_from_the_run_fails_the_run(
    api_client, registration, db_session, gate, engine, monkeypatch  # noqa: F811
):
    async def queued(*args, **kwargs):
        return None

    _, headers = await make_account(api_client, registration, db_session, gate)
    uploaded = await upload_problem(api_client, headers)
    monkeypatch.setattr(runs_routes, "dispatch_persisted_job", queued)
    job_id = await submit(api_client, headers, uploaded["revision_id"])
    job = await db_session.get(Job, job_id)
    job.provenance = {**job.provenance, "irDigest": "sha256-" + "0" * 64}
    await db_session.commit()

    await dispatch_persisted_job(str(job_id), db_session)

    await db_session.refresh(job)
    assert job.state is JobState.FAILED
    assert job.result["code"] == "job_input_invalid"
    assert engine == []

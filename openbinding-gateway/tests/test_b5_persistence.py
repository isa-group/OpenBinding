"""B5: open range ends survive a problem upload (source and compilation) and job creation fails closed for them."""

from __future__ import annotations

import json
import uuid

import io
import zipfile

import pytest
from sqlalchemy import select

from _problem_helpers import upload_problem
from _repo import REPO_ROOT
from openbinding_gateway.db.models import ProblemCompilation
from bim_core.compiler import compile_instance
from bim_core.package import load_package

DEMO = REPO_ROOT / "examples/demo/01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
RANGES = [
    {"min": 100, "max": None},
    {"min": None, "max": 200},
    {"min": None, "max": None},
]


def package_with(latency):
    package = load_package(DEMO)
    catalog = json.loads(package.files["candidates.json"])
    catalog["spec"]["candidates"]["c1a"]["features"]["latency"] = latency
    package.files["candidates.json"] = json.dumps(catalog).encode()
    return package


def stored(document):
    return document["spec"]["candidates"]["catalog"]["candidates"]["c1a"]["features"]["latency"]


async def sign_in(api_client, registration):
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['access_token']}"}


@pytest.mark.asyncio
@pytest.mark.parametrize("latency", RANGES)
async def test_open_ranges_round_trip_through_the_problem_store(api_client, db_session, registration, latency):
    headers = await sign_in(api_client, registration)
    package = package_with(latency)
    created = await upload_problem(api_client, headers, archive=package.to_zip(), slug="ranges")
    base = f"/v1/organizations/{created['org']}/problems/ranges/revisions/1"

    source = await api_client.get(f"{base}/source", headers=headers)
    assert source.status_code == 200
    with zipfile.ZipFile(io.BytesIO(source.content)) as archive:
        catalog = json.loads(archive.read("candidates.json"))
    assert catalog["spec"]["candidates"]["c1a"]["features"]["latency"] == latency

    compilation = (await api_client.get(f"{base}/compilation", headers=headers)).json()
    ir = await api_client.get(f"{base}/compilations/{compilation['id']}/ir", headers=headers)
    assert stored(ir.json()["ir"]) == latency
    row = await db_session.scalar(
        select(ProblemCompilation).where(ProblemCompilation.revision_id == uuid.UUID(created["revision_id"]))
    )
    assert stored(row.ir) == latency
    assert row.ir_digest == compile_instance(package).digest == compilation["ir_digest"]


@pytest.mark.asyncio
@pytest.mark.parametrize("latency", [*RANGES, {"min": 1, "max": 2}])
async def test_a_job_over_open_or_finite_ranges_is_refused_with_unsupported_capability_value(
    api_client, registration, latency
):
    headers = await sign_in(api_client, registration)
    created = await upload_problem(api_client, headers, archive=package_with(latency).to_zip())

    job = await api_client.post(
        "/v1/jobs",
        headers={**headers, "Idempotency-Key": f"b5-{uuid.uuid4()}"},
        json={
            "revision": created["revision_id"],
            "engine": "random-search",
            "mode": "seeded",
            "optimization": OPTIMIZATION,
        },
    )

    assert job.status_code == 422, job.text
    assert "engine_mode_incompatible" in job.text
    assert "unsupported_capability_value" in job.text

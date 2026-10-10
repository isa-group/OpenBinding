"""B5: open range ends survive snapshot persistence and job creation fails closed for them."""

from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import select

from _repo import REPO_ROOT
from openbinding_gateway.db.models import BindingIRSnapshot, InstanceResource, InstanceSnapshot
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import load_package

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
async def test_open_ranges_round_trip_through_the_snapshot_store(api_client, db_session, registration, latency):
    headers = await sign_in(api_client, registration)
    package = package_with(latency)
    created = await api_client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )
    assert created.status_code == 201, created.text
    snapshot_id = uuid.UUID(created.json()["id"])

    fetched = await api_client.get(f"/v1/instances/{snapshot_id}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["instanceDigest"] == created.json()["instanceDigest"]

    snapshot = await db_session.get(InstanceSnapshot, snapshot_id)
    resources = (
        await db_session.execute(select(InstanceResource).where(InstanceResource.snapshot_id == snapshot_id))
    ).scalars().all()
    catalog = next(item for item in resources if item.path == "candidates.json")
    assert json.loads(catalog.content)["spec"]["candidates"]["c1a"]["features"]["latency"] == latency
    if catalog.document is not None:
        assert catalog.document["spec"]["candidates"]["c1a"]["features"]["latency"] == latency

    ir = await db_session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot_id))
    assert stored(ir.document) == latency

    # The restore path recomputes the semantic digest of the stored JSON and refuses a mismatch.
    restored = await routes._snapshot_problem(snapshot, db_session)
    assert stored(restored.document) == latency
    assert restored.digest == compile_instance(package).digest == ir.ir_digest


@pytest.mark.asyncio
@pytest.mark.parametrize("latency", [*RANGES, {"min": 1, "max": 2}])
async def test_a_job_over_open_or_finite_ranges_is_refused_with_unsupported_capability_value(
    api_client, registration, latency
):
    headers = await sign_in(api_client, registration)
    created = await api_client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package_with(latency).to_zip(),
    )
    assert created.status_code == 201, created.text

    job = await api_client.post(
        "/v1/jobs",
        headers={**headers, "Idempotency-Key": f"b5-{uuid.uuid4()}"},
        json={
            "snapshot": created.json()["id"],
            "engine": "random-search",
            "mode": "seeded",
            "optimization": OPTIMIZATION,
        },
    )

    assert job.status_code == 422, job.text
    assert "engine_mode_incompatible" in job.text
    assert "unsupported_capability_value" in job.text

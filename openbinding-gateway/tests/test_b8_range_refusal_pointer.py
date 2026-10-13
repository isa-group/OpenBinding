"""B8: refusing a job because of ranges points at the candidate feature value that carries the range."""

from __future__ import annotations

import json
import uuid
from dataclasses import replace

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.services.engines import MANIFEST_DIR
from bim_core import mode_compatibility
from bim_core.compiler import compile_instance
from bim_core.package import load_package

DEMO = REPO_ROOT / "examples/demo/01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
SOURCE_POINTER = "/spec/candidates/c1a/features/latency"
IR_POINTER = "/spec/candidates/catalog/candidates/c1a/features/latency"
RANGES = [
    {"min": 100, "max": None},
    {"min": None, "max": 200},
    {"min": None, "max": None},
    {"min": 1, "max": 2},
]


def package_with(latency):
    package = load_package(DEMO)
    catalog = json.loads(package.files["candidates.json"])
    catalog["spec"]["candidates"]["c1a"]["features"]["latency"] = latency
    package.files["candidates.json"] = json.dumps(catalog).encode()
    return package


def scalar_mode():
    manifests = [json.loads(path.read_text(encoding="utf-8")) for path in sorted(MANIFEST_DIR.glob("*.json"))]
    return next(
        mode
        for manifest in manifests
        for mode in manifest["spec"]["modes"]
        if mode["capabilities"].get("featureValues") == {"selector": "only", "values": ["scalar"]}
    )


def range_refusals(problem):
    return [
        item
        for item in mode_compatibility(problem, scalar_mode())
        if item["code"] == "unsupported_capability_value" and item["category"] == "featureValues"
    ]


@pytest.mark.parametrize("latency", RANGES)
def test_the_refusal_points_at_the_feature_value_of_the_candidate_with_the_range(latency):
    refusals = range_refusals(compile_instance(package_with(latency)))

    assert len(refusals) == 1
    assert refusals[0]["unsupported"] == ["interval"]
    assert refusals[0]["resource"] == "candidates.json"
    assert refusals[0]["pointer"] == SOURCE_POINTER
    assert refusals[0]["irPath"] == IR_POINTER


def test_the_pointer_names_the_first_candidate_that_carries_a_range():
    package = package_with({"min": 1, "max": 2})
    catalog = json.loads(package.files["candidates.json"])
    catalog["spec"]["candidates"]["c1b"]["features"]["latency"] = {"min": None, "max": 5}
    package.files["candidates.json"] = json.dumps(catalog).encode()

    refusals = range_refusals(compile_instance(package))

    assert [item["pointer"] for item in refusals] == [SOURCE_POINTER]


def test_a_package_with_only_single_values_has_no_range_refusal():
    assert range_refusals(compile_instance(load_package(DEMO))) == []


def test_without_a_source_map_the_refusal_keeps_only_the_ir_path():
    problem = compile_instance(package_with({"min": 1, "max": None}))
    refusals = range_refusals(replace(problem, source_map={}))

    assert len(refusals) == 1
    assert "pointer" not in refusals[0]
    assert "resource" not in refusals[0]
    assert refusals[0]["irPath"] == IR_POINTER


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
async def test_the_422_of_a_job_with_ranges_carries_the_pointer_in_its_diagnostic(api_client, registration):
    headers = await sign_in(api_client, registration)
    created = await api_client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package_with({"min": 100, "max": None}).to_zip(),
    )
    assert created.status_code == 201, created.text

    job = await api_client.post(
        "/v1/jobs",
        headers={**headers, "Idempotency-Key": f"b8-{uuid.uuid4()}"},
        json={
            "snapshot": created.json()["id"],
            "engine": "random-search",
            "mode": "seeded",
            "optimization": OPTIMIZATION,
        },
    )

    assert job.status_code == 422, job.text
    body = job.json()
    assert body["code"] == "engine_mode_incompatible"
    refusal = next(item for item in body["diagnostics"] if item["code"] == "unsupported_capability_value")
    assert refusal["resource"] == "candidates.json"
    assert refusal["pointer"] == SOURCE_POINTER
    assert refusal["irPath"] == IR_POINTER
    assert refusal["category"] == "featureValues"
    assert refusal["unsupported"] == ["interval"]
    assert refusal["allowed"] == ["scalar"]

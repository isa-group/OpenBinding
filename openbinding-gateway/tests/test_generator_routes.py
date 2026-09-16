"""Tests for /v1/generator API routes."""

from __future__ import annotations

import io
import uuid
import zipfile
import pytest

from openbinding_gateway import space_client
from _pricing import fake_pricing_gate, largest_plan

LARGER_PLAN = largest_plan()


async def _get_auth_headers(api_client, registration, platform_gate, username: str = "gen-user") -> dict[str, str]:
    details = registration(username=username, email=f"{username}@example.com")
    resp = await api_client.post("/v1/auth/register", json=details)
    assert resp.status_code == 201, resp.text
    user_id = resp.json()["id"]
    platform_gate.plans[uuid.UUID(user_id)] = LARGER_PLAN
    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.fixture
def platform_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


@pytest.mark.asyncio
async def test_generate_instance_endpoint_success(api_client):
    payload = {
        "tasks": 5,
        "candidates": 3,
        "control_flow": 30,
        "constraints": 1,
        "name": "api_test_inst",
        "target_engines": ["minizinc-csp"],
        "seed": 42,
    }
    resp = await api_client.post("/v1/generator/instances", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["name"] == "api_test_inst"
    assert "package_digest" in data
    assert "compilation_digest" in data
    assert "workload_features" in data
    assert data["workload_features"]["N_tasks"] > 0

    # Check 6 BIM v1 files
    files = data["files"]
    for expected_file in [
        "instance.json",
        "application.json",
        "candidates.json",
        "constraints.json",
        "optimization.json",
        "routing.json",
    ]:
        assert expected_file in files


@pytest.mark.asyncio
async def test_generate_instance_incompatible_engines(api_client):
    payload = {
        "tasks": 6,
        "candidates": 3,
        "target_engines": ["minizinc-csp", "many-heuristic"],
    }
    resp = await api_client.post("/v1/generator/instances", json=payload)
    assert resp.status_code == 422, resp.text
    detail = resp.json()
    assert detail.get("detail", {}).get("code") == "incompatible_target_engines"


@pytest.mark.asyncio
async def test_generate_instance_persist(api_client, registration, platform_gate):
    headers = await _get_auth_headers(api_client, registration, platform_gate, username="persister")

    # Create Org & Project
    org_slug = f"org-{uuid.uuid4().hex[:6]}"
    proj_slug = "test-proj"
    r = await api_client.post("/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Test Org"})
    assert r.status_code == 201
    r = await api_client.post(f"/v1/organizations/{org_slug}/projects", headers=headers, json={"slug": proj_slug, "name": "Test Proj", "visibility": "private"})
    assert r.status_code == 201
    proj_id = r.json()["id"]

    payload = {
        "tasks": 4,
        "candidates": 2,
        "name": "persisted_inst",
        "persist": True,
        "project_id": proj_id,
        "case_name": "My Case",
    }
    resp = await api_client.post("/v1/generator/instances", headers=headers, json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["snapshot_id"] is not None
    assert data["case_id"] is not None


@pytest.mark.asyncio
async def test_generate_corpus_endpoint(api_client):
    payload = {
        "count": 3,
        "name": "bench_corpus",
        "base_config": {
            "tasks": 4,
            "candidates": 2,
            "constraints": 1,
        },
    }
    resp = await api_client.post("/v1/generator/corpus", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["name"] == "bench_corpus"
    assert data["count"] == 3
    assert len(data["instances"]) == 3
    for inst in data["instances"]:
        assert "package_digest" in inst
        assert "workload_features" in inst


@pytest.mark.asyncio
async def test_generate_corpus_as_zip_archive(api_client):
    payload = {
        "count": 2,
        "name": "zip_corpus",
        "as_archive": True,
        "base_config": {
            "tasks": 3,
            "candidates": 2,
        },
    }
    resp = await api_client.post("/v1/generator/corpus", json=payload)
    assert resp.status_code == 200, resp.text
    assert resp.headers.get("content-type") == "application/zip"

    # Verify zip content
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        namelist = zf.namelist()
        assert len(namelist) == 2
        for item in namelist:
            assert item.endswith(".bim.zip")
            inner_zip = zf.read(item)
            with zipfile.ZipFile(io.BytesIO(inner_zip)) as izf:
                assert "instance.json" in izf.namelist()
                assert "application.json" in izf.namelist()


@pytest.mark.asyncio
async def test_convert_legacy_endpoint(api_client):
    raw_text = """SEC
  T1
  T2
END

CANDIDATES
  T1:
    c1: 10.0, 50.0
  T2:
    c2: 20.0, 30.0
END

QOS_MODEL
  latency: ms, MIN, ADD
  cost: eur, MIN, ADD
END

CONSTRAINTS
  latency <= 50.0
END
"""
    payload = {
        "raw_text": raw_text,
        "name": "converted_from_api",
        "guarantee_feasibility": True,
        "tension": 0.6,
    }
    resp = await api_client.post("/v1/generator/convert-legacy", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["name"] == "converted_from_api"
    assert "package_digest" in data
    assert "workload_features" in data
    assert "application.json" in data["files"]


@pytest.mark.asyncio
async def test_calibrate_engine_endpoint(api_client):
    observations = [
        {
            "workload_features": {"S": 10.0, "D_constr": 1, "N_tasks": 10, "N_cap": 5, "D_obj": 1, "T_budget": 60},
            "latency": 1.2,
            "quality": 0.95,
            "success": True,
        },
        {
            "workload_features": {"S": 20.0, "D_constr": 1, "N_tasks": 20, "N_cap": 5, "D_obj": 1, "T_budget": 60},
            "latency": 3.4,
            "quality": 0.91,
            "success": True,
        },
    ]
    payload = {
        "engine": "evolutionary-heuristics",
        "mode": "single-term",
        "observations": observations,
    }
    resp = await api_client.post("/v1/generator/calibrate-engine", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["engine"] == "evolutionary-heuristics"
    assert data["mode"] == "single-term"
    assert data["sample_count"] == 2
    assert data["status"] == "calibrated"
    assert "latency_coefficients" in data

"""Tests for the Cryptographic Provenance & Digest Verifier API."""

from __future__ import annotations

import uuid
import pytest
import pytest_asyncio

from openbinding_gateway import space_client
from openbinding_gateway.v1.canonical import digest
from _pricing import fake_pricing_gate, largest_plan

LARGER_PLAN = largest_plan()


@pytest_asyncio.fixture
async def verifier_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


async def _auth_headers(api_client, registration, verifier_gate, username: str = "verifier-user") -> dict[str, str]:
    details = registration(username=username, email=f"{username}@example.com")
    resp = await api_client.post("/v1/auth/register", json=details)
    assert resp.status_code == 201, resp.text
    user_id = resp.json()["id"]
    verifier_gate.plans[uuid.UUID(user_id)] = LARGER_PLAN
    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.mark.asyncio
async def test_verifier_inspect_document_computation(api_client, registration, verifier_gate):
    headers = await _auth_headers(api_client, registration, verifier_gate, username=f"user-{uuid.uuid4().hex[:6]}")

    sample_doc = {
        "apiVersion": "bim/v1",
        "kind": "BindingCase",
        "spec": {
            "tasks": ["t1", "t2"],
            "sla": {"latency_ms": 50.0},
        },
    }
    expected_digest = digest(sample_doc)

    # 1. Inspect without providing digest -> computes canonical digest
    resp = await api_client.post(
        "/v1/verifier/inspect",
        headers=headers,
        json={"document": sample_doc},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "computed"
    assert data["digest"] == expected_digest
    assert data["matches"] is True
    assert data["canonical_json"] is not None
    assert data["citation"] is not None
    assert "@misc" in data["citation"]["bibtex"]
    assert "OpenBinding" in data["citation"]["markdown_badge"]

    # 2. Inspect with matching digest -> status is verified
    resp_match = await api_client.post(
        "/v1/verifier/inspect",
        headers=headers,
        json={"digest": expected_digest, "document": sample_doc},
    )
    assert resp_match.status_code == 200
    data_match = resp_match.json()
    assert data_match["status"] == "verified"
    assert data_match["matches"] is True

    # 3. Inspect with mismatched digest -> status is mismatch
    wrong_digest = "sha256-" + "0" * 64
    resp_mismatch = await api_client.post(
        "/v1/verifier/inspect",
        headers=headers,
        json={"digest": wrong_digest, "document": sample_doc},
    )
    assert resp_mismatch.status_code == 200
    data_mismatch = resp_mismatch.json()
    assert data_mismatch["status"] == "mismatch"
    assert data_mismatch["matches"] is False


@pytest.mark.asyncio
async def test_verifier_inspect_registered_entity(api_client, registration, verifier_gate):
    headers = await _auth_headers(api_client, registration, verifier_gate, username=f"user-{uuid.uuid4().hex[:6]}")
    org_slug = f"org-{uuid.uuid4().hex[:6]}"
    proj_slug = "verifier-proj"

    # Create Org, Project, and Case
    await api_client.post("/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Verifier Org"})
    await api_client.post(f"/v1/organizations/{org_slug}/projects", headers=headers, json={"slug": proj_slug, "name": "Verifier Proj", "visibility": "public"})

    case_doc = {"apiVersion": "bim/v1", "kind": "BindingCase", "title": "Sequential Workflow"}
    c_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/cases",
        headers=headers,
        json={"slug": "seq-case", "name": "Sequential Case", "description": "Benchmark"},
    )
    assert c_resp.status_code == 201

    rev_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/cases/seq-case/revisions",
        headers=headers,
        json={"document": case_doc},
    )
    assert rev_resp.status_code == 201
    case_digest = rev_resp.json()["digest"]

    # Verify by digest alone -> finds the registered case revision
    inspect_resp = await api_client.post(
        "/v1/verifier/inspect",
        headers=headers,
        json={"digest": case_digest},
    )
    assert inspect_resp.status_code == 200
    data = inspect_resp.json()
    assert data["status"] == "verified"
    assert data["matches"] is True
    assert len(data["entities"]) >= 1

    matched = data["entities"][0]
    assert matched["entity_type"] == "case"
    assert matched["slug"] == "seq-case"
    assert matched["organization_slug"] == org_slug
    assert matched["project_slug"] == proj_slug

    citation = data["citation"]
    assert "Sequential Case" in citation["title"]
    assert case_digest in citation["bibtex"]


@pytest.mark.asyncio
async def test_verifier_inspect_file(api_client, registration, verifier_gate):
    headers = await _auth_headers(api_client, registration, verifier_gate, username=f"user-{uuid.uuid4().hex[:6]}")

    file_bytes = b"OpenBinding Reproducibility Artifact Archive Package"
    file_digest = "sha256-" + pytest.importorskip("hashlib").sha256(file_bytes).hexdigest()

    resp = await api_client.post(
        "/v1/verifier/inspect-file",
        headers={**headers, "x-filename": "archive.zip", "content-type": "application/zip"},
        content=file_bytes,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "computed"
    assert data["digest"] == file_digest
    assert data["matches"] is True
    assert "archive.zip" in data["detail"]

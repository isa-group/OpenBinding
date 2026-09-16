"""Tests for the universal cryptographic resolver (/v1/resolve)."""

from __future__ import annotations

import uuid
import pytest_asyncio

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings
from _pricing import fake_pricing_gate, largest_plan


@pytest_asyncio.fixture
async def platform_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


async def create_user(client, registration) -> tuple[dict, dict[str, str]]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    login = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login.status_code == 200, login.text
    return created.json(), {"Authorization": f"Bearer {login.json()['access_token']}"}


async def create_project(client, headers, *, visibility="public") -> tuple[str, str]:
    org_slug = f"org-{uuid.uuid4().hex[:8]}"
    created_org = await client.post(
        "/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Test Org"}
    )
    assert created_org.status_code == 201, created_org.text
    project_slug = f"proj-{uuid.uuid4().hex[:8]}"
    created_project = await client.post(
        f"/v1/organizations/{org_slug}/projects",
        headers=headers,
        json={"slug": project_slug, "name": "Test Project", "visibility": visibility},
    )
    assert created_project.status_code == 201, created_project.text
    return org_slug, project_slug


async def test_resolve_public_and_private_case_revisions(
    api_client, registration, platform_gate, monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    get_settings.cache_clear()

    # Create User 1 (Alice)
    alice, alice_headers = await create_user(api_client, registration)
    platform_gate.plans[uuid.UUID(alice["id"])] = largest_plan()

    # Create User 2 (Bob - unauthorized outsider)
    bob, bob_headers = await create_user(api_client, registration)
    platform_gate.plans[uuid.UUID(bob["id"])] = largest_plan()

    # Alice creates a public project and a private project
    pub_org, pub_proj = await create_project(api_client, alice_headers, visibility="public")
    priv_org, priv_proj = await create_project(api_client, alice_headers, visibility="private")

    # Upload case in public project
    case_doc = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "public-case"},
        "spec": {"profile": "qos-binding/v1", "resources": {"application": {"app": "app.json"}}},
    }
    pub_case_resp = await api_client.post(
        f"/v1/organizations/{pub_org}/projects/{pub_proj}/cases",
        headers=alice_headers,
        json={"slug": "public-case", "name": "Public Case"},
    )
    assert pub_case_resp.status_code == 201
    pub_case_rev = await api_client.post(
        f"/v1/organizations/{pub_org}/projects/{pub_proj}/cases/public-case/revisions",
        headers=alice_headers,
        json={"document": case_doc},
    )
    assert pub_case_rev.status_code == 201
    pub_digest = pub_case_rev.json()["digest"]

    # Upload case in private project
    priv_case_doc = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "secret-case"},
        "spec": {"profile": "qos-binding/v1", "resources": {"application": {"app": "secret.json"}}},
    }
    priv_case_resp = await api_client.post(
        f"/v1/organizations/{priv_org}/projects/{priv_proj}/cases",
        headers=alice_headers,
        json={"slug": "secret-case", "name": "Secret Case"},
    )
    assert priv_case_resp.status_code == 201
    priv_case_rev = await api_client.post(
        f"/v1/organizations/{priv_org}/projects/{priv_proj}/cases/secret-case/revisions",
        headers=alice_headers,
        json={"document": priv_case_doc},
    )
    assert priv_case_rev.status_code == 201
    priv_digest = priv_case_rev.json()["digest"]

    # 1. Public digest is accessible anonymously
    anon_pub = await api_client.get(f"/v1/resolve/case-revision/{pub_digest}")
    assert anon_pub.status_code == 200
    assert anon_pub.json()["verified"] is True
    assert anon_pub.json()["kind"] == "case-revision"
    assert anon_pub.json()["digest"] == pub_digest
    assert len(anon_pub.json()["locations"]) == 1
    assert anon_pub.json()["locations"][0]["project"]["slug"] == pub_proj

    # Content is downloadable anonymously
    anon_pub_content = await api_client.get(f"/v1/resolve/case-revision/{pub_digest}/content")
    assert anon_pub_content.status_code == 200
    assert anon_pub_content.json()["metadata"]["name"] == "public-case"
    assert "public" in anon_pub_content.headers["cache-control"]

    # 2. Private digest is completely hidden from anonymous users (404 Not Found)
    anon_priv = await api_client.get(f"/v1/resolve/case-revision/{priv_digest}")
    assert anon_priv.status_code == 404
    anon_priv_content = await api_client.get(f"/v1/resolve/case-revision/{priv_digest}/content")
    assert anon_priv_content.status_code == 404

    # 3. Private digest is hidden from Bob (outsider) -> 404 Not Found (no oracle leaks)
    bob_priv = await api_client.get(f"/v1/resolve/case-revision/{priv_digest}", headers=bob_headers)
    assert bob_priv.status_code == 404
    bob_priv_content = await api_client.get(f"/v1/resolve/case-revision/{priv_digest}/content", headers=bob_headers)
    assert bob_priv_content.status_code == 404

    # 4. Private digest is accessible to Alice (owner/member)
    alice_priv = await api_client.get(f"/v1/resolve/case-revision/{priv_digest}", headers=alice_headers)
    assert alice_priv.status_code == 200
    assert alice_priv.json()["verified"] is True
    assert alice_priv.json()["locations"][0]["project"]["slug"] == priv_proj
    assert alice_priv.json()["locations"][0]["project"]["visibility"] == "private"

    # Alice can download private content
    alice_priv_content = await api_client.get(f"/v1/resolve/case-revision/{priv_digest}/content", headers=alice_headers)
    assert alice_priv_content.status_code == 200
    assert alice_priv_content.json()["metadata"]["name"] == "secret-case"
    assert "private" in alice_priv_content.headers["cache-control"]


async def test_resolve_multi_location_and_pagination(
    api_client, registration, platform_gate, monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    get_settings.cache_clear()

    alice, alice_headers = await create_user(api_client, registration)
    platform_gate.plans[uuid.UUID(alice["id"])] = largest_plan()

    # Create 3 projects owned by Alice
    projects = []
    for _ in range(3):
        org, proj = await create_project(api_client, alice_headers, visibility="public")
        projects.append((org, proj))

    # Create an identical case revision across all 3 projects
    shared_doc = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "shared-benchmark"},
        "spec": {"profile": "qos-binding/v1", "resources": {"app": "shared.json"}},
    }

    shared_digest = None
    for org, proj in projects:
        await api_client.post(
            f"/v1/organizations/{org}/projects/{proj}/cases",
            headers=alice_headers,
            json={"slug": "shared-case", "name": "Shared Case"},
        )
        rev = await api_client.post(
            f"/v1/organizations/{org}/projects/{proj}/cases/shared-case/revisions",
            headers=alice_headers,
            json={"document": shared_doc},
        )
        shared_digest = rev.json()["digest"]

    # Resolve with limit=2, offset=0
    res_page1 = await api_client.get(
        f"/v1/resolve/case-revision/{shared_digest}?limit=2&offset=0", headers=alice_headers
    )
    assert res_page1.status_code == 200
    data1 = res_page1.json()
    assert data1["pagination"]["total"] == 3
    assert data1["pagination"]["limit"] == 2
    assert data1["pagination"]["offset"] == 0
    assert data1["pagination"]["has_more"] is True
    assert len(data1["locations"]) == 2

    # Resolve with limit=2, offset=2 (page 2)
    res_page2 = await api_client.get(
        f"/v1/resolve/case-revision/{shared_digest}?limit=2&offset=2", headers=alice_headers
    )
    assert res_page2.status_code == 200
    data2 = res_page2.json()
    assert data2["pagination"]["total"] == 3
    assert data2["pagination"]["limit"] == 2
    assert data2["pagination"]["offset"] == 2
    assert data2["pagination"]["has_more"] is False
    assert len(data2["locations"]) == 1


async def test_resolve_digest_tolerance_and_invalid_kind(
    api_client, registration, platform_gate, monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    get_settings.cache_clear()

    alice, alice_headers = await create_user(api_client, registration)
    platform_gate.plans[uuid.UUID(alice["id"])] = largest_plan()

    org, proj = await create_project(api_client, alice_headers, visibility="public")
    artifact_bytes = b"sample reproducible binary payload\n"
    art_resp = await api_client.post(
        f"/v1/organizations/{org}/projects/{proj}/blobs?public=true",
        headers={**alice_headers, "Content-Type": "text/plain"},
        content=artifact_bytes,
    )
    assert art_resp.status_code == 201
    digest_val = art_resp.json()["digest"]  # format "sha256-..."
    raw_hex = digest_val.removeprefix("sha256-")

    # 1. Bare hex format should resolve cleanly
    res_bare = await api_client.get(f"/v1/resolve/artifact/{raw_hex}")
    assert res_bare.status_code == 200
    assert res_bare.json()["digest"] == digest_val

    # 2. Colon prefix "sha256:..." should resolve cleanly
    res_colon = await api_client.get(f"/v1/resolve/artifact/sha256:{raw_hex}")
    assert res_colon.status_code == 200
    assert res_colon.json()["digest"] == digest_val

    # 3. Invalid kind -> 404
    res_invalid_kind = await api_client.get(f"/v1/resolve/non-existent-kind/{digest_val}")
    assert res_invalid_kind.status_code == 404

    # 4. Malformed digest -> 404
    res_malformed = await api_client.get("/v1/resolve/artifact/too-short")
    assert res_malformed.status_code == 404

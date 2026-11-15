"""Tests for CRUD extensions on platform elements: problems, studies, jobs and engine revisions."""

from __future__ import annotations

import uuid
import pytest
import pytest_asyncio

from openbinding_gateway import space_client
from _pricing import fake_pricing_gate, largest_plan
from _problem_helpers import placeholder_refs, upload_problem

LARGER_PLAN = largest_plan()


@pytest_asyncio.fixture
async def platform_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


async def _auth_headers(api_client, registration, platform_gate, username: str = "test-crud-user") -> dict[str, str]:
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


@pytest.mark.asyncio
async def test_problem_patch_and_delete(api_client, registration, platform_gate):
    headers = await _auth_headers(api_client, registration, platform_gate, username=f"user-{uuid.uuid4().hex[:6]}")
    org_slug = f"org-{uuid.uuid4().hex[:6]}"
    r = await api_client.post("/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Test Org"})
    assert r.status_code == 201
    await upload_problem(api_client, headers, org_slug, slug="case-a")
    url = f"/v1/organizations/{org_slug}/problems/case-a"

    get_c = await api_client.get(url, headers=headers)
    assert get_c.status_code == 200
    assert get_c.json()["slug"] == "case-a"

    patch_c = await api_client.patch(url, headers=headers, json={"name": "Case Alpha Updated", "description": "New Desc"})
    assert patch_c.status_code == 200
    assert patch_c.json()["name"] == "Case Alpha Updated"
    assert patch_c.json()["description"] == "New Desc"

    del_c = await api_client.delete(url, headers=headers)
    assert del_c.status_code == 204

    # Verify deleted
    list_c = await api_client.get(f"/v1/organizations/{org_slug}/problems", headers=headers)
    assert list_c.status_code == 200
    assert list_c.json()["problems"] == []


@pytest.mark.asyncio
async def test_study_patch_and_delete(api_client, registration, platform_gate):
    headers = await _auth_headers(api_client, registration, platform_gate, username=f"user-{uuid.uuid4().hex[:6]}")
    org_slug = f"org-{uuid.uuid4().hex[:6]}"
    await api_client.post("/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Test Org"})

    from openbinding_gateway.routes import v1 as routes
    from openbinding_gateway.services.engines import engine_ref

    # A problem revision of the organization for the study
    case_rev_id = (await upload_problem(api_client, headers, org_slug, slug="case-for-study"))["revision_id"]

    # Study CRUD
    study_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/studies",
        headers=headers,
        json={
            "slug": "study-a",
            "name": "Study Alpha",
            "description": "Initial study",
            "definition": {
                "revision_ids": [case_rev_id],
                "engines": [{**engine_ref(routes._manifest("random-search"), "bim.builtin"), "mode": "seeded",
                             "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"}}],
                "parameter_sets": [{}],
                "seeds": [42],
            },
        },
    )
    assert study_resp.status_code == 201

    study_patch = await api_client.patch(
        f"/v1/organizations/{org_slug}/studies/study-a",
        headers=headers,
        json={"name": "Study Alpha Updated", "description": "Updated description"},
    )
    assert study_patch.status_code == 200
    assert study_patch.json()["name"] == "Study Alpha Updated"

    study_del = await api_client.delete(
        f"/v1/organizations/{org_slug}/studies/study-a",
        headers=headers,
    )
    assert study_del.status_code == 204


@pytest.mark.asyncio
async def test_organization_runs_and_engine_revisions(api_client, registration, db_session, platform_gate):
    headers = await _auth_headers(api_client, registration, platform_gate, username=f"user-{uuid.uuid4().hex[:6]}")
    org_slug = f"org-{uuid.uuid4().hex[:6]}"
    await api_client.post("/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Test Org"})

    # Large result payloads are omitted from the run list and fetched only for the selected run.
    from sqlalchemy import select
    from openbinding_gateway.db.models import Job, JobState, Organization
    organization = (await db_session.execute(select(Organization).where(Organization.slug == org_slug))).scalars().first()
    job = Job(created_by_id=organization.created_by_id, organization_id=organization.id,
              engine_id="diagnostic", engine_job_id="metadata-fixture", service_url="https://example.invalid",
              state=JobState.COMPLETED, original_request={"evidence": "pinned"}, result={"solutions": [{"large": "evidence"}]},
              provenance={"engine": {"namespace": "bim.builtin", "name": "diagnostic", "version": "1", "digest": "sha256-d"}},
              **placeholder_refs("organization_id"))
    db_session.add(job)
    await db_session.commit()
    metadata = await api_client.get(f"/v1/organizations/{org_slug}/runs", headers=headers)
    assert metadata.status_code == 200
    assert metadata.json()["total"] == 1
    assert metadata.json()["runs"][0]["result"] is None and metadata.json()["runs"][0]["original_request"] is None
    detail = await api_client.get(f"/v1/organizations/{org_slug}/runs/{job.id}", headers=headers)
    assert detail.json()["id"] == str(job.id)
    assert detail.json()["result"] == job.result

    # GET engine revisions
    eng_revs = await api_client.get("/v1/engines/revisions", headers=headers)
    assert eng_revs.status_code == 200
    assert "revisions" in eng_revs.json()

"""Tests for CRUD extensions on platform elements: cases, resources, collections,
studies, reports, publications, artifacts, jobs, snapshots, and engine revisions.
"""

from __future__ import annotations

import io
import uuid
import zipfile
import pytest
import pytest_asyncio

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import InstanceSnapshot, BindingIRSnapshot
from _pricing import fake_pricing_gate, largest_plan

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
async def test_case_and_resource_patch_and_delete(api_client, registration, platform_gate):
    headers = await _auth_headers(api_client, registration, platform_gate, username=f"user-{uuid.uuid4().hex[:6]}")
    org_slug = f"org-{uuid.uuid4().hex[:6]}"
    proj_slug = "test-proj"

    # Create Org & Project
    r = await api_client.post("/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Test Org"})
    assert r.status_code == 201
    r = await api_client.post(f"/v1/organizations/{org_slug}/projects", headers=headers, json={"slug": proj_slug, "name": "Test Proj", "visibility": "private"})
    assert r.status_code == 201

    # Case CRUD
    c_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/cases",
        headers=headers,
        json={"slug": "case-a", "name": "Case Alpha", "description": "Desc"},
    )
    assert c_resp.status_code == 201

    get_c = await api_client.get(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/cases/case-a",
        headers=headers,
    )
    assert get_c.status_code == 200
    assert get_c.json()["name"] == "Case Alpha"

    patch_c = await api_client.patch(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/cases/case-a",
        headers=headers,
        json={"name": "Case Alpha Updated", "description": "New Desc"},
    )
    assert patch_c.status_code == 200
    assert patch_c.json()["name"] == "Case Alpha Updated"
    assert patch_c.json()["description"] == "New Desc"

    del_c = await api_client.delete(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/cases/case-a",
        headers=headers,
    )
    assert del_c.status_code == 204

    # Verify deleted
    list_c = await api_client.get(f"/v1/organizations/{org_slug}/projects/{proj_slug}/cases", headers=headers)
    assert list_c.status_code == 200
    assert len(list_c.json()) == 0

    # Resource CRUD
    r_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/resources",
        headers=headers,
        json={"slug": "res-a", "name": "Resource Alpha", "description": "Desc", "kind": "catalog"},
    )
    assert r_resp.status_code == 201

    patch_r = await api_client.patch(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/resources/res-a",
        headers=headers,
        json={"name": "Resource Alpha Updated", "description": "New Resource Desc"},
    )
    assert patch_r.status_code == 200
    assert patch_r.json()["name"] == "Resource Alpha Updated"

    del_r = await api_client.delete(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/resources/res-a",
        headers=headers,
    )
    assert del_r.status_code == 204

    list_r = await api_client.get(f"/v1/organizations/{org_slug}/projects/{proj_slug}/resources", headers=headers)
    assert list_r.status_code == 200
    assert len(list_r.json()) == 0


@pytest.mark.asyncio
async def test_collection_and_study_patch_and_delete(api_client, registration, platform_gate):
    headers = await _auth_headers(api_client, registration, platform_gate, username=f"user-{uuid.uuid4().hex[:6]}")
    org_slug = f"org-{uuid.uuid4().hex[:6]}"
    proj_slug = "test-proj"

    await api_client.post("/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Test Org"})
    await api_client.post(f"/v1/organizations/{org_slug}/projects", headers=headers, json={"slug": proj_slug, "name": "Test Proj", "visibility": "private"})

    # Collection CRUD
    coll_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/collections",
        headers=headers,
        json={"slug": "coll-a", "name": "Collection Alpha", "description": "Initial"},
    )
    assert coll_resp.status_code == 201

    coll_patch = await api_client.patch(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/collections/coll-a",
        headers=headers,
        json={"name": "Collection Alpha Updated", "description": "Updated"},
    )
    assert coll_patch.status_code == 200
    assert coll_patch.json()["name"] == "Collection Alpha Updated"

    coll_del = await api_client.delete(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/collections/coll-a",
        headers=headers,
    )
    assert coll_del.status_code == 204

    from test_studies_platform import executable_revision_payload
    from openbinding_gateway.routes import v1 as routes

    # Create Case and Revision for Study
    await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/cases",
        headers=headers,
        json={"slug": "case-for-study", "name": "Study Case"},
    )
    rev_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/cases/case-for-study/revisions",
        headers=headers,
        json=await executable_revision_payload(api_client, headers),
    )
    case_rev_id = rev_resp.json()["id"]

    # Study CRUD
    study_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/studies",
        headers=headers,
        json={
            "slug": "study-a",
            "name": "Study Alpha",
            "description": "Initial study",
            "definition": {
                "case_revision_ids": [case_rev_id],
                "engines": [{**routes._engine_ref(routes._manifest("random-search"), "bim.builtin"), "mode": "seeded"}],
                "parameter_sets": [{}],
                "seeds": [42],
            },
        },
    )
    assert study_resp.status_code == 201

    study_patch = await api_client.patch(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/studies/study-a",
        headers=headers,
        json={"name": "Study Alpha Updated", "description": "Updated description"},
    )
    assert study_patch.status_code == 200
    assert study_patch.json()["name"] == "Study Alpha Updated"

    study_del = await api_client.delete(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/studies/study-a",
        headers=headers,
    )
    assert study_del.status_code == 204


@pytest.mark.asyncio
async def test_report_draft_mutation_frozen_immutability_and_delete(api_client, registration, platform_gate):
    headers = await _auth_headers(api_client, registration, platform_gate, username=f"user-{uuid.uuid4().hex[:6]}")
    org_slug = f"org-{uuid.uuid4().hex[:6]}"
    proj_slug = "test-proj"

    await api_client.post("/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Test Org"})
    await api_client.post(f"/v1/organizations/{org_slug}/projects", headers=headers, json={"slug": proj_slug, "name": "Test Proj", "visibility": "private"})

    valid_document = {
        "summary": "Draft notes",
        "provenance": {
            "study": {
                "reference": "exact-vs-heuristic",
                "digest": "sha256-" + "b" * 64,
            },
            "datasets": [
                {
                    "reference": "catalog-1",
                    "digest": "sha256-" + "c" * 64,
                }
            ],
            "software": [
                {
                    "name": "OpenBinding",
                    "version": "1.0.0",
                    "digest": "sha256-" + "d" * 64,
                }
            ],
            "bimVersion": "bim/v1",
            "engineRevisions": [
                {
                    "name": "minizinc-csp",
                    "version": "1.0.0",
                    "digest": "sha256-" + "a" * 64,
                }
            ],
            "parameters": {"solver": "gecode"},
        },
    }

    # Create draft report
    rep_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/reports",
        headers=headers,
        json={"slug": "rep-a", "title": "Draft Report Alpha", "document": valid_document},
    )
    assert rep_resp.status_code == 201
    assert rep_resp.json()["state"] == "draft"

    get_rep = await api_client.get(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/reports/rep-a",
        headers=headers,
    )
    assert get_rep.status_code == 200
    assert get_rep.json()["slug"] == "rep-a"

    # PATCH draft report -> allowed
    patch_resp = await api_client.patch(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/reports/rep-a",
        headers=headers,
        json={"title": "Updated Draft Report Alpha"},
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["title"] == "Updated Draft Report Alpha"

    # Freeze report -> becomes frozen
    freeze_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/reports/rep-a/freeze",
        headers=headers,
    )
    assert freeze_resp.status_code == 200, freeze_resp.text
    assert freeze_resp.json()["state"] == "frozen"

    # PATCH frozen report -> 409 Conflict
    patch_frozen = await api_client.patch(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/reports/rep-a",
        headers=headers,
        json={"title": "Illegal edit on frozen report"},
    )
    assert patch_frozen.status_code == 409
    assert "immutable" in patch_frozen.text.lower()

    # Publish report -> creates publication
    pub_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/publications",
        headers=headers,
        json={"report_id": rep_resp.json()["id"], "slug": "pub-a", "citation": {"authors": ["Alice"]}},
    )
    assert pub_resp.status_code == 201

    # DELETE publication -> 204
    del_pub = await api_client.delete(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/publications/pub-a",
        headers=headers,
    )
    assert del_pub.status_code == 204

    # DELETE report -> 204
    del_rep = await api_client.delete(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/reports/rep-a",
        headers=headers,
    )
    assert del_rep.status_code == 409
    first_version = freeze_resp.json()['version_id']
    first_digest = freeze_resp.json()['digest']
    first_document = freeze_resp.json()['document']
    new_draft = await api_client.post(f"/v1/organizations/{org_slug}/projects/{proj_slug}/reports/rep-a/drafts", headers=headers)
    assert new_draft.status_code == 200, new_draft.text
    corrected = {**first_document, 'correction': 'Updated interpretation, same retained evidence.'}
    edited = await api_client.patch(f"/v1/organizations/{org_slug}/projects/{proj_slug}/reports/rep-a", headers=headers,
        json={'document': corrected, 'draft_revision': new_draft.json()['draft_revision']})
    assert edited.status_code == 200, edited.text
    stale = await api_client.patch(f"/v1/organizations/{org_slug}/projects/{proj_slug}/reports/rep-a", headers=headers,
        json={'document': first_document, 'draft_revision': new_draft.json()['draft_revision']})
    assert stale.status_code == 409
    second_version = await api_client.post(f"/v1/organizations/{org_slug}/projects/{proj_slug}/reports/rep-a/freeze", headers=headers)
    assert second_version.status_code == 200, second_version.text
    assert second_version.json()['version_id'] != first_version
    assert second_version.json()['artifact_id'] == freeze_resp.json()['artifact_id']
    published_second = await api_client.post(f"/v1/organizations/{org_slug}/projects/{proj_slug}/publications", headers=headers,
        json={'report_id': rep_resp.json()['id'], 'slug': 'report-edition-two', 'version_id': second_version.json()['version_id']})
    assert published_second.status_code == 201, published_second.text

    historical = await api_client.get(f'/v1/resolve/report/{first_digest}/content')
    assert historical.status_code == 200, historical.text
    assert historical.json() == first_document
    withdrawn = await api_client.delete(f"/v1/organizations/{org_slug}/projects/{proj_slug}/publications/pub-a", headers=headers)
    assert withdrawn.status_code == 204
    editions = await api_client.get(f"/v1/organizations/{org_slug}/projects/{proj_slug}/publications", headers=headers)
    historical_edition = next(edition for edition in editions.json() if edition['version_id'] == first_version)
    assert historical_edition['withdrawn'] is True
    assert historical_edition['citation']['authors'] == ['Alice']
    assert (await api_client.get(f'/v1/resolve/report/{first_digest}/content')).json() == first_document



@pytest.mark.asyncio
async def test_artifact_delete(api_client, registration, platform_gate, monkeypatch, tmp_path):
    monkeypatch.setenv("ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    get_settings.cache_clear()

    headers = await _auth_headers(api_client, registration, platform_gate, username=f"user-{uuid.uuid4().hex[:6]}")
    org_slug = f"org-{uuid.uuid4().hex[:6]}"
    proj_slug = "test-proj"

    await api_client.post("/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Test Org"})
    await api_client.post(f"/v1/organizations/{org_slug}/projects", headers=headers, json={"slug": proj_slug, "name": "Test Proj", "visibility": "private"})

    # Upload artifact
    artifact_content = b"artifact raw test data"
    up_resp = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/blobs",
        headers={**headers, "Content-Type": "application/octet-stream"},
        content=artifact_content,
    )
    assert up_resp.status_code == 201
    digest = up_resp.json()["digest"]

    # Delete artifact
    del_resp = await api_client.delete(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/blobs/{digest}",
        headers=headers,
    )
    assert del_resp.status_code == 204

    # Verify not found
    get_resp = await api_client.get(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/blobs/{digest}",
        headers=headers,
    )
    assert get_resp.status_code == 404


@pytest.mark.asyncio
async def test_project_jobs_snapshots_and_engine_revisions(api_client, registration, db_session, platform_gate):
    headers = await _auth_headers(api_client, registration, platform_gate, username=f"user-{uuid.uuid4().hex[:6]}")
    org_slug = f"org-{uuid.uuid4().hex[:6]}"
    proj_slug = "test-proj"

    await api_client.post("/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Test Org"})
    await api_client.post(f"/v1/organizations/{org_slug}/projects", headers=headers, json={"slug": proj_slug, "name": "Test Proj", "visibility": "private"})

    # Large result payloads are omitted from the summary request and fetched only for the selected job.
    from sqlalchemy import select
    from openbinding_gateway.db.models import Job, JobState, Project
    project = (await db_session.execute(select(Project).where(Project.slug == proj_slug))).scalars().first()
    job = Job(owner_id=project.created_by_id, project_id=project.id, organization_id=project.organization_id,
              engine_id="diagnostic", engine_job_id="metadata-fixture", service_url="https://example.invalid",
              state=JobState.COMPLETED, original_request={"evidence": "pinned"}, result={"solutions": [{"large": "evidence"}]})
    db_session.add(job)
    await db_session.commit()
    metadata = await api_client.get(f"/v1/organizations/{org_slug}/projects/{proj_slug}/jobs?include_results=false", headers=headers)
    assert metadata.status_code == 200
    assert metadata.json()[0]["result"] is None and metadata.json()[0]["original_request"] is None
    detail = await api_client.get(f"/v1/organizations/{org_slug}/projects/{proj_slug}/jobs?job_id={job.id}", headers=headers)
    assert [row["id"] for row in detail.json()] == [str(job.id)]
    assert detail.json()[0]["result"] == job.result

    # GET project jobs
    jobs_resp = await api_client.get(f"/v1/organizations/{org_slug}/projects/{proj_slug}/jobs", headers=headers)
    assert jobs_resp.status_code == 200
    assert isinstance(jobs_resp.json(), list)

    # GET engine revisions
    eng_revs = await api_client.get("/v1/engines/revisions", headers=headers)
    assert eng_revs.status_code == 200
    assert "revisions" in eng_revs.json()

    # Snapshot retrieval
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("model.bim", "apiVersion: bim/v1\nkind: BindingProblem\n")
    archive_bytes = buf.getvalue()

    snap = InstanceSnapshot(
        name="test-snapshot",
        instance_digest="sha256-" + "1" * 64,
        package_digest="sha256-" + "2" * 64,
        root_document={},
        resource_digests={},
        source_archive=archive_bytes,
    )
    db_session.add(snap)
    await db_session.flush()

    ir_snap = BindingIRSnapshot(
        snapshot_id=snap.id,
        ir_digest="sha256-" + "3" * 64,
        document={"apiVersion": "bim/v1", "kind": "BindingProblem"},
        source_map={},
        compiler_version="1.0.0",
    )
    db_session.add(ir_snap)
    await db_session.commit()

    denied = await api_client.get(f"/v1/snapshots/{snap.id}", headers=headers)
    assert denied.status_code == 404
    denied_archive = await api_client.get(f"/v1/snapshots/{snap.id}/archive", headers=headers)
    assert denied_archive.status_code == 404
    identity = await api_client.get("/v1/users/me", headers=headers)
    assert identity.status_code == 200
    snap.owner_id = uuid.UUID(identity.json()["id"])
    await db_session.commit()
    snap_detail = await api_client.get(f"/v1/snapshots/{snap.id}", headers=headers)
    assert snap_detail.status_code == 200
    assert snap_detail.json()["instanceDigest"] == snap.instance_digest
    assert snap_detail.json()["ir"] is not None

    snap_archive = await api_client.get(f"/v1/snapshots/{snap.id}/archive", headers=headers)
    assert snap_archive.status_code == 200
    assert snap_archive.headers["content-type"] == "application/zip"
    assert len(snap_archive.content) == len(archive_bytes)

"""Portable project packages."""

from __future__ import annotations

import io
import json
import uuid
import zipfile

import pytest_asyncio

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings
from _pricing import fake_pricing_gate, largest_plan
import _m96_seed as seed
from test_studies_platform import executable_revision_payload
from openbinding_gateway.services.engines import engine_ref, manifest as engine_manifest


@pytest_asyncio.fixture
async def platform_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


def multi_resource_package():
    """The language-test package with a current Optimization (criteria, not legacy terms)."""
    from test_bim_v1_language_final import base_package, envelope

    return base_package(optimization=envelope("Optimization", "opt", {
        "criteria": [
            {"id": "latency", "feature": {"resource": "app", "id": "latency"},
             "normalize": {"min": 0, "max": 100, "clamp": False}},
            {"id": "cost", "feature": {"resource": "app", "id": "cost"},
             "normalize": {"min": 0, "max": 20, "clamp": False}},
        ],
        "penalties": [{"constraint": {"resource": "soft", "id": "limit"}, "weight": 1}],
    }))


async def account(client, registration) -> tuple[dict, dict[str, str]]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    login = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), {"Authorization": f"Bearer {login.json()['access_token']}"}


async def project(client, headers, *, visibility="public") -> tuple[str, str]:
    org_slug = f"portable-{uuid.uuid4().hex[:8]}"
    created_org = await client.post(
        "/v1/organizations", headers=headers, json={"slug": org_slug, "name": "Portable lab"}
    )
    assert created_org.status_code == 201, created_org.text
    project_slug = f"project-{uuid.uuid4().hex[:8]}"
    created_project = await client.post(
        f"/v1/organizations/{org_slug}/projects",
        headers=headers,
        json={"slug": project_slug, "name": "Portable binding", "visibility": visibility},
    )
    assert created_project.status_code == 201, created_project.text
    return org_slug, project_slug


async def test_packages_round_trip_cases_resources_and_artifacts(
    api_client, registration, platform_gate, monkeypatch, tmp_path, db_session
) -> None:
    # The resource is seeded through the internal services, because its write routes are removed
    # (design.md §2.1 rows 29 and 31).
    monkeypatch.setenv("ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    get_settings.cache_clear()
    try:
        profile, headers = await account(api_client, registration)
        platform_gate.plans[uuid.UUID(profile["id"])] = largest_plan()
        org, source = await project(api_client, headers)
        base = f"/v1/organizations/{org}/projects/{source}"
        source_project = await seed.project_by_slugs(db_session, org, source)

        case = await api_client.post(
            f"{base}/cases", headers=headers,
            json={"slug": "checkout", "name": "Checkout binding"},
        )
        case_revision = await api_client.post(
            f"{base}/cases/checkout/revisions", headers=headers,
            json=await executable_revision_payload(api_client, headers),
        )
        _, (resource_revision,) = await seed.project_resource(
            db_session, source_project, profile["id"], slug="offers", name="Offers", kind="qos-offerings",
            documents=[{"offers": [{"id": "edge-a", "latency": 20}]}],
        )
        assert all(response.status_code == 201 for response in (case, case_revision))

        study = await api_client.post(
            f"{base}/studies", headers=headers,
            json={
                "slug": "engine-benchmark", "name": "Engine benchmark",
                "definition": {
                    "case_revision_ids": [case_revision.json()["id"]],
                    "engines": [{**engine_ref(engine_manifest("random-search")), "mode": "seeded",
                                 "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"}}],
                    "parameter_sets": [{}], "seeds": [7],
                },
            },
        )
        assert study.status_code == 201, study.text
        artifact_body = b"reproducible solver trace\n"
        artifact = await api_client.post(
            f"{base}/blobs?public=true", headers={**headers, "Content-Type": "text/plain"},
            content=artifact_body,
        )
        assert artifact.status_code == 201, artifact.text

        exported = await api_client.get(f"{base}/package?format=zip", headers=headers)
        exported_json = await api_client.get(f"{base}/package?format=json", headers=headers)
        exported_yaml = await api_client.get(f"{base}/package?format=yaml", headers=headers)
        assert exported.status_code == exported_json.status_code == exported_yaml.status_code == 200
        package_json = exported_json.json()
        assert package_json["resources"][0]["revisions"][0]["digest"] == resource_revision.content_digest
        assert package_json["studies"][0]["definition"]["case_revision_ids"] == [case_revision.json()["id"]]
        assert package_json["artifacts"][0]["contentBase64"]
        assert not {"reports", "publications", "evidenceJobs", "collections"} & set(package_json)
        with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
            manifest = json.loads(archive.read("package.json"))
            assert archive.read(manifest["artifacts"][0]["path"]) == artifact_body

        destination = await api_client.post(
            f"/v1/organizations/{org}/projects", headers=headers,
            json={"slug": "restored", "name": "Restored", "visibility": "private"},
        )
        assert destination.status_code == 201
        imported = await api_client.post(
            f"/v1/organizations/{org}/projects/restored/package",
            headers={**headers, "Content-Type": "application/zip"}, content=exported.content,
        )
        assert imported.status_code == 200, imported.text
        assert imported.json()["imported"]["caseRevisions"] == 1
        assert imported.json()["imported"]["resourceRevisions"] == 1
        restored_resources = await api_client.get(
            f"/v1/organizations/{org}/projects/restored/resources", headers=headers
        )
        restored_artifacts = await api_client.get(
            f"/v1/organizations/{org}/projects/restored/blobs", headers=headers
        )
        assert restored_resources.json()[0]["slug"] == "offers"
        assert restored_artifacts.json()[0]["public"] is False
    finally:
        get_settings.cache_clear()


async def test_package_manifest_tampering_is_rejected(
    api_client, registration, platform_gate, monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    get_settings.cache_clear()
    try:
        _, headers = await account(api_client, registration)
        org, source = await project(api_client, headers, visibility="private")
        exported = await api_client.get(
            f"/v1/organizations/{org}/projects/{source}/package?format=json", headers=headers
        )
        tampered = exported.json()
        tampered["project"]["name"] = "Changed after signing"
        response = await api_client.post(
            f"/v1/organizations/{org}/projects/{source}/package",
            headers={**headers, "Content-Type": "application/json"},
            json=tampered,
        )
        assert response.status_code == 422
        # The unified 422 problem (docs/ERRORS.md): the code is top level.
        assert response.json()["code"] == "checksum_mismatch"
        assert response.json()["diagnostics"][0]["code"] == "checksum_mismatch"
    finally:
        get_settings.cache_clear()


async def test_library_case_roundtrip_keeps_exact_inputs(api_client, registration, platform_gate, monkeypatch, tmp_path,
                                                         db_session):
    from openbinding_gateway.artifacts import reference

    monkeypatch.setattr(get_settings(), 'artifact_root', str(tmp_path))
    user, headers = await account(api_client, registration)
    platform_gate.plans[uuid.UUID(user['id'])] = largest_plan()
    org, project_slug = await project(api_client, headers, visibility='private')
    base = f'/v1/organizations/{org}/projects/{project_slug}'
    organization_id = (await seed.project_by_slugs(db_session, org, project_slug)).organization_id
    source = multi_resource_package()
    uses = []
    # The library write routes are removed since M9.6; the inputs are sealed by the internal artifact service.
    for role, resources in source.instance()['spec']['resources'].items():
        for alias, path in resources.items():
            document = json.loads(source.files[path])
            identity = await seed.library_artifact(db_session, organization_id, user['id'], name=alias, kind=document['kind'])
            sealed = await seed.seal(db_session, identity, user['id'], document)
            uses.append(dict(role=role, alias=alias, artifact=reference(identity, sealed)))
    created_case = await api_client.post(f'{base}/cases', headers=headers, json={'slug': 'experiment', 'name': 'Experiment'})
    assert created_case.status_code == 201, created_case.text
    revision = await api_client.post(f'{base}/cases/experiment/revisions', headers=headers,
        json={'document': source.instance(), 'resources': uses})
    assert revision.status_code == 201, revision.text
    original = revision.json()
    assert original['source_snapshot_id']
    exported = await api_client.get(f'{base}/package?format=json', headers=headers)
    assert exported.status_code == 200, exported.text
    assert len(exported.json()['library']) == len(uses)
    assert original['source_snapshot_id'] in exported.json()['snapshots']
    created_project = await api_client.post(f'/v1/organizations/{org}/projects', headers=headers,
        json={'slug': 'restored-library', 'name': 'Restored', 'visibility': 'private'})
    assert created_project.status_code == 201, created_project.text
    restored_base = f'/v1/organizations/{org}/projects/restored-library'
    imported = await api_client.post(f'{restored_base}/package', headers=headers, json=exported.json())
    assert imported.status_code == 200, imported.text
    restored = await api_client.get(f'{restored_base}/cases/experiment/revisions', headers=headers)
    assert restored.status_code == 200, restored.text
    assert restored.json()[0]['digest'] == original['digest']
    assert restored.json()[0]['document'] == original['document']
    assert restored.json()[0]['source_snapshot_id'] == original['source_snapshot_id']


async def test_removing_project_use_keeps_shared_version(api_client, registration, platform_gate, db_session):
    # The project library routes are removed since M9.6 (design.md §2.1 rows 26 to 28): the use is the
    # ProjectArtifact row, which package export and import still carry.
    from sqlalchemy import delete, select
    from openbinding_gateway.artifacts import reference
    from openbinding_gateway.db.models import ProjectArtifact

    profile, headers = await account(api_client, registration)
    platform_gate.plans[uuid.UUID(profile['id'])] = largest_plan()
    org, source = await project(api_client, headers)
    source_project = await seed.project_by_slugs(db_session, org, source)
    identity = await seed.library_artifact(db_session, source_project.organization_id, profile['id'],
        name='shared-data', display_name='Shared data', kind='Dataset')
    sealed = await seed.seal(db_session, identity, profile['id'], {'value': 1})
    artifact, ref = str(identity.id), reference(identity, sealed)
    db_session.add(ProjectArtifact(project_id=source_project.id, artifact_id=identity.id))
    await db_session.flush()
    exported = await api_client.get(f'/v1/organizations/{org}/projects/{source}/package?format=json', headers=headers)
    assert exported.status_code == 200, exported.text
    package = exported.json()
    assert package['projectArtifacts'] == [ref]
    assert [entry['ref'] for entry in package['library']] == [ref]
    target = await api_client.post(f'/v1/organizations/{org}/projects', headers=headers,
        json={'slug': 'restored-library', 'name': 'Restored library'})
    assert target.status_code == 201, target.text
    imported = await api_client.post(f'/v1/organizations/{org}/projects/restored-library/package', headers=headers, json=package)
    assert imported.status_code == 200, imported.text
    restored = await seed.project_by_slugs(db_session, org, 'restored-library')
    uses = select(ProjectArtifact.artifact_id).where(ProjectArtifact.project_id.in_([source_project.id, restored.id]))
    assert [str(row) for row in (await db_session.scalars(uses)).all()] == [artifact, artifact]
    await db_session.execute(delete(ProjectArtifact).where(ProjectArtifact.artifact_id == identity.id))
    assert (await db_session.scalars(uses)).all() == []
    content = await api_client.get(f"/v1/artifacts/{artifact}/versions/{sealed.id}/content", headers=headers)
    assert content.status_code == 200 and content.json() == {'value': 1}

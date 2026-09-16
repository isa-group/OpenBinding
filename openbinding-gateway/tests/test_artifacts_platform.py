"""Portable project packages and immutable public content."""

from __future__ import annotations

import io
import json
import uuid
import zipfile

import pytest_asyncio

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings
from _pricing import fake_pricing_gate, largest_plan
from test_studies_platform import executable_revision_payload
from openbinding_gateway.routes import v1 as routes


@pytest_asyncio.fixture
async def platform_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


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


async def test_packages_round_trip_cases_resources_collections_and_artifacts(
    api_client, registration, platform_gate, monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    get_settings.cache_clear()
    try:
        profile, headers = await account(api_client, registration)
        platform_gate.plans[uuid.UUID(profile["id"])] = largest_plan()
        org, source = await project(api_client, headers)
        base = f"/v1/organizations/{org}/projects/{source}"

        case = await api_client.post(
            f"{base}/cases", headers=headers,
            json={"slug": "checkout", "name": "Checkout binding"},
        )
        case_revision = await api_client.post(
            f"{base}/cases/checkout/revisions", headers=headers,
            json=await executable_revision_payload(api_client, headers),
        )
        resource = await api_client.post(
            f"{base}/resources", headers=headers,
            json={"slug": "offers", "name": "Offers", "kind": "qos-offerings"},
        )
        resource_revision = await api_client.post(
            f"{base}/resources/offers/revisions", headers=headers,
            json={"document": {"offers": [{"id": "edge-a", "latency": 20}]}},
        )
        collection = await api_client.post(
            f"{base}/collections", headers=headers,
            json={"slug": "benchmark", "name": "Benchmark"},
        )
        collection_revision = await api_client.post(
            f"{base}/collections/benchmark/revisions", headers=headers,
            json={"items": [{
                "target_kind": "case",
                "target_digest": case_revision.json()["digest"],
                "target_ref": {"caseRevisionId": case_revision.json()["id"]},
            }]},
        )
        assert all(response.status_code == 201 for response in (
            case, case_revision, resource, resource_revision, collection, collection_revision
        ))

        study = await api_client.post(
            f"{base}/studies", headers=headers,
            json={
                "slug": "engine-benchmark", "name": "Engine benchmark",
                "definition": {
                    "case_revision_ids": [case_revision.json()["id"]],
                    "engines": [routes._engine_ref(routes._manifest("random-search"))],
                    "parameter_sets": [{}], "seeds": [7],
                },
            },
        )
        assert study.status_code == 201, study.text
        report = await api_client.post(
            f"{base}/reports", headers=headers,
            json={
                "slug": "findings", "title": "Findings",
                "document": {"provenance": {
                    "study": {
                        "reference": "urn:openbinding:study:standalone-findings",
                        "digest": "sha256-" + "b" * 64,
                    },
                    "datasets": [{
                        "reference": "urn:openbinding:dataset:checkout-v1",
                        "digest": case_revision.json()["digest"],
                    }],
                    "software": [{
                        "name": "openbinding-gateway", "version": "1.0.0",
                        "digest": "sha256-" + "c" * 64,
                    }],
                    "bimVersion": "v1", "engineRevisions": ["sha256-" + "a" * 64],
                    "parameters": {"seed": 7},
                }},
            },
        )
        frozen = await api_client.post(f"{base}/reports/findings/freeze", headers=headers)
        published = await api_client.post(
            f"{base}/publications", headers=headers,
            json={"report_id": report.json()["id"], "slug": "findings", "citation": {"doi": "10.0000/example"}},
        )
        assert frozen.status_code == 200
        assert published.status_code == 201

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
        assert package_json["resources"][0]["revisions"][0]["digest"] == resource_revision.json()["digest"]
        assert package_json["studies"][0]["definition"]["case_revision_ids"] == [case_revision.json()["id"]]
        assert package_json["artifacts"][0]["contentBase64"]
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

        public_case_res = await api_client.get(
            f"/v1/resolve/case-revision/{case_revision.json()['digest']}"
        )
        assert public_case_res.status_code == 200
        assert public_case_res.json()["verified"] is True
        assert len(public_case_res.json()["locations"]) >= 1

        public_case = await api_client.get(
            f"/v1/resolve/case-revision/{case_revision.json()['digest']}/content"
        )
        public_resource = await api_client.get(
            f"/v1/resolve/resource-revision/{resource_revision.json()['digest']}/content"
        )
        public_report = await api_client.get(
            f"/v1/resolve/report/{frozen.json()['digest']}/content"
        )
        public_artifact = await api_client.get(
            f"/v1/resolve/artifact/{artifact.json()['digest']}/content"
        )
        for response in (public_case, public_resource, public_report, public_artifact):
            assert response.status_code == 200, response.text
            assert response.headers["cache-control"].endswith("immutable")
            assert response.headers["etag"].startswith('"sha256-')

        # A signed package is only a checksum, not permission to publish a new edition.
        await api_client.post(f'{base}/reports/findings/drafts', headers=headers)
        next_version = await api_client.post(f'{base}/reports/findings/freeze', headers=headers)
        assert next_version.status_code == 200, next_version.text
        portable = (await api_client.get(f'{base}/package?format=json', headers=headers)).json()
        report_entry = portable['reports'][0]
        portable['publications'].append({'reportId': report_entry['id'], 'slug': 'forged-publication',
            'versionRef': report_entry['versionRef'], 'citation': {}})
        from openbinding_gateway.v1.canonical import digest
        portable['packageDigest'] = digest({key: value for key, value in portable.items() if key != 'packageDigest'})
        forged = await api_client.post(f'{base}/package', headers=headers, json=portable)
        assert forged.status_code == 409, forged.text
        assert forged.json()['detail']['code'] == 'unpublished_import'
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
        assert response.json()["detail"]["code"] == "checksum_mismatch"
    finally:
        get_settings.cache_clear()


async def test_library_case_roundtrip_keeps_exact_inputs(api_client, registration, platform_gate, monkeypatch, tmp_path):
    from test_bim_v1_language_final import base_package
    monkeypatch.setattr(get_settings(), 'artifact_root', str(tmp_path))
    user, headers = await account(api_client, registration)
    platform_gate.plans[uuid.UUID(user['id'])] = largest_plan()
    org, project_slug = await project(api_client, headers, visibility='private')
    base = f'/v1/organizations/{org}/projects/{project_slug}'
    source = base_package()
    uses = []
    for role, resources in source.instance()['spec']['resources'].items():
        for alias, path in resources.items():
            document = json.loads(source.files[path])
            created = await api_client.post(f'/v1/organizations/{org}/library', headers=headers,
                json=dict(name=alias, display_name=alias, kind=document['kind']))
            assert created.status_code == 201, created.text
            identity = created.json()['id']
            draft = await api_client.post(f'/v1/artifacts/{identity}/drafts', headers=headers, json={'content': document})
            assert draft.status_code == 201, draft.text
            sealed = await api_client.post(f'/v1/artifacts/{identity}/drafts/{draft.json()["id"]}/seal',
                headers=headers, json={'revision': 1})
            assert sealed.status_code == 201, sealed.text
            uses.append(dict(role=role, alias=alias, artifact=sealed.json()['ref']))
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


async def test_removing_project_use_keeps_shared_version(api_client, registration, platform_gate):
    profile, headers = await account(api_client, registration)
    platform_gate.plans[uuid.UUID(profile['id'])] = largest_plan()
    org, source = await project(api_client, headers)
    created = await api_client.post(f'/v1/organizations/{org}/library', headers=headers,
        json={'name': 'shared-data', 'display_name': 'Shared data', 'kind': 'Dataset'})
    assert created.status_code == 201, created.text
    artifact = created.json()['id']
    base = f'/v1/artifacts/{artifact}'
    draft = await api_client.post(f'{base}/drafts', headers=headers, json={'content': {'value': 1}})
    sealed = await api_client.post(f"{base}/drafts/{draft.json()['id']}/seal", headers=headers, json={'revision': 1})
    assert sealed.status_code == 201, sealed.text
    usage = f'/v1/organizations/{org}/projects/{source}/library'
    for _ in range(2):
        assert (await api_client.put(f'{usage}/{artifact}', headers=headers)).status_code == 200
    assert [row['id'] for row in (await api_client.get(usage, headers=headers)).json()] == [artifact]
    exported = await api_client.get(f'/v1/organizations/{org}/projects/{source}/package?format=json', headers=headers)
    assert exported.status_code == 200, exported.text
    package = exported.json()
    assert package['projectArtifacts'] == [sealed.json()['ref']]
    assert [entry['ref'] for entry in package['library']] == [sealed.json()['ref']]
    target = await api_client.post(f'/v1/organizations/{org}/projects', headers=headers,
        json={'slug': 'restored-library', 'name': 'Restored library'})
    assert target.status_code == 201, target.text
    imported = await api_client.post(f'/v1/organizations/{org}/projects/restored-library/package', headers=headers, json=package)
    assert imported.status_code == 200, imported.text
    restored = await api_client.get(f'/v1/organizations/{org}/projects/restored-library/library', headers=headers)
    assert [row['id'] for row in restored.json()] == [artifact]
    _, outsider = await account(api_client, registration)
    assert (await api_client.delete(f'{usage}/{artifact}', headers=outsider)).status_code == 403
    for _ in range(2):
        assert (await api_client.delete(f'{usage}/{artifact}', headers=headers)).status_code == 204
    assert (await api_client.get(usage, headers=headers)).json() == []
    content = await api_client.get(f"{base}/versions/{sealed.json()['id']}/content", headers=headers)
    assert content.status_code == 200 and content.json() == {'value': 1}

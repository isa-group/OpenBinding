from __future__ import annotations

import copy
import json
import uuid

import jsonschema
import pytest
from sqlalchemy import select

from _repo import REPO_ROOT

from openbinding_gateway.core.settings import Settings
from openbinding_gateway.db.models import (
    EngineCredential,
    EngineRegistrationRevision,
    EngineRevision,
    InstanceSnapshot,
    Job,
    JobState,
    ManifestPublication,
    RegisteredResourceRevision,
    User,
    UserRole,
)
from openbinding_gateway.main import app
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.security.secrets import generate_key
from openbinding_gateway.v1.package import load_package


EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"


def _zip_headers(headers: dict[str, str]) -> dict[str, str]:
    return {**headers, "Content-Type": "application/vnd.bim+zip"}


async def _register_and_login(client, details: dict[str, str]) -> dict[str, str]:
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await client.post(
        "/v1/auth/login",
        json={
            "username_or_email": details["username"],
            "password": details["password"],
        },
    )
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['access_token']}"}


async def _builtin_engine_ref(client, headers: dict[str, str]) -> dict[str, str]:
    response = await client.get("/v1/engines", headers=headers)
    assert response.status_code == 200, response.text
    engine = next(
        item for item in response.json()["engines"] if item["name"] == "random-search"
    )
    return engine["ref"]


def _registration_document(
    *,
    namespace: str,
    name: str,
    version: str,
    engine: dict[str, str],
    auth_scheme: str = "none",
) -> dict:
    openapi = copy.deepcopy(routes._protocol_document())
    openapi["x-bim-protocol"] = "bim-engine/v1"
    openapi["x-bim-protocol-digest"] = routes._protocol_digest()
    openapi["paths"]["/health"] = {
        "get": {"responses": {"200": {"description": "Healthy"}}}
    }
    return {
        "apiVersion": "bim/v1",
        "kind": "EngineRegistration",
        "metadata": {
            "namespace": namespace,
            "name": name,
            "version": version,
        },
        "spec": {
            "engine": engine,
            "endpoint": "https://solver.example",
            "protocol": {
                "id": "bim-engine/v1",
                "mediaType": "application/json",
                "digest": routes._protocol_digest(),
            },
            "mappings": {
                "request": "/internal/v1/binding-problems",
                "health": "/health",
                "openapi": "/openapi.json",
            },
            "auth": {"scheme": auth_scheme},
            "openapi": openapi,
        },
    }


def _engine_document(namespace: str, name: str, version: str) -> dict:
    document = copy.deepcopy(routes._manifest("random-search"))
    document["metadata"].update(
        {"namespace": namespace, "name": name, "version": version}
    )
    return document


def _optimization_document(name: str, version: str) -> dict:
    document = copy.deepcopy(load_package(EXAMPLE).json("optimization.json"))
    document["metadata"].update({"name": name, "version": version})
    return document


def _assert_same_not_found(hidden, missing) -> None:
    assert hidden.status_code == missing.status_code == 404
    assert hidden.headers["content-type"].startswith("application/problem+json")
    assert missing.headers["content-type"].startswith("application/problem+json")
    assert hidden.json() == missing.json()
    assert hidden.json()["title"] == "not_found"


def _assert_component(component: str, payload: dict) -> None:
    document = app.openapi()
    jsonschema.Draft202012Validator(
        {
            "$ref": f"#/components/schemas/{component}",
            "components": document["components"],
        }
    ).validate(payload)


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/v1/catalog"),
        ("GET", "/v1/engines"),
        ("GET", "/v1/engine-registrations"),
        ("POST", "/v1/analyze"),
        ("POST", "/v1/jobs"),
        ("POST", "/v1/engines"),
        ("POST", "/v1/engine-registrations"),
    ],
)
async def test_engine_discovery_and_execution_never_allow_anonymous_callers(
    api_client,
    method: str,
    path: str,
) -> None:
    response = await api_client.request(method, path, json={})
    assert response.status_code == 401, response.text
    assert response.headers["www-authenticate"].startswith("Bearer")
    assert response.headers["content-type"].startswith("application/problem+json")


async def test_second_user_cannot_distinguish_private_v1_resources(
    api_client,
    db_session,
    registration,
    monkeypatch,
) -> None:
    owner_details = registration()
    other_details = registration()
    owner_headers = await _register_and_login(api_client, owner_details)
    other_headers = await _register_and_login(api_client, other_details)
    other = (
        await db_session.execute(
            select(User).where(User.username == other_details["username"])
        )
    ).scalars().one()
    other.role = UserRole.ADMIN
    await db_session.flush()
    monkeypatch.setattr(routes, "validate_endpoint", lambda endpoint, **_kwargs: None)

    package = load_package(EXAMPLE)
    created_snapshot = await api_client.post(
        "/v1/instances",
        headers=_zip_headers(owner_headers),
        content=package.to_zip(),
    )
    assert created_snapshot.status_code == 201, created_snapshot.text
    snapshot_id = created_snapshot.json()["id"]

    owner = (
        await db_session.execute(
            select(User).where(User.username == owner_details["username"])
        )
    ).scalars().one()
    snapshot = await db_session.get(InstanceSnapshot, uuid.UUID(snapshot_id))
    assert snapshot is not None
    job = Job(
        owner_id=owner.id,
        engine_id="random-search",
        engine_job_id="private-job",
        service_url="https://solver.example",
        state=JobState.QUEUED,
        original_request={
            "bindingProblem": {
                "apiVersion": "bim/v1",
                "kind": "BindingProblem",
                "metadata": {"name": "private-problem"},
                "spec": {},
            }
        },
        instance_snapshot_id=snapshot.id,
        provenance={},
    )
    db_session.add(job)
    await db_session.flush()

    private_engine_name = f"private-engine-{uuid.uuid4().hex[:8]}"
    private_engine_document = _engine_document(
        owner_details["username"], private_engine_name, "1.0.0"
    )
    engine_params = {
        "namespace": owner_details["username"],
        "version": "1.0.0",
        "digest": routes.digest(private_engine_document),
    }
    engine_before = await api_client.get(
        f"/v1/engines/{private_engine_name}", params=engine_params, headers=other_headers
    )
    private_engine = await api_client.post(
        "/v1/engines",
        headers=owner_headers,
        json=private_engine_document,
    )
    assert private_engine.status_code == 201, private_engine.text
    assert private_engine.json()["status"] == "private"
    _assert_component("EngineRevision", private_engine.json())
    engine_after = await api_client.get(
        f"/v1/engines/{private_engine_name}", params=engine_params, headers=other_headers
    )
    _assert_same_not_found(engine_after, engine_before)

    registration_name = f"private-registration-{uuid.uuid4().hex[:8]}"
    engine_ref = await _builtin_engine_ref(api_client, owner_headers)
    private_registration = await api_client.post(
        "/v1/engine-registrations",
        headers=owner_headers,
        json=_registration_document(
            namespace=owner_details["username"],
            name=registration_name,
            version="1.0.0",
            engine=engine_ref,
        ),
    )
    assert private_registration.status_code == 201, private_registration.text
    assert private_registration.json()["status"] == "private"
    assert private_registration.json()["active"] is False
    _assert_component("EngineRegistrationRevision", private_registration.json())
    registration_params = {
        "namespace": owner_details["username"],
        "version": "1.0.0",
        "digest": private_registration.json()["digest"],
    }
    missing_registration_params = {
        **registration_params,
        "digest": "sha256-" + "0" * 64,
    }

    resource_name = f"private-optimization-{uuid.uuid4().hex[:8]}"
    private_resource = await api_client.post(
        "/v1/resources",
        params={
            "namespace": owner_details["username"],
            "name": resource_name,
            "version": "1.0.0",
            "role": "optimization",
        },
        headers={**owner_headers, "Content-Type": "application/json"},
        content=json.dumps(_optimization_document(resource_name, "1.0.0")),
    )
    assert private_resource.status_code == 201, private_resource.text
    assert private_resource.json()["status"] == "pending_review"
    resource_params = {
        "namespace": owner_details["username"],
        "version": "1.0.0",
        "revision": private_resource.json()["digest"],
    }
    missing_resource_params = {
        **resource_params,
        "revision": "sha256-" + "0" * 64,
    }

    missing_id = str(uuid.uuid4())
    for suffix in ("", "/source", "/ir"):
        hidden = await api_client.get(
            f"/v1/instances/{snapshot_id}{suffix}", headers=other_headers
        )
        missing = await api_client.get(
            f"/v1/instances/{missing_id}{suffix}", headers=other_headers
        )
        _assert_same_not_found(hidden, missing)

    for suffix in ("", "/ir", "/instance", "/report"):
        hidden = await api_client.get(
            f"/v1/jobs/{job.id}{suffix}", headers=other_headers
        )
        missing = await api_client.get(
            f"/v1/jobs/{missing_id}{suffix}", headers=other_headers
        )
        _assert_same_not_found(hidden, missing)

    hidden_resource = await api_client.get(
        f"/v1/resources/{resource_name}",
        params=resource_params,
        headers=other_headers,
    )
    missing_resource = await api_client.get(
        f"/v1/resources/{resource_name}",
        params=missing_resource_params,
        headers=other_headers,
    )
    _assert_same_not_found(hidden_resource, missing_resource)

    for suffix in ("", "/report"):
        hidden = await api_client.get(
            f"/v1/engine-registrations/{registration_name}{suffix}",
            params=registration_params,
            headers=other_headers,
        )
        missing = await api_client.get(
            f"/v1/engine-registrations/{registration_name}{suffix}",
            params=missing_registration_params,
            headers=other_headers,
        )
        _assert_same_not_found(hidden, missing)

    listed_engines = (await api_client.get("/v1/engines", headers=other_headers)).json()
    listed_registrations = (
        await api_client.get("/v1/engine-registrations", headers=other_headers)
    ).json()
    listed_resources = (await api_client.get("/v1/resources", headers=other_headers)).json()
    assert private_engine_name not in json.dumps(listed_engines)
    assert registration_name not in json.dumps(listed_registrations)
    assert resource_name not in json.dumps(listed_resources)


async def test_engine_registration_secret_is_never_serialized(
    api_client,
    db_session,
    registration,
    monkeypatch,
) -> None:
    owner_details = registration()
    owner_headers = await _register_and_login(api_client, owner_details)
    monkeypatch.setattr(routes, "validate_endpoint", lambda endpoint, **_kwargs: None)
    monkeypatch.setattr(
        routes,
        "get_settings",
        lambda: Settings(federation_secret_key=generate_key()),
    )

    engine_ref = await _builtin_engine_ref(api_client, owner_headers)
    registration_name = f"credential-registration-{uuid.uuid4().hex[:8]}"
    created = await api_client.post(
        "/v1/engine-registrations",
        headers=owner_headers,
        json=_registration_document(
            namespace=owner_details["username"],
            name=registration_name,
            version="1.0.0",
            engine=engine_ref,
            auth_scheme="bearer",
        ),
    )
    assert created.status_code == 201, created.text
    reference = {
        "namespace": owner_details["username"],
        "version": "1.0.0",
        "digest": created.json()["digest"],
    }
    secret = "engine-secret-that-must-never-leave-the-store"
    stored = await api_client.put(
        f"/v1/engine-registrations/{registration_name}/credential",
        params=reference,
        headers=owner_headers,
        json={"secret": secret},
    )
    assert stored.status_code == 200, stored.text

    registration_row = (
        await db_session.execute(
            select(EngineRegistrationRevision).where(
                EngineRegistrationRevision.manifest_digest == reference["digest"]
            )
        )
    ).scalars().one()
    credential_row = (
        await db_session.execute(
            select(EngineCredential).where(
                EngineCredential.registration_id == registration_row.id
            )
        )
    ).scalars().one()
    assert secret not in json.dumps(registration_row.document)
    assert secret not in credential_row.credential_encrypted
    assert secret not in credential_row.credential_ref
    assert registration_row.document["spec"]["auth"] == {"scheme": "bearer"}
    assert "credential" not in registration_row.document["spec"]

    fetched = await api_client.get(
        f"/v1/engine-registrations/{registration_name}",
        params=reference,
        headers=owner_headers,
    )
    listed = await api_client.get("/v1/engine-registrations", headers=owner_headers)
    report = await api_client.get(
        f"/v1/engine-registrations/{registration_name}/report",
        params=reference,
        headers=owner_headers,
    )
    for response in (created, stored, fetched, listed, report):
        assert response.status_code in {200, 201}, response.text
        serialized = json.dumps(response.json())
        assert secret not in serialized
        assert credential_row.credential_encrypted not in serialized
    _assert_component("EngineRegistrationRevision", created.json())
    _assert_component("EngineRegistrationRevision", stored.json())
    _assert_component("EngineRegistrationReport", report.json())


async def test_registration_owner_controls_private_and_public_access(
    api_client,
    db_session,
    registration,
    monkeypatch,
) -> None:
    owner_details = registration()
    moderator_details = registration()
    viewer_details = registration()
    owner_headers = await _register_and_login(api_client, owner_details)
    moderator_headers = await _register_and_login(api_client, moderator_details)
    viewer_headers = await _register_and_login(api_client, viewer_details)
    moderator = (
        await db_session.execute(
            select(User).where(User.username == moderator_details["username"])
        )
    ).scalars().one()
    moderator.role = UserRole.ADMIN
    await db_session.flush()
    monkeypatch.setattr(routes, "validate_endpoint", lambda endpoint, **_kwargs: None)

    async def verified_registration(document, credential, engine_document):
        assert document["metadata"]["namespace"] == owner_details["username"]
        assert credential is None
        assert engine_document["kind"] == "Engine"
        return (
            {
                "protocol": "bim-engine/v1",
                "protocolDigest": routes._protocol_digest(),
                "status": "verified",
                "checks": [],
                "durationMs": 0.0,
            },
            {"openapi": "3.1.0", "paths": {}},
            "sha256-" + "e" * 64,
        )

    monkeypatch.setattr(routes, "_verify_registration", verified_registration)
    engine_ref = await _builtin_engine_ref(api_client, owner_headers)
    name = f"owned-deployment-{uuid.uuid4().hex[:8]}"
    created = await api_client.post(
        "/v1/engine-registrations",
        headers=owner_headers,
        json=_registration_document(
            namespace=owner_details["username"],
            name=name,
            version="1.0.0",
            engine=engine_ref,
        ),
    )
    assert created.status_code == 201, created.text
    reference = {
        "namespace": owner_details["username"],
        "version": "1.0.0",
        "digest": created.json()["digest"],
    }
    row = (
        await db_session.execute(
            select(EngineRegistrationRevision).where(
                EngineRegistrationRevision.manifest_digest == reference["digest"]
            )
        )
    ).scalars().one()
    owner = (
        await db_session.execute(
            select(User).where(User.username == owner_details["username"])
        )
    ).scalars().one()
    viewer = (
        await db_session.execute(
            select(User).where(User.username == viewer_details["username"])
        )
    ).scalars().one()
    assert row.owner_id == owner.id

    # Creation is private even from administrators. Only the owner sees the
    # exact resource and no moderation event exists yet.
    private_owner = await api_client.get(
        f"/v1/engine-registrations/{name}", params=reference, headers=owner_headers
    )
    assert private_owner.status_code == 200, private_owner.text
    for outsider_headers in (moderator_headers, viewer_headers):
        hidden = await api_client.get(
            f"/v1/engine-registrations/{name}",
            params=reference,
            headers=outsider_headers,
        )
        assert hidden.status_code == 404, hidden.text
    empty_queue = await api_client.get(
        "/v1/engine-registrations", params={"review": "true"}, headers=moderator_headers
    )
    assert empty_queue.status_code == 200
    assert name not in json.dumps(empty_queue.json())

    activated = await api_client.post(
        f"/v1/engine-registrations/{name}/activate",
        params=reference,
        headers=owner_headers,
    )
    assert activated.status_code == 200, activated.text
    assert activated.json()["status"] == "private"
    assert activated.json()["active"] is True
    assert await routes._registration_for_engine(
        reference["namespace"], name, reference["version"], reference["digest"], owner, db_session
    ) is not None
    assert await routes._registration_for_engine(
        reference["namespace"], name, reference["version"], reference["digest"], moderator, db_session
    ) is None

    for action in ("activate", "deactivate", "publication-request"):
        refused = await api_client.post(
            f"/v1/engine-registrations/{name}/{action}",
            params=reference,
            headers=moderator_headers,
        )
        assert refused.status_code == 404, refused.text
    refused_credential = await api_client.put(
        f"/v1/engine-registrations/{name}/credential",
        params=reference,
        headers=moderator_headers,
        json={"secret": "not-the-moderator's-secret"},
    )
    assert refused_credential.status_code == 404, refused_credential.text

    requested = await api_client.post(
        f"/v1/engine-registrations/{name}/publication-request",
        params=reference,
        headers=owner_headers,
    )
    assert requested.status_code == 200, requested.text
    assert requested.json()["status"] == "pending_review"
    review_queue = await api_client.get(
        "/v1/engine-registrations", params={"review": "true"}, headers=moderator_headers
    )
    assert review_queue.status_code == 200
    assert [item["name"] for item in review_queue.json()["registrations"]] == [name]
    admin_review = await api_client.get(
        f"/v1/engine-registrations/{name}", params=reference, headers=moderator_headers
    )
    assert admin_review.status_code == 200, admin_review.text
    still_hidden = await api_client.get(
        f"/v1/engine-registrations/{name}", params=reference, headers=viewer_headers
    )
    assert still_hidden.status_code == 404

    non_admin_approval = await api_client.post(
        f"/v1/engine-registrations/{name}/approve",
        params=reference,
        headers=viewer_headers,
    )
    assert non_admin_approval.status_code == 403

    published = await api_client.post(
        f"/v1/engine-registrations/{name}/approve",
        params=reference,
        headers=moderator_headers,
    )
    assert published.status_code == 200, published.text
    assert published.json()["status"] == "published"
    visible = await api_client.get(
        f"/v1/engine-registrations/{name}", params=reference, headers=viewer_headers
    )
    assert visible.status_code == 200, visible.text
    assert await routes._registration_for_engine(
        reference["namespace"], name, reference["version"], reference["digest"], viewer, db_session
    ) is not None

    deactivated = await api_client.post(
        f"/v1/engine-registrations/{name}/deactivate",
        params=reference,
        headers=owner_headers,
    )
    assert deactivated.status_code == 200, deactivated.text
    assert deactivated.json()["status"] == "published"
    assert deactivated.json()["active"] is False
    assert await routes._registration_for_engine(
        reference["namespace"], name, reference["version"], reference["digest"], owner, db_session
    ) is None
    assert await routes._registration_for_engine(
        reference["namespace"], name, reference["version"], reference["digest"], viewer, db_session
    ) is not None

    reactivated = await api_client.post(
        f"/v1/engine-registrations/{name}/activate",
        params=reference,
        headers=owner_headers,
    )
    assert reactivated.status_code == 200, reactivated.text
    assert reactivated.json()["active"] is True


async def test_approvals_and_publications_do_not_cross_revision_digests(
    api_client,
    db_session,
    registration,
    monkeypatch,
) -> None:
    owner_details = registration()
    admin_details = registration()
    viewer_details = registration()
    owner_headers = await _register_and_login(api_client, owner_details)
    admin_headers = await _register_and_login(api_client, admin_details)
    viewer_headers = await _register_and_login(api_client, viewer_details)
    admin = (
        await db_session.execute(
            select(User).where(User.username == admin_details["username"])
        )
    ).scalars().one()
    admin.role = UserRole.ADMIN
    await db_session.flush()
    monkeypatch.setattr(routes, "validate_endpoint", lambda endpoint, **_kwargs: None)

    async def verified_registration(document, credential, engine_document):
        assert credential is None
        assert engine_document["kind"] == "Engine"
        return (
            {
                "protocol": "bim-engine/v1",
                "protocolDigest": routes._protocol_digest(),
                "status": "verified",
                "checks": [],
                "durationMs": 0.0,
            },
            {"openapi": "3.1.0", "paths": {}},
            "sha256-" + "f" * 64,
        )

    monkeypatch.setattr(routes, "_verify_registration", verified_registration)

    resource_name = f"revision-resource-{uuid.uuid4().hex[:8]}"

    async def register_resource(version: str):
        response = await api_client.post(
            "/v1/resources",
            params={
                "namespace": owner_details["username"],
                "name": resource_name,
                "version": version,
                "role": "optimization",
            },
            headers={**owner_headers, "Content-Type": "application/json"},
            content=json.dumps(_optimization_document(resource_name, version)),
        )
        assert response.status_code == 201, response.text
        return response.json()

    resource_v1 = await register_resource("1.0.0")
    approved_resource = await api_client.post(
        f"/v1/resources/{resource_name}/approve",
        params={
            "namespace": owner_details["username"],
            "version": resource_v1["version"],
            "revision": resource_v1["digest"],
        },
        headers=admin_headers,
    )
    assert approved_resource.status_code == 200, approved_resource.text
    resource_v2 = await register_resource("2.0.0")
    assert resource_v2["status"] == "pending_review"

    engine_name = f"revision-engine-{uuid.uuid4().hex[:8]}"

    async def register_engine(version: str):
        response = await api_client.post(
            "/v1/engines",
            headers=owner_headers,
            json=_engine_document(owner_details["username"], engine_name, version),
        )
        assert response.status_code == 201, response.text
        return response.json()

    engine_v1 = await register_engine("1.0.0")
    engine_v2 = await register_engine("2.0.0")
    assert engine_v1["status"] == engine_v2["status"] == "private"

    registration_name = f"revision-registration-{uuid.uuid4().hex[:8]}"

    async def register_engine_registration(version: str, engine_ref: dict[str, str]):
        response = await api_client.post(
            "/v1/engine-registrations",
            headers=owner_headers,
            json=_registration_document(
                namespace=owner_details["username"],
                name=registration_name,
                version=version,
                engine=engine_ref,
            ),
        )
        assert response.status_code == 201, response.text
        return response.json()

    registration_v1 = await register_engine_registration("1.0.0", {
        key: engine_v1[key] for key in ("namespace", "name", "version", "digest")
    })
    registration_v1_params = {
        "namespace": owner_details["username"],
        "version": registration_v1["version"],
        "digest": registration_v1["digest"],
    }
    activated_registration = await api_client.post(
        f"/v1/engine-registrations/{registration_name}/activate",
        params=registration_v1_params,
        headers=owner_headers,
    )
    assert activated_registration.status_code == 200, activated_registration.text
    requested_publication = await api_client.post(
        f"/v1/engine-registrations/{registration_name}/publication-request",
        params=registration_v1_params,
        headers=owner_headers,
    )
    assert requested_publication.status_code == 200, requested_publication.text
    approved_registration = await api_client.post(
        f"/v1/engine-registrations/{registration_name}/approve",
        params=registration_v1_params,
        headers=admin_headers,
    )
    assert approved_registration.status_code == 200, approved_registration.text
    assert approved_registration.json()["status"] == "published"
    registration_v2 = await register_engine_registration("2.0.0", {
        key: engine_v2[key] for key in ("namespace", "name", "version", "digest")
    })
    assert registration_v2["status"] == "private"

    public_resource = await api_client.get(
        f"/v1/resources/{resource_name}",
        params={
            "namespace": owner_details["username"],
            "version": resource_v1["version"],
            "revision": resource_v1["digest"],
        },
        headers=viewer_headers,
    )
    private_resource_revision = await api_client.get(
        f"/v1/resources/{resource_name}",
        params={
            "namespace": owner_details["username"],
            "version": resource_v2["version"],
            "revision": resource_v2["digest"],
        },
        headers=viewer_headers,
    )
    assert public_resource.status_code == 200
    assert private_resource_revision.status_code == 404

    visible_engine = await api_client.get(
        f"/v1/engines/{engine_name}",
        params={
            "namespace": owner_details["username"],
            "version": engine_v1["version"],
            "digest": engine_v1["digest"],
        },
        headers=viewer_headers,
    )
    assert visible_engine.status_code == 200, visible_engine.text
    assert visible_engine.json()["metadata"]["version"] == "1.0.0"
    listed_engines = (await api_client.get("/v1/engines", headers=viewer_headers)).json()
    visible_versions = {
        item["version"]
        for item in listed_engines["engines"]
        if item["name"] == engine_name
    }
    assert visible_versions == {"1.0.0"}

    public_registration = await api_client.get(
        f"/v1/engine-registrations/{registration_name}",
        params={
            "namespace": owner_details["username"],
            "version": registration_v1["version"],
            "digest": registration_v1["digest"],
        },
        headers=viewer_headers,
    )
    private_registration_revision = await api_client.get(
        f"/v1/engine-registrations/{registration_name}",
        params={
            "namespace": owner_details["username"],
            "version": registration_v2["version"],
            "digest": registration_v2["digest"],
        },
        headers=viewer_headers,
    )
    assert public_registration.status_code == 200
    assert private_registration_revision.status_code == 404

    resources = (
        await db_session.execute(
            select(RegisteredResourceRevision).where(
                RegisteredResourceRevision.name == resource_name
            )
        )
    ).scalars().all()
    engines = (
        await db_session.execute(
            select(EngineRevision).where(EngineRevision.name == engine_name)
        )
    ).scalars().all()
    registrations = (
        await db_session.execute(
            select(EngineRegistrationRevision).where(
                EngineRegistrationRevision.name == registration_name
            )
        )
    ).scalars().all()
    assert {row.version: row.state for row in resources} == {
        "1.0.0": "published",
        "2.0.0": "pending_review",
    }
    assert {row.version: row.state for row in engines} == {
        "1.0.0": "published",
        "2.0.0": "private",
    }
    assert {row.version: row.publication_status for row in registrations} == {
        "1.0.0": "published",
        "2.0.0": "private",
    }

    publications = (
        await db_session.execute(
            select(ManifestPublication).where(
                ManifestPublication.resource_digest.in_(
                    {
                        resource_v1["digest"],
                        resource_v2["digest"],
                        engine_v1["digest"],
                        engine_v2["digest"],
                        registration_v1["digest"],
                        registration_v2["digest"],
                    }
                )
            )
        )
    ).scalars().all()
    published_digests = {row.resource_digest for row in publications}
    assert published_digests == {
        resource_v1["digest"],
        engine_v1["digest"],
        registration_v1["digest"],
    }
    assert {
        resource_v2["digest"],
        engine_v2["digest"],
        registration_v2["digest"],
    }.isdisjoint(published_digests)

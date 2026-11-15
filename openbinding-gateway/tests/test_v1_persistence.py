import json
import uuid

import jsonschema

from _problem_helpers import make_org, runs_url_for, upload_problem
from _repo import REPO_ROOT

from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.main import app
from openbinding_gateway.modules.execution.adapters import routes as runs_routes
from openbinding_gateway.services import execution
from bim_core.canonical import digest_bytes
from bim_core.package import InstancePackage, load_package, strict_json_loads


EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}


def _zip_headers(headers):
    return {**headers, "Content-Type": "application/vnd.bim+zip"}


def _assert_component(component: str, payload: dict) -> None:
    document = app.openapi()
    jsonschema.Draft202012Validator(
        {
            "$ref": f"#/components/schemas/{component}",
            "components": document["components"],
        }
    ).validate(payload)


async def _register_and_login(client, details):
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['access_token']}"}


async def test_v1_revision_and_job_are_persisted(
    api_client, db_session, registration, monkeypatch
):
    async def solve(*args, **kwargs):
        return {
            "termination": "FEASIBLE",
            "solutions": [
                {
                    "decision": {
                        "kind": "binding",
                        "binding": {
                            "t1": {"resource": "catalog", "id": "c1a"},
                            "t2": {"resource": "catalog", "id": "c2a"},
                            "t3": {"resource": "catalog", "id": "c3a"},
                        },
                    }
                }
            ],
        }

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers = await _register_and_login(api_client, registration())

    created = await upload_problem(api_client, headers, slug="persisted")
    revision_id = created["revision_id"]
    base = f"/v1/organizations/{created['org']}/problems/persisted/revisions/1"

    fetched = await api_client.get(base, headers=headers)
    assert fetched.status_code == 200
    _assert_component("RevisionDetail", fetched.json())
    assert fetched.json()["instance_digest"] == created["revision"]["instance_digest"]
    compilation = await api_client.get(f"{base}/compilation", headers=headers)
    assert compilation.status_code == 200, compilation.text
    assert compilation.json()["resources"]
    assert all(item["apiVersion"] and item["kind"] for item in compilation.json()["resources"].values())

    unknown_field = await api_client.post(
        runs_url_for(revision_id),
        headers=headers,
        json={"revision": revision_id, "unexpected": True},
    )
    assert unknown_field.status_code == 422
    assert unknown_field.json()["title"] == "invalid_request_fields"
    oversized_key = await api_client.post(
        runs_url_for(revision_id),
        headers={**headers, "Idempotency-Key": "x" * 256},
        json={"revision": revision_id},
    )
    assert oversized_key.status_code == 422
    assert oversized_key.json()["title"] == "invalid_idempotency_key"

    job = await api_client.post(
        runs_url_for(revision_id),
        headers={**headers, "Idempotency-Key": "persisted-v1-job"},
        json={"revision": revision_id, "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
    )
    assert job.status_code == 202, job.text
    _assert_component("JobAccepted", job.json())
    job_id = job.json()["id"]
    result = await api_client.get(f"{runs_url_for(revision_id)}/{job_id}", headers=headers)
    assert result.status_code == 200
    _assert_component("RunView", result.json())
    assert result.json()["status"] == "completed"
    assert result.json()["result"]["termination"] in {"FEASIBLE", "INFEASIBLE", "UNKNOWN"}

    replay = await api_client.post(
        runs_url_for(revision_id),
        headers={**headers, "Idempotency-Key": "persisted-v1-job"},
        json={"revision": revision_id, "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
    )
    assert replay.status_code == 202
    _assert_component("JobAccepted", replay.json())
    assert replay.json()["id"] == job_id
    assert replay.json()["profile"] == job.json()["profile"]
    assert replay.json()["irDigest"] == job.json()["irDigest"]


async def test_persisted_job_is_committed_before_the_background_session(
    tmp_path, registration, monkeypatch
):
    from httpx import ASGITransport, AsyncClient

    from openbinding_gateway import space_client
    from openbinding_gateway.db import base as db_base
    from openbinding_gateway.db.base import Base
    from openbinding_gateway.db.models import Job, JobState
    from openbinding_gateway.job_dispatch import dispatch_persisted_job
    from openbinding_gateway.main import app
    from _pricing import fake_pricing_gate

    async def solve(*args, **kwargs):
        return {
            "termination": "FEASIBLE",
            "solutions": [{
                "decision": {
                    "kind": "binding",
                    "binding": {
                        "t1": {"resource": "catalog", "id": "c1a"},
                        "t2": {"resource": "catalog", "id": "c2a"},
                        "t3": {"resource": "catalog", "id": "c3a"},
                    },
                }
            }],
        }

    monkeypatch.setattr(execution, "solve_remote", solve)
    previous_gate = space_client.get_gate()
    previous_overrides = dict(app.dependency_overrides)
    engine = db_base.init_engine(f"sqlite+aiosqlite:///{tmp_path / 'gateway.db'}")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        space_client.set_gate(fake_pricing_gate())
        app.dependency_overrides.clear()

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://gateway"
        ) as client:
            headers = await _register_and_login(client, registration())
            revision_id = (await upload_problem(client, headers))["revision_id"]

            request_sessions = []
            scheduled_after_commit = []
            get_session = db_base.get_session

            async def observed_get_session():
                async for session in get_session():
                    request_sessions.append(session)
                    yield session

            async def observed_dispatch(job_id, request_session=None):
                scheduled_after_commit.append(
                    bool(request_sessions) and not request_sessions[-1].in_transaction()
                )
                await dispatch_persisted_job(job_id, request_session)

            monkeypatch.setattr(db_base, "get_session", observed_get_session)
            monkeypatch.setattr(runs_routes, "dispatch_persisted_job", observed_dispatch)
            response = await client.post(
                runs_url_for(revision_id),
                headers=headers,
                json={
                    "revision": revision_id,
                    "engine": "random-search",
                    "mode": "seeded",
                    "optimization": OPTIMIZATION,
                },
            )
            assert response.status_code == 202, response.text
            assert scheduled_after_commit == [True]

        async with db_base.session_factory()() as verification_session:
            stored = await verification_session.get(Job, uuid.UUID(response.json()["id"]))
            assert stored is not None
            assert stored.state is JobState.COMPLETED
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)
        space_client.set_gate(previous_gate)
        await db_base.dispose_engine()


async def test_v1_plan_limits_are_persisted_in_options_and_provenance(
    api_client, registration, monkeypatch
):
    dispatched_options = []

    async def solve(_registration, _problem, options, _optimization, **_kwargs):
        dispatched_options.append(options)
        return {
            "termination": "FEASIBLE",
            "solutions": [
                {
                    "decision": {
                        "kind": "binding",
                        "binding": {
                            "t1": {"resource": "catalog", "id": "c1a"},
                            "t2": {"resource": "catalog", "id": "c2a"},
                            "t3": {"resource": "catalog", "id": "c3a"},
                        },
                    }
                }
            ],
        }

    monkeypatch.setattr(execution, "solve_remote", solve)
    monkeypatch.setattr(get_settings(), "max_iterations", 10_000)
    headers = await _register_and_login(api_client, registration())
    revision_id = (await upload_problem(api_client, headers))["revision_id"]

    response = await api_client.post(
        runs_url_for(revision_id),
        headers=headers,
        json={
            "revision": revision_id,
            "engine": "evolutionary-heuristics",
            "mode": "elitist-genetic",
            "options": {"max_evaluations": 50_000, "population_size": 100},
            "optimization": OPTIMIZATION,
        },
    )
    assert response.status_code == 202, response.text

    job = await api_client.get(f"{runs_url_for(revision_id)}/{response.json()['id']}", headers=headers)
    assert job.status_code == 200, job.text
    provenance = job.json()["provenance"]
    assert provenance["options"]["max_evaluations"] == 10_000
    assert provenance["options"]["population_size"] == 100
    assert provenance["warnings"] == [
        {
            "code": "OPTION_CLAMPED",
            "message": (
                "'max_evaluations' was reduced from 50000 to 10000 iterations, "
                "which is what this deployment allows."
            ),
            "details": {
                "option": "max_evaluations",
                "requested": 50_000,
                "applied": 10_000,
                "unit": "iterations",
            },
        }
    ]
    assert dispatched_options
    assert dispatched_options[0] == provenance["options"]


async def test_v1_private_resources_require_authentication(api_client, registration):
    headers = await _register_and_login(api_client, registration())
    created = await upload_problem(api_client, headers, slug="private")
    source = f"/v1/organizations/{created['org']}/problems/private/revisions/1/source"
    assert (await api_client.get(source)).status_code == 401


async def test_a_registry_reference_is_not_resolved(api_client, registration):
    # The gateway keeps no registry of resources: only package files and library versions resolve.
    details = registration()
    headers = await _register_and_login(api_client, details)
    package = load_package(EXAMPLE)
    files = dict(package.files)
    optimization = files.pop("optimization.json")
    instance = strict_json_loads(files["instance.json"])
    instance["spec"]["resources"]["optimization"]["optimization"] = {
        "namespace": details["username"],
        "name": "optimization",
        "version": "1.0.0",
        "digest": digest_bytes(optimization),
    }
    files["instance.json"] = json.dumps(instance).encode()
    org = await make_org(api_client, headers)
    refused = await api_client.post(
        f"/v1/organizations/{org}/problems", headers=_zip_headers(headers), content=InstancePackage(files).to_zip()
    )
    assert refused.status_code == 422, refused.text

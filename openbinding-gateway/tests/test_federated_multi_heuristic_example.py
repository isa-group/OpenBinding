from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from _repo import REPO_ROOT

from openbinding_gateway.db.models import EngineRegistrationRevision, EngineRevision, User, UserRole
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.v1.canonical import digest


EXAMPLE = REPO_ROOT / "examples/federation/multi-heuristic"
OPENAPI = REPO_ROOT / "engines/multi-heuristic/src/main/resources/openapi.json"


def documents() -> tuple[dict, dict, dict]:
    return tuple(
        json.loads(path.read_text(encoding="utf-8"))
        for path in (EXAMPLE / "engine.json", EXAMPLE / "registration.json", OPENAPI)
    )


def test_federated_example_pins_valid_immutable_contracts() -> None:
    engine, registration, deployment_openapi = documents()

    assert engine["metadata"]["namespace"] == "admin"
    assert registration["metadata"]["namespace"] == "admin"
    assert registration["spec"]["engine"]["namespace"] == "admin"
    assert routes._schema_diagnostics(engine, "Engine") == []
    assert routes._engine_contract_diagnostics(engine) == []
    assert routes._schema_diagnostics(registration, "EngineRegistration") == []
    assert registration["spec"]["engine"]["digest"] == digest(engine)
    assert registration["spec"]["protocol"]["digest"] == routes._protocol_digest()
    assert deployment_openapi["x-bim-protocol-digest"] == routes._protocol_digest()
    assert registration["spec"]["openapi"] == deployment_openapi
    assert routes._installed_builtin_registration(engine, "http://engine-multi-heuristic:8080") is None

    mode = engine["spec"]["modes"][0]
    problem = routes._conformance_problem(mode)
    optimization = problem["spec"]["optimization"]
    assert (optimization["type"], optimization["mode"], len(optimization["terms"])) == (
        "MULTI",
        "pareto",
        2,
    )


def test_federated_example_openapi_is_protocol_equivalent() -> None:
    _, _, deployed = documents()
    canonical = routes._protocol_document()
    deployed_operation = deployed["paths"]["/internal/v1/binding-problems"]["post"]
    canonical_operation = canonical["paths"]["/internal/v1/binding-problems"]["post"]
    routes._assert_protocol_schema(
        "solve request",
        deployed,
        routes._operation_schema(deployed_operation, request=True),
        canonical,
        routes._operation_schema(canonical_operation, request=True),
    )
    routes._assert_protocol_schema(
        "synchronous result",
        deployed,
        routes._operation_schema(deployed_operation, response="200"),
        canonical,
        routes._operation_schema(canonical_operation, response="200"),
    )


@pytest.mark.asyncio
async def test_federated_verification_probes_the_published_multi_mode(monkeypatch) -> None:
    engine, registration, deployment_openapi = documents()

    async def fetch(_transport, path, **_kwargs):
        return deployment_openapi if path == "/openapi.json" else {"status": "ok"}

    async def solve(_transport, problem, options, **_kwargs):
        optimization = problem["spec"]["optimization"]
        assert optimization["type"] == "MULTI"
        assert optimization["mode"] == "pareto"
        assert len(optimization["terms"]) == 2
        assert options == {"iterations": 5000, "archive_size": 100, "seed": 0}
        return {
            "termination": "FEASIBLE",
            "solutions": [
                {
                    "decision": {
                        "kind": "binding",
                        "binding": {
                            "probe-task": {
                                "resource": "probe-catalog",
                                "id": "probe-candidate",
                            }
                        },
                    }
                }
            ],
        }

    monkeypatch.setattr(routes, "fetch_remote_document", fetch)
    monkeypatch.setattr(routes, "solve_remote", solve)

    report, served, _ = await routes._verify_registration(registration, None, engine)

    assert report["status"] == "verified"
    assert [check["id"] for check in report["checks"]] == [
        "openapi",
        "health",
        "binding-result",
    ]
    assert served == deployment_openapi


@pytest.mark.asyncio
async def test_admin_owns_and_manages_the_federated_example(
    api_client,
    db_session,
    monkeypatch,
) -> None:
    engine, registration, _ = documents()
    created_user = await api_client.post(
        "/v1/auth/register",
        json={
            "username": "admin",
            "email": "admin-federation@example.org",
            "password": "correct-horse-battery",
        },
    )
    assert created_user.status_code == 201, created_user.text
    admin = (
        await db_session.execute(select(User).where(User.username == "admin"))
    ).scalars().one()
    admin.role = UserRole.ADMIN
    await db_session.flush()
    logged = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": "admin", "password": "correct-horse-battery"},
    )
    headers = {"Authorization": f"Bearer {logged.json()['access_token']}"}
    monkeypatch.setattr(routes, "validate_endpoint", lambda endpoint, **_kwargs: None)

    published_engine = await api_client.post("/v1/engines", headers=headers, json=engine)
    assert published_engine.status_code == 201, published_engine.text
    assert published_engine.json()["status"] == "private"
    registered = await api_client.post(
        "/v1/engine-registrations", headers=headers, json=registration
    )
    assert registered.status_code == 201, registered.text
    assert registered.json()["status"] == "private"
    assert registered.json()["active"] is False

    engine_row = (
        await db_session.execute(
            select(EngineRevision).where(EngineRevision.digest == published_engine.json()["digest"])
        )
    ).scalars().one()
    registration_row = (
        await db_session.execute(
            select(EngineRegistrationRevision).where(
                EngineRegistrationRevision.manifest_digest == registered.json()["digest"]
            )
        )
    ).scalars().one()
    assert engine_row.owner_id == registration_row.owner_id == admin.id

    async def verified(document, _credential, engine_document):
        assert engine_document == engine
        return (
            {
                "protocol": "bim-engine/v1",
                "protocolDigest": routes._protocol_digest(),
                "status": "verified",
                "checks": [],
                "durationMs": 0.0,
            },
            document["spec"]["openapi"],
            digest(document["spec"]["openapi"]),
        )

    monkeypatch.setattr(routes, "_verify_registration", verified)
    params = {
        "namespace": "admin",
        "version": registration["metadata"]["version"],
        "digest": registered.json()["digest"],
    }
    activated = await api_client.post(
        "/v1/engine-registrations/multi-heuristic-deployment/activate",
        headers=headers,
        params=params,
    )
    assert activated.status_code == 200, activated.text
    assert activated.json()["status"] == "private"
    assert activated.json()["active"] is True
    private_queue = await api_client.get(
        "/v1/engine-registrations", headers=headers, params={"review": "true"}
    )
    assert private_queue.json()["registrations"] == []

    requested = await api_client.post(
        "/v1/engine-registrations/multi-heuristic-deployment/publication-request",
        headers=headers,
        params=params,
    )
    assert requested.status_code == 200, requested.text
    assert requested.json()["status"] == "pending_review"
    review_queue = await api_client.get(
        "/v1/engine-registrations", headers=headers, params={"review": "true"}
    )
    assert [item["name"] for item in review_queue.json()["registrations"]] == [
        "multi-heuristic-deployment"
    ]

    approved = await api_client.post(
        "/v1/engine-registrations/multi-heuristic-deployment/approve",
        headers=headers,
        params=params,
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "published"
    await db_session.refresh(engine_row)
    assert engine_row.state == "published"

    deactivated = await api_client.post(
        "/v1/engine-registrations/multi-heuristic-deployment/deactivate",
        headers=headers,
        params=params,
    )
    assert deactivated.status_code == 200, deactivated.text
    assert deactivated.json()["status"] == "published"
    assert deactivated.json()["active"] is False

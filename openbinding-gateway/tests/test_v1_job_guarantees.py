from copy import deepcopy
import uuid

import pytest
from sqlalchemy import select

from _repo import REPO_ROOT

from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import Job
from openbinding_gateway.integrations import bim, packages
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services import engines, execution
from bim_core.canonical import digest
from bim_core.package import load_package


EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"

BUILTIN_DEPLOYMENTS = {
    "minizinc-csp": "http://engine-minizinc:3000",
    "random-search": "http://engine-random-search:8080",
    "many-heuristic": "http://engine-many-heuristic:8080",
    "evolutionary-heuristics": "http://engine-evolutionary-heuristics:8080",
}


async def _authenticated_snapshot(client, registration) -> tuple[dict[str, str], str]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await client.post(
        "/v1/auth/login",
        json={
            "username_or_email": details["username"],
            "password": details["password"],
        },
    )
    headers = {"Authorization": f"Bearer {logged.json()['access_token']}"}
    package = load_package(EXAMPLE)
    snapshot = await client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )
    assert snapshot.status_code == 201, snapshot.text
    return headers, snapshot.json()["id"]


def _valid_result(termination: str) -> dict:
    return {
        "termination": termination,
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


def test_builtin_registration_is_deterministic_and_pins_the_whole_deployment() -> None:
    manifest = routes._manifest("random-search")
    endpoint = get_settings().engine_urls["random-search"]

    first = engines.installed_builtin_registration(manifest, endpoint)
    second = engines.installed_builtin_registration(manifest, endpoint)

    assert first is not None
    assert second is not None
    assert engines.registration_reference(first) == engines.registration_reference(second)
    assert first["digest"] == digest(first["document"])
    assert first["document"]["spec"] == {
        "engine": engines.engine_ref(manifest, "bim.builtin"),
        "endpoint": endpoint,
        "protocol": {
            "id": "bim-engine/v1",
            "mediaType": "application/json",
            "digest": engines.protocol_digest(),
        },
        "mappings": engines.BUILTIN_ENGINE_MAPPINGS,
        "auth": {"scheme": "none"},
        "openapi": {
            **engines.protocol_document(),
            "x-bim-protocol": "bim-engine/v1",
            "x-bim-protocol-digest": engines.protocol_digest(),
        },
    }
    assert engines.registration_transport(first).allow_internal_http is True

    changed = engines.installed_builtin_registration(manifest, endpoint + "-changed")
    assert changed is not None
    assert changed["version"] != first["version"]
    assert changed["digest"] != first["digest"]


@pytest.mark.parametrize(("engine", "endpoint"), BUILTIN_DEPLOYMENTS.items())
def test_builtin_registration_documents_accept_their_internal_http_endpoint(
    engine: str,
    endpoint: str,
) -> None:
    registration = engines.installed_builtin_registration(routes._manifest(engine), endpoint)

    assert registration is not None
    assert engines.schema_diagnostics(registration["document"], "EngineRegistration") == []


def test_registration_schema_leaves_https_to_the_runtime_transport_policy() -> None:
    installed = engines.installed_builtin_registration(
        routes._manifest("random-search"),
        BUILTIN_DEPLOYMENTS["random-search"],
    )
    assert installed is not None
    document = deepcopy(installed["document"])
    document["metadata"]["namespace"] = "example.team"

    diagnostics = engines.schema_diagnostics(document, "EngineRegistration")

    assert diagnostics == []


async def test_production_registration_route_rejects_http(
    api_client,
    registration,
    monkeypatch,
) -> None:
    monkeypatch.setattr(get_settings(), "federation_require_https", True)
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await api_client.post(
        "/v1/auth/login",
        json={
            "username_or_email": details["username"],
            "password": details["password"],
        },
    )
    headers = {"Authorization": f"Bearer {logged.json()['access_token']}"}
    installed = engines.installed_builtin_registration(
        routes._manifest("random-search"),
        BUILTIN_DEPLOYMENTS["random-search"],
    )
    assert installed is not None

    response = await api_client.post(
        "/v1/engine-registrations",
        headers=headers,
        json=installed["document"],
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "engine endpoint must use HTTPS without userinfo or fragments"


def test_gateway_downgrades_termination_claims_not_declared_by_the_mode() -> None:
    heuristic = ["FEASIBLE", "UNKNOWN"]
    exact = ["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"]
    port = bim.get_bim()
    ir = port.compile(packages.zip_directory(EXAMPLE))["ir"]

    assert port.reevaluate(ir, _valid_result("OPTIMAL"), None, heuristic)["termination"] == "UNKNOWN"
    assert (
        port.reevaluate(ir, {"termination": "INFEASIBLE", "solutions": []}, None, heuristic)["termination"]
        == "UNKNOWN"
    )
    assert port.reevaluate(ir, _valid_result("OPTIMAL"), None, exact)["termination"] == "OPTIMAL"
    assert (
        port.reevaluate(ir, {"termination": "INFEASIBLE", "solutions": []}, None, exact)["termination"]
        == "INFEASIBLE"
    )


async def test_job_options_must_be_an_object(api_client, registration) -> None:
    headers, snapshot_id = await _authenticated_snapshot(api_client, registration)

    for invalid in (None, [], "fast", 1):
        response = await api_client.post(
            "/v1/jobs",
            headers=headers,
            json={
                "snapshot": snapshot_id,
                "engine": "random-search",
                "mode": "seeded",
                "options": invalid,
            },
        )
        assert response.status_code == 422, response.text
        assert response.json()["title"] == "invalid_option"
        assert response.json()["diagnostics"] == [
            {
                "code": "option_type",
                "message": "engine options must be a JSON object",
                "pointer": "/options",
            }
        ]


async def test_persisted_builtin_job_pins_registration_and_mode_guarantees(
    api_client,
    db_session,
    registration,
    monkeypatch,
) -> None:
    transports = []

    async def solve(transport, _problem, _options, _optimization, **_kwargs):
        transports.append(transport)
        return {
            "termination": "OPTIMAL",
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
    headers, snapshot_id = await _authenticated_snapshot(api_client, registration)
    response = await api_client.post(
        "/v1/jobs",
        headers={**headers, "Idempotency-Key": "builtin-registration-persistence"},
        json={
            "snapshot": snapshot_id,
            "engine": "random-search",
            "mode": "seeded",
            "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"},
        },
    )
    assert response.status_code == 202, response.text

    stored = (
        await db_session.execute(
            select(Job).where(Job.id == uuid.UUID(response.json()["id"]))
        )
    ).scalars().one()
    reference = stored.original_request["registration"]
    assert set(reference) == {"namespace", "name", "version", "digest"}
    assert reference["namespace"] == "bim.builtin"
    assert "builtinEndpoint" not in stored.original_request
    assert stored.original_request["mode"] == {
        "id": "seeded",
        "terminationGuarantees": ["FEASIBLE", "UNKNOWN"],
    }
    assert stored.provenance["registration"] == reference
    assert stored.provenance["terminationGuarantees"] == ["FEASIBLE", "UNKNOWN"]
    assert stored.idempotency_fingerprint.startswith("v2:sha256-")
    assert len(stored.idempotency_fingerprint) == 74
    assert (
        await engines.persisted_engine_contract(
            stored.engine_id,
            stored.provenance["engine"],
            stored.original_request["mode"],
            db_session,
        )
        is not None
    )
    assert (
        await engines.persisted_engine_contract(
            stored.engine_id,
            stored.provenance["engine"],
            {"id": "seeded", "terminationGuarantees": ["OPTIMAL", "UNKNOWN"]},
            db_session,
        )
        is None
    )

    installed_key = tuple(
        reference[field] for field in ("namespace", "name", "version", "digest")
    )
    installed = engines.BUILTIN_REGISTRATIONS[installed_key]
    assert digest(installed["document"]) == reference["digest"]
    assert transports and transports[0].allow_internal_http is True
    assert transports[0].mappings == engines.BUILTIN_ENGINE_MAPPINGS

    fetched = await api_client.get(f"/v1/jobs/{stored.id}", headers=headers)
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["result"]["termination"] == "UNKNOWN"

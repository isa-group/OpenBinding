import copy
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select

from _repo import REPO_ROOT

from openbinding_gateway.db.base import Base
from openbinding_gateway.db.models import EngineRegistrationRevision, User, UserRole
from openbinding_gateway.main import app
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.v1.canonical import digest
from openbinding_gateway.v1.package import load_package


EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
MULTI_ENGINE = REPO_ROOT / "examples/federation/multi-heuristic/engine.json"


async def _account_headers(client, details: dict[str, str]) -> dict[str, str]:
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['access_token']}"}


def _deployment_openapi(contract: dict) -> dict:
    deployment = copy.deepcopy(contract)
    deployment["x-bim-protocol"] = "bim-engine/v1"
    deployment["x-bim-protocol-digest"] = routes._protocol_digest()
    solve = deployment["paths"].pop("/internal/v1/binding-problems")
    job = deployment["paths"].pop("/internal/v1/jobs/{id}")
    deployment["paths"]["/deployment/solve"] = solve
    deployment["paths"]["/deployment/jobs/{id}"] = job
    deployment["paths"]["/deployment/health"] = {
        "get": {"responses": {"200": {"description": "Healthy"}}}
    }
    return deployment


def test_protocol_digest_pins_the_external_binding_problem_schema(monkeypatch) -> None:
    installed = routes._protocol_digest()
    monkeypatch.setattr(routes, "digest_bytes", lambda value: "sha256-" + "f" * 64)

    assert routes._protocol_digest() != installed


def _problem(*, placement: bool = False):
    return SimpleNamespace(
        document={
            "apiVersion": "bim/v1",
            "kind": "BindingProblem",
            "spec": {
                "profile": {"id": "qos-binding/v1"},
                "application": {
                    "tasks": {"task": {"kind": "service"}},
                    "metrics": {
                    "latency": {
                        "scope": "selectedCandidate",
                        "aggregation": {
                                "sequence": "sum",
                                "parallel": "max",
                                "exclusive": "weightedSum",
                                "repeat": "scale",
                                "selection": "sum",
                            }
                        }
                    },
                    "requiredMetrics": ["latency"],
                    "workflow": {"kind": "sequence", "steps": [{"kind": "task"}]},
                },
                "candidates": {
                    "catalog": {
                        "providers": {},
                        "metricBindings": {},
                        "candidates": {"one": {}, "two": {}},
                    }
                },
                "constraints": [{"enforcement": "soft", "assert": {"kind": "compare"}, "penalty": {"kind": "literal"}}],
                "optimization": {"mode": "weighted", "type": "MONO", "terms": []},
                "placement": [{"kind": "pool"}] if placement else [],
                "dialects": [{"id": "qos-binding/v1"}],
            }
        }
    )


def test_mode_compatibility_checks_construct_values_and_limits() -> None:
    mode = {
        "profile": "qos-binding/v1",
        "ir": {"apiVersion": "bim/v1", "kind": "BindingProblem"},
        "capabilities": {
            "workflowNodes": {"selector": "only", "values": ["task"]},
            "aggregations": {"selector": "all"},
            "metricScopes": {"selector": "only", "values": ["invocation"]},
            "constraints": {"selector": "none"},
            "optimization": {"selector": "only", "values": ["satisfy"]},
            "objectiveTypes": {"selector": "only", "values": ["MONO"]},
            "expressions": {"selector": "all"},
            "placement": {"selector": "none"},
            "irExtensions": {"selector": "none"},
        },
        "limits": {"maxTasks": 10, "maxCandidates": 1},
    }
    diagnostics = routes._mode_compatibility(_problem(placement=True), mode)
    by_category = {item.get("category") for item in diagnostics}
    assert {"workflowNodes", "metricScopes", "constraints", "optimization", "placement"} <= by_category
    assert any(item.get("limit") == "maxCandidates" for item in diagnostics)


def test_mode_compatibility_accepts_all_only_for_closed_dimensions() -> None:
    mode = {
        "profile": "qos-binding/v1",
        "ir": {"apiVersion": "bim/v1", "kind": "BindingProblem"},
        "capabilities": {
            category: {"selector": "all"}
            for category in (
                "workflowNodes",
                "aggregations",
                "metricScopes",
                "constraints",
                "optimization",
                "objectiveTypes",
                "expressions",
                "placement",
            )
        } | {"irExtensions": {"selector": "none"}},
        "limits": {"maxTasks": 10, "maxCandidates": 10},
    }
    assert routes._mode_compatibility(_problem(placement=True), mode) == []


def test_none_selector_accepts_an_unused_feature_category() -> None:
    mode = {
        "profile": "qos-binding/v1",
        "ir": {"apiVersion": "bim/v1", "kind": "BindingProblem"},
        "capabilities": {
            category: {"selector": "all"}
            for category in (
                "workflowNodes",
                "aggregations",
                "metricScopes",
                "constraints",
                "optimization",
                "objectiveTypes",
                "expressions",
            )
        }
        | {
            "placement": {"selector": "none"},
            "irExtensions": {"selector": "none"},
        },
        "limits": {"maxTasks": 10, "maxCandidates": 10},
    }
    assert routes._mode_compatibility(_problem(), mode) == []


@pytest.mark.parametrize(
    ("objective_type", "objective_count", "many_compatible", "multi_compatible"),
    [
        ("MANY", 2, False, False),
        ("MANY", 3, True, False),
        ("MANY", 4, True, False),
        ("MULTI", 1, False, False),
        ("MULTI", 2, False, True),
        ("MULTI", 3, False, True),
        ("MULTI", 4, False, False),
    ],
)
def test_many_and_multi_modes_are_eligible_only_for_their_declared_objective_class(
    objective_type: str,
    objective_count: int,
    many_compatible: bool,
    multi_compatible: bool,
) -> None:
    problem = _problem()
    problem.document["spec"]["optimization"] = {
        "mode": "pareto",
        "type": objective_type,
        "terms": [{} for _ in range(objective_count)],
    }
    many = copy.deepcopy(routes._manifest("many-heuristic")["spec"]["modes"][0])
    multi = json.loads(MULTI_ENGINE.read_text(encoding="utf-8"))["spec"]["modes"][0]

    assert (routes._mode_compatibility(problem, many) == []) is many_compatible
    assert (routes._mode_compatibility(problem, multi) == []) is multi_compatible


def test_feature_extraction_ignores_unreachable_aggregation_expressions() -> None:
    problem = _problem()
    aggregation = problem.document["spec"]["application"]["metrics"]["latency"]["aggregation"]
    aggregation["sequence"] = {
        "kind": "arithmetic",
        "op": "add",
        "left": {"kind": "literal", "value": 1},
        "right": {"kind": "literal", "value": 2},
    }
    # selectedCandidate metrics execute only the selection slot, so a source
    # override in an unreachable workflow slot is not an Engine requirement.
    assert "arithmetic" not in routes._ir_features(problem)["expressions"]


@pytest.mark.asyncio
async def test_registration_conformance_pins_openapi_and_probes_result(monkeypatch) -> None:
    contract = routes._protocol_document()
    deployment = _deployment_openapi(contract)
    fetched_paths = []

    async def fetch(registration, path, **kwargs):
        fetched_paths.append(path)
        return deployment if path == "/deployment/openapi.json" else {"status": "ready"}

    async def solve(*args, **kwargs):
        return {
            "termination": "FEASIBLE",
            "solutions": [
                {
                    "decision": {
                        "kind": "binding",
                        "binding": {
                            "probe-task": {"resource": "probe-catalog", "id": "probe-candidate"}
                        },
                    }
                }
            ],
        }

    monkeypatch.setattr(routes, "fetch_remote_document", fetch)
    monkeypatch.setattr(routes, "solve_remote", solve)
    registration = {
        "spec": {
            "endpoint": "https://solver.example",
            "protocol": {"id": "bim-engine/v1", "digest": routes._protocol_digest()},
            "mappings": {
                "request": "/deployment/solve",
                "job": "/deployment/jobs/{id}",
                "health": "/deployment/health",
                "openapi": "/deployment/openapi.json",
            },
            "auth": {"scheme": "none"},
            "openapi": deployment,
        }
    }
    report, served, served_digest = await routes._verify_registration(
        registration, None, routes._manifest("random-search")
    )
    assert report["status"] == "verified"
    assert [item["id"] for item in report["checks"]] == ["openapi", "health", "binding-result"]
    assert fetched_paths == ["/deployment/openapi.json", "/deployment/health"]
    assert served == deployment
    assert served_digest == digest(deployment)
    assert served_digest != digest(contract)


@pytest.mark.asyncio
async def test_registration_conformance_rejects_unpinned_openapi(monkeypatch) -> None:
    async def fetch(*args, **kwargs):
        raise AssertionError("a missing submitted OpenAPI must fail before network access")

    async def solve(*args, **kwargs):
        raise AssertionError("solve probe must not run for an unpinned OpenAPI")

    monkeypatch.setattr(routes, "fetch_remote_document", fetch)
    monkeypatch.setattr(routes, "solve_remote", solve)
    registration = {
        "spec": {
            "endpoint": "https://solver.example",
            "protocol": {"id": "bim-engine/v1", "digest": routes._protocol_digest()},
            "mappings": {"request": "/internal/v1/binding-problems", "openapi": "/openapi.json"},
            "auth": {"scheme": "none"},
        }
    }
    report, served, served_digest = await routes._verify_registration(
        registration, None, routes._manifest("random-search")
    )
    assert report["status"] == "failed"
    assert served is None
    assert served_digest is None


def test_registration_openapi_cannot_call_optional_auth_required() -> None:
    document = {
        "components": {
            "securitySchemes": {
                "Bearer": {"type": "http", "scheme": "bearer"},
            }
        }
    }
    operation = {"security": [{}, {"Bearer": []}]}

    with pytest.raises(routes.RemoteEngineError, match="permits anonymous access"):
        routes._assert_operation_auth(document, operation, "bearer", "solve operation")


@pytest.mark.asyncio
async def test_registration_conformance_checks_async_job_auth(monkeypatch) -> None:
    deployment = _deployment_openapi(routes._protocol_document())
    deployment.setdefault("components", {})["securitySchemes"] = {
        "Bearer": {"type": "http", "scheme": "bearer"},
    }
    deployment["paths"]["/deployment/solve"]["post"]["security"] = [{"Bearer": []}]
    deployment["paths"]["/deployment/health"]["get"]["security"] = [{"Bearer": []}]

    async def fetch(*args, **kwargs):
        return deployment

    async def solve(*args, **kwargs):
        raise AssertionError("the solve probe must not run when polling auth is unspecified")

    monkeypatch.setattr(routes, "fetch_remote_document", fetch)
    monkeypatch.setattr(routes, "solve_remote", solve)
    registration = {
        "spec": {
            "endpoint": "https://solver.example",
            "protocol": {"id": "bim-engine/v1", "digest": routes._protocol_digest()},
            "mappings": {
                "request": "/deployment/solve",
                "job": "/deployment/jobs/{id}",
                "health": "/deployment/health",
                "openapi": "/deployment/openapi.json",
            },
            "auth": {"scheme": "bearer"},
            "openapi": deployment,
        }
    }

    report, _, _ = await routes._verify_registration(
        registration, "secret", routes._manifest("random-search")
    )

    assert report["status"] == "failed"
    assert "asynchronous job operation permits anonymous access" in report["checks"][-1]["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["protocol", "digest", "request-schema", "result-schema"])
async def test_registration_conformance_rejects_false_protocol_or_schema(monkeypatch, failure: str) -> None:
    contract = routes._protocol_document()
    deployment = _deployment_openapi(contract)
    if failure == "protocol":
        deployment["x-bim-protocol"] = "not-bim/v1"
    elif failure == "digest":
        deployment["x-bim-protocol-digest"] = "sha256-" + "0" * 64
    elif failure == "request-schema":
        deployment["components"]["schemas"]["BindingProblemRequest"]["additionalProperties"] = True
    else:
        deployment["components"]["schemas"]["BindingResult"]["additionalProperties"] = True

    async def fetch(*args, **kwargs):
        return deployment

    async def solve(*args, **kwargs):
        raise AssertionError("solve probe must not run for a false protocol declaration or schema")

    monkeypatch.setattr(routes, "fetch_remote_document", fetch)
    monkeypatch.setattr(routes, "solve_remote", solve)
    registration = {
        "spec": {
            "endpoint": "https://solver.example",
            "protocol": {"id": "bim-engine/v1", "digest": routes._protocol_digest()},
            "mappings": {
                "request": "/deployment/solve",
                "job": "/deployment/jobs/{id}",
                "health": "/deployment/health",
                "openapi": "/deployment/openapi.json",
            },
            "auth": {"scheme": "none"},
            "openapi": deployment,
        }
    }
    report, served, served_digest = await routes._verify_registration(
        registration, None, routes._manifest("random-search")
    )
    assert report["status"] == "failed"
    assert report["checks"][-1]["id"] == "conformance"
    assert served == deployment
    assert served_digest == digest(deployment)


def test_retired_federated_engine_model_is_absent() -> None:
    assert "federated_engines" not in Base.metadata.tables


def test_secret_detection_is_recursive() -> None:
    assert routes._embedded_secret_paths({"spec": {"extensions": {"nested": [{"apiToken": "x"}]}}}) == [
        "/spec/extensions/nested/0/apiToken"
    ]


def test_repeated_engine_aliases_are_removed_and_protocol_stays_public() -> None:
    client = TestClient(app)
    assert "/v1/catalog/engines" not in app.openapi()["paths"]
    assert "/v1/catalog/engines/{name}" not in app.openapi()["paths"]
    protocol = client.get("/v1/schemas/engine-contract").json()
    assert protocol["protocol"] == "bim-engine/v1"
    assert protocol["digest"] == routes._protocol_digest()


def test_structured_http_errors_preserve_their_problem_code() -> None:
    response = routes._error_from_http(
        HTTPException(
            status_code=422,
            detail={
                "code": "engine_mode_incompatible",
                "message": "the selected mode cannot run this IR",
                "diagnostics": [{"code": "unsupported_capability"}],
            },
        )
    )
    assert response.media_type == "application/problem+json"
    assert json.loads(response.body)["title"] == "engine_mode_incompatible"


def test_pricing_contract_is_public_and_separate_from_bim_schemas() -> None:
    client = TestClient(app)
    response = client.get("/v1/pricing")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/yaml")
    assert "syntaxVersion:" in response.text
    assert client.get("/v1/schemas/pricing").status_code == 404


@pytest.mark.asyncio
async def test_analyze_counts_candidates_and_reports_immutable_compatible_modes(
    api_client,
    registration,
) -> None:
    headers = await _account_headers(api_client, registration())
    package = load_package(EXAMPLE)
    response = await api_client.post(
        "/v1/analyze",
        content=package.to_zip(),
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["analysis"] == {
        "tasks": 3,
        "candidates": 4,
        "constraints": 0,
        "placement": False,
    }
    assert any(item["compatible"] for item in payload["compatibleModes"])
    for item in payload["compatibleModes"]:
        assert {"namespace", "name", "version", "digest"} == set(item["engine"])
        assert {"namespace", "name", "version", "digest"} == set(item["registration"])


@pytest.mark.asyncio
async def test_analyze_enumerates_exact_visible_active_registrations_without_ambiguity(
    api_client,
    db_session,
    registration,
    monkeypatch,
) -> None:
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    headers = {"Authorization": f"Bearer {logged.json()['access_token']}"}
    viewer_details = registration()
    viewer_headers = await _account_headers(api_client, viewer_details)
    viewer = (
        await db_session.execute(
            select(User).where(User.username == viewer_details["username"])
        )
    ).scalars().one()
    monkeypatch.setattr(routes, "validate_endpoint", lambda endpoint, **_kwargs: None)
    engine = next(
        item
        for item in (await api_client.get("/v1/engines", headers=headers)).json()["engines"]
        if item["name"] == "random-search"
    )
    engine_ref = {field: engine[field] for field in ("namespace", "name", "version", "digest")}

    async def create_deployment(name: str) -> dict:
        deployment_openapi = _deployment_openapi(routes._protocol_document())
        response = await api_client.post(
            "/v1/engine-registrations",
            headers=headers,
            json={
                "apiVersion": "bim/v1",
                "kind": "EngineRegistration",
                "metadata": {
                    "namespace": details["username"],
                    "name": name,
                    "version": "1.0.0",
                },
                "spec": {
                    "engine": engine_ref,
                    "endpoint": f"https://{name}.example.test",
                    "protocol": {
                        "id": "bim-engine/v1",
                        "mediaType": "application/json",
                        "digest": routes._protocol_digest(),
                    },
                    "mappings": {
                        "request": "/deployment/solve",
                        "health": "/deployment/health",
                        "openapi": "/openapi.json",
                    },
                    "auth": {"scheme": "none"},
                    "openapi": deployment_openapi,
                },
            },
        )
        assert response.status_code == 201, response.text
        return response.json()

    private_a = await create_deployment("private-a")
    private_b = await create_deployment("private-b")
    public = await create_deployment("public-a")
    pending = await create_deployment("pending-a")
    rows = (
        await db_session.execute(
            select(EngineRegistrationRevision).where(
                EngineRegistrationRevision.name.in_(["private-a", "private-b", "public-a", "pending-a"])
            )
        )
    ).scalars().all()
    states = {
        private_a["digest"]: ("private", True),
        private_b["digest"]: ("private", True),
        public["digest"]: ("published", True),
        pending["digest"]: ("pending_review", False),
    }
    for row in rows:
        row.publication_status, row.is_active = states[row.manifest_digest]
    await db_session.flush()

    package = load_package(EXAMPLE).to_zip()
    owner_analysis = await api_client.post(
        "/v1/analyze",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package,
    )
    assert owner_analysis.status_code == 200, owner_analysis.text
    owner_refs = {
        tuple(item["registration"][field] for field in ("namespace", "name", "version", "digest"))
        for item in owner_analysis.json()["compatibleModes"]
        if item["engine"] == engine_ref and item["mode"] == "seeded"
    }
    expected_owner = {
        tuple(item[field] for field in ("namespace", "name", "version", "digest"))
        for item in (private_a, private_b, public)
    }
    assert expected_owner <= owner_refs
    assert tuple(pending[field] for field in ("namespace", "name", "version", "digest")) not in owner_refs
    assert any(reference[0] == "bim.builtin" for reference in owner_refs)

    public_analysis = await api_client.post(
        "/v1/analyze",
        headers={**viewer_headers, "Content-Type": "application/vnd.bim+zip"},
        content=package,
    )
    assert public_analysis.status_code == 200, public_analysis.text
    viewer_refs = {
        tuple(item["registration"][field] for field in ("namespace", "name", "version", "digest"))
        for item in public_analysis.json()["compatibleModes"]
        if item["engine"] == engine_ref and item["mode"] == "seeded"
    }
    assert tuple(public[field] for field in ("namespace", "name", "version", "digest")) in viewer_refs
    assert tuple(private_a[field] for field in ("namespace", "name", "version", "digest")) not in viewer_refs

    public_job_registration = await routes._registration_for_engine(
        *(public[field] for field in ("namespace", "name", "version", "digest")),
        viewer,
        db_session,
    )
    private_job_registration = await routes._registration_for_engine(
        *(private_a[field] for field in ("namespace", "name", "version", "digest")),
        viewer,
        db_session,
    )
    assert routes._registration_reference(public_job_registration) == {
        field: public[field] for field in ("namespace", "name", "version", "digest")
    }
    assert routes._registration_engine_reference(public_job_registration) == engine_ref
    assert private_job_registration is None


@pytest.mark.asyncio
async def test_analyze_rejects_the_removed_inline_instance_convenience_form(
    api_client,
    registration,
) -> None:
    headers = await _account_headers(api_client, registration())
    response = await api_client.post(
        "/v1/analyze",
        headers=headers,
        json={"instance": load_package(EXAMPLE).instance()},
    )
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["title"] == "snapshot_or_package_required"


@pytest.mark.parametrize("body_kind", ["inline", "vfs"])
@pytest.mark.asyncio
async def test_jobs_reject_json_packages_in_favour_of_snapshots_or_zip(
    body_kind: str,
    api_client,
    registration,
) -> None:
    headers = await _account_headers(api_client, registration())
    package = load_package(EXAMPLE)
    body = (
        {"instance": package.instance()}
        if body_kind == "inline"
        else {
            "files": {
                path: json.loads(content)
                for path, content in package.files.items()
            }
        }
    )
    body.update({"engine": "random-search", "mode": "seeded"})
    response = await api_client.post(
        "/v1/jobs",
        headers=headers,
        json=body,
    )
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["title"] == "snapshot_or_package_required"


@pytest.mark.asyncio
async def test_registration_lifecycle_targets_one_exact_immutable_revision(
    api_client,
    db_session,
    registration,
    monkeypatch,
) -> None:
    details = registration()
    created_user = await api_client.post("/v1/auth/register", json=details)
    assert created_user.status_code == 201, created_user.text
    logged = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    headers = {"Authorization": f"Bearer {logged.json()['access_token']}"}
    admin_details = registration()
    admin_headers = await _account_headers(api_client, admin_details)
    admin = (
        await db_session.execute(
            select(User).where(User.username == admin_details["username"])
        )
    ).scalars().one()
    admin.role = UserRole.ADMIN
    await db_session.flush()
    monkeypatch.setattr(routes, "validate_endpoint", lambda endpoint, **_kwargs: None)

    async def verified(document, _credential, _engine):
        submitted = document["spec"]["openapi"]
        return (
            {
                "protocol": "bim-engine/v1",
                "protocolDigest": routes._protocol_digest(),
                "status": "verified",
                "checks": [],
                "durationMs": 0.0,
            },
            submitted,
            digest(submitted),
        )

    monkeypatch.setattr(routes, "_verify_registration", verified)

    engines = (await api_client.get("/v1/engines", headers=headers)).json()["engines"]
    engine = next(item for item in engines if item["name"] == "random-search")

    async def create_revision(version: str):
        deployment_openapi = _deployment_openapi(routes._protocol_document())
        document = {
            "apiVersion": "bim/v1",
            "kind": "EngineRegistration",
                "metadata": {
                    "namespace": details["username"],
                    "name": "same-deployment",
                    "version": version,
                },
            "spec": {
                "engine": {
                    key: engine[key]
                    for key in ("namespace", "name", "version", "digest")
                },
                "endpoint": "https://solver.example",
                "protocol": {
                    "id": "bim-engine/v1",
                    "mediaType": "application/json",
                    "digest": routes._protocol_digest(),
                },
                "mappings": {
                    "request": "/deployment/solve",
                    "health": "/deployment/health",
                    "openapi": "/openapi.json",
                },
                "auth": {"scheme": "none"},
                "openapi": deployment_openapi,
            },
        }
        response = await api_client.post(
            "/v1/engine-registrations",
            headers=headers,
            json=document,
        )
        assert response.status_code == 201, response.text
        return response.json()

    first = await create_revision("1.0.0")
    second = await create_revision("2.0.0")
    assert set(first) == {"namespace", "name", "version", "digest", "status", "active"}
    assert first["status"] == second["status"] == "private"
    assert first["active"] is second["active"] is False

    missing_selector = await api_client.post(
        "/v1/engine-registrations/same-deployment/reject",
        headers=admin_headers,
    )
    assert missing_selector.status_code == 422

    refused = await api_client.post(
        "/v1/engine-registrations/same-deployment/reject",
        headers=headers,
        params={key: first[key] for key in ("namespace", "version", "digest")},
    )
    assert refused.status_code == 403

    first_params = {key: first[key] for key in ("namespace", "version", "digest")}
    activated = await api_client.post(
        "/v1/engine-registrations/same-deployment/activate",
        headers=headers,
        params=first_params,
    )
    assert activated.status_code == 200, activated.text
    requested = await api_client.post(
        "/v1/engine-registrations/same-deployment/publication-request",
        headers=headers,
        params=first_params,
    )
    assert requested.status_code == 200, requested.text
    rejected = await api_client.post(
        "/v1/engine-registrations/same-deployment/reject",
        headers=admin_headers,
        params=first_params,
    )
    assert rejected.status_code == 200, rejected.text
    assert rejected.json() == {**first, "status": "rejected", "active": True}

    rows = (await api_client.get("/v1/engine-registrations", headers=headers)).json()["registrations"]
    states = {(row["version"], row["digest"]): row["status"] for row in rows}
    assert states[(first["version"], first["digest"])] == "rejected"
    assert states[(second["version"], second["digest"])] == "private"


def test_builtin_dialects_satisfy_the_public_schema() -> None:
    for dialect in routes._builtin_dialects():
        assert routes._schema_diagnostics(dialect, "Dialect") == []


def test_open_capability_dimensions_never_accept_an_unbounded_all_claim() -> None:
    engine = copy.deepcopy(routes._manifest("random-search"))
    engine["spec"]["modes"][0]["capabilities"]["irExtensions"] = {"selector": "all"}
    diagnostics = routes._engine_contract_diagnostics(engine)
    assert any(
        item["code"] == "open_capability_requires_explicit_values"
        and item["pointer"].endswith("/irExtensions/selector")
        for item in diagnostics
    )


def test_compiled_ir_pins_complete_dialect_and_adapter_revisions() -> None:
    problem = routes.compile_instance(load_package(EXAMPLE))
    installed = routes._builtin_dialects()[0]
    descriptor = problem.document["spec"]["dialects"][0]
    assert descriptor["id"] == "qos-binding/v1"
    assert descriptor["digest"] == digest(installed)
    assert descriptor["adapter"] == {
        "id": installed["spec"]["adapter"]["id"],
        "version": installed["spec"]["adapter"]["version"],
        "digest": installed["spec"]["adapter"]["binaryDigest"],
    }


def test_dialect_publication_cannot_relabel_an_installed_binary_contract() -> None:
    document = copy.deepcopy(routes._builtin_dialects()[0])
    document["spec"]["roles"] = ["application"]
    assert routes._installed_dialect_contract(document) is False


def test_gateway_rejects_incomplete_decisions_and_replaces_engine_evaluation() -> None:
    class FakeProblem:
        document = {
            "spec": {
                "application": {"metrics": {"latency": {}}},
                "optimization": {"penalties": []},
            }
        }

        def validate_binding(self, binding):
            if binding != {"task": {"resource": "catalog", "id": "candidate"}}:
                raise ValueError("binding must contain exactly service tasks")
            return binding

        def evaluate(self, binding):
            self.validate_binding(binding)
            return {
                "metrics": {"latency": 7.0},
                "objectives": {"mode": "weighted", "score": 7.0},
                "violations": [],
            }

    incomplete = routes._reevaluate_result(
        FakeProblem(),
        {"termination": "FEASIBLE", "solutions": [{"decision": {"kind": "binding", "binding": {}}}]},
    )
    assert incomplete["termination"] == "UNKNOWN"
    assert incomplete["solutions"] == []

    valid = routes._reevaluate_result(
        FakeProblem(),
        {
            "termination": "FEASIBLE",
            "solutions": [
                {
                    "decision": {
                        "kind": "binding",
                        "binding": {"task": {"resource": "catalog", "id": "candidate"}},
                    },
                    "metrics": {"latency": -999},
                }
            ],
        },
    )
    assert valid["termination"] == "FEASIBLE"
    assert valid["solutions"][0]["metrics"] == {"latency": 7.0}
    assert valid["solutions"][0]["objectives"]["score"] == 7.0

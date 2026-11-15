"""The OpenAPI document, treated as the contract it is.

The document is generated, so it cannot be stale - which is exactly the problem
it used to have: a change to the contract was invisible in review, buried in a
change to a Pydantic model. These pin the properties a consumer would rely on,
and `test_the_committed_snapshot_is_current` puts the rest in the diff.

The audience matters. A third party implementing an engine, or generating a
client, reads this and nothing else.
"""

from __future__ import annotations

import json
import subprocess
import sys

import jsonschema
import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from _paths import GATEWAY_ROOT
from _repo import REPO_ROOT
from openbinding_gateway.access.dependencies import (
    get_current_user,
    get_reader,
    require_admin,
    require_platform_admin,
    require_v1_admin,
    solve_caller,
)
from openbinding_gateway.main import app
from openbinding_gateway.security.apikeys import ENGINE_LIMITED_PERMISSIONS

SNAPSHOT = REPO_ROOT / "docs" / "openapi.json"


@pytest.fixture(scope="module")
def document() -> dict:
    return app.openapi()


def operations(document: dict):
    for path, methods in document["paths"].items():
        for method, operation in methods.items():
            yield path, method, operation


# -- What a consumer needs to exist -----------------------------------------


def test_the_document_names_and_versions_itself(document):
    info = document["info"]
    assert info["title"] == "OpenBinding Gateway"
    assert info["version"]
    assert info["description"]


def test_every_operation_has_a_stable_identifier(document):
    # Generated clients name their methods after these, and a federated engine
    # manifest refers to operations by id - so an operation without one is a
    # method called `solve_v1_solve_post` today and something else tomorrow.
    missing = [f"{m.upper()} {p}" for p, m, op in operations(document) if not op.get("operationId")]
    assert missing == []


def test_operation_identifiers_are_unique(document):
    ids = [op["operationId"] for _, _, op in operations(document)]
    duplicates = {i for i in ids if ids.count(i) > 1}
    assert duplicates == set()


def test_every_operation_is_tagged(document):
    # Untagged operations land in a "default" bucket, which is where an API
    # stops being navigable.
    untagged = [f"{m.upper()} {p}" for p, m, op in operations(document) if not op.get("tags")]
    assert untagged == []


def test_every_operation_has_a_summary(document):
    missing = [f"{m.upper()} {p}" for p, m, op in operations(document) if not op.get("summary")]
    assert missing == []


def test_every_success_response_has_a_concrete_media_schema(document):
    empty = []
    for path, method, operation in operations(document):
        for code, response in operation.get("responses", {}).items():
            if not code.startswith("2"):
                continue
            for media_type, representation in response.get("content", {}).items():
                if representation.get("schema") in ({}, None):
                    empty.append(f"{method.upper()} {path} {code} {media_type}")
    assert empty == []


def test_every_custom_component_is_valid_json_schema(document):
    for name, schema in document["components"]["schemas"].items():
        try:
            jsonschema.Draft202012Validator.check_schema(schema)
        except jsonschema.SchemaError as error:
            pytest.fail(f"components.schemas.{name} is invalid: {error.message}")


def test_authentication_and_role_requirements_are_explicit(document):
    expected = [{"BearerAuth": []}, {"ApiKeyAuth": []}]
    schemes = document["components"]["securitySchemes"]
    assert schemes["BearerAuth"]["type"] == "http"
    assert schemes["BearerAuth"]["scheme"] == "bearer"
    assert schemes["ApiKeyAuth"] == {
        "type": "apiKey",
        "description": (
            "OpenBinding API key. Each key has immutable granular permissions and "
            "access to either selected immutable Engine revisions or all visible Engines."
        ),
        "in": "header",
        "name": "X-API-Key",
    }

    public = {
        ("/health", "get"),
        ("/health/live", "get"),
        ("/health/ready", "get"),
        ("/v1/auth/register", "post"),
        ("/v1/auth/login", "post"),
        ("/v1/auth/refresh", "post"),
        ("/v1/auth/logout", "post"),
        ("/v1/auth/password-reset/request", "post"),
        ("/v1/auth/password-reset/complete", "post"),
        ("/v1/auth/cas/start", "get"),
        ("/v1/auth/cas/callback", "get"),
        ("/v1/auth/cas/exchange", "post"),
        ("/v1/engines/protocol", "get"),
        ("/v1/artifacts/{artifact_id}/versions", "get"),
        ("/v1/artifacts/{artifact_id}/versions/{version_id}/content", "get"),
        ("/v1/artifacts/resolve", "post"),
        ("/v1/bim/templates", "get"),
        ("/v1/bim/templates/{template}", "get"),
        ("/v1/pricing/catalog", "get"),
        ("/v1/pricing/current", "get"),
        # The public engine catalogue: a visitor gets the built-in and published Engines.
        ("/v1/engines", "get"),
        ("/v1/bim/validate", "post"),
        # The stateless Composition2Yaml services: counted for anybody, as /v1/bim/validate is.
        ("/v1/compositions/validate", "post"),
        ("/v1/compositions/parse", "post"),
        ("/v1/compositions/serialise", "post"),
        ("/v1/compositions/diff", "post"),
        ("/v1/compositions/schema", "get"),
    }
    # The reads of a public composition: a credential is optional (`{}`), and one that names nobody is a 401.
    composition = "/v1/organizations/{org}/compositions/{composition}"
    optional = {
        (composition, "get"),
        (f"{composition}/versions", "get"),
        (f"{composition}/versions/{{version}}", "get"),
        (f"{composition}/versions/{{version}}/content", "get"),
        (f"{composition}/diff", "get"),
    }
    for path, method, operation in operations(document):
        if (path, method) in public:
            assert not operation.get("security"), f"{method.upper()} {path} must stay public"
            continue
        wanted = [*expected, {}] if (path, method) in optional else expected
        assert operation.get("security") == wanted, f"{method.upper()} {path} lacks account auth"
        assert {"401", "503"} <= set(operation["responses"])
        assert operation.get("x-required-api-key-permissions"), (
            f"{method.upper()} {path} has no documented API-key permission"
        )
        engine_limited = bool(
            set(operation["x-required-api-key-permissions"])
            & ENGINE_LIMITED_PERMISSIONS
        )
        assert bool(operation.get("x-api-key-engine-access")) is engine_limited, (
            f"{method.upper()} {path} Engine boundary is not documented consistently"
        )
        assert "403" in operation["responses"]

    admin_only = {
        ("/v1/admin/users", "get"),
        ("/v1/admin/users/{user_id}", "patch"),
        ("/v1/admin/users/{user_id}/plan", "post"),
        ("/v1/admin/users/{user_id}/usage", "get"),
        ("/v1/admin/users/{user_id}/subscription", "get"),
        ("/v1/admin/users/{user_id}/subscription", "post"),
        ("/v1/admin/users/{user_id}/api-keys/{key_id}", "delete"),
        ("/v1/admin/audit", "get"),
        ("/v1/admin/maintenance/preview", "get"),
        ("/v1/admin/maintenance/purge", "post"),
        ("/v1/admin/maintenance/reconcile-jobs", "post"),
        ("/v1/admin/moderation", "get"),
        ("/v1/admin/overview", "get"),
        ("/v1/admin/queues", "get"),
        ("/v1/admin/errors/overview", "get"),
        ("/v1/admin/errors", "get"),
        ("/v1/engine-registrations/{name}/approve", "post"),
        ("/v1/engine-registrations/{name}/reject", "post"),
    }
    for path, method in admin_only:
        operation = document["paths"][path][method]
        assert operation["x-required-role"] == "admin"
        assert "403" in operation["responses"]

    described_admin_only = {
        (path, method)
        for path, method, operation in operations(document)
        if operation.get("x-required-role") == "admin"
    }
    assert described_admin_only == admin_only


def test_documented_security_matches_the_runtime_dependency_graph(document):
    """Catch a protected-looking operation whose handler forgot its guard."""

    def calls(dependant) -> set[object]:
        found = {dependant.call}
        for dependency in dependant.dependencies:
            found.update(calls(dependency))
        return found

    routes = {}
    for included in app.routes:
        original_router = getattr(included, "original_router", None)
        candidates = original_router.routes if original_router is not None else [included]
        for route in candidates:
            if isinstance(route, APIRoute):
                for method in route.methods - {"HEAD", "OPTIONS"}:
                    routes[(route.path_format, method.lower())] = route
    auth_guards = {get_current_user, get_reader, solve_caller, require_admin}
    for path, method, operation in operations(document):
        route = routes[(path, method)]
        dependencies = calls(route.dependant)
        assert bool(dependencies & auth_guards) is bool(operation.get("security")), (
            f"{method.upper()} {path} runtime authentication and OpenAPI security differ"
        )
        assert bool({require_admin, require_v1_admin, require_platform_admin} & dependencies) is (
            operation.get("x-required-role") == "admin"
        ), f"{method.upper()} {path} runtime role and OpenAPI role differ"


def test_engine_registration_contract_describes_private_lifecycle_and_openapi(document):
    schemas = document["components"]["schemas"]
    registration = schemas["EngineRegistrationManifest"]
    assert "openapi" in registration["properties"]["spec"]["required"]
    submitted_openapi = registration["properties"]["spec"]["properties"]["openapi"]
    assert {"openapi", "info", "paths", "x-bim-protocol", "x-bim-protocol-digest"} <= set(
        submitted_openapi["required"]
    )
    revision = schemas["EngineRegistrationRevision"]
    assert set(revision["properties"]["status"]["enum"]) == {
        "private",
        "pending_review",
        "published",
        "rejected",
    }
    assert {"status", "active"} <= set(revision["required"])

    paths = document["paths"]
    assert "/v1/catalog/engines" not in paths
    assert "/v1/catalog/engines/{name}" not in paths
    for action in ("activate", "deactivate", "publication-request", "approve", "reject"):
        assert f"/v1/engine-registrations/{{name}}/{action}" in paths
    for removed in ("disable", "publish", "unpublish"):
        assert f"/v1/engine-registrations/{{name}}/{removed}" not in paths

    report = paths["/v1/engine-registrations/{name}/report"]["get"]
    assert report["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/EngineRegistrationReport"
    }
    assert "404" in report["responses"]
    report_schema = schemas["EngineRegistrationReport"]
    assert {"openapiDigest", "openapi", "engine", "report"} <= set(
        report_schema["required"]
    )


def test_binary_yaml_and_job_inputs_have_their_real_media_types(document):
    paths = document["paths"]
    template = paths["/v1/bim/templates/{template}"]["get"]["responses"]["200"]["content"]
    source = paths["/v1/organizations/{org}/problems/{problem}/revisions/{revision}/source"]["get"]["responses"]["200"]["content"]
    assert set(template) == set(source) == {"application/vnd.bim+zip"}

    validate = paths["/v1/bim/validate"]["post"]["requestBody"]["content"]
    assert {"application/vnd.bim+zip", "application/zip"} <= set(validate)
    assert "application/json" not in validate
    for upload in (
        paths["/v1/organizations/{org}/problems"]["post"],
        paths["/v1/organizations/{org}/problems/{problem}/revisions"]["post"],
    ):
        assert set(upload["requestBody"]["content"]) == {"application/vnd.bim+zip", "application/zip"}
    for operation in ("validate", "parse"):
        body = paths[f"/v1/compositions/{operation}"]["post"]["requestBody"]["content"]
        assert set(body) == {"application/yaml", "text/yaml", "application/x-yaml"}
    serialised = paths["/v1/compositions/serialise"]["post"]
    assert set(serialised["requestBody"]["content"]) == {"application/json"}
    assert set(serialised["responses"]["200"]["content"]) == {"application/yaml"}
    schema = paths["/v1/compositions/schema"]["get"]["responses"]["200"]
    assert set(schema["content"]) == {"application/schema+json"}
    assert "ETag" in schema["headers"]
    runs = paths["/v1/organizations/{org}/runs"]["post"]
    assert set(runs["requestBody"]["content"]) == {"application/json"}
    assert runs["requestBody"]["content"]["application/json"]["schema"] == {"$ref": "#/components/schemas/JobRequest"}
    assert any(parameter["name"] == "Idempotency-Key" for parameter in runs["parameters"])
    # A run names its settings or a preset that holds them.
    assert "preset" in document["components"]["schemas"]["JobRequest"]["properties"]


@pytest.mark.parametrize(
    ("path", "component"),
    [
        ("/v1/engines/protocol", "ProfileList"),
        ("/v1/bim/templates", "TemplateList"),
    ],
)
def test_public_catalogue_responses_satisfy_the_published_schema(document, path, component):
    response = TestClient(app).get(path)
    assert response.status_code == 200, response.text
    validator = jsonschema.Draft202012Validator(
        {
            "$ref": f"#/components/schemas/{component}",
            "components": document["components"],
        }
    )
    validator.validate(response.json())


# -- Errors -----------------------------------------------------------------


def test_the_error_shape_is_described(document):
    # Every failure used to be documented as a bare string, whatever the body
    # actually contained.
    schemas = document["components"]["schemas"]
    assert "ErrorResponse" in schemas
    assert "QuotaErrorResponse" in schemas


def test_an_error_carries_a_machine_readable_code(document):
    body = document["components"]["schemas"]["ErrorBody"]
    assert "code" in body["properties"]
    assert "error" in body["properties"]
    assert set(body["required"]) == {"code", "error"}


def test_a_quota_refusal_says_which_limit_and_where_it_stands(document):
    quota = document["components"]["schemas"]["QuotaBody"]["properties"]
    for field in ("limit_id", "limit", "used", "renews_at"):
        assert field in quota, f"a client cannot act on a refusal without {field}"


@pytest.mark.parametrize(
    "path,method,statuses",
    [
        ("/v1/organizations/{org}/runs", "post", {"202", "403", "404", "409", "422", "429"}),
        ("/v1/organizations/{org}/runs/{run}", "get", {"200", "404", "422"}),
        # The run presets of an organization: a non-member gets a 404, a role below MEMBER a 403 on writes.
        ("/v1/organizations/{org}/presets", "get", {"200", "404", "422"}),
        ("/v1/organizations/{org}/presets", "post", {"201", "403", "404", "409", "422"}),
        ("/v1/organizations/{org}/presets/{preset}", "get", {"200", "404"}),
        ("/v1/organizations/{org}/presets/{preset}", "patch", {"200", "400", "403", "404", "412", "422"}),
        ("/v1/organizations/{org}/presets/{preset}", "delete", {"204", "403", "404"}),
        ("/v1/auth/login", "post", {"401", "503"}),
        ("/v1/auth/register", "post", {"409", "503"}),
        ("/v1/users/me", "get", {"401", "503"}),
        ("/v1/admin/users", "get", {"401", "403"}),
        # Conditional writes of the subscription: 400/412 for If-Match, 409 also `contract_changed`.
        ("/v1/admin/users/{user_id}/plan", "post", {"400", "404", "409", "412", "503"}),
        ("/v1/admin/users/{user_id}/subscription", "post", {"400", "404", "409", "412", "503"}),
        ("/v1/organizations", "post", {"201", "409", "422"}),
        ("/v1/organizations/{org}", "delete", {"204", "403", "409"}),
        # The compositions of an organization: an unreadable one is a 404, a weak role a 403.
        ("/v1/organizations/{org}/compositions", "get", {"200", "403", "404", "422"}),
        ("/v1/organizations/{org}/compositions", "post", {"201", "403", "404", "409", "422"}),
        ("/v1/organizations/{org}/compositions/{composition}", "get", {"200", "404"}),
        ("/v1/organizations/{org}/compositions/{composition}", "patch", {"200", "400", "403", "404", "412", "422"}),
        ("/v1/organizations/{org}/compositions/{composition}", "delete", {"204", "403", "404"}),
        # Its versions: a seal is evaluated by the toolchain and counted against the `evaluate` budget.
        ("/v1/organizations/{org}/compositions/{composition}/versions", "get", {"200", "404", "422"}),
        (
            "/v1/organizations/{org}/compositions/{composition}/versions", "post",
            {"200", "201", "403", "404", "409", "413", "415", "422", "429", "503"},
        ),
        (
            "/v1/organizations/{org}/compositions/{composition}/versions/check", "post",
            {"200", "404", "413", "415", "429", "503"},
        ),
        ("/v1/organizations/{org}/compositions/{composition}/versions/{version}", "get", {"200", "404"}),
        ("/v1/organizations/{org}/compositions/{composition}/versions/{version}/content", "get", {"200", "304", "404"}),
        # Comparing two versions reads their stored bytes in a language slot; a fork seals as a seal does.
        ("/v1/organizations/{org}/compositions/{composition}/diff", "get", {"200", "404", "422", "429"}),
        (
            "/v1/organizations/{org}/compositions/{composition}/fork", "post",
            {"200", "201", "403", "404", "409", "422", "429"},
        ),
        # A stored version evaluated again, with another binding, and around its binding.
        (
            "/v1/organizations/{org}/compositions/{composition}/versions/{version}/evaluations", "post",
            {"200", "201", "403", "404", "422", "429", "503"},
        ),
        ("/v1/organizations/{org}/compositions/{composition}/evaluate", "post", {"200", "404", "409", "422", "429", "503"}),
        ("/v1/organizations/{org}/compositions/{composition}/neighborhood", "get", {"200", "404", "409", "422", "429", "503"}),
        # A version derived from a run's solution or a binding, sealed as a seal is.
        (
            "/v1/organizations/{org}/compositions/{composition}/derive", "post",
            {"200", "201", "403", "404", "409", "422", "429", "503"},
        ),
    ],
)
def test_the_failures_an_endpoint_can_produce_are_declared(document, path, method, statuses):
    declared = set(document["paths"][path][method]["responses"])
    assert statuses <= declared, f"{method.upper()} {path} is missing {statuses - declared}"


def test_runs_are_always_accepted_asynchronously(document):
    responses = document["paths"]["/v1/organizations/{org}/runs"]["post"]["responses"]
    assert {code for code in responses if code.startswith("2")} == {"202"}
    assert {"401", "503"} <= set(responses)


# -- The instance and the solution ------------------------------------------


def test_the_instance_structure_is_in_the_document(document):
    schema = json.loads((REPO_ROOT / "schemas/bim/v1/instance.schema.json").read_text())
    assert schema["properties"]["kind"]["const"] == "Instance"
    spec = schema["properties"]["spec"]
    assert set(spec["required"]) == {"profile", "resources"}
    assert spec["properties"]["profile"]["pattern"] == "^[A-Za-z][A-Za-z0-9_.-]{0,127}/v[1-9][0-9]*$"
    resources = schema["properties"]["spec"]["properties"]["resources"]
    assert resources["type"] == "object"
    assert resources["minProperties"] == 1
    assert resources["additionalProperties"] == {"$ref": "#/$defs/nonEmptyGroup"}
    assert "required" not in resources
    assert "properties" not in resources
    target = schema["$defs"]["resourceTarget"]
    assert target["oneOf"] == [
        {"$ref": "#/$defs/localPath"},
        {"$ref": "#/$defs/registeredRef"},
        {"$ref": "#/$defs/artifactRef"},
    ]


def test_projects_and_public_read_are_gone(document):
    assert not [path for path in document["paths"] if "project" in path]
    assert "Projects" not in {tag["name"] for tag in document.get("tags", [])}
    assert "x-public-read" not in json.dumps(document)
    assert not [name for name in document["components"]["schemas"] if name.startswith("Project")]


def test_v1_surface_has_no_replaced_routes(document):
    health_paths = {"/health", "/health/live", "/health/ready"}
    assert all(path.startswith("/v1") or path in health_paths for path in document["paths"])


def test_no_method_and_path_is_registered_twice():
    pairs = []
    for included in app.routes:
        router = getattr(included, "original_router", None)
        routes = router.routes if router is not None else [included]
        for route in routes:
            path = getattr(route, "path", None)
            for method in getattr(route, "methods", set()) or set():
                if path is not None and method not in {"HEAD", "OPTIONS"}:
                    pairs.append((method, path))

    duplicates = {pair for pair in pairs if pairs.count(pair) > 1}
    assert duplicates == set()


# -- The snapshot -----------------------------------------------------------


def test_the_committed_snapshot_is_current():
    # What puts a contract change in the diff. If this fails, run
    # `python tools/dump_openapi.py` and commit the result.
    result = subprocess.run(
        [sys.executable, str(GATEWAY_ROOT / "tools" / "dump_openapi.py"), "--check"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr or result.stdout


def test_the_snapshot_parses_as_json():
    assert isinstance(json.loads(SNAPSHOT.read_text(encoding="utf-8")), dict)

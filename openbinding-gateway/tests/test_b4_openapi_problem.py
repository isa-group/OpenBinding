"""B4: the OpenAPI document declares one 422 for the whole API.

FastAPI's default `HTTPValidationError` / `ValidationError` (a list of
`{loc, msg, type}` under `detail`) is not what the gateway answers with any more;
every 422 is the `Problem` component, whose findings are `Diagnostic`s.
"""

from __future__ import annotations

import json

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.main import _BIM_PATH_PREFIXES, app

SNAPSHOT = REPO_ROOT / "docs" / "openapi.json"
PROBLEM = {"$ref": "#/components/schemas/Problem"}


@pytest.fixture(scope="module", params=["code", "snapshot"])
def document(request) -> dict:
    if request.param == "code":
        return app.openapi()
    return json.loads(SNAPSHOT.read_text(encoding="utf-8"))


def operations(document: dict):
    for path, methods in document["paths"].items():
        for method, operation in methods.items():
            if method in {"get", "post", "put", "patch", "delete"}:
                yield path, method, operation


def references(node):
    """Every `$ref` anywhere in the document."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str):
                yield value
            else:
                yield from references(value)
    elif isinstance(node, list):
        for item in node:
            yield from references(item)


def test_no_endpoint_declares_the_default_validation_error(document):
    offenders = []
    for path, method, operation in operations(document):
        for status, response in operation.get("responses", {}).items():
            for media_type, representation in response.get("content", {}).items():
                ref = json.dumps(representation.get("schema", {}))
                if "HTTPValidationError" in ref or "/ValidationError" in ref:
                    offenders.append(f"{method.upper()} {path} {status} {media_type}")
    assert offenders == []
    assert not [ref for ref in references(document) if ref.endswith(("/HTTPValidationError", "/ValidationError"))]
    schemas = document["components"]["schemas"]
    assert "HTTPValidationError" not in schemas
    assert "ValidationError" not in schemas


def test_every_422_is_the_problem_document_in_the_media_type_its_routes_answer_with(document):
    seen = 0
    for path, method, operation in operations(document):
        response = operation.get("responses", {}).get("422")
        if response is None:
            continue
        seen += 1
        bim = any(path.startswith(prefix) for prefix in _BIM_PATH_PREFIXES)
        expected = "application/problem+json" if bim else "application/json"
        assert set(response["content"]) == {expected}, f"{method.upper()} {path}"
        assert response["content"][expected]["schema"] == PROBLEM, f"{method.upper()} {path}"
        assert response["description"], f"{method.upper()} {path}"
    assert seen > 100


def test_problem_and_diagnostic_are_components(document):
    schemas = document["components"]["schemas"]
    assert "ProblemDetails" not in schemas
    problem = schemas["Problem"]
    assert set(problem["required"]) == {"type", "title", "status", "code", "detail"}
    assert problem["properties"]["status"] == {"type": "integer"}
    assert problem["properties"]["code"]["type"] == "string"
    assert problem["properties"]["diagnostics"]["items"] == {"$ref": "#/components/schemas/Diagnostic"}
    diagnostic = schemas["Diagnostic"]
    assert set(diagnostic["required"]) == {"code", "message"}
    assert {"pointer", "resource", "span", "hint", "fix", "in", "parameter", "loc", "context"} <= set(diagnostic["properties"])
    assert diagnostic["properties"]["in"]["enum"] == ["body", "query", "path", "header", "cookie"]


def test_every_other_refusal_points_at_the_same_problem_component(document):
    refs = {
        representation["schema"]["$ref"]
        for _, _, operation in operations(document)
        for status, response in operation.get("responses", {}).items()
        if status in {"401", "403", "503"}
        for representation in response.get("content", {}).values()
        if "$ref" in representation.get("schema", {})
    }
    assert "#/components/schemas/Problem" in refs
    assert "#/components/schemas/ProblemDetails" not in refs


def test_the_platform_error_envelope_gains_the_canonical_keys_beside_detail(document):
    schemas = document["components"]["schemas"]
    for name in ("ErrorResponse", "QuotaErrorResponse"):
        properties = schemas[name]["properties"]
        assert {"detail", "type", "title", "status", "code"} <= set(properties), name
        assert schemas[name]["required"] == ["detail"], name


def test_the_published_pricing_is_served_read_only(document):
    pricing_paths = {
        path: item for path, item in document["paths"].items() if path.startswith("/v1/pricing")
    }
    assert set(pricing_paths) == {"/v1/pricing", "/v1/pricing/catalog", "/v1/pricing/current"}
    for path, item in pricing_paths.items():
        assert set(item) == {"get"}, path
        assert "503" in item["get"]["responses"], path

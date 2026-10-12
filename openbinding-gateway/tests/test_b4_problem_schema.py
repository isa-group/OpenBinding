"""B4: every 422 is the same problem document (docs/ERRORS.md).

A broad sample of endpoints is driven with a bad body, a bad query, a bad path
parameter, a wrong type, a missing field, an out-of-range value and malformed
JSON; each answer must have the canonical shape, whichever layer produced it
(Pydantic, a route's own `api_error`, the BIM compiler, the pricing linter).
"""

from __future__ import annotations

import json
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from starlette.requests import Request

from _repo import REPO_ROOT
from openbinding_gateway import main as gateway_main
from openbinding_gateway.db.models import User, UserRole
from openbinding_gateway.models.problem import (
    json_pointer,
    normalize_diagnostics,
    problem_body,
    split_detail,
    summarize,
    validation_diagnostics,
)
from openbinding_gateway.v1.compiler import CompileDiagnostic, CompileError
from openbinding_gateway.v1.package import InstancePackage, load_package

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
CANONICAL = {"type", "title", "status", "code", "detail", "diagnostics"}
GENERATOR_FEATURES = [
    {"id": "cost", "unit": "EUR", "direction": "minimize", "scope": "selectedCandidate",
     "distribution": {"kind": "uniform", "minimum": 1, "maximum": 10},
     "aggregation": {"selection": "sum"}},
    {"id": "latency", "unit": "ms", "direction": "minimize", "scope": "invocation",
     "distribution": {"kind": "normal", "minimum": 2, "maximum": 20, "mean": 10, "stddev": 3},
     "aggregation": {"sequence": "sum", "parallel": "max", "exclusive": "weightedSum", "repeat": "scale"}},
]


async def sign_in(api_client, registration, db_session=None, *, admin: bool = False) -> dict[str, str]:
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    if admin:
        user = await db_session.scalar(select(User).where(User.id == uuid.UUID(created.json()["id"])))
        user.role = UserRole.ADMIN
        await db_session.flush()
    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest_asyncio.fixture
async def member(api_client, registration):
    return await sign_in(api_client, registration)


@pytest_asyncio.fixture
async def admin(api_client, registration, db_session):
    return await sign_in(api_client, registration, db_session, admin=True)


def assert_problem(response, *, code: str | None = None, media_type: str = "application/json") -> dict:
    """The one shape: RFC 9457 keys, a stable code and diagnostics with code + message."""
    assert response.status_code == 422, response.text
    assert response.headers["content-type"].split(";")[0] == media_type
    body = response.json()
    assert isinstance(body, dict), body
    assert CANONICAL <= set(body), sorted(body)
    assert body["status"] == 422
    assert isinstance(body["code"], str) and body["code"]
    assert body["title"] == body["code"]
    assert body["type"].endswith("/" + body["code"])
    assert isinstance(body["detail"], str) and body["detail"]
    assert isinstance(body["diagnostics"], list) and body["diagnostics"]
    for diagnostic in body["diagnostics"]:
        assert isinstance(diagnostic["code"], str) and diagnostic["code"]
        assert isinstance(diagnostic["message"], str) and diagnostic["message"]
        if "pointer" in diagnostic:
            assert diagnostic["pointer"].startswith("/"), diagnostic
    # The FastAPI default (`detail` as a list of {loc, msg, type}) is gone.
    assert not isinstance(body["detail"], (list, dict))
    if code is not None:
        assert body["code"] == code
    return body


def by_pointer(body: dict) -> dict[str, dict]:
    return {item["pointer"]: item for item in body["diagnostics"] if "pointer" in item}


# -- Request validation (Pydantic) --------------------------------------------


async def test_missing_body_fields_are_one_diagnostic_each_with_a_pointer(api_client):
    body = assert_problem(await api_client.post("/v1/auth/register", json={}), code="validation_error")
    found = by_pointer(body)
    assert set(found) == {"/username", "/email", "/password"}
    assert {item["code"] for item in found.values()} == {"missing"}
    assert all(item["in"] == "body" and item["loc"][0] == "body" for item in found.values())
    assert body["detail"].endswith("(+2 more)")


async def test_a_wrong_type_names_the_field_and_the_pydantic_error_type(api_client):
    body = assert_problem(
        await api_client.post("/v1/auth/login", json={"username_or_email": 5, "password": "x"}),
        code="validation_error",
    )
    [diagnostic] = body["diagnostics"]
    assert diagnostic["code"] == "string_type"
    assert diagnostic["pointer"] == "/username_or_email"
    assert diagnostic["loc"] == ["body", "username_or_email"]
    assert body["detail"].startswith("Request validation failed: /username_or_email:")


async def test_a_pattern_violation_keeps_the_limit_that_was_exceeded(api_client, registration):
    response = await api_client.post("/v1/auth/register", json=registration(username="a b"))
    body = assert_problem(response)
    diagnostic = by_pointer(body)["/username"]
    assert diagnostic["code"] == "string_pattern_mismatch"
    assert diagnostic["context"]["pattern"]


async def test_the_submitted_value_is_never_echoed(api_client, registration):
    secret = "p4ssw0rd-that-must-not-leak"
    response = await api_client.post(
        "/v1/auth/register", json=registration(username="a b", password=secret)
    )
    assert response.status_code == 422
    assert secret not in response.text


async def test_malformed_json_reports_the_offset_not_a_pointer(api_client):
    response = await api_client.post(
        "/v1/auth/login",
        content=b'{"username_or_email": ',
        headers={"Content-Type": "application/json"},
    )
    body = assert_problem(response, code="validation_error")
    [diagnostic] = body["diagnostics"]
    assert diagnostic["code"] == "json_invalid"
    assert diagnostic["in"] == "body"
    assert isinstance(diagnostic["span"]["offset"], int)
    assert "pointer" not in diagnostic
    assert diagnostic["hint"]


async def test_nested_body_errors_have_a_json_pointer_with_array_indexes(api_client):
    response = await api_client.post("/v1/generator/instances", json={"features": [5]})
    body = assert_problem(response, code="validation_error")
    assert "/features/0" in by_pointer(body)


async def test_a_value_out_of_range_says_which_bound(api_client):
    response = await api_client.post(
        "/v1/generator/instances", json={"tasks": 1, "candidates": 101, "features": []}
    )
    body = assert_problem(response)
    found = by_pointer(body)
    assert found["/tasks"]["code"] == "greater_than_equal"
    assert found["/tasks"]["context"] == {"ge": 2}
    assert found["/candidates"]["code"] == "less_than_equal"
    assert found["/candidates"]["context"] == {"le": 100}
    assert found["/features"]["code"] == "too_short"


async def test_an_unknown_body_field_is_pointed_at(api_client, admin):
    response = await api_client.post(
        "/v1/admin/users/00000000-0000-0000-0000-000000000000/subscription",
        headers=admin,
        json={"plan": "X", "reason": "new_feature", "nope": 1},
    )
    body = assert_problem(response, code="validation_error")
    assert by_pointer(body)["/nope"]["code"] == "extra_forbidden"


async def test_query_errors_name_the_parameter_not_a_body_pointer(api_client, member):
    base = "/v1/users/me/sponsor-proposals"
    below = assert_problem(await api_client.get(base + "?limit=0", headers=member))
    [diagnostic] = below["diagnostics"]
    assert (diagnostic["in"], diagnostic["parameter"]) == ("query", "limit")
    assert diagnostic["code"] == "greater_than_equal"
    assert diagnostic["context"] == {"ge": 1}
    assert "pointer" not in diagnostic

    text = assert_problem(await api_client.get(base + "?limit=abc", headers=member))
    assert text["diagnostics"][0]["code"] == "int_parsing"

    unknown = assert_problem(await api_client.get(base + "?status=bogus", headers=member))
    assert (unknown["diagnostics"][0]["in"], unknown["diagnostics"][0]["parameter"]) == ("query", "status")
    assert unknown["detail"].startswith("Request validation failed: query parameter status:")


async def test_path_errors_name_the_parameter(api_client, member):
    body = assert_problem(await api_client.get("/v1/sponsor-proposals/1", headers=member))
    [diagnostic] = body["diagnostics"]
    assert diagnostic["in"] == "path"
    assert diagnostic["parameter"]
    assert diagnostic["code"].startswith("uuid")


async def test_bim_routes_use_the_same_document_as_problem_json(api_client, member):
    response = await api_client.post(
        "/v1/resources?namespace=&name=x&version=1", headers=member, content=b"{}"
    )
    body = assert_problem(response, code="validation_error", media_type="application/problem+json")
    found = {(item["in"], item["parameter"]): item for item in body["diagnostics"]}
    assert found[("query", "namespace")]["code"] == "string_too_short"
    assert found[("query", "namespace")]["context"] == {"min_length": 1}
    assert found[("query", "role")]["code"] == "missing"


# -- A route's own 422 (api_error / HTTPException) ------------------------------


async def test_a_route_refusal_keeps_its_code_and_gains_the_document(api_client, registration):
    response = await api_client.post("/v1/auth/register", json=registration(password="short"))
    body = assert_problem(response, code="weak_password")
    assert body["diagnostics"][0]["code"] == "weak_password"
    assert body["diagnostics"][0]["message"] == body["detail"]
    assert "error" not in body


async def test_a_route_refusal_keeps_its_extra_fields(api_client):
    response = await api_client.post(
        "/v1/generator/instances",
        json={
            "tasks": 6,
            "candidates": 3,
            "target_engines": ["minizinc-csp", "many-heuristic"],
            "features": GENERATOR_FEATURES,
        },
    )
    body = assert_problem(response, code="incompatible_target_engines")
    assert "conflicts" in body
    assert body["diagnostics"][0]["message"] == body["detail"]


# -- The BIM compiler -----------------------------------------------------------


async def test_a_bim_package_the_compiler_refuses_is_a_422_problem_with_its_diagnostics(api_client, member):
    package = load_package(EXAMPLE)
    application = json.loads(package.files["application.json"])
    application["spec"]["workflow"]["sequence"][0]["task"]["id"] = "undeclared_task"
    files = dict(package.files)
    files["application.json"] = json.dumps(application).encode()
    response = await api_client.post(
        "/v1/validate",
        headers={**member, "Content-Type": "application/vnd.bim+zip"},
        content=InstancePackage(files).to_zip(),
    )
    body = assert_problem(response, media_type="application/problem+json")
    assert all(isinstance(item["message"], str) for item in body["diagnostics"])


async def test_an_unreadable_package_is_the_same_document(api_client, member):
    response = await api_client.post(
        "/v1/validate",
        headers={**member, "Content-Type": "application/vnd.bim+zip"},
        content=b"this is not a zip archive",
    )
    assert_problem(response, code="validation_error", media_type="application/problem+json")


def request_to(path: str) -> Request:
    return Request({"type": "http", "method": "POST", "path": path, "headers": [], "query_string": b""})


async def test_the_domain_exception_handler_keeps_every_compiler_field():
    diagnostic = CompileDiagnostic(
        code="unknown_task",
        message="workflow references an undeclared task",
        resource="application.json",
        pointer="/spec/workflow/sequence/0/task/id",
        span={"line": 21, "column": 13},
        related=({"resource": "application.json", "pointer": "/spec/tasks"},),
    )
    response = await gateway_main.compile_error(request_to("/v1/validate"), CompileError([diagnostic]))
    assert response.status_code == 422
    assert response.media_type == "application/problem+json"
    body = json.loads(response.body)
    assert CANONICAL <= set(body)
    assert body["code"] == "invalid_instance" == body["title"]
    assert body["diagnostics"] == [diagnostic.as_dict()]
    assert body["diagnostics"][0]["span"] == {"line": 21, "column": 13}
    assert body["detail"].endswith("workflow references an undeclared task")


async def test_a_422_raised_inside_a_bim_route_is_the_same_as_one_raised_outside():
    from fastapi import HTTPException

    for path, media_type in (("/v1/validate", "application/problem+json"), ("/v1/auth/login", "application/json")):
        response = await gateway_main.http_error(
            request_to(path),
            HTTPException(
                status_code=422,
                detail={
                    "code": "engine_mode_incompatible",
                    "message": "the selected mode cannot run this IR",
                    "diagnostics": [{"code": "unsupported_capability"}],
                },
            ),
        )
        body = json.loads(response.body)
        assert response.media_type == media_type
        assert body["code"] == "engine_mode_incompatible"
        assert body["detail"] == "the selected mode cannot run this IR"
        # A diagnostic that names only a code is completed, never dropped.
        assert body["diagnostics"] == [{"code": "unsupported_capability", "message": "unsupported_capability"}]


async def test_a_bare_string_422_becomes_validation_error():
    from fastapi import HTTPException

    response = await gateway_main.http_error(request_to("/v1/analysis/x"), HTTPException(422, "bad thing"))
    body = json.loads(response.body)
    assert (body["code"], body["detail"]) == ("validation_error", "bad thing")
    assert body["diagnostics"] == [{"code": "validation_error", "message": "bad thing"}]


# -- Published pricing ----------------------------------------------------------


async def test_an_unreadable_published_pricing_is_a_coded_503_with_the_canonical_keys(api_client):
    # SPHERE is switched off in the suite, so the read-only pricing endpoints refuse.
    for path in ("/v1/pricing/catalog", "/v1/pricing/current", "/v1/pricing"):
        response = await api_client.get(path)
        body = response.json()
        assert response.status_code == 503, path
        assert body["detail"]["code"] == "pricing_unavailable"
        assert (body["code"], body["status"]) == ("pricing_unavailable", 503)


# -- The other refusals keep their shape and gain the canonical keys ------------


async def test_a_coded_platform_failure_keeps_detail_and_adds_the_canonical_keys(api_client, registration):
    details = registration()
    assert (await api_client.post("/v1/auth/register", json=details)).status_code == 201
    duplicate = await api_client.post("/v1/auth/register", json=registration(email=details["email"]))
    assert duplicate.status_code == 409
    body = duplicate.json()
    assert body["detail"]["code"] == "already_registered"
    assert body["detail"]["error"]
    assert (body["code"], body["title"], body["status"]) == ("already_registered", "already_registered", 409)
    assert body["type"].endswith("/already_registered")


async def test_an_unauthenticated_call_has_the_code_and_status_beside_detail(api_client):
    response = await api_client.get("/v1/users/me")
    body = response.json()
    assert response.status_code == 401
    assert body["code"] == body["detail"]["code"]
    assert body["status"] == 401


async def test_a_bim_refusal_that_is_not_a_422_has_the_same_keys(api_client):
    response = await api_client.get("/v1/schemas/there-is-no-such-schema")
    assert response.status_code == 404
    assert response.headers["content-type"].split(";")[0] == "application/problem+json"
    body = response.json()
    assert {"type", "title", "status", "code", "detail"} <= set(body)
    assert body["status"] == 404 and body["code"] == body["title"]
    assert isinstance(body["detail"], str)


# -- The helpers ----------------------------------------------------------------


def test_json_pointers_are_escaped_per_rfc_6901():
    assert json_pointer(()) == ""
    assert json_pointer(("spec", "limits", "maxTasks")) == "/spec/limits/maxTasks"
    assert json_pointer(("a/b", "c~d", 3)) == "/a~1b/c~0d/3"


def test_pydantic_errors_become_diagnostics_without_losing_anything_useful():
    errors = [
        {"type": "greater_than", "loc": ("body", "spec", "limits", "maxTasks"), "msg": "Input should be greater than 0",
         "input": 0, "ctx": {"gt": 0}},
        {"type": "missing", "loc": ("query", "role"), "msg": "Field required", "input": None},
        {"type": "value_error", "loc": ("body",), "msg": "Value error, nope", "ctx": {"error": ValueError("nope")}},
    ]
    first, second, third = validation_diagnostics(errors)
    assert first == {
        "code": "greater_than",
        "message": "Input should be greater than 0",
        "in": "body",
        "pointer": "/spec/limits/maxTasks",
        "loc": ["body", "spec", "limits", "maxTasks"],
        "context": {"gt": 0},
    }
    assert second["in"] == "query" and second["parameter"] == "role" and "pointer" not in second
    assert second["hint"] == "This field is required."
    assert "pointer" not in third and "context" not in third and third["in"] == "body"
    assert "input" not in first


def test_summaries_name_the_first_problem_and_count_the_rest():
    diagnostics = [
        {"code": "a", "message": "first", "pointer": "/x"},
        {"code": "b", "message": "second"},
        {"code": "c", "message": "third"},
    ]
    assert summarize(diagnostics) == "Request validation failed: /x: first (+2 more)"
    assert summarize([]) == "Request validation failed"


def test_diagnostics_are_normalised_but_never_stripped():
    rich = {"code": "x", "message": "m", "resource": "a.json", "pointer": "/p", "span": {"line": 1}}
    items = normalize_diagnostics([rich, {"message": "only a message"}, {"code": "only_code"}, "plain text"], "fallback")
    assert items[0] == rich
    assert items[1] == {"code": "fallback", "message": "only a message"}
    assert items[2] == {"code": "only_code", "message": "only_code"}
    assert items[3] == {"code": "fallback", "message": "plain text"}


def test_detail_shapes_are_taken_apart_consistently():
    code, message, diagnostics, extra = split_detail(
        {"code": "c", "error": "boom", "conflicts": [1], "diagnostics": [{"message": "m"}]}, "validation_error"
    )
    assert (code, message, extra) == ("c", "boom", {"conflicts": [1]})
    assert diagnostics == [{"code": "c", "message": "m"}]
    assert split_detail("text", "validation_error") == ("validation_error", "text", [], {})
    code, message, diagnostics, _ = split_detail(
        [{"type": "missing", "loc": ["body", "x"], "msg": "Field required"}], "validation_error"
    )
    assert code == "validation_error" and diagnostics[0]["pointer"] == "/x"


def test_extra_fields_never_replace_the_canonical_keys():
    body = problem_body(422, "c", "d", None, {"status": "pending", "conflicts": [1]})
    assert body["status"] == 422
    assert body["conflicts"] == [1]
    assert body["extra"] == {"status": "pending"}
    assert body["diagnostics"] == [{"code": "c", "message": "d"}]

"""The port, the translation of problems into exceptions, token handling and the transport failures."""

from __future__ import annotations

import functools
import inspect
import json
import os

import httpx
import pytest
from client_support import BASE_URL, TOKEN, outcome

from bim_client import BimPort, BimServiceError, HttpBim, InProcessBim, exception_from_problem
from bim_core import (
    BimError,
    CanonicalizationError,
    CompileDiagnostic,
    CompileError,
    ContractError,
    EvaluationError,
    ExpressionError,
    PackageError,
    ProtocolError,
)
from bim_service.problems import bim_error_problem

PUBLIC = [
    "capabilities", "profiles", "dialects", "schema", "protocol", "compile", "validate", "compatibility",
    "resolve_optimization", "evaluate", "evaluate_many", "reevaluate", "validate_result", "neighborhood", "close",
]  # fmt: skip


def mock_bim(handler, **kwargs) -> HttpBim:
    client = httpx.Client(transport=httpx.MockTransport(handler), base_url=BASE_URL)
    return HttpBim(client=client, **kwargs)


def problem_response(status: int, body: dict, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(status, json=body, headers={"content-type": "application/problem+json", **(headers or {})})


# --- the interface -----------------------------------------------------------------------------------


def test_both_implementations_satisfy_the_port() -> None:
    assert isinstance(InProcessBim(), BimPort)
    assert isinstance(mock_bim(lambda request: httpx.Response(200, json={})), BimPort)


@pytest.mark.parametrize("name", PUBLIC)
def test_both_implementations_have_the_signature_of_the_port(name: str) -> None:
    expected = inspect.signature(getattr(BimPort, name))
    for implementation in (InProcessBim, HttpBim):
        found = inspect.signature(getattr(implementation, name))
        assert [(p.name, p.kind, p.default, p.annotation) for p in found.parameters.values()] == [
            (p.name, p.kind, p.default, p.annotation) for p in expected.parameters.values()
        ], (implementation.__name__, name)
        assert found.return_annotation == expected.return_annotation, (implementation.__name__, name)


def test_the_port_has_no_method_the_implementations_lack() -> None:
    port = {name for name, member in inspect.getmembers(BimPort, inspect.isfunction) if not name.startswith("_")}
    assert port == set(PUBLIC)
    for implementation in (InProcessBim, HttpBim):
        assert port <= {name for name, _ in inspect.getmembers(implementation, inspect.isfunction)}


# --- inputs ------------------------------------------------------------------------------------------


def test_an_input_that_is_not_strict_json_fails_before_anything_is_sent() -> None:
    def forbidden(request):
        raise AssertionError("nothing may be sent")

    http, local = mock_bim(forbidden), InProcessBim()
    calls = [
        lambda bim: bim.validate_result({"termination": float("nan")}),
        lambda bim: bim.validate_result({"x": b"bytes"}),
        lambda bim: bim.reevaluate({}, {"provenance": {"t": float("inf")}}),
        lambda bim: bim.reevaluate({}, ["not", "an", "object"]),
        lambda bim: bim.evaluate({}, {"t": float("nan")}),
        lambda bim: bim.evaluate_many({}, []),
        lambda bim: bim.evaluate_many({}, [{}], on_error="ignore"),
        lambda bim: bim.compile("not bytes"),
        lambda bim: bim.compile(b"", [{"namespace": "a"}]),
        lambda bim: bim.neighborhood({}, {}, limit=True),
        lambda bim: bim.neighborhood({}, {}, seconds=0),
        lambda bim: bim.compatibility({}, [], mode=3),
    ]
    for call in calls:
        a, b = outcome(functools.partial(call, http)), outcome(functools.partial(call, local))
        assert a == b and a[0] == "error" and a[2] == "request_invalid", a
        assert a[5] == 422 and a[4]["diagnostics"][0]["code"] == "request_invalid"


def test_an_object_with_a_document_is_accepted_as_an_ir(inprocess_bim) -> None:
    from consumer_fixtures import BINDING, demo_problem

    problem = demo_problem()
    assert inprocess_bim.evaluate(problem, BINDING) == inprocess_bim.evaluate(problem.document, BINDING)


def test_results_are_independent_of_the_inputs_and_of_each_other(inprocess_bim) -> None:
    from consumer_fixtures import BINDING, demo_zip

    compiled = inprocess_bim.compile(demo_zip())
    ir_before = json.dumps(compiled["ir"], sort_keys=True)
    binding = json.loads(json.dumps(BINDING))
    first = inprocess_bim.evaluate(compiled["ir"], binding)
    assert json.dumps(compiled["ir"], sort_keys=True) == ir_before and binding == BINDING
    first["features"]["probe"] = -1
    assert "probe" not in inprocess_bim.evaluate(compiled["ir"], binding)["features"]
    assert all(type(value) in {dict, list, str, int, float, bool, type(None)} for value in walk(first))


def walk(value):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


# --- problems into exceptions ---------------------------------------------------------------------------

SAMPLES = [
    PackageError("not a zip", diagnostics=[{"code": "zip", "message": "x"}]),
    PackageError("too big", code="package_limit"),
    CompileError([
        CompileDiagnostic("schema", "bad", "a.json", "/spec", {"start": 1, "end": 2}, "task", "/spec/x", ({"resource": "r"},)),
        CompileDiagnostic("reference", "worse"),
    ]),
    ExpressionError("unsafe", span={"start": 0, "end": 3}),
    ExpressionError("no span", code="expression_custom"),
    CanonicalizationError("non-finite number at $.a"),
    EvaluationError("binding_invalid", "bad binding"),
    EvaluationError("neighborhood_limit", "limit", [{"code": "x", "message": "y"}]),
    ProtocolError("invalid_termination", "engine response has an invalid termination"),
    ContractError("ir_digest_mismatch", "mismatch"),
    ContractError("engine_mode_incompatible", "no mode", [{"code": "mode", "message": "m"}], http_status=422),
    ContractError("schema_not_found", "no schema", http_status=404),
    BimError("custom", "a plain BimError", [{"a": 1}]),
]


@pytest.mark.parametrize("error", SAMPLES, ids=lambda error: f"{type(error).__name__}-{error.code}")
def test_a_problem_becomes_the_exception_it_was_made_from(error: BimError) -> None:
    status, body = bim_error_problem(error)
    body = json.loads(json.dumps(body))
    rebuilt = exception_from_problem(body, status=status)
    assert type(rebuilt) is type(error)
    assert (rebuilt.code, str(rebuilt), rebuilt.as_dict()) == (error.code, str(error), error.as_dict())
    assert getattr(rebuilt, "http_status", None) == getattr(error, "http_status", None)
    assert getattr(rebuilt, "span", None) == getattr(error, "span", None)
    if isinstance(error, CompileError):
        assert rebuilt.diagnostics == error.diagnostics


def test_a_problem_without_error_type_is_about_the_service() -> None:
    error = exception_from_problem(
        {"code": "rate_limited", "detail": "slow down", "status": 429, "diagnostics": []}, status=429, retry_after=2.0
    )
    assert type(error) is BimServiceError
    assert (error.code, str(error), error.status, error.retry_after) == ("rate_limited", "slow down", 429, 2.0)
    assert error.as_dict()["status"] == 429
    unknown = exception_from_problem({"code": "x", "detail": "d", "errorType": "FutureError"}, status=418)
    assert type(unknown) is BimServiceError and unknown.status == 418


def test_http_errors_are_raised_as_the_exceptions_of_the_problems() -> None:
    error = ContractError("engine_mode_incompatible", "no mode", [{"code": "mode", "message": "m"}], http_status=422)

    def handler(request):
        status, body = bim_error_problem(error)
        return problem_response(status, body)

    with pytest.raises(ContractError) as raised:
        mock_bim(handler).compatibility({}, {})
    assert (raised.value.code, raised.value.diagnostics, raised.value.http_status) == (
        "engine_mode_incompatible", [{"code": "mode", "message": "m"}], 422,
    )  # fmt: skip


def test_service_level_problems_carry_status_and_retry_after() -> None:
    body = {"type": "urn:bim-toolchain:problem:service_busy", "title": "x", "status": 503, "detail": "busy", "code": "service_busy"}
    bim = mock_bim(lambda request: problem_response(503, body, {"Retry-After": "7"}))
    with pytest.raises(BimServiceError) as raised:
        bim.capabilities()
    assert (raised.value.code, raised.value.status, raised.value.retry_after) == ("service_busy", 503, 7.0)


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(502, text="<html>Bad gateway</html>", headers={"content-type": "text/html"}), "http_502"),
        (httpx.Response(500, json=["not", "a", "problem"]), "http_500"),
        (httpx.Response(200, text="not json"), "bad_response"),
    ],
)
def test_responses_that_are_not_what_the_contract_says(response: httpx.Response, code: str) -> None:
    with pytest.raises(BimServiceError) as raised:
        mock_bim(lambda request: response).capabilities()
    assert raised.value.code == code and raised.value.status == response.status_code


@pytest.mark.parametrize(
    ("failure", "code"),
    [(httpx.ConnectError("refused"), "service_unavailable"), (httpx.ReadTimeout("slow"), "service_timeout")],
)
def test_transport_failures_are_service_errors_that_say_nothing_about_the_request(failure, code: str) -> None:
    def handler(request):
        raise failure

    with pytest.raises(BimServiceError) as raised:
        mock_bim(handler).protocol()
    assert raised.value.code == code and raised.value.status is None
    assert "refused" not in str(raised.value) and "slow" not in str(raised.value)


# --- the request that is sent -------------------------------------------------------------------------


def test_the_request_carries_the_token_the_tenant_and_the_trace(tmp_path) -> None:
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"results": [{"evaluation": {"features": {}}}]})

    bim = mock_bim(handler, token=TOKEN, tenant="acme", traceparent=lambda: "00-" + "a" * 32 + "-" + "b" * 16 + "-01")
    bim.evaluate({}, {"t": {"resource": "r", "id": "i"}})
    request = seen[0]
    assert (request.method, request.url.path) == ("POST", "/bim/v1/evaluate")
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert request.headers["x-bim-tenant"] == "acme" and request.headers["traceparent"].startswith("00-aaaa")
    assert request.headers["content-type"] == "application/json"
    assert json.loads(request.content)["bindings"] == [{"t": {"resource": "r", "id": "i"}}]
    # Without credentials, tenant or trace nothing of the kind is sent.
    plain = mock_bim(handler)
    plain.evaluate({}, {})
    assert not {"authorization", "x-bim-tenant", "traceparent"} & set(seen[1].headers)


def test_the_token_file_is_read_again_when_it_changes(tmp_path) -> None:
    seen: list[str] = []

    def handler(request):
        seen.append(request.headers["authorization"])
        return httpx.Response(200, json={})

    path = tmp_path / "token"
    path.write_text("first-token-" + "a" * 30 + "\nsecond-line-ignored\n", encoding="utf-8")
    bim = mock_bim(handler, token_file=path)
    bim.protocol()
    bim.protocol()
    path.write_text("rotated-token-" + "b" * 30 + "\n", encoding="utf-8")
    os.utime(path, ns=(1, 2_000_000_000))
    bim.protocol()
    assert seen == ["Bearer first-token-" + "a" * 30, "Bearer first-token-" + "a" * 30, "Bearer rotated-token-" + "b" * 30]


def test_an_unreadable_token_file_is_a_service_error(tmp_path) -> None:
    bim = mock_bim(lambda request: httpx.Response(200, json={}), token_file=tmp_path / "absent")
    with pytest.raises(BimServiceError) as raised:
        bim.protocol()
    assert raised.value.code == "token_unavailable"


def test_the_token_is_not_in_the_representation_and_is_not_sent_over_plain_http() -> None:
    assert TOKEN not in repr(mock_bim(lambda request: httpx.Response(200, json={}), token=TOKEN))
    with pytest.raises(ValueError, match="plain http"):
        HttpBim("http://bim.example.org", token=TOKEN)
    HttpBim("https://bim.example.org", token=TOKEN).close()
    HttpBim("http://localhost:8080", token=TOKEN).close()
    HttpBim("http://127.0.0.1:8080", token=TOKEN).close()
    HttpBim("http://bim.internal", token=TOKEN, allow_insecure_http=True).close()
    with pytest.raises(ValueError, match="either"):
        HttpBim("https://bim.example.org", token=TOKEN, token_file="/x")
    with pytest.raises(ValueError, match="base_url"):
        HttpBim()


def test_close_is_idempotent_and_leaves_a_borrowed_client_open() -> None:
    client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})), base_url=BASE_URL)
    bim = HttpBim(client=client)
    bim.close()
    bim.close()
    assert not client.is_closed
    owned = HttpBim("https://bim.example.org")
    owned.close()
    owned.close()
    InProcessBim().close()

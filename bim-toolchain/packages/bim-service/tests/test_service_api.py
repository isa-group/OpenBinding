"""The endpoints, the problem documents and the headers."""

from __future__ import annotations

import base64
import json
import logging
import threading
from dataclasses import asdict

import pytest
from service_support import BASE_URL, bearer

import consumer_fixtures as demo
from bim_core import (
    BindingProblem,
    ContractError,
    EvaluationError,
    compiler_bundle_digest,
    dialect_descriptor,
    load_package,
    profile_descriptor,
    protocol_digest,
    protocol_document,
    toolchain_identity,
)
from bim_core.compiler import installed_dialect_manifests, installed_profile_manifests
from bim_service import operations

JSON = {"Content-Type": "application/json"}


def package_body(data: bytes, registered: list | None = None) -> dict:
    return {"package": base64.b64encode(data).decode(), "registeredResources": registered or []}


@pytest.fixture
def compiled(client) -> dict:
    response = client.post("/bim/v1/compile", json=package_body(demo.demo_zip()))
    assert response.status_code == 200, response.text
    return response.json()


# --- descriptors ------------------------------------------------------------------------------------


def test_capabilities_describe_the_toolchain_the_limits_and_the_contracts(client, app) -> None:
    body = client.get("/bim/v1/capabilities").json()
    settings = app.state.settings
    assert body["apiVersion"] == "bim-service/v1"
    assert body["toolchain"] == toolchain_identity()
    assert body["compilerDigest"] == compiler_bundle_digest() == body["toolchain"]["compilerDigest"]
    assert body["protocolDigest"] == protocol_digest() == body["protocol"]["digest"]
    assert body["protocol"]["id"] == "bim-engine/v1"
    assert body["service"]["name"] == "bim-service"
    assert body["limits"]["package"] == asdict(settings.limits)
    assert body["limits"]["service"] == settings.public_limits()
    assert body["profiles"] == [profile_descriptor(item) for item in installed_profile_manifests()]
    assert body["dialects"] == [dialect_descriptor(item) for item in installed_dialect_manifests()]
    assert {"Instance", "BindingProblem", "Engine"} <= set(body["schemaKinds"])


def test_the_effective_limits_follow_the_settings(make_app) -> None:
    from starlette.testclient import TestClient

    app = make_app(max_body_bytes=12345, max_concurrency=3, max_concurrency_per_tenant=1, operation_timeout_seconds=7.5)
    body = TestClient(app, base_url=BASE_URL, headers=bearer()).get("/bim/v1/capabilities").json()
    published = body["limits"]["service"]
    assert (published["maxBodyBytes"], published["maxConcurrentOperations"]) == (12345, 3)
    assert (published["maxConcurrentOperationsPerTenant"], published["operationTimeoutSeconds"]) == (1, 7.5)


def test_profiles_and_dialects_are_the_installed_ones(client) -> None:
    profiles = client.get("/bim/v1/profiles").json()["profiles"]
    dialects = client.get("/bim/v1/dialects").json()["dialects"]
    identity = toolchain_identity()
    assert [item["reference"] for item in profiles] == identity["profiles"]
    assert [item["reference"] for item in dialects] == identity["dialects"]
    assert all(item["manifest"]["kind"] in {"Profile", "Dialect"} for item in [*profiles, *dialects])


def test_every_advertised_schema_is_served(client) -> None:
    kinds = client.get("/bim/v1/capabilities").json()["schemaKinds"]
    assert len(kinds) == 12
    for kind in kinds:
        response = client.get(f"/bim/v1/schemas/{kind}")
        assert response.status_code == 200
        assert response.json()["$schema"].startswith("https://json-schema.org/")


@pytest.mark.parametrize("kind", ["Nope", "..", "%2e%2e%2fsecret", "instance", "x" * 300])
def test_an_unknown_schema_kind_is_a_404_problem(client, kind: str) -> None:
    response = client.get(f"/bim/v1/schemas/{kind}")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] in {"schema_not_found", "not_found"}


def test_the_protocol_is_the_installed_contract(client) -> None:
    body = client.get("/bim/v1/protocol").json()
    assert body == {"id": "bim-engine/v1", "digest": protocol_digest(), "document": protocol_document()}


# --- compile and validate ---------------------------------------------------------------------------


def test_compile_returns_the_ir_and_everything_that_identifies_it(compiled) -> None:
    ir = compiled["ir"]
    package = load_package(demo.demo_zip())
    problem = BindingProblem.from_document(ir)
    assert compiled["irDigest"] == problem.digest
    assert compiled["packageDigest"] == package.package_digest
    assert compiled["instanceDigest"] == ir["spec"]["instance"]["digest"]
    assert compiled["sourceMap"] == problem.source_map
    assert compiled["toolchain"] == {
        "name": "bim-core",
        "version": toolchain_identity()["version"],
        "apiVersion": "bim/v1",
        "compilerDigest": compiler_bundle_digest(),
    }
    assert compiled["analysis"]["serviceTasks"] == 2
    assert compiled["analysis"]["bindingSpaceCardinality"] == "4"  # two eligible candidates for each service task
    assert compiled["analysis"]["bindingSpaceLog10"] == problem.binding_space_log10
    assert compiled["analysis"]["bindingSpaceBreakdown"] == {"t1": 2, "t2": 2}
    assert compiled["analysis"]["candidates"] == 2
    assert compiled["inputDigest"].startswith("sha256-")
    assert set(compiled) == {
        "ir", "irDigest", "instanceDigest", "packageDigest", "compilationDigest", "inputDigest", "sourceMap",
        "analysis", "toolchain",
    }  # fmt: skip


def test_compilation_is_deterministic(client, compiled) -> None:
    again = client.post("/bim/v1/compile", json=package_body(demo.demo_zip())).json()
    assert again == compiled


def test_a_multipart_upload_is_the_same_request(client, compiled) -> None:
    response = client.post(
        "/bim/v1/compile",
        files={"package": ("demo.bim.zip", demo.demo_zip(), "application/zip")},
    )
    assert response.status_code == 200
    assert response.json() == compiled


def test_a_multipart_upload_can_carry_registered_resources(client) -> None:
    files, registered = registered_package()
    response = client.post(
        "/bim/v1/compile",
        files={"package": ("demo.bim.zip", files, "application/zip")},
        data={"registeredResources": json.dumps(registered)},
    )
    assert response.status_code == 200, response.text
    assert "registered" in response.json()["ir"]["spec"]["instance"]["resources"]["cat-b"]


def test_the_package_must_be_base64_and_the_body_must_match_the_contract(client) -> None:
    bad = client.post("/bim/v1/compile", json={"package": "not base64!", "registeredResources": []})
    assert bad.status_code == 422
    assert bad.json()["code"] == "request_invalid"
    assert bad.json()["diagnostics"][0]["pointer"] == "/package"
    extra = client.post("/bim/v1/compile", json={"package": "", "surprise": 1})
    assert extra.status_code == 422 and extra.json()["code"] == "request_invalid"
    broken = client.post("/bim/v1/compile", content=b"{", headers=JSON)
    assert broken.status_code == 422 and broken.json()["code"] == "request_invalid"


def test_other_media_types_are_refused(client) -> None:
    response = client.post("/bim/v1/compile", content=demo.demo_zip(), headers={"Content-Type": "application/zip"})
    assert response.status_code == 415
    assert response.json()["code"] == "unsupported_media_type"


def test_bytes_that_are_not_a_package_are_a_package_error(client) -> None:
    response = client.post("/bim/v1/compile", json=package_body(b"not a zip"))
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert (body["code"], body["errorType"], body["status"]) == ("package_error", "PackageError", 422)
    assert body["type"] == "urn:bim-toolchain:problem:package_error"
    assert body["title"] == "Package error"
    assert isinstance(body["detail"], str) and body["diagnostics"] == []


def test_a_package_with_findings_is_a_compile_error_with_its_diagnostics(client) -> None:
    response = client.post("/bim/v1/compile", json=package_body(demo.demo_zip(broken=True)))
    assert response.status_code == 422
    body = response.json()
    assert (body["code"], body["errorType"]) == ("compile_error", "CompileError")
    assert body["diagnostics"] and all({"code", "message"} <= set(item) for item in body["diagnostics"])
    assert "resource_missing" in {item["code"] for item in body["diagnostics"]}


def test_validate_reports_findings_as_data(client, compiled) -> None:
    good = client.post("/bim/v1/validate", json=package_body(demo.demo_zip())).json()
    assert good["valid"] is True and good["diagnostics"] == [] and "ir" not in good
    assert good["irDigest"] == compiled["irDigest"] and good["packageDigest"] == compiled["packageDigest"]
    bad = client.post("/bim/v1/validate", json=package_body(demo.demo_zip(broken=True)))
    assert bad.status_code == 200
    assert bad.json()["valid"] is False
    assert "resource_missing" in {item["code"] for item in bad.json()["diagnostics"]}
    assert "irDigest" not in bad.json()
    assert client.post("/bim/v1/validate", json=package_body(b"not a zip")).status_code == 422


registered_package = demo.registered_demo


def test_registered_resources_travel_inline_and_are_pinned_by_digest(client, compiled) -> None:
    data, registered = registered_package()
    response = client.post("/bim/v1/compile", json=package_body(data, registered))
    assert response.status_code == 200, response.text
    ir = response.json()["ir"]
    assert ir["spec"]["instance"]["resources"]["cat-b"]["registered"]["namespace"] == "acme"
    assert ir["spec"]["candidates"] == compiled["ir"]["spec"]["candidates"]
    assert ir["spec"]["eligibility"] == compiled["ir"]["spec"]["eligibility"]
    # What the compilation read is part of the input digest.
    assert response.json()["inputDigest"] != compiled["inputDigest"]


def test_a_registered_resource_that_is_missing_or_altered_is_a_compile_error(client) -> None:
    data, registered = registered_package()
    missing = client.post("/bim/v1/compile", json=package_body(data))
    assert missing.status_code == 422
    assert "registered_ref_unresolved" in {item["code"] for item in missing.json()["diagnostics"]}
    altered = json.loads(base64.b64decode(registered[0]["contentBase64"]))
    altered["spec"]["candidates"]["c1"]["features"]["latency"] = 1
    registered[0]["contentBase64"] = base64.b64encode(json.dumps(altered).encode()).decode()
    response = client.post("/bim/v1/compile", json=package_body(data, registered))
    assert response.status_code == 422
    assert "registered_digest" in {item["code"] for item in response.json()["diagnostics"]}


def test_a_registered_resource_listed_twice_or_in_excess_is_refused(client, make_app) -> None:
    from starlette.testclient import TestClient

    data, registered = registered_package()
    twice = client.post("/bim/v1/compile", json=package_body(data, [registered[0], registered[0]]))
    assert twice.status_code == 422 and twice.json()["code"] == "request_invalid"
    small = TestClient(make_app(max_registered_resources=1), base_url=BASE_URL, headers=bearer())
    other = {**registered[0], "version": "2.0.0"}
    excess = small.post("/bim/v1/compile", json=package_body(data, [registered[0], other]))
    assert excess.status_code == 422 and excess.json()["code"] == "limit_exceeded"


# --- the other operations: limits and plumbing (the interactions themselves are the consumer fixtures) ----


def test_evaluate_refuses_more_bindings_than_the_service_allows(make_app, compiled) -> None:
    from starlette.testclient import TestClient

    small = TestClient(make_app(max_bindings=1), base_url=BASE_URL, headers=bearer())
    body = {"ir": compiled["ir"], "bindings": [demo.BINDING, demo.BINDING]}
    response = small.post("/bim/v1/evaluate", json=body)
    assert response.status_code == 422 and response.json()["code"] == "limit_exceeded"
    assert small.post("/bim/v1/evaluate", json={**body, "bindings": [demo.BINDING]}).status_code == 200


def test_neighborhood_refuses_a_time_budget_above_the_ceiling(make_app, compiled) -> None:
    from starlette.testclient import TestClient

    small = TestClient(make_app(neighborhood_max_seconds=1.0), base_url=BASE_URL, headers=bearer())
    body = {"ir": compiled["ir"], "binding": demo.BINDING, "seconds": 5}
    assert small.post("/bim/v1/neighborhood", json=body).json()["code"] == "limit_exceeded"
    assert small.post("/bim/v1/neighborhood", json={**body, "seconds": 0.5}).status_code == 200


def test_an_ir_of_another_toolchain_is_refused_with_its_contract_error(client, compiled) -> None:
    ir = json.loads(json.dumps(compiled["ir"]))
    ir["spec"]["profile"]["digest"] = "sha256-" + "0" * 64
    response = client.post("/bim/v1/evaluate", json={"ir": ir, "bindings": [demo.BINDING]})
    assert response.status_code == 422
    assert response.json()["code"] == "contract_not_installed"
    assert response.json()["errorType"] == "ContractError"
    assert "httpStatus" not in response.json()


def test_requests_that_do_not_match_the_contract_are_422_without_echoing_the_input(client) -> None:
    response = client.post("/bim/v1/evaluate", json={"ir": "SECRET-IR", "bindings": [], "extra": 1})
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "request_invalid" and body["errorType"] == "ContractError" and body["httpStatus"] == 422
    assert {item["pointer"] for item in body["diagnostics"]} >= {"/body/ir", "/body/bindings", "/body/extra"}
    assert "SECRET-IR" not in response.text


def test_non_finite_numbers_are_not_json_and_are_refused(client, compiled) -> None:
    body = '{"result": {"termination": "FEASIBLE", "solutions": [], "provenance": {"x": NaN}}}'
    response = client.post("/bim/v1/validate-result", content=body, headers=JSON)
    assert response.status_code == 422 and response.json()["code"] == "request_invalid"
    huge = client.post("/bim/v1/validate-result", content='{"result": 1e999}', headers=JSON)
    assert huge.status_code == 422


def test_unknown_routes_and_methods_are_problems_too(client) -> None:
    missing = client.get("/bim/v1/nothing")
    assert missing.status_code == 404 and missing.json()["code"] == "not_found"
    assert missing.headers["content-type"].startswith("application/problem+json")
    wrong = client.get("/bim/v1/compile")
    assert wrong.status_code == 405 and wrong.json()["code"] == "method_not_allowed"
    assert "POST" in wrong.headers["allow"]


# --- one handler for every BimError ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("error", "status", "error_type"),
    [
        (ContractError("custom_conflict", "no", [{"code": "x"}], http_status=409), 409, "ContractError"),
        (ContractError("custom_plain", "no"), 422, "ContractError"),
        (ContractError("invalid_limit", "no"), 500, "ContractError"),
        (EvaluationError("binding_invalid", "bad binding"), 422, "EvaluationError"),
    ],
)
def test_one_handler_maps_a_bim_error_to_its_problem(client, monkeypatch, error, status, error_type) -> None:
    def raising(*args):
        raise error

    monkeypatch.setattr(operations, "evaluate", raising)
    response = client.post("/bim/v1/evaluate", json={"ir": {}, "bindings": [{}]})
    assert response.status_code == status
    body = response.json()
    assert (body["code"], body["errorType"], body["status"], body["detail"]) == (error.code, error_type, status, error.message)
    assert body["type"] == f"urn:bim-toolchain:problem:{error.code}"
    assert body["diagnostics"] == error.diagnostics
    assert ("httpStatus" in body) == (getattr(error, "http_status", None) is not None)


def test_an_unexpected_failure_is_a_500_that_says_nothing_about_the_input(client, monkeypatch, caplog) -> None:
    def failing(*args):
        raise RuntimeError("SECRET contents of the package")

    monkeypatch.setattr(operations, "evaluate", failing)
    caplog.set_level(logging.DEBUG)
    response = client.post("/bim/v1/evaluate", json={"ir": {}, "bindings": [{}]})
    assert response.status_code == 500
    assert response.json()["code"] == "internal_error" and "errorType" not in response.json()
    assert "SECRET" not in response.text and "SECRET" not in caplog.text
    assert "RuntimeError" in caplog.text


# --- context headers ---------------------------------------------------------------------------------

TRACE = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"


def test_a_valid_traceparent_is_propagated_and_an_invalid_or_missing_one_is_replaced(client) -> None:
    assert client.get("/healthz", headers={"traceparent": TRACE}).headers["traceparent"] == TRACE
    for bad in ("garbage", "00-" + "0" * 32 + "-b7ad6b7169203331-01", "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"):
        replaced = client.get("/healthz", headers={"traceparent": bad}).headers["traceparent"]
        assert replaced != bad and len(replaced) == 55
    first = client.get("/healthz").headers["traceparent"]
    assert first != client.get("/healthz").headers["traceparent"]


def test_errors_carry_the_traceparent_too(client) -> None:
    response = client.get("/bim/v1/nothing", headers={"traceparent": TRACE})
    assert response.headers["traceparent"] == TRACE
    assert client.get("/bim/v1/capabilities", headers={"Authorization": "", "traceparent": TRACE}).headers["traceparent"] == TRACE


def test_the_tenant_is_for_logs_only_and_never_changes_a_result(client, compiled, caplog) -> None:
    caplog.set_level(logging.INFO)
    body = {"ir": compiled["ir"], "bindings": [demo.BINDING]}
    answers = []
    for tenant in (None, "acme", "another-tenant", "bad tenant!!", "x" * 500):
        headers = {} if tenant is None else {"X-BIM-Tenant": tenant}
        compile_answer = client.post("/bim/v1/compile", json=package_body(demo.demo_zip()), headers=headers)
        evaluate_answer = client.post("/bim/v1/evaluate", json=body, headers=headers)
        assert (compile_answer.status_code, evaluate_answer.status_code) == (200, 200)
        answers.append((compile_answer.json(), evaluate_answer.json()))
    assert all(answer == answers[0] for answer in answers)
    assert "tenant=acme" in caplog.text
    assert "bad tenant" not in caplog.text and "x" * 200 not in caplog.text


def test_logs_have_no_package_content(client, caplog) -> None:
    from bim_core import InstancePackage

    caplog.set_level(logging.DEBUG)
    files = demo.demo_files()
    instance = json.loads(files["instance.json"])
    instance["metadata"]["name"] = "SECRET-PACKAGE-NAME"
    files["instance.json"] = json.dumps(instance).encode()
    data = InstancePackage(files).to_zip()
    response = client.post("/bim/v1/compile", json=package_body(data), headers={"X-BIM-Tenant": "acme"})
    assert response.status_code == 200
    assert "SECRET-PACKAGE-NAME" in response.text
    assert "SECRET-PACKAGE-NAME" not in caplog.text
    assert base64.b64encode(data).decode()[:40] not in caplog.text
    assert "path='/bim/v1/compile' status=200" in caplog.text


def test_operations_run_in_the_worker_pool_not_in_the_event_loop(client, monkeypatch) -> None:
    seen: list[str] = []

    def spy(*args):
        seen.append(threading.current_thread().name)
        return {"results": []}

    monkeypatch.setattr(operations, "evaluate", spy)
    assert client.post("/bim/v1/evaluate", json={"ir": {}, "bindings": [{}]}).status_code == 200
    assert seen and seen[0].startswith("bim-op")

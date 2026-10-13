"""The endpoints about one document: a resource, an Engine manifest, a standalone XML resource."""

from __future__ import annotations

import base64
import json

import pytest
from service_support import BASE_URL, TOOLCHAIN_ROOT, bearer
from starlette.testclient import TestClient

import consumer_fixtures as demo
from bim_core import Limits, engine_contract_diagnostics, resource_schema_diagnostics

RESOURCE = "/bim/v1/resources/validate"
ENGINE = "/bim/v1/engines/validate"
XML_ROOT = "/bim/v1/resources/xml/root"
XML_BPMN = "/bim/v1/resources/xml/validate-bpmn"
MANIFESTS = TOOLCHAIN_ROOT / "packages" / "bim-core" / "tests" / "fixtures" / "manifests"

BPMN_NAMESPACE = "http://www.omg.org/spec/BPMN/20100524/MODEL"
BPMN = b"""<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             targetNamespace="https://example.test/bpmn">
  <process id="p1" isExecutable="true">
    <startEvent id="start"><outgoing>f1</outgoing></startEvent>
    <serviceTask id="task"><incoming>f1</incoming><outgoing>f2</outgoing></serviceTask>
    <endEvent id="end"><incoming>f2</incoming></endEvent>
    <sequenceFlow id="f1" sourceRef="start" targetRef="task"/>
    <sequenceFlow id="f2" sourceRef="task" targetRef="end"/>
  </process>
</definitions>"""
BPMN_INVALID = BPMN.replace(b'targetNamespace="https://example.test/bpmn"', b"")

#: XML that the secure parser refuses before it reads a single external byte (XXE and its relatives).
FORBIDDEN_XML = {
    "external entity": b'<?xml version="1.0"?><!DOCTYPE a [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><a>&xxe;</a>',
    "external dtd": b'<?xml version="1.0"?><!DOCTYPE a SYSTEM "http://127.0.0.1:9/evil.dtd"><a/>',
    "parameter entity": b'<!DOCTYPE a [<!ENTITY % p SYSTEM "http://127.0.0.1:9/p">%p;]><a/>',
    "entity bomb": b'<!DOCTYPE a [<!ENTITY x "xxxxxxxxxx"><!ENTITY y "&x;&x;&x;&x;&x;&x;&x;&x;">]><a>&y;</a>',
    "xinclude": b'<a xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="file:///etc/passwd" parse="text"/></a>',
    "schema location": b'<a xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:x http://127.0.0.1:9/x.xsd"/>',
}


def encode(content: bytes) -> str:
    return base64.b64encode(content).decode()


def application() -> dict:
    return demo.demo_documents()["application.json"]


def resource_body(document: dict | None = None, **overrides) -> dict:
    body = {
        "document": application() if document is None else document,
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "mediaType": "application/json",
        "resource": "content",
        "dialects": None,
    }
    return {**body, **overrides}


def manifest(name: str) -> dict:
    return json.loads((MANIFESTS / f"{name}.json").read_text(encoding="utf-8"))


def small_client(make_app, **overrides) -> TestClient:
    return TestClient(make_app(**overrides), base_url=BASE_URL, raise_server_exceptions=False, headers=bearer())


def assert_problem(response, status: int, code: str, error_type: str | None = None) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert (body["status"], body["code"]) == (status, code)
    assert body["type"] == f"urn:bim-toolchain:problem:{code}"
    if error_type is not None:
        assert body["errorType"] == error_type
    return body


# --- /resources/validate ----------------------------------------------------------------------------------


def test_a_valid_resource_has_no_diagnostics(client) -> None:
    response = client.post(RESOURCE, json=resource_body())
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"diagnostics": []}


def test_an_invalid_resource_is_reported_as_data_with_the_diagnostics_of_bim_core(client) -> None:
    document = {"apiVersion": "qos-binding/v1", "kind": "Application"}
    response = client.post(RESOURCE, json=resource_body(document))
    assert response.status_code == 200, response.text
    found = response.json()["diagnostics"]
    expected = [item.as_dict() for item in resource_schema_diagnostics(document, "qos-binding/v1", "Application", "application/json", "content")]
    assert found == expected and found
    assert all({"code", "message", "resource"} <= set(item) for item in found)
    assert {item["resource"] for item in found} == {"content"}


def test_a_type_no_dialect_claims_is_a_diagnostic_not_an_error(client) -> None:
    response = client.post(RESOURCE, json=resource_body(apiVersion="nobody/v1", kind="Nothing"))
    assert response.status_code == 200
    assert [item["code"] for item in response.json()["diagnostics"]] == ["schema_unavailable"]
    # The identity is compared as given: anything JSON may be sent, and none of it matches.
    odd = client.post(RESOURCE, json=resource_body(apiVersion=1, kind=None, mediaType=[1]))
    assert odd.status_code == 200 and [item["code"] for item in odd.json()["diagnostics"]] == ["schema_unavailable"]


def test_the_dialects_considered_can_be_restricted(client) -> None:
    response = client.post(RESOURCE, json=resource_body(dialects=[]))
    assert response.status_code == 200
    assert [item["code"] for item in response.json()["diagnostics"]] == ["schema_unavailable"]
    installed = [item["manifest"] for item in client.get("/bim/v1/dialects").json()["dialects"]]
    assert client.post(RESOURCE, json=resource_body(dialects=installed)).json() == {"diagnostics": []}


@pytest.mark.parametrize(
    "overrides",
    [
        {"document": [1]},
        {"document": "text"},
        {"resource": 5},
        {"resource": None},
        {"dialects": {}},
        {"dialects": ["x"]},
        {"surprise": 1},
    ],
)
def test_a_resource_request_that_does_not_match_the_contract_is_422(client, overrides) -> None:
    response = client.post(RESOURCE, json={**resource_body(), **overrides})
    body = assert_problem(response, 422, "request_invalid", "ContractError")
    assert body["httpStatus"] == 422 and body["diagnostics"]


@pytest.mark.parametrize("member", ["document", "apiVersion", "kind", "mediaType", "resource"])
def test_every_member_but_dialects_is_required(client, member: str) -> None:
    body = resource_body()
    del body[member]
    response = client.post(RESOURCE, json=body)
    problem = assert_problem(response, 422, "request_invalid")
    assert any(item["pointer"] == f"/body/{member}" for item in problem["diagnostics"])
    without_dialects = resource_body()
    del without_dialects["dialects"]
    assert client.post(RESOURCE, json=without_dialects).status_code == 200


def test_non_finite_numbers_in_a_document_are_refused(client) -> None:
    body = json.dumps(resource_body(document={"spec": 0})).replace('"spec": 0', '"spec": NaN')
    response = client.post(RESOURCE, content=body, headers={"Content-Type": "application/json"})
    assert_problem(response, 422, "request_invalid")


# --- /engines/validate ------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["random-search", "minizinc-csp", "evolutionary-heuristics", "many-heuristic"])
def test_an_installed_engine_manifest_has_the_diagnostics_of_bim_core(client, name: str) -> None:
    document = manifest(name)
    response = client.post(ENGINE, json={"document": document})
    assert response.status_code == 200, response.text
    assert response.json() == {"diagnostics": engine_contract_diagnostics(document)}


def test_a_valid_engine_manifest_has_no_diagnostics(client) -> None:
    assert client.post(ENGINE, json={"document": manifest("random-search")}).json() == {"diagnostics": []}


def test_an_engine_that_declares_a_missing_profile_is_a_diagnostic(client) -> None:
    document = manifest("random-search")
    document["spec"]["modes"][0]["profile"] = "nobody/v1"
    response = client.post(ENGINE, json={"document": document})
    assert response.status_code == 200
    found = response.json()["diagnostics"]
    assert found == engine_contract_diagnostics(document)
    assert "profile_adapter_not_installed" in {item["code"] for item in found}


@pytest.mark.parametrize("spec", ["text", [], ["a"], None, 3, 1.5, True])
def test_an_engine_whose_spec_is_not_an_object_is_a_stable_diagnostic_not_a_500(client, spec) -> None:
    response = client.post(ENGINE, json={"document": {"spec": spec}})
    assert response.status_code == 200, response.text
    found = response.json()["diagnostics"]
    assert [(item["code"], item["pointer"]) for item in found] == [("engine_contract_invalid", "/spec")]
    assert isinstance(found[0]["message"], str) and found[0]["message"]


def test_an_engine_without_spec_keeps_the_diagnostics_of_bim_core(client) -> None:
    response = client.post(ENGINE, json={"document": {"kind": "Engine"}})
    assert response.status_code == 200
    assert response.json() == {"diagnostics": engine_contract_diagnostics({"kind": "Engine"})}


@pytest.mark.parametrize("body", [{}, {"document": 1},{"document": []}, {"document": {}, "extra": 1}, {"documento": {}}])
def test_an_engine_request_that_does_not_match_the_contract_is_422(client, body) -> None:
    assert_problem(client.post(ENGINE, json=body), 422, "request_invalid", "ContractError")


# --- /resources/xml/root and /resources/xml/validate-bpmn -------------------------------------------------


def test_the_root_of_an_xml_resource(client) -> None:
    response = client.post(XML_ROOT, json={"contentBase64": encode(BPMN)})
    assert response.status_code == 200, response.text
    assert response.json() == {"namespace": BPMN_NAMESPACE, "localName": "definitions"}
    assert client.post(XML_ROOT, json={"contentBase64": encode(b"<plain/>")}).json() == {
        "namespace": "", "localName": "plain",
    }  # fmt: skip
    # The root is read as XML, not validated: a document that is not BPMN still has one.
    assert client.post(XML_ROOT, json={"contentBase64": encode(BPMN_INVALID)}).status_code == 200


def test_a_conformant_bpmn_resource_is_valid(client) -> None:
    response = client.post(XML_BPMN, json={"contentBase64": encode(BPMN)})
    assert response.status_code == 200, response.text
    assert response.json() == {"valid": True}


def test_a_bpmn_resource_that_does_not_conform_is_a_package_error(client) -> None:
    response = client.post(XML_BPMN, json={"contentBase64": encode(BPMN_INVALID)})
    body = assert_problem(response, 422, "package_error", "PackageError")
    assert "OMG BPMN 2.0.2" in body["detail"]


@pytest.mark.parametrize("path", [XML_ROOT, XML_BPMN])
@pytest.mark.parametrize("content", [b"<a", b"", b"not xml", b"\xff\xfe<a/>", b"<a><b></a>"])
def test_xml_that_is_malformed_or_not_utf8_is_a_package_error(client, path: str, content: bytes) -> None:
    response = client.post(path, json={"contentBase64": encode(content)})
    assert_problem(response, 422, "package_error", "PackageError")


@pytest.mark.parametrize("path", [XML_ROOT, XML_BPMN])
@pytest.mark.parametrize("label", sorted(FORBIDDEN_XML))
def test_xml_with_a_dtd_or_external_entities_is_refused(client, path: str, label: str) -> None:
    response = client.post(path, json={"contentBase64": encode(FORBIDDEN_XML[label])})
    body = assert_problem(response, 422, "package_error", "PackageError")
    assert "forbidden external construct" in body["detail"]
    assert "root:" not in response.text  # nothing of /etc/passwd


def test_a_marker_hidden_after_a_long_prefix_is_still_refused(client) -> None:
    content = b"<a>" + b" " * 70_000 + FORBIDDEN_XML["external entity"] + b"</a>"
    assert_problem(client.post(XML_ROOT, json={"contentBase64": encode(content)}), 422, "package_error")


@pytest.mark.parametrize("path", [XML_ROOT, XML_BPMN])
@pytest.mark.parametrize(
    "body",
    [{}, {"contentBase64": 5}, {"contentBase64": None}, {"contentBase64": "", "extra": 1}, {"content": "PGEvPg=="}],
)
def test_an_xml_request_that_does_not_match_the_contract_is_422(client, path: str, body) -> None:
    assert_problem(client.post(path, json=body), 422, "request_invalid", "ContractError")


@pytest.mark.parametrize("path", [XML_ROOT, XML_BPMN])
@pytest.mark.parametrize("text", ["not base64!", "PGEvPg", "PGEv Pg==", "PGEvPg=\n=", "PGEv-Pg==", "====", "é"])
def test_the_content_must_be_strict_base64(client, path: str, text: str) -> None:
    body = assert_problem(client.post(path, json={"contentBase64": text}), 422, "request_invalid", "ContractError")
    assert body["diagnostics"][0]["pointer"] == "/contentBase64"


def test_the_package_limits_bound_an_xml_resource(make_app) -> None:
    small = small_client(make_app, limits=Limits(max_entry_bytes=256))
    content = b"<a>" + b"x" * 1000 + b"</a>"
    for path in (XML_ROOT, XML_BPMN):
        body = assert_problem(small.post(path, json={"contentBase64": encode(content)}), 422, "package_error", "PackageError")
        assert "exceeds 256 bytes" in body["detail"]
    assert small.post(XML_ROOT, json={"contentBase64": encode(b"<a/>")}).json() == {"namespace": "", "localName": "a"}
    # The default limits accept the same content.
    assert client_root(make_app, content) == {"namespace": "", "localName": "a"}


def client_root(make_app, content: bytes) -> dict:
    return small_client(make_app).post(XML_ROOT, json={"contentBase64": encode(content)}).json()


# --- all four: authentication, size, methods --------------------------------------------------------------

BODIES = {
    RESOURCE: resource_body,
    ENGINE: lambda: {"document": manifest("random-search")},
    XML_ROOT: lambda: {"contentBase64": encode(BPMN)},
    XML_BPMN: lambda: {"contentBase64": encode(BPMN)},
}


@pytest.mark.parametrize("path", sorted(BODIES))
def test_a_request_without_a_token_is_401_before_its_body_is_looked_at(client, path: str) -> None:
    for headers in ({"Authorization": ""}, {"Authorization": "Bearer " + "x" * 40}, {"Authorization": "Basic abc"}):
        response = client.post(path, json=BODIES[path](), headers=headers)
        assert_problem(response, 401, "unauthorized")
        assert response.headers["www-authenticate"].startswith("Bearer")
    garbage = client.post(path, content=b"{", headers={"Authorization": "", "Content-Type": "application/json"})
    assert garbage.status_code == 401


@pytest.mark.parametrize("path", sorted(BODIES))
def test_either_token_of_a_rotation_is_accepted(client, path: str) -> None:
    from service_support import TOKEN_OLD

    assert client.post(path, json=BODIES[path](), headers=bearer(TOKEN_OLD)).status_code == 200


@pytest.mark.parametrize("path", sorted(BODIES))
def test_a_body_over_the_limit_is_413(make_app, path: str) -> None:
    small = small_client(make_app, max_body_bytes=2048)
    huge = {
        RESOURCE: resource_body({"pad": "x" * 5000}),
        ENGINE: {"document": {"pad": "x" * 5000}},
        XML_ROOT: {"contentBase64": "A" * 5000},
        XML_BPMN: {"contentBase64": "A" * 5000},
    }[path]
    body = assert_problem(small.post(path, json=huge), 413, "payload_too_large")
    assert body["diagnostics"] == []
    assert small.get("/healthz").status_code == 200


@pytest.mark.parametrize("path", sorted(BODIES))
def test_a_body_that_is_not_json_is_422(client, path: str) -> None:
    for content in (b"{", b"[]", b'"text"', b"null", b""):
        response = client.post(path, content=content, headers={"Content-Type": "application/json"})
        assert_problem(response, 422, "request_invalid", "ContractError")


@pytest.mark.parametrize("path", sorted(BODIES))
def test_the_endpoints_are_post_only(client, path: str) -> None:
    response = client.get(path)
    assert_problem(response, 405, "method_not_allowed")
    assert "POST" in response.headers["allow"]


@pytest.mark.parametrize("path", sorted(BODIES))
def test_the_answers_are_deterministic_and_carry_the_trace(client, path: str) -> None:
    trace = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
    first = client.post(path, json=BODIES[path](), headers={"traceparent": trace})
    again = client.post(path, json=BODIES[path](), headers={"X-BIM-Tenant": "acme"})
    assert first.status_code == 200 and first.json() == again.json()
    assert first.headers["traceparent"] == trace


def test_operations_run_in_the_worker_pool(client, monkeypatch) -> None:
    import threading

    from bim_service import operations

    seen: list[str] = []

    def spy(*args):
        seen.append(threading.current_thread().name)
        return {"diagnostics": []}

    monkeypatch.setattr(operations, "validate_engine", spy)
    assert client.post(ENGINE, json={"document": {}}).status_code == 200
    assert seen and seen[0].startswith("bim-op")


def test_the_openapi_document_describes_the_four_endpoints(client) -> None:
    document = client.get("/bim/v1/openapi.json").json()
    for path in (RESOURCE, ENGINE, XML_ROOT, XML_BPMN):
        operation = document["paths"][path]["post"]
        assert {"200", "401", "413", "422", "429", "500", "503"} <= set(operation["responses"])
        assert operation["requestBody"]["required"] is True
    schema = document["components"]["schemas"]["ResourceValidateRequest"]
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {"document", "apiVersion", "kind", "mediaType", "resource"}

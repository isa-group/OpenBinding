"""``BimResourcePort``: the operations about one document through ``InProcessBim`` and ``HttpBim`` (the service in ASGI).

The outcomes must be *equal*: the same diagnostics, the same root, the same error class with the same ``code``,
message, ``diagnostics`` and ``http_status``.
"""

from __future__ import annotations

import base64
import functools
import inspect
import json
from typing import Any

import httpx
import pytest
from client_support import BASE_URL, MANIFEST_DIR, TOKEN, outcome
from starlette.testclient import TestClient

import consumer_fixtures as fx
from bim_client import BimResourcePort, HttpBim, InProcessBim
from bim_core import Limits
from bim_service.app import create_app
from bim_service.settings import BimServiceSettings

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
XML = {
    "bpmn": BPMN,
    "bpmn without target namespace": BPMN.replace(b'targetNamespace="https://example.test/bpmn"', b""),
    "namespaced": b'<root xmlns="urn:example"/>',
    "prefixed": b'<p:root xmlns:p="urn:example"><p:child/></p:root>',
    "plain": b"<plain/>",
    "malformed": b"<a",
    "mismatched": b"<a><b></a>",
    "empty": b"",
    "not utf-8": b"\xff\xfe<a/>",
    "external entity": b'<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>',
    "internal entity": b'<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>',
    "external dtd": b'<!DOCTYPE a SYSTEM "http://127.0.0.1:9/a.dtd"><a/>',
    "xinclude": b'<a xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="file:///etc/passwd"/></a>',
    "schema location": b'<a xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:x u"/>',
    "hidden after a long prefix": b"<a>" + b" " * 70_000 + b'<!DOCTYPE b [<!ENTITY x SYSTEM "file:///x">]></a>',
}
ENGINES = ["random-search", "minizinc-csp", "evolutionary-heuristics", "many-heuristic"]


def calling(name: str, *args: Any, **kwargs: Any):
    def call(port):
        return getattr(port, name)(*args, **kwargs)

    return call


def both(inprocess: InProcessBim, http: HttpBim, call) -> tuple:
    local, remote = outcome(functools.partial(call, inprocess)), outcome(functools.partial(call, http))
    assert local == remote
    return local


def manifest(name: str) -> dict[str, Any]:
    return json.loads((MANIFEST_DIR / f"{name}.json").read_text(encoding="utf-8"))


def application() -> dict[str, Any]:
    return fx.demo_documents()["application.json"]


# --- the interface ------------------------------------------------------------------------------------------


def test_both_implementations_satisfy_the_resource_port(inprocess_bim, http_bim) -> None:
    assert isinstance(inprocess_bim, BimResourcePort) and isinstance(http_bim, BimResourcePort)


@pytest.mark.parametrize("name", ["validate_resource", "validate_engine", "xml_resource_root", "validate_bpmn_resource"])
def test_both_implementations_have_the_signature_of_the_resource_port(name: str) -> None:
    expected = inspect.signature(getattr(BimResourcePort, name))
    for implementation in (InProcessBim, HttpBim):
        found = inspect.signature(getattr(implementation, name))
        assert [(p.name, p.kind, p.default, p.annotation) for p in found.parameters.values()] == [
            (p.name, p.kind, p.default, p.annotation) for p in expected.parameters.values()
        ], (implementation.__name__, name)
        assert found.return_annotation == expected.return_annotation, (implementation.__name__, name)


def test_http_bim_sends_each_operation_to_its_endpoint() -> None:
    seen: list[tuple[str, str, dict[str, Any]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, json.loads(request.content)))
        answers = {
            "/bim/v1/resources/validate": {"diagnostics": []},
            "/bim/v1/engines/validate": {"diagnostics": []},
            "/bim/v1/resources/xml/root": {"namespace": "", "localName": "a"},
            "/bim/v1/resources/xml/validate-bpmn": {"valid": True},
        }
        return httpx.Response(200, json=answers[request.url.path])

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url=BASE_URL)
    with HttpBim(client=client, token=TOKEN) as bim:
        assert bim.validate_resource({"a": 1}, "v1", "K", "application/json", "r", [{"b": 2}]) == []
        assert bim.validate_resource({}, "v1", "K", "application/json", "r") == []
        assert bim.validate_engine({"c": 3}) == []
        assert bim.xml_resource_root(b"<a/>") == {"namespace": "", "localName": "a"}
        assert bim.validate_bpmn_resource(b"<a/>") == {"valid": True}
    encoded = base64.b64encode(b"<a/>").decode()
    assert seen == [
        (
            "POST",
            "/bim/v1/resources/validate",
            {
                "document": {"a": 1}, "apiVersion": "v1", "kind": "K", "mediaType": "application/json",
                "resource": "r", "dialects": [{"b": 2}],
            },
        ),  # fmt: skip
        (
            "POST",
            "/bim/v1/resources/validate",
            {
                "document": {}, "apiVersion": "v1", "kind": "K", "mediaType": "application/json",
                "resource": "r", "dialects": None,
            },
        ),  # fmt: skip
        ("POST", "/bim/v1/engines/validate", {"document": {"c": 3}}),
        ("POST", "/bim/v1/resources/xml/root", {"contentBase64": encoded}),
        ("POST", "/bim/v1/resources/xml/validate-bpmn", {"contentBase64": encoded}),
    ]


def test_inputs_that_are_not_strict_json_fail_before_anything_is_sent() -> None:
    def forbidden(request):
        raise AssertionError("nothing may be sent")

    client = httpx.Client(transport=httpx.MockTransport(forbidden), base_url=BASE_URL)
    http, local = HttpBim(client=client), InProcessBim()
    nan = float("nan")
    calls = [
        lambda bim: bim.validate_resource([1], "v1", "K", "application/json", "r"),
        lambda bim: bim.validate_resource({"a": nan}, "v1", "K", "application/json", "r"),
        lambda bim: bim.validate_resource({}, nan, "K", "application/json", "r"),
        lambda bim: bim.validate_resource({}, "v1", b"bytes", "application/json", "r"),
        lambda bim: bim.validate_resource({}, "v1", "K", "application/json", 5),
        lambda bim: bim.validate_resource({}, "v1", "K", "application/json", "r", [nan]),
        lambda bim: bim.validate_resource({}, "v1", "K", "application/json", "r", ["not an object"]),
        lambda bim: bim.validate_engine("manifest"),
        lambda bim: bim.validate_engine({"a": float("inf")}),
        lambda bim: bim.xml_resource_root("<a/>"),
        lambda bim: bim.validate_bpmn_resource(None),
    ]
    for call in calls:
        a, b = outcome(functools.partial(call, http)), outcome(functools.partial(call, local))
        assert a == b and a[0] == "error" and a[2] == "request_invalid", a
        assert a[5] == 422 and a[4]["diagnostics"][0]["code"] == "request_invalid"


# --- resources and engines ----------------------------------------------------------------------------------


def test_resources_are_validated_identically(inprocess_bim, http_bim) -> None:
    valid = both(inprocess_bim, http_bim, calling("validate_resource", application(), "qos-binding/v1", "Application", "application/json", "content"))
    assert valid == ("ok", [])
    cases = {
        "missing members": ({"apiVersion": "qos-binding/v1", "kind": "Application"}, "qos-binding/v1", "Application"),
        "wrong shape": ({**application(), "spec": "text"}, "qos-binding/v1", "Application"),
        "unknown type": (application(), "nobody/v1", "Nothing"),
        "unhashable type": (application(), ["qos-binding/v1"], {"kind": "Application"}),
        "no type": (application(), None, None),
    }
    findings = 0
    for label, (document, api_version, kind) in cases.items():
        result = both(inprocess_bim, http_bim, calling("validate_resource", document, api_version, kind, "application/json", "content"))
        assert result[0] == "ok" and result[1], label
        findings += len(result[1])
    assert findings >= 5


def test_every_installed_resource_type_is_validated_identically(inprocess_bim, http_bim) -> None:
    checked = 0
    for entry in inprocess_bim.dialects():
        for resource_type in entry["manifest"]["spec"].get("resourceTypes", []):
            if resource_type.get("mediaType") != "application/json":
                continue
            document = {"apiVersion": resource_type["apiVersion"], "kind": resource_type["kind"]}
            args = (resource_type["apiVersion"], resource_type["kind"], "application/json", "content")
            result = both(inprocess_bim, http_bim, calling("validate_resource", document, *args))
            assert result[0] == "ok"
            checked += 1
    assert checked


def test_resources_restricted_to_given_dialects_are_validated_identically(inprocess_bim, http_bim) -> None:
    installed = [entry["manifest"] for entry in inprocess_bim.dialects()]
    args = (application(), "qos-binding/v1", "Application", "application/json", "content")
    assert both(inprocess_bim, http_bim, calling("validate_resource", *args, installed)) == ("ok", [])
    nothing = both(inprocess_bim, http_bim, calling("validate_resource", *args, []))
    assert nothing[0] == "ok" and [item["code"] for item in nothing[1]] == ["schema_unavailable"]
    unrelated = both(inprocess_bim, http_bim, calling("validate_resource", *args, [{"spec": {}}]))
    assert unrelated[0] == "ok" and [item["code"] for item in unrelated[1]] == ["schema_unavailable"]


@pytest.mark.parametrize("name", ENGINES)
def test_engine_manifests_are_validated_identically(inprocess_bim, http_bim, name: str) -> None:
    result = both(inprocess_bim, http_bim, calling("validate_engine", manifest(name)))
    assert result[0] == "ok"


def test_engine_manifests_with_findings_are_reported_identically(inprocess_bim, http_bim) -> None:
    missing_profile = manifest("random-search")
    missing_profile["spec"]["modes"][0]["profile"] = "nobody/v1"
    repeated = manifest("random-search")
    repeated["spec"]["modes"] = [repeated["spec"]["modes"][0], repeated["spec"]["modes"][0]]
    cases = [missing_profile, repeated, {}, {"spec": {"modes": "not a list"}}, {"spec": {"modes": [1, None]}}]
    codes: set[str] = set()
    for document in cases:
        result = both(inprocess_bim, http_bim, calling("validate_engine", document))
        assert result[0] == "ok"
        codes |= {item["code"] for item in result[1]}
    assert {"profile_adapter_not_installed", "mode_id_duplicate"} <= codes


@pytest.mark.parametrize("spec", ["text", [], ["a"], None, 3, 1.5, True])
def test_an_engine_whose_spec_is_not_an_object_is_the_same_diagnostic(inprocess_bim, http_bim, spec) -> None:
    result = both(inprocess_bim, http_bim, calling("validate_engine", {"spec": spec}))
    assert result[0] == "ok"
    assert [(item["code"], item["pointer"]) for item in result[1]] == [("engine_contract_invalid", "/spec")]


def test_an_engine_without_spec_is_the_same_outcome(inprocess_bim, http_bim) -> None:
    assert both(inprocess_bim, http_bim, calling("validate_engine", {"kind": "Engine"})) == ("ok", [])


# --- XML ----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("label", sorted(XML))
def test_xml_resources_are_parsed_and_validated_identically(inprocess_bim, http_bim, label: str) -> None:
    root = both(inprocess_bim, http_bim, calling("xml_resource_root", XML[label]))
    validated = both(inprocess_bim, http_bim, calling("validate_bpmn_resource", XML[label]))
    assert root[0] == ("ok" if label in {"bpmn", "bpmn without target namespace", "namespaced", "prefixed", "plain"} else "error")
    assert validated[0] == ("ok" if label == "bpmn" else "error")


def test_the_roots_and_errors_are_the_documented_ones(inprocess_bim, http_bim) -> None:
    for port in (inprocess_bim, http_bim):
        assert port.xml_resource_root(XML["namespaced"]) == {"namespace": "urn:example", "localName": "root"}
        assert port.xml_resource_root(XML["prefixed"]) == {"namespace": "urn:example", "localName": "root"}
        assert port.xml_resource_root(XML["plain"]) == {"namespace": "", "localName": "plain"}
        assert port.validate_bpmn_resource(BPMN) == {"valid": True}
    for label in ("malformed", "external entity", "internal entity", "external dtd", "xinclude", "schema location"):
        for name in ("xml_resource_root", "validate_bpmn_resource"):
            result = both(inprocess_bim, http_bim, calling(name, XML[label]))
            assert result[:3] == ("error", "PackageError", "package_error"), (label, name)
    forbidden = both(inprocess_bim, http_bim, calling("xml_resource_root", XML["external entity"]))
    assert "forbidden external construct" in forbidden[3]
    invalid = both(inprocess_bim, http_bim, calling("validate_bpmn_resource", XML["bpmn without target namespace"]))
    assert "OMG BPMN 2.0.2" in invalid[3]


def test_a_small_package_limit_bounds_an_xml_resource_identically(tokens_file) -> None:
    limits = Limits(max_entry_bytes=256)
    service = create_app(BimServiceSettings(tokens_file=str(tokens_file), limits=limits))
    client = TestClient(service, base_url=BASE_URL, raise_server_exceptions=False)
    content = b"<a>" + b"x" * 1000 + b"</a>"
    with HttpBim(client=client, token_file=tokens_file) as http, InProcessBim(limits=limits) as local:
        for name in ("xml_resource_root", "validate_bpmn_resource"):
            result = both(local, http, calling(name, content))
            assert result[:3] == ("error", "PackageError", "package_error") and "exceeds 256 bytes" in result[3]
        assert both(local, http, calling("xml_resource_root", b"<a/>")) == ("ok", {"namespace": "", "localName": "a"})

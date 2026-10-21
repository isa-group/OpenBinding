"""``integrations/bim_host.py`` asks the BIM port for the checks about a single document.

With ``InProcessBim`` the answers are those ``bim_core`` always gave; the port that has the operations is the
one that answers (nothing is computed with the local ``bim_core``); with ``HttpBim`` each operation is a request
to the matching endpoint of bim-service and nothing runs in this process.
"""

from __future__ import annotations

import ast
import base64
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from bim_client import BimResourcePort, HttpBim, InProcessBim
from bim_core import PackageError
from bim_core import engine_contract_diagnostics as core_engine_diagnostics
from bim_core import resource_schema_diagnostics as core_resource_diagnostics

from openbinding_gateway.integrations import bim, bim_host

HOST = Path(bim_host.__file__)

ENGINES: list[dict[str, Any]] = [
    {},
    {"spec": {"modes": [{"id": "a"}, {"id": "a"}]}},
    {"spec": {"modes": "not a list"}},
    {"spec": {"modes": [{"id": "m", "profile": {"name": "nope", "version": "9"}}]}},
]
RESOURCES: list[dict[str, Any]] = [
    {"apiVersion": "nobody/v1", "kind": "Nothing"},
    {"apiVersion": 1, "kind": None},
]
XML_OK = b'<root xmlns="urn:example"/>'
XML_PLAIN = b"<plain/>"
XML_BAD = [b"<a", b"\xff\xfe", b'<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>']


class RecordingPort:
    """A port with the document operations only, answering fixed values."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def validate_resource(self, *args: Any) -> list[dict[str, Any]]:
        self.calls.append(("validate_resource", args))
        return [{"code": "schema", "message": "from the port", "resource": args[4], "pointer": "/x"}]

    def validate_engine(self, document: Any) -> list[dict[str, Any]]:
        self.calls.append(("validate_engine", (document,)))
        return [{"code": "from_port", "message": "engine"}]

    def xml_resource_root(self, content: bytes) -> dict[str, str]:
        self.calls.append(("xml_resource_root", (content,)))
        return {"namespace": "urn:port", "localName": "thing"}

    def validate_bpmn_resource(self, content: bytes) -> dict[str, bool]:
        self.calls.append(("validate_bpmn_resource", (content,)))
        return {"valid": True}


class FakeService:
    """The four endpoints of bim-service, answering fixed bodies and recording what was sent."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.answers: dict[str, tuple[int, dict[str, Any]]] = {
            "/bim/v1/resources/validate": (
                200,
                {"diagnostics": [{"code": "schema", "message": "from the service", "resource": "r", "pointer": "/x"}]},
            ),
            "/bim/v1/engines/validate": (200, {"diagnostics": [{"code": "from_service", "message": "engine"}]}),
            "/bim/v1/resources/xml/root": (200, {"namespace": "urn:service", "localName": "thing"}),
            "/bim/v1/resources/xml/validate-bpmn": (200, {"valid": True}),
        }

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.url.path, json.loads(request.content)))
        status, body = self.answers[request.url.path]
        media_type = "application/json" if status < 400 else "application/problem+json"
        return httpx.Response(status, json=body, headers={"content-type": media_type})


def http_port(service: FakeService | None = None) -> HttpBim:
    client = httpx.Client(transport=httpx.MockTransport(service or FakeService()), base_url="http://bim.test")
    return HttpBim(client=client)


@pytest.fixture
def poisoned_core(monkeypatch: pytest.MonkeyPatch) -> None:
    """The local ``bim_core`` checks fail if anything falls back to them."""
    import bim_core

    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("bim_core was used although the port answers")

    for name in ("resource_schema_diagnostics", "engine_contract_diagnostics", "InstancePackage"):
        monkeypatch.setattr(bim_core, name, forbidden)


def outcome(call) -> Any:
    try:
        return call()
    except PackageError as exc:
        return ("PackageError", exc.code, exc.message)


def core_xml(content: bytes) -> Any:
    from bim_core import InstancePackage

    package = InstancePackage({"instance.json": b"{}", "resource.xml": content})
    return outcome(lambda: package.xml_root("resource.xml").tag)


# ------------------------------------------------------------------------------------ the module


def test_bim_host_imports_nothing_from_the_toolchain_at_any_level() -> None:
    tree = ast.parse(HOST.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            modules = [node.module or ""]
        else:
            continue
        for module in modules:
            assert not module.startswith(("bim_core", "bim_client", "bim_service")), module


def test_bim_host_has_no_local_fallback() -> None:
    names = {node.name for node in ast.walk(ast.parse(HOST.read_text(encoding="utf-8"))) if isinstance(node, ast.FunctionDef)}
    assert not {"_ask", "local"} & names
    assert "BimOperationUnavailable" not in HOST.read_text(encoding="utf-8")


def test_both_implementations_have_the_document_operations() -> None:
    assert isinstance(InProcessBim(), BimResourcePort)
    assert isinstance(http_port(), BimResourcePort)


# ------------------------------------------------------------------- the port answers when it can


def test_the_port_answers_and_bim_core_is_not_used(poisoned_core: None) -> None:
    port = RecordingPort()
    with bim.bim_override(port):  # type: ignore[arg-type]
        found = bim_host.resource_schema_diagnostics({"kind": "K"}, "v1", "K", "application/json", "resource")
        engine = bim_host.engine_contract_diagnostics({"spec": {}})
        resource = bim_host.XmlResource(XML_OK)
        root = resource.root()
        resource.validate_bpmn()

    assert [item.as_dict() for item in found] == [
        {"code": "schema", "message": "from the port", "resource": "resource", "pointer": "/x"}
    ]
    assert engine == [{"code": "from_port", "message": "engine"}]
    assert root.tag == "{urn:port}thing"
    assert [name for name, _ in port.calls] == [
        "validate_resource",
        "validate_engine",
        "xml_resource_root",
        "validate_bpmn_resource",
    ]
    assert port.calls[0][1] == ({"kind": "K"}, "v1", "K", "application/json", "resource", None)


def test_a_root_without_namespace_has_a_plain_tag(monkeypatch: pytest.MonkeyPatch) -> None:
    port = RecordingPort()
    monkeypatch.setattr(port, "xml_resource_root", lambda content: {"namespace": "", "localName": "plain"})
    with bim.bim_override(port):  # type: ignore[arg-type]
        assert bim_host.XmlResource(XML_PLAIN).root().tag == "plain"


# ---------------------------------------------------------- the same results through InProcessBim


@pytest.mark.parametrize("document", ENGINES)
def test_engine_diagnostics_are_those_of_bim_core(document: dict[str, Any]) -> None:
    with bim.bim_override(InProcessBim()):
        assert bim_host.engine_contract_diagnostics(document) == core_engine_diagnostics(document)


@pytest.mark.parametrize("document", RESOURCES)
def test_resource_diagnostics_are_those_of_bim_core(document: dict[str, Any]) -> None:
    api_version, kind = document.get("apiVersion"), document.get("kind")
    expected = [item.as_dict() for item in core_resource_diagnostics(document, api_version, kind, "application/json", "r")]
    with bim.bim_override(InProcessBim()):
        found = bim_host.resource_schema_diagnostics(document, api_version, kind, "application/json", "r")
    assert [item.as_dict() for item in found] == expected
    assert expected, "an unknown type must be reported"


def test_resource_diagnostics_restricted_to_given_dialects_are_those_of_bim_core() -> None:
    document = {"apiVersion": "nobody/v1", "kind": "Nothing"}
    expected = [item.as_dict() for item in core_resource_diagnostics(document, "nobody/v1", "Nothing", "application/json", "r", [])]
    with bim.bim_override(InProcessBim()):
        found = bim_host.resource_schema_diagnostics(document, "nobody/v1", "Nothing", "application/json", "r", [])
    assert [item.as_dict() for item in found] == expected


def test_installed_dialects_validate_like_bim_core() -> None:
    with bim.bim_override(InProcessBim()):
        entries = bim.dialect_entries()
        pairs = [(item["manifest"], rt) for item in entries for rt in item["manifest"]["spec"].get("resourceTypes", [])]
        checked = 0
        for _, resource_type in pairs:
            if resource_type.get("mediaType") != "application/json":
                continue
            args = (resource_type["apiVersion"], resource_type["kind"], "application/json")
            document = {"apiVersion": args[0], "kind": args[1]}
            expected = [item.as_dict() for item in core_resource_diagnostics(document, *args, "r")]
            found = bim_host.resource_schema_diagnostics(document, *args, "r")
            assert [item.as_dict() for item in found] == expected
            checked += 1
    assert checked


def test_type_matching_is_that_of_bim_core() -> None:
    from bim_core import dialect_type_matches, dialect_xml_type_matches

    dialects = [item["manifest"] for item in InProcessBim().dialects()]
    for manifest in dialects:
        for resource_type in manifest["spec"].get("resourceTypes", []):
            api, kind, media = resource_type["apiVersion"], resource_type["kind"], resource_type["mediaType"]
            assert bim_host.dialect_type_matches(dialects, api, kind, media) == dialect_type_matches(dialects, api, kind, media)
            root = resource_type.get("xmlRoot")
            if root:
                args = (root["namespace"], root["localName"])
                for media_type in (None, media):
                    assert bim_host.dialect_xml_type_matches(dialects, *args, media_type) == dialect_xml_type_matches(
                        dialects, *args, media_type
                    )
    assert bim_host.dialect_type_matches(dialects, "nobody/v1", "Nothing", "application/json") == []


@pytest.mark.parametrize("content", [XML_OK, XML_PLAIN, *XML_BAD])
def test_xml_root_and_bpmn_are_those_of_bim_core(content: bytes) -> None:
    from bim_core import InstancePackage

    package = InstancePackage({"instance.json": b"{}", "resource.xml": content})
    with bim.bim_override(InProcessBim()):
        resource = bim_host.XmlResource(content)
        assert outcome(lambda: resource.root().tag) == core_xml(content)
        assert outcome(lambda: (resource.validate_bpmn(), None)[1]) == outcome(
            lambda: (package.xml("resource.xml"), None)[1]
        )


# ------------------------------------------------------------ HttpBim: the service answers


def test_with_http_every_operation_is_a_request_to_the_service_and_bim_core_is_not_used(poisoned_core: None) -> None:
    service = FakeService()
    with bim.bim_override(http_port(service)):
        found = bim_host.resource_schema_diagnostics({"kind": "K"}, "v1", "K", "application/json", "resource")
        engine = bim_host.engine_contract_diagnostics({"spec": {}})
        resource = bim_host.XmlResource(XML_OK)
        root = resource.root()
        resource.validate_bpmn()

    assert [item.as_dict() for item in found] == [
        {"code": "schema", "message": "from the service", "resource": "r", "pointer": "/x"}
    ]
    assert engine == [{"code": "from_service", "message": "engine"}]
    assert root.tag == "{urn:service}thing"
    encoded = base64.b64encode(XML_OK).decode()
    assert service.requests == [
        (
            "/bim/v1/resources/validate",
            {
                "document": {"kind": "K"},
                "apiVersion": "v1",
                "kind": "K",
                "mediaType": "application/json",
                "resource": "resource",
                "dialects": None,
            },
        ),
        ("/bim/v1/engines/validate", {"document": {"spec": {}}}),
        ("/bim/v1/resources/xml/root", {"contentBase64": encoded}),
        ("/bim/v1/resources/xml/validate-bpmn", {"contentBase64": encoded}),
    ]


def test_with_http_a_problem_of_the_service_is_the_error_bim_core_raises() -> None:
    service = FakeService()
    problem = {
        "type": "urn:bim-toolchain:problem:package_error",
        "title": "Package error",
        "status": 422,
        "detail": "invalid XML at line 1, column 3: resource.xml",
        "code": "package_error",
        "errorType": "PackageError",
        "diagnostics": [],
    }
    service.answers["/bim/v1/resources/xml/root"] = (422, problem)
    service.answers["/bim/v1/resources/xml/validate-bpmn"] = (422, problem)
    with bim.bim_override(http_port(service)):
        with pytest.raises(PackageError, match="invalid XML"):
            bim_host.XmlResource(XML_BAD[0]).root()
        with pytest.raises(PackageError):
            bim_host.XmlResource(XML_BAD[0]).validate_bpmn()

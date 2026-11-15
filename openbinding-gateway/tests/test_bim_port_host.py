"""``integrations/bim_host.py`` asks the BIM port for the check about a single document (an Engine manifest).

With ``InProcessBim`` the answers are those ``bim_core`` always gave; the port that has the operations is the
one that answers (nothing is computed with the local ``bim_core``); with ``HttpBim`` each operation is a request
to the matching endpoint of bim-service and nothing runs in this process.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from bim_client import BimResourcePort, HttpBim, InProcessBim
from bim_core import engine_contract_diagnostics as core_engine_diagnostics

from openbinding_gateway.integrations import bim, bim_host

HOST = Path(bim_host.__file__)

ENGINES: list[dict[str, Any]] = [
    {},
    {"spec": {"modes": [{"id": "a"}, {"id": "a"}]}},
    {"spec": {"modes": "not a list"}},
    {"spec": {"modes": [{"id": "m", "profile": {"name": "nope", "version": "9"}}]}},
]


class RecordingPort:
    """A port with the document operation only, answering a fixed value."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def validate_engine(self, document: Any) -> list[dict[str, Any]]:
        self.calls.append(("validate_engine", (document,)))
        return [{"code": "from_port", "message": "engine"}]


class FakeService:
    """The engine endpoint of bim-service, answering a fixed body and recording what was sent."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.answers: dict[str, tuple[int, dict[str, Any]]] = {
            "/bim/v1/engines/validate": (200, {"diagnostics": [{"code": "from_service", "message": "engine"}]}),
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

    for name in ("engine_contract_diagnostics",):
        monkeypatch.setattr(bim_core, name, forbidden)


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
        engine = bim_host.engine_contract_diagnostics({"spec": {}})

    assert engine == [{"code": "from_port", "message": "engine"}]
    assert port.calls == [("validate_engine", ({"spec": {}},))]


# ---------------------------------------------------------- the same results through InProcessBim


@pytest.mark.parametrize("document", ENGINES)
def test_engine_diagnostics_are_those_of_bim_core(document: dict[str, Any]) -> None:
    with bim.bim_override(InProcessBim()):
        assert bim_host.engine_contract_diagnostics(document) == core_engine_diagnostics(document)


def test_type_matching_is_that_of_bim_core() -> None:
    from bim_core import dialect_type_matches

    dialects = [item["manifest"] for item in InProcessBim().dialects()]
    for manifest in dialects:
        for resource_type in manifest["spec"].get("resourceTypes", []):
            api, kind, media = resource_type["apiVersion"], resource_type["kind"], resource_type["mediaType"]
            assert bim_host.dialect_type_matches(dialects, api, kind, media) == dialect_type_matches(dialects, api, kind, media)
    assert bim_host.dialect_type_matches(dialects, "nobody/v1", "Nothing", "application/json") == []


# ------------------------------------------------------------ HttpBim: the service answers


def test_with_http_the_operation_is_a_request_to_the_service_and_bim_core_is_not_used(poisoned_core: None) -> None:
    service = FakeService()
    with bim.bim_override(http_port(service)):
        engine = bim_host.engine_contract_diagnostics({"spec": {}})

    assert engine == [{"code": "from_service", "message": "engine"}]
    assert service.requests == [("/bim/v1/engines/validate", {"document": {"spec": {}}})]

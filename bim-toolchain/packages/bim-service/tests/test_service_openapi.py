"""The committed OpenAPI document is what the application generates."""

from __future__ import annotations

import json

import pytest
from service_support import TOOLCHAIN_ROOT  # puts tools/ on sys.path

import dump_service_openapi as tool  # noqa: E402


def test_the_committed_openapi_is_the_generated_one() -> None:
    found = tool.render(tool.generate())
    if not tool.OPENAPI_PATH.is_file():
        tool.OPENAPI_PATH.parent.mkdir(parents=True, exist_ok=True)
        tool.OPENAPI_PATH.write_bytes(found)
        pytest.fail(f"{tool.OPENAPI_PATH.relative_to(TOOLCHAIN_ROOT)} did not exist and was created: review and commit it")
    assert tool.difference(found, tool.OPENAPI_PATH.read_bytes()) is None


def test_generation_is_deterministic_and_independent_of_the_configuration() -> None:
    from bim_service.app import build_app
    from bim_service.auth import Authenticator
    from bim_service.settings import BimServiceSettings

    other = build_app(BimServiceSettings(max_body_bytes=5, max_concurrency=1), Authenticator(["x" * 40])).openapi()
    assert tool.render(other) == tool.render(tool.generate()) == tool.render(tool.generate())


def test_the_check_mode_of_the_tool(tmp_path, capsys) -> None:
    assert tool.main(["--check"]) == 0
    assert "up to date" in capsys.readouterr().out
    stale = tmp_path / "stale.json"
    stale.write_bytes(tool.OPENAPI_PATH.read_bytes().replace(b"BIM service", b"Other service", 1))
    assert tool.main(["--check", "--path", str(stale)]) == 1
    assert "out of date" in capsys.readouterr().out
    assert tool.main(["--check", "--path", str(tmp_path / "absent.json")]) == 1


def test_the_tool_writes_the_document_it_checks(tmp_path) -> None:
    target = tmp_path / "nested" / "openapi.json"
    assert tool.main(["--path", str(target)]) == 0
    assert target.read_bytes() == tool.render(tool.generate())
    assert tool.main(["--check", "--path", str(target)]) == 0


def test_the_document_describes_the_versioned_api() -> None:
    document = json.loads(tool.OPENAPI_PATH.read_text(encoding="utf-8"))
    assert document["openapi"].startswith("3.")
    assert set(document["paths"]) == {
        "/bim/v1/capabilities", "/bim/v1/profiles", "/bim/v1/dialects", "/bim/v1/schemas/{kind}", "/bim/v1/protocol",
        "/bim/v1/compile", "/bim/v1/validate", "/bim/v1/compatibility", "/bim/v1/optimization/resolve",
        "/bim/v1/evaluate", "/bim/v1/reevaluate", "/bim/v1/validate-result", "/bim/v1/neighborhood",
        "/bim/v1/resources/validate", "/bim/v1/engines/validate", "/bim/v1/resources/xml/root",
        "/bim/v1/resources/xml/validate-bpmn",
    }  # fmt: skip
    assert document["security"] == [{"bearerAuth": []}]
    schemas = document["components"]["schemas"]
    assert {"PackageRequest", "RegisteredResourceModel", "Problem", "CompileResponse"} <= set(schemas)
    assert {"ResourceValidateRequest", "EngineValidateRequest", "XmlResourceRequest", "DiagnosticsResponse"} <= set(schemas)
    assert "HTTPValidationError" not in schemas
    assert set(document["paths"]["/bim/v1/compile"]["post"]["requestBody"]["content"]) == {
        "application/json", "multipart/form-data",
    }  # fmt: skip


def test_every_operation_documents_its_problems_as_problem_json() -> None:
    document = json.loads(tool.OPENAPI_PATH.read_text(encoding="utf-8"))
    for path, item in document["paths"].items():
        for method, operation in item.items():
            responses = operation["responses"]
            assert {"401", "413", "422", "429", "500", "503"} <= set(responses), (method, path)
            for status in ("401", "422", "503"):
                assert list(responses[status]["content"]) == ["application/problem+json"], (method, path)
    operation_ids = [operation["operationId"] for item in document["paths"].values() for operation in item.values()]
    assert len(operation_ids) == len(set(operation_ids)) == 17

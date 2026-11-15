"""What the gateway does with an upload the BIM toolchain refuses, and with the limits it applies.

The rules themselves (paths, ZIP limits, XML security, canonical form, digests) belong to ``bim-core`` and
are tested there (``packages/bim-core/tests/test_package_security.py``).  What the platform adds, and
what is tested here, is that every refusal reaches the caller as a 422 through both entry points of a
package (``POST /v1/bim/validate`` and the problem upload), and that the limits of the toolchain in use
(``BIM_MAX_*``) are the ones that apply.
"""

import io
import json
import zipfile

import pytest

from _b1_helpers import gate, make_account  # noqa: F401,F811
from _problem_helpers import make_org
from openbinding_gateway.integrations import bim
from openbinding_gateway.modules.problems.adapters import bim_routes
from openbinding_gateway.modules.problems.adapters import routes as problem_routes
from bim_core import PackageError
from bim_core.package import InstancePackage

ROOT = {
    "apiVersion": "bim/v1",
    "kind": "Instance",
    "metadata": {"name": "test"},
    "spec": {"profile": "qos-binding/v1", "resources": {}},
}

BPMN = b'''<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             targetNamespace="https://example.test/bpmn">
  <process id="p1" isExecutable="true">
    <startEvent id="start"><outgoing>f1</outgoing></startEvent>
    <serviceTask id="task"><incoming>f1</incoming><outgoing>f2</outgoing></serviceTask>
    <endEvent id="end"><incoming>f2</incoming></endEvent>
    <sequenceFlow id="f1" sourceRef="start" targetRef="task"/>
    <sequenceFlow id="f2" sourceRef="task" targetRef="end"/>
  </process>
</definitions>'''

ZIP = {"Content-Type": "application/vnd.bim+zip"}


def _zip(files: dict[str, bytes], *, compression: int = zipfile.ZIP_STORED) -> bytes:
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=compression) as archive:
        for name, value in files.items():
            archive.writestr(name, value)
    return result.getvalue()


def _package_with_bpmn(xml: bytes) -> bytes:
    application = {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": "application"},
        "spec": {
            "tasks": {"task": "service/test"},
            "features": {},
            "workflow": {"bpmn": {"resource": "workflow", "id": "p1"}},
        },
    }
    candidates = {
        "apiVersion": "qos-binding/v1",
        "kind": "CandidateCatalog",
        "metadata": {"name": "catalog"},
        "spec": {
            "featureBindings": {},
            "candidates": {"candidate": {"provides": "service/test", "features": {}}},
        },
    }
    optimization = {
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "metadata": {"name": "optimization"},
        "spec": {"criteria": []},
    }
    root = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "bpmn-conformance"},
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {"application": "application.json", "workflow": "workflow.bpmn"},
                "candidateCatalog": {"catalog": "candidates.json"},
                "optimization": {"optimization": "optimization.json"},
            },
        },
    }
    return InstancePackage(
        {
            "instance.json": json.dumps(root).encode(),
            "application.json": json.dumps(application).encode(),
            "candidates.json": json.dumps(candidates).encode(),
            "optimization.json": json.dumps(optimization).encode(),
            "workflow.bpmn": xml,
        }
    ).to_zip()


@pytest.fixture(params=["validate", "upload"])
async def entry(request, api_client, registration, db_session, gate):  # noqa: F811
    """Both ways a package reaches the toolchain: the stateless validation and the problem upload."""
    if request.param == "validate":
        return request.param, "/v1/bim/validate", ZIP
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)
    return request.param, f"/v1/organizations/{org}/problems", {**headers, **ZIP}


async def _post(api_client, entry, archive: bytes):
    _, url, headers = entry
    return await api_client.post(url, content=archive, headers=headers)


@pytest.mark.asyncio
async def test_an_archive_that_is_not_a_zip_is_a_422(api_client, entry) -> None:
    response = await _post(api_client, entry, b"not a zip archive")

    assert response.status_code == 422, response.text
    assert "invalid ZIP archive" in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["/instance.json", "../instance.json", "folder//instance.json", "C:/instance.json"])
async def test_a_non_portable_path_is_a_422(api_client, entry, name: str) -> None:
    response = await _post(api_client, entry, _zip({name: b"{}"}))

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_a_compression_bomb_is_refused_before_its_resources_are_parsed(api_client, entry) -> None:
    response = await _post(api_client, entry, _zip({"instance.json": b"0" * 100_000}, compression=zipfile.ZIP_DEFLATED))

    assert response.status_code == 422, response.text
    assert "compression ratio" in response.text


@pytest.mark.asyncio
async def test_a_case_folding_collision_is_a_422(api_client, entry) -> None:
    response = await _post(api_client, entry, _zip({"instance.json": json.dumps(ROOT).encode(), "A.json": b"{}", "a.json": b"{}"}))

    assert response.status_code == 422, response.text
    assert "duplicate package path" in response.text


@pytest.mark.asyncio
async def test_bpmn_that_the_official_schema_rejects_is_refused_as_an_invalid_instance(api_client, entry) -> None:
    accepted = await _post(api_client, entry, _package_with_bpmn(BPMN))
    assert accepted.status_code in (200, 201), accepted.text

    invalid = BPMN.replace(b'targetNamespace="https://example.test/bpmn"', b"")
    refused = await _post(api_client, entry, _package_with_bpmn(invalid))
    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "invalid_instance"
    assert "OMG BPMN 2.0.2" in refused.text


@pytest.mark.asyncio
async def test_an_upload_above_the_compressed_limit_of_the_toolchain_is_a_413(api_client, entry, monkeypatch) -> None:
    monkeypatch.setattr(bim_routes, "max_compressed", lambda caller: 10)
    monkeypatch.setattr(problem_routes, "_upload_limit", lambda: 10)

    response = await _post(api_client, entry, b"x" * 11)

    assert response.status_code == 413, response.text


def test_the_package_limits_of_the_process_are_the_former_environment_variables(monkeypatch) -> None:
    monkeypatch.setenv("BIM_MAX_ENTRIES", "1")
    bim.set_bim(None)
    entries = {"instance.json": json.dumps(ROOT).encode(), "extra.json": b"{}"}

    assert bim.package_limits()["max_entries"] == 1
    with pytest.raises(PackageError, match="more than 1 entries"):
        bim.get_bim().compile(_zip(entries))

"""What the gateway does with an upload the BIM toolchain refuses, and with the limits it applies.

The rules themselves (paths, ZIP limits, XML security, canonical form, digests) belong to ``bim-core`` and
are tested there (``packages/bim-core/tests/test_package_security.py``).  What the platform adds, and
what is tested here, is that every refusal reaches the caller as a 422 problem, that the multipart
upload is read as one bounded file part, and that the limits of the toolchain in use (``BIM_MAX_*`` in
process, the service's own over HTTP) are the ones that apply.
"""

import io
import json
import zipfile

import pytest

from openbinding_gateway.integrations import bim
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.routes.v1 import _multipart_zip
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


async def _validate(api_client, archive: bytes):
    return await api_client.post("/v1/instances/validate", content=archive, headers=ZIP)


@pytest.mark.asyncio
async def test_an_archive_that_is_not_a_zip_is_a_422(api_client) -> None:
    response = await _validate(api_client, b"not a zip archive")

    assert response.status_code == 422, response.text
    assert "invalid ZIP archive" in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["/instance.json", "../instance.json", "folder//instance.json", "C:/instance.json"])
async def test_a_non_portable_path_is_a_422(api_client, name: str) -> None:
    response = await _validate(api_client, _zip({name: b"{}"}))

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_a_compression_bomb_is_refused_before_its_resources_are_parsed(api_client) -> None:
    response = await _validate(api_client, _zip({"instance.json": b"0" * 100_000}, compression=zipfile.ZIP_DEFLATED))

    assert response.status_code == 422, response.text
    assert "compression ratio" in response.text


@pytest.mark.asyncio
async def test_a_case_folding_collision_is_a_422(api_client) -> None:
    response = await _validate(api_client, _zip({"instance.json": json.dumps(ROOT).encode(), "A.json": b"{}", "a.json": b"{}"}))

    assert response.status_code == 422, response.text
    assert "duplicate package path" in response.text


@pytest.mark.asyncio
async def test_bpmn_that_the_official_schema_rejects_is_refused_as_an_invalid_instance(api_client) -> None:
    accepted = await _validate(api_client, _package_with_bpmn(BPMN))
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["valid"] is True

    invalid = BPMN.replace(b'targetNamespace="https://example.test/bpmn"', b"")
    refused = await _validate(api_client, _package_with_bpmn(invalid))
    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "invalid_instance"
    assert "OMG BPMN 2.0.2" in refused.text


@pytest.mark.asyncio
async def test_an_upload_above_the_compressed_limit_of_the_toolchain_is_a_413(api_client, monkeypatch) -> None:
    monkeypatch.setattr(routes, "_max_compressed", lambda: 10)

    response = await _validate(api_client, b"x" * 11)

    assert response.status_code == 413, response.text


def test_the_package_limits_of_the_process_are_the_former_environment_variables(monkeypatch) -> None:
    monkeypatch.setenv("BIM_MAX_ENTRIES", "1")
    bim.set_bim(None)
    entries = {"instance.json": json.dumps(ROOT).encode(), "extra.json": b"{}"}

    assert bim.package_limits()["max_entries"] == 1
    with pytest.raises(PackageError, match="more than 1 entries"):
        bim.get_bim().compile(_zip(entries))


def test_multipart_parser_preserves_zip_bytes_and_requires_one_file() -> None:
    archive = _zip({"instance.json": json.dumps(ROOT).encode()})
    boundary = "bim-boundary"

    def part(name: str) -> bytes:
        return (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"package\"; filename=\"{name}\"\r\n"
            "Content-Type: application/vnd.bim+zip\r\n\r\n"
        ).encode() + archive + b"\r\n"

    body = part("instance.bim.zip") + f"--{boundary}--\r\n".encode()
    assert _multipart_zip(body, f"multipart/form-data; boundary={boundary}") == archive
    duplicate = part("one.bim.zip") + part("two.bim.zip") + f"--{boundary}--\r\n".encode()
    with pytest.raises(PackageError, match="exactly one"):
        _multipart_zip(duplicate, f"multipart/form-data; boundary={boundary}")

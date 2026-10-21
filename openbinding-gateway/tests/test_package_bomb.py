"""ZIP bombs against the instance routes: a controlled 4xx in bounded time, never an inflated stream.

Two places read an upload: the platform reads ``instance.json`` before the toolchain has judged the archive
(``integrations.packages.instance_document``), and the toolchain then loads the whole package. Neither may
trust the sizes or the compression method an archive declares. The rules themselves belong to ``bim-core``
(``packages/bim-core/tests/test_package_bomb.py``); this is what reaches the caller.
"""

import io
import json
import struct
import time
import tracemalloc
import zipfile

import pytest

from openbinding_gateway.integrations import packages

ZIP = {"Content-Type": "application/vnd.bim+zip"}

ROOT = {
    "apiVersion": "bim/v1",
    "kind": "Instance",
    "metadata": {"name": "test"},
    "spec": {"profile": "qos-binding/v1", "resources": {}},
}
INSTANCE = json.dumps(ROOT).encode()

#: Offset of the uncompressed size in a central-directory header.
SIZE = 24
#: A refusal must not depend on inflating anything: generous for a loaded machine, hopeless for an inflation.
BUDGET_SECONDS = 20


def _zip(files: dict[str, bytes], *, compression: int = zipfile.ZIP_STORED) -> bytes:
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=compression) as archive:
        for name, value in files.items():
            archive.writestr(name, value)
    return result.getvalue()


def _declare_size(archive: bytes, size: int) -> bytes:
    """The same archive with a central directory that claims ``size`` bytes for its entries."""
    data = bytearray(archive)
    position = data.find(b"PK\x01\x02")
    while position >= 0:
        struct.pack_into("<I", data, position + SIZE, size)
        position = data.find(b"PK\x01\x02", position + 4)
    return bytes(data)


def _bomb(compression: int, *, declared: int | None, size: int = 48 * 1024 * 1024) -> bytes:
    archive = _zip({"instance.json": b"0" * size}, compression=compression)
    return archive if declared is None else _declare_size(archive, declared)


async def _validate(api_client, archive: bytes):
    started = time.monotonic()
    response = await api_client.post("/v1/instances/validate", content=archive, headers=ZIP)
    assert time.monotonic() - started < BUDGET_SECONDS
    return response


@pytest.mark.asyncio
async def test_a_deflate_bomb_with_an_honest_header_is_a_422(api_client) -> None:
    response = await _validate(api_client, _bomb(zipfile.ZIP_DEFLATED, declared=None, size=8 * 1024 * 1024))

    assert response.status_code == 422, response.text
    assert "compression ratio" in response.text


@pytest.mark.asyncio
async def test_a_deflate_bomb_declaring_a_small_size_is_a_422(api_client) -> None:
    response = await _validate(api_client, _bomb(zipfile.ZIP_DEFLATED, declared=64))

    assert response.status_code == 422, response.text
    assert "could not read package entry" in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("method", [zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA])
@pytest.mark.parametrize("declared", [None, 64])
async def test_bzip2_and_lzma_entries_are_a_422(api_client, method: int, declared) -> None:
    response = await _validate(api_client, _bomb(method, declared=declared, size=16 * 1024 * 1024))

    assert response.status_code == 422, response.text
    assert "compression method" in response.text or "compression ratio" in response.text


def test_instance_document_does_not_inflate_a_stream_that_outgrows_its_header() -> None:
    bomb = _bomb(zipfile.ZIP_DEFLATED, declared=len(INSTANCE))
    tracemalloc.start()
    try:
        assert packages.instance_document(bomb) is None
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert peak < 8 * 1024 * 1024, f"read {peak} bytes of a bomb"


@pytest.mark.parametrize("method", [zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA])
def test_instance_document_reads_only_stored_and_deflated_entries(method: int) -> None:
    assert packages.instance_document(_zip({"instance.json": INSTANCE}, compression=method)) is None
    bomb = _bomb(method, declared=64, size=16 * 1024 * 1024)
    tracemalloc.start()
    try:
        assert packages.instance_document(bomb) is None
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 8 * 1024 * 1024


def test_instance_document_applies_the_compression_ratio_of_the_toolchain() -> None:
    padded = json.dumps({**ROOT, "padding": " " * 2_000_000}).encode()
    assert packages.instance_document(_zip({"instance.json": padded}, compression=zipfile.ZIP_DEFLATED)) is None
    assert packages.instance_document(_zip({"instance.json": padded})) is not None


@pytest.mark.parametrize("compression", [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED])
def test_instance_document_still_reads_a_valid_package(compression: int) -> None:
    document = packages.instance_document(
        _zip({"instance.json": json.dumps(ROOT, indent=2).encode(), "other.json": b"{}"}, compression=compression)
    )

    assert document == ROOT


def test_instance_document_gives_up_quietly_on_anything_else() -> None:
    assert packages.instance_document(b"not a zip") is None
    assert packages.instance_document(_zip({"other.json": b"{}"})) is None
    assert packages.instance_document(_zip({"instance.json": b"[1]"})) is None
    assert packages.instance_document(_zip({"instance.json": b"{"})) is None
    assert packages.instance_document(_declare_size(_zip({"instance.json": INSTANCE}), len(INSTANCE) + 5)) is None

"""ZIP bombs: the reader trusts neither the declared sizes nor the compression method of an entry.

Only STORED and DEFLATED entries are read, an entry is read in bounded chunks, and the read stops as soon
as it yields more than the entry may hold, whatever its header claims.
"""

from __future__ import annotations

import io
import json
import struct
import time
import tracemalloc
import zipfile

import pytest

from bim_core import Limits, PackageError, load_package

from _minimal import ROOT, make_zip

CENTRAL = b"PK\x01\x02"
#: Offsets in a central-directory header.
METHOD, COMPRESSED_SIZE, SIZE = 10, 20, 24
INSTANCE = json.dumps(ROOT).encode()


def _patch_central(archive: bytes, field: int, fmt: str, value: int) -> bytes:
    """Overwrite ``field`` of every central-directory header of ``archive`` (a lying header)."""
    data = bytearray(archive)
    position = data.find(CENTRAL)
    while position >= 0:
        struct.pack_into(fmt, data, position + field, value)
        position = data.find(CENTRAL, position + 4)
    return bytes(data)


def _deflated(size: int, *, name: str = "instance.json") -> bytes:
    return make_zip({name: b"0" * size}, compression=zipfile.ZIP_DEFLATED)


def test_a_header_that_declares_a_small_size_cannot_make_the_reader_inflate_the_stream() -> None:
    bomb = _patch_central(_deflated(48 * 1024 * 1024), SIZE, "<I", 64)
    tracemalloc.start()
    try:
        started = time.monotonic()
        with pytest.raises(PackageError):
            load_package(bomb)
        elapsed = time.monotonic() - started
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 8 * 1024 * 1024, f"the reader held {peak} bytes while refusing the entry"
    assert elapsed < 5


def test_a_header_that_declares_a_larger_size_is_refused() -> None:
    lying = _patch_central(make_zip({"instance.json": INSTANCE}), SIZE, "<I", len(INSTANCE) + 10)
    with pytest.raises(PackageError):
        load_package(lying)


def test_a_stored_entry_with_a_smaller_declared_size_is_refused() -> None:
    lying = _patch_central(make_zip({"instance.json": INSTANCE}), SIZE, "<I", len(INSTANCE) - 5)
    with pytest.raises(PackageError):
        load_package(lying)


@pytest.mark.parametrize("method", [zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA])
def test_only_stored_and_deflated_entries_are_read(method: int) -> None:
    with pytest.raises(PackageError, match="compression method"):
        load_package(make_zip({"instance.json": INSTANCE}, compression=method))


@pytest.mark.parametrize("method", [zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA])
def test_a_bomb_in_a_refused_method_is_refused_before_it_is_inflated(method: int) -> None:
    bomb = _patch_central(
        make_zip({"instance.json": b"0" * (32 * 1024 * 1024)}, compression=method), SIZE, "<I", 64
    )
    tracemalloc.start()
    try:
        with pytest.raises(PackageError):
            load_package(bomb)
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 8 * 1024 * 1024


def test_an_unknown_compression_method_is_a_package_error() -> None:
    lying = _patch_central(make_zip({"instance.json": INSTANCE}), METHOD, "<H", 99)
    with pytest.raises(PackageError, match="compression method"):
        load_package(lying)


def test_an_honest_extreme_ratio_is_refused() -> None:
    with pytest.raises(PackageError, match="compression ratio"):
        load_package(_deflated(10 * 1024 * 1024))


def test_the_ratio_limit_is_configurable() -> None:
    archive = _deflated(100_000)
    with pytest.raises(PackageError, match="compression ratio"):
        load_package(archive)
    assert load_package(archive, limits=Limits(max_compression_ratio=10_000)).files["instance.json"] == b"0" * 100_000


def test_the_entry_limit_bounds_a_deflated_entry_before_it_is_inflated() -> None:
    with pytest.raises(PackageError, match="package entry exceeds 1000 bytes"):
        load_package(_deflated(1_000_000), limits=Limits(max_entry_bytes=1000))


def test_the_expanded_limit_applies_across_entries() -> None:
    archive = make_zip({"instance.json": INSTANCE, "a.json": b" " * 5000, "b.json": b" " * 5000})
    with pytest.raises(PackageError, match="expanded package exceeds 6000 bytes"):
        load_package(archive, limits=Limits(max_expanded_bytes=6000))


def test_a_corrupt_deflate_stream_is_a_package_error() -> None:
    data = bytearray(make_zip({"instance.json": INSTANCE * 20}, compression=zipfile.ZIP_DEFLATED))
    start = data.index(b"PK\x03\x04")
    name_length, extra_length = struct.unpack_from("<HH", data, start + 26)
    body = start + 30 + name_length + extra_length
    data[body + 2 : body + 8] = b"\xff" * 6
    with pytest.raises(PackageError, match="could not read"):
        load_package(bytes(data))


@pytest.mark.parametrize("compression", [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED])
def test_valid_packages_load_unchanged(compression: int) -> None:
    large = json.dumps({"values": list(range(60_000))}).encode()  # several read chunks
    files = {
        "instance.json": INSTANCE,
        "empty.bin": b"",
        "large.json": large,
        "nested/dir/data.bin": bytes(range(256)) * 10,
    }
    package = load_package(make_zip(files, compression=compression))
    assert set(package.files) == set(files)
    assert package.files["large.json"] == large
    assert package.files["empty.bin"] == b""
    assert package.files["nested/dir/data.bin"] == files["nested/dir/data.bin"]
    assert package.files["instance.json"] == INSTANCE


def test_the_bounded_reader_stops_at_the_limit() -> None:
    from bim_core.package import _read_bounded

    source = io.BytesIO(b"x" * 1_000_000)
    with pytest.raises(PackageError, match="exceeds its declared size"):
        _read_bounded(source, 10, "entry.json")
    assert source.tell() <= 64 * 1024 + 1
    assert _read_bounded(io.BytesIO(b"abc"), 3, "entry.json") == b"abc"
    assert _read_bounded(io.BytesIO(b""), 0, "entry.json") == b""

"""``Limits`` at their boundary: a package exactly at a limit loads, one unit beyond is refused, and the work
done for either is bounded (memory with ``tracemalloc``, time with a generous budget).

Nothing here is a load test: the largest package is a few MiB and every case runs in well under a second.  The
limits are lowered where a smaller package says the same thing.  ``test_package_bomb.py`` covers lying headers.
"""

from __future__ import annotations

import io
import json
import math
import time
import tracemalloc
import zipfile
from pathlib import Path
from typing import Any, Callable

import pytest

from bim_core import InstancePackage, Limits, PackageError, load_package

from _minimal import ROOT, make_zip

INSTANCE = json.dumps(ROOT).encode()
KIB = 1024
MIB = 1024 * KIB
#: Generous for a loaded machine, hopeless for a reader that inflates or copies without bound.
BUDGET_SECONDS = 10


def blob(size: int) -> bytes:
    """``size`` bytes that do not compress to nothing."""
    return (bytes(range(256)) * (size // 256 + 1))[:size]


def as_zip(files: dict[str, bytes], _tmp: Path, limits: Limits) -> InstancePackage:
    return load_package(make_zip(files), limits=limits)


def as_directory(files: dict[str, bytes], tmp: Path, limits: Limits) -> InstancePackage:
    root = tmp / "package"
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return load_package(root, limits=limits)


def as_files(files: dict[str, bytes], _tmp: Path, limits: Limits) -> InstancePackage:
    return InstancePackage(files, limits)


LOADERS: dict[str, Callable[[dict[str, bytes], Path, Limits], InstancePackage]] = {
    "zip": as_zip,
    "directory": as_directory,
    "files": as_files,
}


@pytest.fixture(params=sorted(LOADERS))
def load(request, tmp_path: Path) -> Callable[[dict[str, bytes], Limits], InstancePackage]:
    loader = LOADERS[request.param]
    return lambda files, limits: loader(files, tmp_path, limits)


# --- exactly at the limit loads, one more is refused ---------------------------------------------------------------------


def test_an_entry_of_exactly_max_entry_bytes_loads_and_one_byte_more_is_refused(load) -> None:
    limits = Limits(max_entry_bytes=64 * KIB)
    assert len(load({"instance.json": INSTANCE, "data.bin": blob(64 * KIB)}, limits).files["data.bin"]) == 64 * KIB
    with pytest.raises(PackageError, match="package entry exceeds 65536 bytes"):
        load({"instance.json": INSTANCE, "data.bin": blob(64 * KIB + 1)}, limits)


def test_a_package_of_exactly_max_expanded_bytes_loads_and_one_byte_more_is_refused(load) -> None:
    budget = 100 * KIB
    limits = Limits(max_expanded_bytes=budget)
    rest = budget - len(INSTANCE)
    files = {"instance.json": INSTANCE, "a.bin": blob(rest // 2), "b.bin": blob(rest - rest // 2)}
    assert sum(len(content) for content in load(files, limits).files.values()) == budget
    with pytest.raises(PackageError, match="exceeds 102400 bytes"):
        load({**files, "b.bin": files["b.bin"] + b"x"}, limits)


def test_max_entries_files_load_and_one_more_is_refused(load) -> None:
    limits = Limits(max_entries=5)
    files = {"instance.json": INSTANCE, **{f"f{index}.bin": b"x" for index in range(4)}}
    assert len(load(files, limits).files) == 5
    with pytest.raises(PackageError, match="more than 5 entries"):
        load({**files, "f4.bin": b"x"}, limits)


def test_a_path_of_exactly_max_path_depth_loads_and_one_level_more_is_refused(load) -> None:
    limits = Limits(max_path_depth=3)
    assert "a/b/c.bin" in load({"instance.json": INSTANCE, "a/b/c.bin": b"x"}, limits).files
    with pytest.raises(PackageError, match="exceeds depth 3"):
        load({"instance.json": INSTANCE, "a/b/c/d.bin": b"x"}, limits)


def test_an_archive_of_exactly_max_compressed_bytes_loads_and_one_byte_less_is_refused() -> None:
    archive = make_zip({"instance.json": INSTANCE, "data.bin": blob(10 * KIB)})
    assert "data.bin" in load_package(archive, limits=Limits(max_compressed_bytes=len(archive))).files
    with pytest.raises(PackageError, match=f"compressed package exceeds {len(archive) - 1} bytes"):
        load_package(archive, limits=Limits(max_compressed_bytes=len(archive) - 1))


def test_the_compression_ratio_limit_is_inclusive() -> None:
    archive = make_zip({"instance.json": INSTANCE, "zeros.bin": b"\0" * 50_000}, compression=zipfile.ZIP_DEFLATED)
    with zipfile.ZipFile(io.BytesIO(archive)) as handle:
        ratio = max(info.file_size / info.compress_size for info in handle.infolist() if info.compress_size)
    assert ratio > 2
    assert "zeros.bin" in load_package(archive, limits=Limits(max_compression_ratio=math.ceil(ratio))).files
    with pytest.raises(PackageError, match="compression ratio"):
        load_package(archive, limits=Limits(max_compression_ratio=math.ceil(ratio) - 1))


# --- a package near the limit costs bounded memory and time --------------------------------------------------------------


def measure(call: Callable[[], Any]) -> tuple[Any, int, float]:
    tracemalloc.start()
    try:
        started = time.monotonic()
        result = call()
        elapsed = time.monotonic() - started
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    return result, peak, elapsed


def test_a_zip_entry_at_the_limit_is_loaded_with_bounded_memory_and_time() -> None:
    size = 4 * MIB
    limits = Limits(max_entry_bytes=size, max_expanded_bytes=2 * size)
    archive = make_zip({"instance.json": INSTANCE, "data.bin": blob(size)})
    package, peak, elapsed = measure(lambda: load_package(archive, limits=limits))
    assert len(package.files["data.bin"]) == size
    # The entry is held once while it is read and once in the result; nothing proportional to anything else.
    assert peak < 4 * size, f"loading a {size}-byte entry held {peak} bytes"
    assert elapsed < BUDGET_SECONDS


def test_a_zip_entry_one_byte_over_the_limit_is_refused_before_it_is_read() -> None:
    size = 4 * MIB
    limits = Limits(max_entry_bytes=size, max_expanded_bytes=2 * size)
    archive = make_zip({"instance.json": INSTANCE, "data.bin": blob(size + 1)})

    def refuse() -> None:
        with pytest.raises(PackageError, match="package entry exceeds"):
            load_package(archive, limits=limits)

    _, peak, elapsed = measure(refuse)
    assert peak < MIB, f"refusing the entry held {peak} bytes"
    assert elapsed < BUDGET_SECONDS


def test_a_directory_entry_one_byte_over_the_limit_is_refused_before_it_is_read(tmp_path: Path) -> None:
    size = 4 * MIB
    root = tmp_path / "package"
    root.mkdir()
    (root / "instance.json").write_bytes(INSTANCE)
    (root / "data.bin").write_bytes(blob(size + 1))
    limits = Limits(max_entry_bytes=size, max_expanded_bytes=2 * size)

    def refuse() -> None:
        with pytest.raises(PackageError, match="package entry exceeds"):
            load_package(root, limits=limits)

    _, peak, elapsed = measure(refuse)
    assert peak < MIB, f"refusing the entry held {peak} bytes"
    assert elapsed < BUDGET_SECONDS


def test_a_package_at_max_expanded_bytes_builds_its_canonical_archive_with_bounded_memory_and_time() -> None:
    size = 2 * MIB
    limits = Limits(max_entry_bytes=size, max_expanded_bytes=2 * size + len(INSTANCE))
    package = load_package(make_zip({"instance.json": INSTANCE, "a.bin": blob(size), "b.bin": blob(size)}), limits=limits)
    archive, peak, elapsed = measure(package.to_zip)
    assert len(archive) > 2 * size
    assert load_package(archive, limits=limits).package_digest == package.package_digest
    # The archive is built in memory and copied once by getvalue(): a small multiple of the package, not more.
    assert peak < 8 * size, f"to_zip held {peak} bytes for a {2 * size}-byte package"
    assert elapsed < BUDGET_SECONDS

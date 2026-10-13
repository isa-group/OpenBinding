"""Directory, raw ZIP and canonical ZIP of the 82 corpus packages, measured by ``bim_core`` alone.

The same comparison as ``openbinding-gateway/tests/test_bim_zip_dir_equivalence.py`` (another owner; see
``docs/qa/BIM_EQUIVALENCE.md``), kept here so the behaviour of ``bim_core`` is pinned by its own tests.  Nothing in
``bim_core/src``, the goldens or any digest is changed by this module.

* directory: ``load_package(directory)``.
* raw ZIP: the files of the loaded package in a STORED archive sorted by path, as ``zip_directory`` of the gateway
  builds it.  Must equal the directory in ``irDigest``, ``packageDigest``, canonical IR and list order (82/82).
* canonical ZIP: ``InstancePackage.to_zip()`` (JSON members sorted).  The 64 packages in
  ``data/zip_divergent_packages.json`` differ, because the compiler builds eligibility, constraints and placement
  by iterating objects in document order: strict ``xfail``.  The other 18 must be equal.
* gate: the set of packages that differ is exactly the one in the data file.  If the compiler changes and the
  list changes, the test fails; it does not fix itself.  ``BIM_WRITE_DIVERGENT=1`` rewrites the file from the
  measurement (review and commit the result).

The corpus is looked up as in the other tests (``BIM_CORPUS_ROOT``): the tests skip with the reason when it is
absent and fail with ``BIM_REQUIRE_CORPUS=1``.
"""

from __future__ import annotations

import io
import json
import os
import zipfile
from pathlib import Path
from typing import Any

import pytest
from bim_core import canonical_json, compile_instance, digest, load_package
from core_support import GOLDEN_DIR, corpus_root, require_corpus_path

DATA_FILE = Path(__file__).resolve().parent / "data" / "zip_divergent_packages.json"
PATHS = sorted(json.loads((GOLDEN_DIR / "corpus.json").read_text(encoding="utf-8"))["packages"])
DIVERGENT = frozenset(json.loads(DATA_FILE.read_text(encoding="utf-8"))["packages"])
EXPECTED_PACKAGES = 82
EXPECTED_DIVERGENT = 64
NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})
METRICS = ("semantic", "ir", "irDigest", "packageDigest", "eligibility")

CAUSE = (
    "to_zip() writes JSON with sorted object members and the compiler builds eligibility, constraints and placement "
    "by iterating objects in document order, so the canonical ZIP has another IR (irDigest, semantic digest); a "
    "canonical order would move the goldens, so it is not applied (docs/qa/BIM_EQUIVALENCE.md)"
)


def stored_zip(files: dict[str, bytes]) -> bytes:
    """A deterministic STORED archive, entries sorted by path (the form ``zip_directory`` of the gateway writes)."""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in sorted(files, key=lambda value: value.encode("utf-8")):
            info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, files[path])
    return output.getvalue()


def normalized(package: Any) -> dict[str, Any]:
    """What the toolchain says about ``package``: semantic digest, canonical IR, digests and eligibility order.

    Copy of ``observe()`` in ``openbinding-gateway/tests/test_bim_zip_dir_equivalence.py`` (the gateway test has no
    ``normalized``): the semantic digest is the digest of ``spec`` without the non-semantic sections.
    """
    problem = compile_instance(package)
    document = problem.document
    return {
        "semantic": digest({key: value for key, value in document["spec"].items() if key not in NON_SEMANTIC}),
        "ir": canonical_json(document),
        "irDigest": problem.digest,
        "packageDigest": package.package_digest,
        "eligibility": document["spec"]["eligibility"],
    }


def differing(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    return [metric for metric in METRICS if left[metric] != right[metric]]


_CACHE: dict[str, dict[str, list[str]]] = {}


def compare(relative: str) -> dict[str, list[str]]:
    """Metrics in which the raw and the canonical ZIP of ``relative`` differ from its directory (cached)."""
    if relative not in _CACHE:
        package = load_package(require_corpus_path(relative))
        reference = normalized(package)
        _CACHE[relative] = {
            "raw": differing(reference, normalized(load_package(stored_zip(package.files)))),
            "canonical": differing(reference, normalized(load_package(package.to_zip()))),
        }
    return _CACHE[relative]


def test_the_corpus_is_the_82_packages_of_the_baseline() -> None:
    assert len(PATHS) == EXPECTED_PACKAGES
    assert DIVERGENT <= set(PATHS) and len(DIVERGENT) == EXPECTED_DIVERGENT


def test_the_discovered_packages_are_the_keys_of_corpus_json(baseline_tool) -> None:
    require_corpus_path(PATHS[0])
    root = corpus_root()
    discovered = [directory.relative_to(root).as_posix() for directory in baseline_tool.package_directories(root)]
    assert discovered == PATHS


@pytest.mark.parametrize("relative", PATHS)
def test_the_raw_zip_is_the_directory(relative: str) -> None:
    """irDigest, packageDigest, canonical IR, semantic digest and eligibility order are those of the directory."""
    assert compare(relative)["raw"] == []


@pytest.mark.parametrize(
    "relative",
    [
        pytest.param(
            relative,
            id=relative,
            marks=pytest.mark.xfail(strict=True, raises=AssertionError, reason=CAUSE) if relative in DIVERGENT else (),
        )
        for relative in PATHS
    ],
)
def test_the_canonical_zip_is_the_directory(relative: str) -> None:
    assert compare(relative)["canonical"] == []


def test_the_divergent_packages_are_exactly_the_recorded_ones() -> None:
    """Gate: a change of the compiler that changes the set must be reviewed, so the data file is not self-healing."""
    measured = sorted(relative for relative in PATHS if compare(relative)["canonical"])
    if os.environ.get("BIM_WRITE_DIVERGENT") == "1":
        document = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        document["packages"] = measured
        DATA_FILE.write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    recorded = sorted(DIVERGENT)
    assert measured == recorded, (
        f"{len(measured)} divergent, {len(recorded)} recorded; "
        f"new: {sorted(set(measured) - set(recorded))}; fixed: {sorted(set(recorded) - set(measured))}"
    )

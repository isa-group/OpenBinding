"""Semantic BIM baseline: what the extraction of BIM into its own repository must not change.

The goldens in `tests/golden/bim_baseline` were written by the platform's own `tools/bim_baseline.py`
before the language moved out (see docs/qa/BIM_BASELINE.md).  The toolchain computes the same documents
with `bim_core` alone (`bim-toolchain/tools/baseline_core.py`); this test runs that tool against the
platform's corpus and Engine manifests and compares the result with the goldens, which are not
regenerated.  `toolchain` fields (compilerDigest, irDigest) change with the bytes of the toolchain and
are never compared: only the semantic digest, the evaluations, the diagnostics, the Engine mode
compatibility, the re-evaluation vectors and the protocol and schema digests must stay.  The
comparison of all 82 packages is slow and runs only with `BIM_BASELINE_FULL=1`.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

from _repo import REPO_ROOT
from bim_core import compile_instance, load_package
from openbinding_gateway.integrations import packages
from openbinding_gateway.services.engines import MANIFEST_DIR

GOLDEN_DIR = Path(__file__).resolve().parent / "golden" / "bim_baseline"
GOLDEN_FILES = ("corpus.json", "negatives.json", "compat.json", "vectors.json", "protocol.json")
SAMPLE_SIZE = 10
SAMPLE_PER_ROOT = 4


@pytest.fixture(scope="module")
def tool():
    path = REPO_ROOT / "bim-toolchain" / "tools" / "baseline_core.py"
    if not path.is_file():
        pytest.skip("bim-toolchain/tools/baseline_core.py is not mounted in this environment")
    spec = importlib.util.spec_from_file_location("baseline_core", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["baseline_core"] = module
    spec.loader.exec_module(module)
    yield module
    sys.modules.pop("baseline_core", None)


@pytest.fixture(scope="module")
def manifests(tool):
    """The platform's own Engine catalog: the inputs of the compatibility and protocol goldens."""
    return tool.engine_manifests(MANIFEST_DIR)


def golden(name: str) -> dict:
    return json.loads((GOLDEN_DIR / name).read_text(encoding="utf-8"))


def small_packages(corpus: dict) -> list[str]:
    """The cheapest packages to recompile, spread over the roots of the corpus."""
    entries = sorted(
        (entry for entry in corpus["packages"].values() if entry["status"] == "compiled" and "bindingSpace" in entry),
        key=lambda entry: (entry["candidates"], int(entry["bindingSpace"]["cardinality"]), entry["path"]),
    )
    chosen: list[str] = []
    per_root: dict[str, int] = {}
    for entry in entries:
        root = entry["path"].split("/", 1)[0]
        if per_root.get(root, 0) < SAMPLE_PER_ROOT and len(chosen) < SAMPLE_SIZE:
            chosen.append(entry["path"])
            per_root[root] = per_root.get(root, 0) + 1
    chosen.extend(
        entry["path"] for entry in entries if entry["path"] not in chosen
    )
    return sorted(chosen[:SAMPLE_SIZE])


@pytest.fixture(scope="module")
def sample(tool, manifests):
    paths = small_packages(golden("corpus.json"))
    corpus, compat = tool.build_corpus_and_compat(
        [REPO_ROOT / path for path in paths], REPO_ROOT, jobs=1, manifests=manifests
    )
    return paths, corpus, compat


def test_every_golden_file_exists_and_is_in_the_canonical_byte_form(tool):
    for name in GOLDEN_FILES:
        data = (GOLDEN_DIR / name).read_bytes()
        assert tool.dump(json.loads(data)) == data, name


def test_the_goldens_cover_exactly_the_discovered_corpus(tool):
    corpus = golden("corpus.json")
    discovered = {directory.relative_to(REPO_ROOT).as_posix() for directory in tool.package_directories(REPO_ROOT)}

    assert set(corpus["packages"]) == discovered
    assert corpus["packageCount"] == len(discovered) == 82
    assert {entry["status"] for entry in corpus["packages"].values()} == {"compiled"}
    assert set(golden("compat.json")["packages"]) <= discovered
    assert (corpus["seed"], corpus["exhaustiveLimit"], corpus["sampleSize"]) == (
        tool.SEED, tool.EXHAUSTIVE_LIMIT, tool.SAMPLE_SIZE,
    )


def test_a_package_is_analyzed_exhaustively_and_deterministically(tool, manifests):
    demo = REPO_ROOT / "examples" / "demo" / "01_simple_seq"
    first, compat = tool.build_corpus_and_compat([demo], REPO_ROOT, manifests=manifests)
    second, _ = tool.build_corpus_and_compat([demo], REPO_ROOT, manifests=manifests)
    entry = first["packages"]["examples/demo/01_simple_seq"]

    assert tool.dump(first) == tool.dump(second)
    assert entry["status"] == "compiled"
    assert entry["tasks"] == {"total": 3, "service": 3}
    assert entry["bindingSpace"]["cardinality"] == "2"
    assert (entry["evaluation"]["mode"], entry["evaluation"]["count"]) == ("exhaustive", 2)
    assert entry["evaluation"]["summary"]["evaluated"] == 2
    assert entry["evaluation"]["summary"]["errors"] == {}
    assert set(compat["packages"]["examples/demo/01_simple_seq"]) == set(compat["engines"])
    assert entry["toolchain"]["irDigest"].startswith("sha256-")
    assert "toolchain" not in tool.comparable(entry)
    assert "toolchain" not in tool.comparable(first)


def test_a_space_above_the_limit_is_sampled_with_the_fixed_seed(tool, monkeypatch):
    monkeypatch.setattr(tool, "EXHAUSTIVE_LIMIT", 1)
    demo = REPO_ROOT / "examples" / "demo" / "01_simple_seq"
    first = tool.analyze_directory(demo, REPO_ROOT)["evaluation"]
    second = tool.analyze_directory(demo, REPO_ROOT)["evaluation"]

    assert first == second
    assert (first["mode"], first["count"], first["seed"]) == ("sample", tool.SAMPLE_SIZE, 20261012)
    assert len(first["bindingDigests"]) == tool.SAMPLE_SIZE


def test_the_sample_is_ten_packages_with_exhaustive_or_sampled_evaluations(sample):
    paths, corpus, _ = sample

    assert len(paths) == SAMPLE_SIZE
    assert {corpus["packages"][path]["evaluation"]["mode"] for path in paths} <= {"exhaustive", "sample"}


def test_sampled_packages_keep_their_semantic_digest_and_evaluations(tool, sample):
    paths, corpus, _ = sample
    expected = golden("corpus.json")

    mismatches = [
        path
        for path in paths
        if tool.comparable(corpus["packages"][path]) != tool.comparable(expected["packages"][path])
    ]
    assert mismatches == []


def zip_mismatches(tool, paths: list[str]) -> list[str]:
    """Packages whose semantic digest, compiled from the ZIP the platform builds, is not the golden's."""
    expected = golden("corpus.json")["packages"]
    return [
        path
        for path in paths
        if tool.semantic_digest(compile_instance(load_package(packages.zip_directory(REPO_ROOT / path))))
        != expected[path]["semanticDigest"]
    ]


def test_the_golden_by_directory_is_the_package_compiled_from_the_production_zip(tool, sample):
    """The goldens are generated from directories; the platform compiles ZIPs (``packages.zip_directory``).  For the
    sample they agree.  The canonical ZIP of ``to_zip()`` is another matter, see test_bim_zip_dir_equivalence.py."""
    paths, _, _ = sample
    assert zip_mismatches(tool, paths) == []


@pytest.mark.skipif(
    os.environ.get("BIM_BASELINE_FULL") != "1",
    reason="slow: recompiles all 82 packages from their ZIP; run with BIM_BASELINE_FULL=1",
)
def test_the_whole_corpus_compiled_from_the_production_zip_matches_the_directory_goldens(tool):
    paths = sorted(golden("corpus.json")["packages"])
    assert len(paths) == 82
    assert zip_mismatches(tool, paths) == []


def test_sampled_packages_keep_their_engine_mode_compatibility(tool, sample):
    paths, _, compat = sample
    expected = golden("compat.json")

    assert compat["engines"] == expected["engines"]
    assert len(expected["engines"]) == 4
    mismatches = [path for path in paths if compat["packages"].get(path) != expected["packages"].get(path)]
    assert mismatches == []


def test_negative_cases_keep_their_diagnostic_codes_and_locations(tool):
    assert tool.comparable(tool.build_negatives(REPO_ROOT)) == tool.comparable(golden("negatives.json"))


def test_reevaluation_vectors_keep_the_current_output(tool):
    assert tool.comparable(tool.build_vectors(REPO_ROOT)) == tool.comparable(golden("vectors.json"))


def test_protocol_and_schema_digests_are_unchanged(tool, manifests):
    assert tool.comparable(tool.build_protocol(manifests)) == tool.comparable(golden("protocol.json"))


def test_regenerating_negatives_and_vectors_gives_identical_bytes(tool):
    assert tool.dump(tool.build_negatives(REPO_ROOT)) == tool.dump(tool.build_negatives(REPO_ROOT))
    assert tool.dump(tool.build_vectors(REPO_ROOT)) == tool.dump(tool.build_vectors(REPO_ROOT))


@pytest.mark.skipif(
    os.environ.get("BIM_BASELINE_FULL") != "1",
    reason="slow: recompiles and re-evaluates all 82 packages; run with BIM_BASELINE_FULL=1",
)
def test_the_whole_corpus_matches_the_goldens(tool, manifests):
    corpus, compat = tool.build_corpus_and_compat(
        tool.package_directories(REPO_ROOT), REPO_ROOT, jobs=min(4, os.cpu_count() or 1), manifests=manifests
    )
    expected_corpus, expected_compat = golden("corpus.json"), golden("compat.json")

    assert sorted(corpus["packages"]) == sorted(expected_corpus["packages"])
    assert [
        path
        for path, entry in corpus["packages"].items()
        if tool.comparable(entry) != tool.comparable(expected_corpus["packages"][path])
    ] == []
    assert compat["engines"] == expected_compat["engines"]
    assert [path for path, found in compat["packages"].items() if found != expected_compat["packages"].get(path)] == []

"""Semantic equivalence of ``bim_core`` with the OpenBinding baseline (corpus and negative cases).

``tools/baseline_core.py`` recomputes the semantic digest and the canonical evaluations of every package of
the OpenBinding corpus, plus the negative cases, using only ``bim_core``; this module compares the result with
``golden/bim_baseline/{corpus,negatives}.json``.  ``toolchain`` fields (compilerDigest, irDigest) change with the
toolchain bytes on purpose and are never compared.

The corpus is not part of this directory.  It is looked up under ``BIM_CORPUS_ROOT`` (default: the directory that
contains ``bim-toolchain/``) and the tests that need it skip with a warning when it is absent.  All packages are
compared by default; ``BIM_BASELINE_SAMPLE_ONLY=1`` skips the full comparison and keeps the ten-package sample.
Engine compatibility, re-evaluation vectors and the protocol section of the baseline are covered by a later step.
"""

import json
import os
import warnings

import pytest

from conftest import CORPUS_MARKER, GOLDEN_DIR, corpus_root

GOLDEN_FILES = ("corpus.json", "negatives.json", "compat.json", "vectors.json", "protocol.json")
SAMPLE_SIZE = 10
SAMPLE_PER_ROOT = 4


@pytest.fixture(scope="module")
def root():
    path = corpus_root()
    if not (path / CORPUS_MARKER).is_file():
        message = f"BIM corpus not available at {path} (set BIM_CORPUS_ROOT): baseline equivalence not checked"
        warnings.warn(message, stacklevel=2)
        pytest.skip(message)
    return path


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
        top = entry["path"].split("/", 1)[0]
        if per_root.get(top, 0) < SAMPLE_PER_ROOT and len(chosen) < SAMPLE_SIZE:
            chosen.append(entry["path"])
            per_root[top] = per_root.get(top, 0) + 1
    chosen.extend(entry["path"] for entry in entries if entry["path"] not in chosen)
    return sorted(chosen[:SAMPLE_SIZE])


def test_every_golden_file_exists_and_is_in_the_canonical_byte_form(baseline_tool) -> None:
    for name in GOLDEN_FILES:
        data = (GOLDEN_DIR / name).read_bytes()
        assert baseline_tool.dump(json.loads(data)) == data, name


def test_the_goldens_are_the_ones_recorded_in_openbinding(root) -> None:
    original = root / "openbinding-gateway" / "tests" / "golden" / "bim_baseline"
    if not original.is_dir():
        pytest.skip(f"{original} is not available")
    for name in GOLDEN_FILES:
        assert (original / name).read_bytes() == (GOLDEN_DIR / name).read_bytes(), name


def test_the_goldens_cover_exactly_the_discovered_corpus(baseline_tool, root) -> None:
    corpus = golden("corpus.json")
    discovered = {
        directory.relative_to(root).as_posix() for directory in baseline_tool.package_directories(root)
    }

    assert set(corpus["packages"]) == discovered
    assert corpus["packageCount"] == len(discovered) == 82
    assert {entry["status"] for entry in corpus["packages"].values()} == {"compiled"}
    assert (corpus["seed"], corpus["exhaustiveLimit"], corpus["sampleSize"]) == (
        baseline_tool.SEED, baseline_tool.EXHAUSTIVE_LIMIT, baseline_tool.SAMPLE_SIZE,
    )


def test_a_package_is_analyzed_exhaustively_and_deterministically(baseline_tool, root) -> None:
    demo = root / "examples" / "demo" / "01_simple_seq"
    first = baseline_tool.build_corpus([demo], root)
    second = baseline_tool.build_corpus([demo], root)
    entry = first["packages"]["examples/demo/01_simple_seq"]

    assert baseline_tool.dump(first) == baseline_tool.dump(second)
    assert entry["status"] == "compiled"
    assert entry["tasks"] == {"total": 3, "service": 3}
    assert entry["bindingSpace"]["cardinality"] == "2"
    assert (entry["evaluation"]["mode"], entry["evaluation"]["count"]) == ("exhaustive", 2)
    assert entry["evaluation"]["summary"]["evaluated"] == 2
    assert entry["evaluation"]["summary"]["errors"] == {}
    assert entry["toolchain"]["irDigest"].startswith("sha256-")
    assert "toolchain" not in baseline_tool.comparable(entry)
    assert "toolchain" not in baseline_tool.comparable(first)


def test_a_space_above_the_limit_is_sampled_with_the_fixed_seed(baseline_tool, root, monkeypatch) -> None:
    monkeypatch.setattr(baseline_tool, "EXHAUSTIVE_LIMIT", 1)
    demo = root / "examples" / "demo" / "01_simple_seq"
    first = baseline_tool.analyze_directory(demo, root)["evaluation"]
    second = baseline_tool.analyze_directory(demo, root)["evaluation"]

    assert first == second
    assert (first["mode"], first["count"], first["seed"]) == ("sample", baseline_tool.SAMPLE_SIZE, 20261012)
    assert len(first["bindingDigests"]) == baseline_tool.SAMPLE_SIZE


def test_sampled_packages_keep_their_semantic_digest_and_evaluations(baseline_tool, root) -> None:
    expected = golden("corpus.json")
    paths = small_packages(expected)
    corpus = baseline_tool.build_corpus([root / path for path in paths], root)

    assert len(paths) == SAMPLE_SIZE
    assert {corpus["packages"][path]["evaluation"]["mode"] for path in paths} <= {"exhaustive", "sample"}
    mismatches = [
        path
        for path in paths
        if baseline_tool.comparable(corpus["packages"][path]) != baseline_tool.comparable(expected["packages"][path])
    ]
    assert mismatches == []


def test_negative_cases_keep_their_diagnostic_codes_and_locations(baseline_tool, root) -> None:
    found = baseline_tool.comparable(baseline_tool.build_negatives(root))
    expected = baseline_tool.comparable(golden("negatives.json"))

    assert sorted(found["cases"]) == sorted(expected["cases"])
    assert [name for name in expected["cases"] if found["cases"][name] != expected["cases"][name]] == []
    assert found == expected


def test_regenerating_the_negatives_gives_identical_bytes(baseline_tool, root) -> None:
    assert baseline_tool.dump(baseline_tool.build_negatives(root)) == baseline_tool.dump(
        baseline_tool.build_negatives(root)
    )


@pytest.mark.skipif(
    os.environ.get("BIM_BASELINE_SAMPLE_ONLY") == "1",
    reason="BIM_BASELINE_SAMPLE_ONLY=1: the full corpus comparison is skipped",
)
def test_the_whole_corpus_matches_the_goldens(baseline_tool, root) -> None:
    directories = baseline_tool.package_directories(root)
    corpus = baseline_tool.build_corpus(directories, root, jobs=min(4, os.cpu_count() or 1))
    expected = golden("corpus.json")

    assert sorted(corpus["packages"]) == sorted(expected["packages"])
    assert [
        path
        for path, entry in corpus["packages"].items()
        if baseline_tool.comparable(entry) != baseline_tool.comparable(expected["packages"][path])
    ] == []
    assert corpus["packageCount"] == expected["packageCount"] == 82

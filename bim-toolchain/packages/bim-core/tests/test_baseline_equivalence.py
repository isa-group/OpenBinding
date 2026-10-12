"""Semantic equivalence of ``bim_core`` with the OpenBinding baseline.

``tools/baseline_core.py`` recomputes, using only ``bim_core``, the semantic digest and the canonical evaluations
of every package of the OpenBinding corpus, the negative cases, the Engine mode compatibility of every package,
the re-evaluation and result-validation vectors and the protocol digests; this module compares the result with
``golden/bim_baseline/{corpus,negatives,compat,vectors,protocol}.json``.  ``toolchain`` fields (compilerDigest,
irDigest) change with the toolchain bytes on purpose and are never compared.

``compat.json`` and ``protocol.json`` of OpenBinding list the Engine ``meta-router-csp``, whose manifest is not in
the repository (only four manifests are).  They are compared with that Engine removed, and the four-Engine
documents are pinned in ``golden/bim_core`` (see ``docs/DIGESTS.md``).

The corpus is not part of this directory.  It is looked up under ``BIM_CORPUS_ROOT`` (default: the directory that
contains ``bim-toolchain/``) and the tests that need it skip with a warning when it is absent.  All packages are
compared by default; ``BIM_BASELINE_SAMPLE_ONLY=1`` skips the full comparison and keeps the ten-package sample.
"""

import json
import os
import warnings

import pytest

from conftest import (
    CORPUS_MARKER,
    GOLDEN_DIR,
    check_or_create_golden,
    corpus_root,
    engine_manifest_fixtures,
)

GOLDEN_FILES = ("corpus.json", "negatives.json", "compat.json", "vectors.json", "protocol.json")
CORE_GOLDEN_DIR = GOLDEN_DIR.parent / "bim_core"
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


def test_the_goldens_are_the_ones_recorded_in_openbinding(baseline_tool, root) -> None:
    original = root / "openbinding-gateway" / "tests" / "golden" / "bim_baseline"
    if not original.is_dir():
        pytest.skip(f"{original} is not available")
    for name in ("corpus.json", "negatives.json", "vectors.json"):
        assert (original / name).read_bytes() == (GOLDEN_DIR / name).read_bytes(), name
    # The copy in this directory still lists the Engine meta-router-csp; OpenBinding's current goldens do
    # not, and its manifest is not in the repository.  Apart from that Engine, whose entries are removed
    # from the copy, and from the toolchain fields, the two copies of compat.json and protocol.json are
    # the same document.
    for name in ("compat.json", "protocol.json"):
        mine = json.loads((GOLDEN_DIR / name).read_text(encoding="utf-8"))
        theirs = json.loads((original / name).read_text(encoding="utf-8"))
        if mine != theirs:
            assert baseline_tool.comparable(baseline_tool.without_engines(mine)) == baseline_tool.comparable(theirs), name


def test_the_bim_core_goldens_equal_the_current_openbinding_ones(baseline_tool, root) -> None:
    original = root / "openbinding-gateway" / "tests" / "golden" / "bim_baseline"
    if not original.is_dir() or not (CORE_GOLDEN_DIR / "compat.json").is_file():
        pytest.skip("the OpenBinding goldens or the bim_core goldens are not available")
    for name in ("compat.json", "protocol.json"):
        mine = json.loads((CORE_GOLDEN_DIR / name).read_text(encoding="utf-8"))
        theirs = json.loads((original / name).read_text(encoding="utf-8"))
        assert baseline_tool.comparable(mine) == baseline_tool.comparable(theirs), name


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


full_corpus_only = pytest.mark.skipif(
    os.environ.get("BIM_BASELINE_SAMPLE_ONLY") == "1",
    reason="BIM_BASELINE_SAMPLE_ONLY=1: the full corpus comparison is skipped",
)


@pytest.fixture(scope="module")
def everything(baseline_tool, root):
    """Every document of the tool, for the whole corpus, computed once."""
    directories = baseline_tool.package_directories(root)
    return baseline_tool.build_all(
        root, directories, jobs=min(4, os.cpu_count() or 1), manifests=engine_manifest_fixtures()
    )


@full_corpus_only
def test_the_whole_corpus_matches_the_goldens(baseline_tool, everything) -> None:
    corpus = everything["corpus.json"]
    expected = golden("corpus.json")

    assert sorted(corpus["packages"]) == sorted(expected["packages"])
    assert [
        path
        for path, entry in corpus["packages"].items()
        if baseline_tool.comparable(entry) != baseline_tool.comparable(expected["packages"][path])
    ] == []
    assert corpus["packageCount"] == expected["packageCount"] == 82


def test_reevaluation_and_validation_vectors_match_the_goldens(baseline_tool, root) -> None:
    found = baseline_tool.build_vectors(root)
    expected = golden("vectors.json")

    assert baseline_tool.differences("vectors", found, expected) == []
    assert baseline_tool.comparable(found) == baseline_tool.comparable(expected)
    assert [item["id"] for item in found["vectors"]] == [item["id"] for item in expected["vectors"]]
    assert len(found["vectors"]) == 10


def test_the_engine_contract_and_protocol_digest_match_the_goldens(baseline_tool) -> None:
    found = baseline_tool.build_protocol(engine_manifest_fixtures())
    expected = golden("protocol.json")

    assert found["protocolDigest"] == expected["protocolDigest"]
    assert found["engineContract"] == expected["engineContract"]
    assert found["schemas"] == expected["schemas"]
    assert found["vendor"] == expected["vendor"]
    assert baseline_tool.differences("protocol", found, baseline_tool.without_engines(expected)) == []


def test_the_only_difference_with_the_protocol_golden_is_the_missing_engine_manifest(baseline_tool) -> None:
    found = baseline_tool.build_protocol(engine_manifest_fixtures())
    expected = golden("protocol.json")

    assert set(expected["manifests"]) - set(found["manifests"]) == set(baseline_tool.MISSING_MANIFESTS)
    assert set(found["manifests"]) <= set(expected["manifests"])
    assert {name: found["manifests"][name] for name in found["manifests"]} == {
        name: expected["manifests"][name] for name in found["manifests"]
    }


@full_corpus_only
def test_engine_compatibility_matches_the_goldens(everything) -> None:
    found = everything["compat.json"]
    expected = golden("compat.json")
    available = set(found["engines"])

    assert set(expected["engines"]) - available == {"meta-router-csp"}
    assert {name: expected["engines"][name] for name in available} == found["engines"]
    assert sorted(found["packages"]) == sorted(expected["packages"])
    assert [
        path
        for path, engines in found["packages"].items()
        if engines != {name: expected["packages"][path][name] for name in available}
    ] == []
    assert len(found["packages"]) == len(expected["packages"])


@full_corpus_only
def test_nothing_differs_from_any_golden(baseline_tool, everything) -> None:
    assert baseline_tool.mismatches(everything, GOLDEN_DIR) == []


@full_corpus_only
@pytest.mark.parametrize("name", ["compat.json", "protocol.json", "evaluator_errors.json"])
def test_the_pinned_bim_core_goldens_match(baseline_tool, everything, name) -> None:
    check_or_create_golden(baseline_tool, CORE_GOLDEN_DIR / name, everything[name])


@full_corpus_only
def test_the_command_line_check_finds_no_difference(baseline_tool, root, capsys) -> None:
    assert baseline_tool.main(["--corpus-root", str(root), "--check", "--jobs", "2"]) == 0
    assert "0 differences" in capsys.readouterr().out


@full_corpus_only
def test_the_command_line_writes_documents_equal_to_the_goldens(baseline_tool, root, tmp_path) -> None:
    output = tmp_path / "bim_baseline"

    assert baseline_tool.main(["--corpus-root", str(root), "--output", str(output), "--jobs", "2"]) == 0

    written = {
        **{name: output / name for name in baseline_tool.GOLDEN_FILES},
        **{name: tmp_path / "bim_core" / name for name in baseline_tool.CORE_GOLDEN_FILES},
        "vectors_extra.json": tmp_path / "vectors_extra.json",
    }
    expected = {
        **{name: GOLDEN_DIR / name for name in baseline_tool.GOLDEN_FILES},
        **{name: CORE_GOLDEN_DIR / name for name in baseline_tool.CORE_GOLDEN_FILES},
        "vectors_extra.json": GOLDEN_DIR.parent / "vectors_extra.json",
    }
    assert sorted(written) == sorted(expected) and len(written) == 7
    for name, path in written.items():
        assert path.read_bytes() == baseline_tool.dump(json.loads(path.read_text(encoding="utf-8"))), name
        found = baseline_tool.comparable(json.loads(path.read_text(encoding="utf-8")))
        assert found == baseline_tool.comparable(json.loads(expected[name].read_text(encoding="utf-8"))), name
    # The OpenBinding copies of compat.json and protocol.json are never rewritten.
    assert not (output / "compat.json").exists() and not (output / "protocol.json").exists()


def test_the_command_line_refuses_to_run_without_the_corpus(baseline_tool, tmp_path, capsys) -> None:
    assert baseline_tool.main(["--corpus-root", str(tmp_path)]) == 2
    assert "corpus not found" in capsys.readouterr().err


def test_the_bim_core_goldens_carry_the_four_engines_only(baseline_tool) -> None:
    if not (CORE_GOLDEN_DIR / "protocol.json").is_file() or not (CORE_GOLDEN_DIR / "compat.json").is_file():
        pytest.skip("the bim_core goldens are created by test_the_pinned_bim_core_goldens_match")
    compat =json.loads((CORE_GOLDEN_DIR / "compat.json").read_text(encoding="utf-8"))
    protocol = json.loads((CORE_GOLDEN_DIR / "protocol.json").read_text(encoding="utf-8"))

    assert sorted(compat["engines"]) == sorted(engine_manifest_fixtures())
    assert sorted(protocol["manifests"]) == sorted(engine_manifest_fixtures())
    assert "meta-router-csp" not in compat["engines"] and "meta-router-csp" not in protocol["manifests"]
    assert baseline_tool.dump(compat) == (CORE_GOLDEN_DIR / "compat.json").read_bytes()


def test_the_evaluator_reports_the_same_binding_failures_as_an_evaluation_error(baseline_tool, root) -> None:
    found = baseline_tool.build_evaluator_errors(root)
    negatives = golden("negatives.json")["cases"]

    assert found["reason"]
    assert sorted(found["cases"]) == sorted(name for name, case in negatives.items() if case["kind"] == "binding")
    for name, case in found["cases"].items():
        recorded = negatives[name]
        if recorded["outcome"] == "ok":
            assert case == {"outcome": "ok"}, name
            continue
        assert recorded["outcome"] in {"ValueError", "KeyError", "TypeError"}, name
        assert case["outcome"] == "EvaluationError", name
        assert case["isValueError"] is True, name
        assert case["code"] == "binding_invalid", name
        assert case["message"] == recorded["message"], name

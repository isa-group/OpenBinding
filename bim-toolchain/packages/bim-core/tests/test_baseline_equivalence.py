"""Semantic equivalence of ``bim_core`` with the OpenBinding baseline.

``tools/baseline_core.py`` recomputes, using only ``bim_core``, the semantic digest and the canonical evaluations
of every package of the OpenBinding corpus, the negative cases, the Engine mode compatibility of every package,
the re-evaluation and result-validation vectors and the protocol digests.  ``toolchain`` fields (compilerDigest,
irDigest) change with the toolchain bytes on purpose and are never compared.

Two baselines are involved (``docs/qa/IR_NORMALIZATION.md``).  ``golden/bim_baseline`` is OpenBinding's, taken from the
toolchain that listed eligible candidates, constraints and placement in document order; it is frozen.  The normalized
toolchain lists them in one canonical order, which moves the semantic digest of 64 packages and the enumeration order
of their evaluations, so ``corpus.json`` and ``zip_equivalence.json`` are pinned in ``golden/bim_normalized``;
``negatives`` and ``vectors`` did not move and are compared with the frozen baseline.  How the two corpora relate,
package by package and by identifier, is tested in ``test_ir_previous_baseline.py``.

``compat.json`` and ``protocol.json`` of OpenBinding list the Engine ``meta-router-csp``, whose manifest is not in
the repository (only four manifests are), and the ``minizinc-csp`` manifest they were computed with is not the 1.1.1
one of the repository.  A second frozen baseline, ``golden/bim_baseline_1_1_1``, holds the two documents with the four
Engines and ``minizinc-csp`` 1.1.1 (byte copies of ``golden/bim_core`` when it was created, pinned by SHA-256 here):
``compat`` and ``protocol`` are compared with it with no Engine removed (see ``docs/DIGESTS.md``).  The tests
``test_frozen_manifest_*`` relate it to ``golden/bim_baseline`` by identifier.

The corpus is not part of this directory.  It is looked up under ``BIM_CORPUS_ROOT`` (default: the directory that
contains ``bim-toolchain/``) and the tests that need it skip with a warning when it is absent, unless
``BIM_REQUIRE_CORPUS=1``, which makes them fail (the CI job that is meant to compare with the corpus sets it).  All
packages are compared by default; ``BIM_BASELINE_SAMPLE_ONLY=1`` skips the full comparison and keeps the
ten-package sample.  The directory/ZIP equivalence on synthetic packages needs no corpus
(``test_zip_dir_equivalence.py``).
"""

import copy
import hashlib
import json
import os
import warnings

import pytest

from core_support import (
    CORPUS_MARKER,
    GOLDEN_DIR,
    check_or_create_golden,
    corpus_root,
    engine_manifest_fixtures,
)

GOLDEN_FILES = ("corpus.json", "negatives.json", "compat.json", "vectors.json", "protocol.json")
CORE_GOLDEN_DIR = GOLDEN_DIR.parent / "bim_core"
NORMALIZED_DIR = GOLDEN_DIR.parent / "bim_normalized"
#: The second frozen baseline: ``compat.json`` and ``protocol.json`` with the Engines of the repository, minizinc-csp 1.1.1.
FROZEN_MANIFEST_DIR = GOLDEN_DIR.parent / "bim_baseline_1_1_1"
FROZEN_MANIFEST_SHA256 = {
    "compat.json": "eb587a665ec2c30bef05dff6a54096ee721106e0939e9d33cc9cab6306d6d192",
    "protocol.json": "6ae30623f5953e6cc94df401a48aaa797e1c024537c5430edda2ce76c50aebba",
}
MINIZINC_MOVES = FROZEN_MANIFEST_DIR / "minizinc_moves.json"
SAMPLE_SIZE = 10
SAMPLE_PER_ROOT = 4


@pytest.fixture(scope="module")
def root():
    path = corpus_root()
    if not (path / CORPUS_MARKER).is_file():
        message = f"BIM corpus not available at {path} (set BIM_CORPUS_ROOT): baseline equivalence not checked"
        if os.environ.get("BIM_REQUIRE_CORPUS") == "1":
            pytest.fail(message)
        warnings.warn(message, stacklevel=2)
        pytest.skip(message)
    return path


def golden(name: str) -> dict:
    """A document of the frozen previous baseline."""
    return json.loads((GOLDEN_DIR / name).read_text(encoding="utf-8"))


def frozen_manifest(name: str) -> dict:
    """A document of the second frozen baseline (``golden/bim_baseline_1_1_1``)."""
    return json.loads((FROZEN_MANIFEST_DIR / name).read_text(encoding="utf-8"))


def normalized(name: str) -> dict:
    """A document of the baseline of the normalized IR."""
    path = NORMALIZED_DIR / name
    if not path.is_file():
        pytest.fail(f"{path.relative_to(NORMALIZED_DIR.parent.parent)} is missing: test_the_normalized_goldens_match writes it")
    return json.loads(path.read_text(encoding="utf-8"))


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


full_corpus_only = pytest.mark.skipif(
    os.environ.get("BIM_BASELINE_SAMPLE_ONLY") == "1",
    reason="BIM_BASELINE_SAMPLE_ONLY=1: the full corpus comparison is skipped",
)


@full_corpus_only
@pytest.mark.parametrize("name", ["corpus.json", "zip_equivalence.json"])
def test_the_normalized_goldens_match(baseline_tool, everything, name) -> None:
    """``golden/bim_normalized``: the baseline of the normalized IR. A missing document is created and the test fails
    once, as for the other goldens (``check_or_create_golden``): the new file is reviewed and committed.

    It runs first on purpose: the tests below read these files. They were only created after the invariants of
    ``test_ir_previous_baseline.py`` (same members, same evaluations by identifier) held."""
    check_or_create_golden(baseline_tool, NORMALIZED_DIR / name, everything[name])


def test_the_goldens_are_the_ones_recorded_in_openbinding(baseline_tool, root) -> None:
    """The gateway's ``corpus.json`` is the corpus golden of the normalized IR, copied from ``golden/bim_normalized``
    (the gateway moved to it with ``bim-core`` 0.2.0); ``negatives.json`` and ``vectors.json`` did not move and are
    still the frozen baseline's; ``compat.json`` and ``protocol.json`` are those of ``golden/bim_baseline_1_1_1``."""
    original = root / "openbinding-gateway" / "tests" / "golden" / "bim_baseline"
    if not original.is_dir():
        pytest.skip(f"{original} is not available")
    assert (original / "corpus.json").read_bytes() == (NORMALIZED_DIR / "corpus.json").read_bytes(), "corpus.json"
    for name in ("negatives.json", "vectors.json"):
        assert (original / name).read_bytes() == (GOLDEN_DIR / name).read_bytes(), name
    # OpenBinding's current compat.json and protocol.json list the four Engines of the repository, with the
    # minizinc-csp 1.1.1 manifest: they are the documents of golden/bim_baseline_1_1_1, toolchain fields aside.
    # (golden/bim_baseline lists meta-router-csp and the older minizinc-csp: see the test_frozen_manifest_* tests.)
    for name in ("compat.json", "protocol.json"):
        theirs = json.loads((original / name).read_text(encoding="utf-8"))
        assert baseline_tool.comparable(frozen_manifest(name)) == baseline_tool.comparable(theirs), name


def test_the_bim_core_goldens_equal_the_current_openbinding_ones(baseline_tool, root) -> None:
    original = root / "openbinding-gateway" / "tests" / "golden" / "bim_baseline"
    if not original.is_dir() or not (CORE_GOLDEN_DIR / "compat.json").is_file():
        pytest.skip("the OpenBinding goldens or the bim_core goldens are not available")
    for name in ("compat.json", "protocol.json"):
        mine = json.loads((CORE_GOLDEN_DIR / name).read_text(encoding="utf-8"))
        theirs = json.loads((original / name).read_text(encoding="utf-8"))
        assert baseline_tool.comparable(mine) == baseline_tool.comparable(theirs), name


def test_the_goldens_cover_exactly_the_discovered_corpus(baseline_tool, root) -> None:
    discovered = {
        directory.relative_to(root).as_posix() for directory in baseline_tool.package_directories(root)
    }

    for corpus in (golden("corpus.json"), normalized("corpus.json")):
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
    expected = normalized("corpus.json")
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
    expected = normalized("corpus.json")

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
    expected = frozen_manifest("protocol.json")

    assert found["protocolDigest"] == expected["protocolDigest"]
    assert found["engineContract"] == expected["engineContract"]
    assert found["schemas"] == expected["schemas"]
    assert found["vendor"] == expected["vendor"]
    assert baseline_tool.differences("protocol", found, expected) == []


def test_the_protocol_golden_lists_exactly_the_manifests_of_the_repository(baseline_tool) -> None:
    found = baseline_tool.build_protocol(engine_manifest_fixtures())
    expected = frozen_manifest("protocol.json")

    assert found["manifests"] == expected["manifests"]
    assert sorted(expected["manifests"]) == sorted(engine_manifest_fixtures())


@full_corpus_only
def test_engine_compatibility_matches_the_goldens(baseline_tool, everything) -> None:
    found = everything["compat.json"]
    expected = frozen_manifest("compat.json")

    assert found["engines"] == expected["engines"]
    assert sorted(found["packages"]) == sorted(expected["packages"])
    assert [path for path, entry in found["packages"].items() if entry != expected["packages"][path]] == []
    assert len(found["packages"]) == len(expected["packages"])


@full_corpus_only
def test_nothing_differs_from_any_golden(baseline_tool, everything) -> None:
    assert baseline_tool.mismatches(everything) == []


@full_corpus_only
@pytest.mark.parametrize("name", ["compat.json", "protocol.json", "evaluator_errors.json"])
def test_the_pinned_bim_core_goldens_match(baseline_tool, everything, name) -> None:
    check_or_create_golden(baseline_tool, CORE_GOLDEN_DIR / name, everything[name])


@full_corpus_only
def test_every_form_of_a_package_is_the_package_compiled_from_its_directory(baseline_tool, everything) -> None:
    """The production route: the platform stores and compiles the ZIP of the bytes it received, not the directory the
    goldens were generated from.  For all 82 packages that ZIP, the same ZIP with its entries reversed, the canonical
    ZIP and two shuffles of the members of the JSON objects give the IR and the semantic digest of the directory."""
    document = everything["zip_equivalence.json"]
    corpus = normalized("corpus.json")

    assert baseline_tool.zip_equivalence_failures(document) == {}
    assert sorted(document["packages"]) == sorted(corpus["packages"]) and document["packageCount"] == 82
    for path, entry in document["packages"].items():
        for form in baseline_tool.ZIP_FORMS:
            assert entry[form] == {"sameIr": True, "sameSemanticDigest": True}, (path, form)
        assert entry["packageDigestsEqual"], path
    assert len(baseline_tool.ZIP_FORMS) == 5


@full_corpus_only
def test_the_command_line_check_finds_no_difference(baseline_tool, root, capsys) -> None:
    assert baseline_tool.main(["--corpus-root", str(root), "--check", "--jobs", "2"]) == 0
    assert "0 differences" in capsys.readouterr().out


@full_corpus_only
def test_the_command_line_writes_documents_equal_to_the_goldens(baseline_tool, root, tmp_path) -> None:
    output = tmp_path / "golden"

    assert baseline_tool.main(["--corpus-root", str(root), "--output", str(output), "--jobs", "2"]) == 0

    written = {
        **{f"bim_normalized/{name}": output / "bim_normalized" / name for name in baseline_tool.NORMALIZED_FILES},
        **{f"bim_core/{name}": output / "bim_core" / name for name in baseline_tool.CORE_GOLDEN_FILES},
        "vectors_extra.json": output / "vectors_extra.json",
    }
    expected = {
        **{f"bim_normalized/{name}": NORMALIZED_DIR / name for name in baseline_tool.NORMALIZED_FILES},
        **{f"bim_core/{name}": CORE_GOLDEN_DIR / name for name in baseline_tool.CORE_GOLDEN_FILES},
        "vectors_extra.json": GOLDEN_DIR.parent / "vectors_extra.json",
    }
    assert sorted(written) == sorted(expected) and len(written) == 6
    for name, path in written.items():
        assert path.read_bytes() == baseline_tool.dump(json.loads(path.read_text(encoding="utf-8"))), name
        found = baseline_tool.comparable(json.loads(path.read_text(encoding="utf-8")))
        assert found == baseline_tool.comparable(json.loads(expected[name].read_text(encoding="utf-8"))), name
    # The frozen baselines are never rewritten: nothing is written next to them.
    assert not (output / "bim_baseline").exists()
    assert not (output / FROZEN_MANIFEST_DIR.name).exists()


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


def minizinc_moves(old: dict, new: dict) -> dict:
    """What the 1.1.1 manifest of ``minizinc-csp`` changed between two ``{"compat.json", "protocol.json"}`` pairs: its
    manifest digest, its (single) mode and the packages whose entry moved, with their old codes and the one new entry."""
    before_engine = old["compat.json"]["engines"]["minizinc-csp"]
    after_engine = new["compat.json"]["engines"]["minizinc-csp"]
    digest = {"old": before_engine["manifestDigest"], "new": after_engine["manifestDigest"]}
    assert digest == {
        "old": old["protocol.json"]["manifests"]["minizinc-csp"],
        "new": new["protocol.json"]["manifests"]["minizinc-csp"],
    }
    assert before_engine["modes"] == after_engine["modes"] and len(after_engine["modes"]) == 1
    mode = after_engine["modes"][0]
    new_entries, old_codes = [], {}
    for path in sorted(new["compat.json"]["packages"]):
        before = old["compat.json"]["packages"][path]["minizinc-csp"]
        after = new["compat.json"]["packages"][path]["minizinc-csp"]
        assert sorted(before) == sorted(after) == [mode], path
        if before[mode] != after[mode]:
            assert before[mode]["compatible"] is False, path
            new_entries.append(after[mode])
            old_codes[path] = before[mode]["codes"]
    assert new_entries and all(entry == new_entries[0] for entry in new_entries)
    return {"manifestDigest": digest, "mode": mode, "newEntry": new_entries[0], "oldCodes": old_codes}


def previous_and_frozen_manifest() -> tuple[dict, dict]:
    """``compat.json`` and ``protocol.json`` of ``golden/bim_baseline`` and of ``golden/bim_baseline_1_1_1``."""
    names = ("compat.json", "protocol.json")
    return {n: golden(n) for n in names}, {n: frozen_manifest(n) for n in names}


def test_frozen_manifest_files_have_the_pinned_sha256(baseline_tool) -> None:
    assert sorted(FROZEN_MANIFEST_SHA256) == ["compat.json", "protocol.json"]
    for name, digest in FROZEN_MANIFEST_SHA256.items():
        data = (FROZEN_MANIFEST_DIR / name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == digest, name
        assert baseline_tool.dump(json.loads(data)) == data, name


def test_frozen_manifest_is_the_previous_baseline_apart_from_minizinc_csp(baseline_tool) -> None:
    old, new = previous_and_frozen_manifest()
    assert set(old["compat.json"]["engines"]) - set(new["compat.json"]["engines"]) == {"meta-router-csp"}
    assert set(old["protocol.json"]["manifests"]) - set(new["protocol.json"]["manifests"]) == {"meta-router-csp"}
    assert set(new["compat.json"]["engines"]) - set(old["compat.json"]["engines"]) == set()
    assert sorted(new["compat.json"]["packages"]) == sorted(old["compat.json"]["packages"])
    for name in ("compat.json", "protocol.json"):
        before = baseline_tool.without_engines(old[name], ("meta-router-csp", "minizinc-csp"))
        after = baseline_tool.without_engines(new[name], ("minizinc-csp",))
        assert baseline_tool.differences(name, after, before) == [], name
        assert baseline_tool.comparable(after) == baseline_tool.comparable(before), name


def test_frozen_manifest_moves_are_exactly_the_pinned_list(baseline_tool) -> None:
    pinned = json.loads(MINIZINC_MOVES.read_text(encoding="utf-8"))
    old, new = previous_and_frozen_manifest()
    found = minizinc_moves(old, new)

    assert {key: value for key, value in pinned.items() if key != "note"} == found
    assert len(found["oldCodes"]) == 65
    assert found["newEntry"]["compatible"] is True and found["newEntry"]["codes"] == []


def test_frozen_manifest_no_compatible_pair_became_incompatible(baseline_tool) -> None:
    old, new = previous_and_frozen_manifest()
    accepted: dict[str, int] = {}
    for path, engines in old["compat.json"]["packages"].items():
        for engine, modes in engines.items():
            if engine not in new["compat.json"]["packages"][path]:
                assert engine == "meta-router-csp", (path, engine)
                continue
            for mode, entry in modes.items():
                if entry["compatible"] is True:
                    accepted[engine] = accepted.get(engine, 0) + 1
                    assert new["compat.json"]["packages"][path][engine][mode]["compatible"] is True, (path, engine, mode)
    assert accepted.get("minizinc-csp", 0) > 0


def test_frozen_manifest_comparison_removes_no_engine(baseline_tool) -> None:
    # The name is spelled in two parts so that no file under tools/, packages/ or docs/ mentions the removed constant.
    assert not hasattr(baseline_tool, "_".join(("CHANGED", "MANIFESTS")))
    golden_root = FROZEN_MANIFEST_DIR.parent

    def load(directory, name):
        return json.loads((directory / name).read_text(encoding="utf-8"))

    documents = {name: load(NORMALIZED_DIR, name) for name in baseline_tool.NORMALIZED_FILES}
    documents.update({name: load(GOLDEN_DIR, name) for name in baseline_tool.UNCHANGED_FILES})
    documents.update({name: frozen_manifest(name) for name in ("compat.json", "protocol.json")})
    documents["evaluator_errors.json"] = load(CORE_GOLDEN_DIR, "evaluator_errors.json")
    documents["vectors_extra.json"] = load(golden_root, "vectors_extra.json")
    assert baseline_tool.mismatches(documents, golden_root) == []

    path = sorted(documents["compat.json"]["packages"])[0]
    changed = copy.deepcopy(documents)
    mode = sorted(changed["compat.json"]["packages"][path]["minizinc-csp"])[0]
    entry = changed["compat.json"]["packages"][path]["minizinc-csp"][mode]
    entry["compatible"] = not entry["compatible"]
    changed["protocol.json"]["manifests"]["minizinc-csp"] = "sha256-" + "0" * 64
    found = baseline_tool.mismatches(changed, golden_root)
    assert f"bim_baseline_1_1_1/compat.json packages/{path}" in found
    assert "bim_baseline_1_1_1/protocol.json manifests" in found


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

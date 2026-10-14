"""The normalized IR against the baseline that preceded it, package by package and by identifier.

``golden/bim_baseline`` is the baseline of the toolchain that listed eligible candidates, constraints and placement in
the order the JSON objects were written (commit ``b2780381``; see ``docs/qa/IR_NORMALIZATION.md``).  It is frozen: its
files are not edited and ``golden/ir_previous/evidence.json`` pins their SHA-256.  That evidence file also holds, for each
of the 82 corpus packages, the evaluation of bindings chosen *by identifier* (never by position in a list) and the digest
of the members of every set of the IR, both computed with that previous toolchain.

A toolchain that only changes the order of sets must reproduce all of it.  These tests compile the 82 packages with the
installed ``bim_core`` and compare:

* the members of every list of the IR, order forgotten, with the previous IR;
* the evaluation of the same bindings (violations as a set; messages with ``6.0`` read as ``6``);
* the summaries of the exhaustive evaluations of ``golden/bim_baseline/corpus.json``, which do not depend on the
  order in which the bindings are enumerated.

The evidence is created once, by the previous toolchain, and refuses to be produced by any other (see
``baseline_core.build_previous_evidence``).  Without the corpus the tests skip, or fail with ``BIM_REQUIRE_CORPUS=1``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from bim_core import compile_instance, load_package
from core_support import GOLDEN_DIR, corpus_root, require_corpus_path

FROZEN = json.loads((GOLDEN_DIR / "corpus.json").read_text(encoding="utf-8"))["packages"]
PATHS = sorted(FROZEN)
MOVED_FILE = Path(__file__).resolve().parent / "data" / "zip_divergent_packages.json"


def test_the_evidence_exists_or_is_created(baseline_tool) -> None:
    """A missing evidence file is written by the previous toolchain (no other can) and the test fails once, as for
    the other goldens: the new file must be reviewed and committed."""
    require_corpus_path(PATHS[0])
    path = baseline_tool.PREVIOUS_EVIDENCE
    if path.is_file():
        return
    root = corpus_root()
    document = baseline_tool.build_previous_evidence(root, baseline_tool.package_directories(root))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(baseline_tool.dump(document))
    pytest.fail(f"{path.relative_to(baseline_tool.ROOT)} did not exist and was created: review and commit it")


@pytest.fixture(scope="module")
def evidence(baseline_tool):
    require_corpus_path(PATHS[0])
    path = baseline_tool.PREVIOUS_EVIDENCE
    if not path.is_file():
        pytest.fail(f"{path.relative_to(baseline_tool.ROOT)} is missing: test_the_evidence_exists_or_is_created writes it")
    return json.loads(path.read_text(encoding="utf-8"))


def test_the_evidence_covers_the_82_packages_of_the_frozen_baseline(baseline_tool, evidence) -> None:
    assert sorted(evidence["packages"]) == PATHS and evidence["packageCount"] == len(PATHS) == 82
    assert evidence["baseline"] == baseline_tool.PREVIOUS_BASELINE
    assert baseline_tool.dump(evidence) == baseline_tool.PREVIOUS_EVIDENCE.read_bytes()
    assert evidence["seed"] == baseline_tool.SEED
    assert (evidence["exhaustiveUpTo"], evidence["sample"]) == (baseline_tool.EVIDENCE_EXHAUSTIVE, baseline_tool.EVIDENCE_SAMPLE)


def test_the_frozen_baseline_files_are_not_edited(baseline_tool, evidence) -> None:
    """``golden/bim_baseline`` is a comparison fixture: the only change allowed to it is none."""
    assert sorted(evidence["frozenFiles"]) == sorted(baseline_tool.FROZEN_FILES)
    found = {name: baseline_tool.file_sha256(GOLDEN_DIR / name) for name in baseline_tool.FROZEN_FILES}
    assert found == evidence["frozenFiles"]


def test_every_package_has_bindings_to_compare(evidence) -> None:
    for path, entry in evidence["packages"].items():
        assert entry["bindings"], path
        assert len(set(entry["bindings"])) == len(entry["bindings"]), path


def test_the_normalized_corpus_moved_exactly_where_the_order_of_a_set_changed(baseline_tool) -> None:
    """``golden/bim_normalized/corpus.json`` against the frozen ``golden/bim_baseline/corpus.json``, package by package.

    The 18 packages whose sets were already in canonical order have the same entry, evaluation digests included. The
    64 others (``data/zip_divergent_packages.json``) change their semantic digest in ``eligibility``, ``constraints``
    and ``placement`` only; the shape of the binding space, the number of bindings evaluated and the seed are the
    same, and when every binding is evaluated the summary is the same too (it does not depend on the order).  When
    the space is sampled the draws index the (now canonical) list, so the sample may be other bindings: that
    summary is compared by identifier in ``test_a_package_evaluates_as_the_previous_toolchain_did``."""
    path = baseline_tool.NORMALIZED_DIR / "corpus.json"
    if not path.is_file():
        pytest.fail(f"{path.relative_to(baseline_tool.ROOT)} is missing: test_the_normalized_goldens_match writes it")
    current = json.loads(path.read_text(encoding="utf-8"))["packages"]
    moved = set(json.loads(MOVED_FILE.read_text(encoding="utf-8"))["packages"])

    assert sorted(current) == PATHS and len(moved) == 64
    for relative in PATHS:
        old, new = FROZEN[relative], current[relative]
        for key in ("path", "status", "candidates", "tasks", "bindingSpace"):
            assert new[key] == old[key], (relative, key)
        old_evaluation, new_evaluation = old["evaluation"], new["evaluation"]
        for key in ("mode", "count", "seed"):
            assert new_evaluation.get(key) == old_evaluation.get(key), (relative, key)
        if relative in moved:
            changed = {key for key in new["sectionDigests"] if new["sectionDigests"][key] != old["sectionDigests"][key]}
            assert changed and changed <= {"eligibility", "constraints", "placement"}, relative
            assert new["semanticDigest"] != old["semanticDigest"], relative
        else:
            assert baseline_tool.comparable(new) == baseline_tool.comparable(old), relative
        if old_evaluation["mode"] == "exhaustive":
            assert new_evaluation["summary"] == old_evaluation["summary"], relative


def test_what_the_order_did_to_the_baseline_evaluations_of_the_moved_packages(baseline_tool) -> None:
    """The figures quoted in ``docs/qa/IR_NORMALIZATION.md``, from the two corpus goldens.

    Of the 64 packages that moved, 14 are evaluated exhaustively and 50 are sampled. Exhaustive: the same summary,
    another enumeration order (so another ``rollupDigest``) for 13; ``examples/literature/zhang`` keeps every digest.
    Sampled: the 16 seeded draws index a list now in canonical order, so 33 of the 50 draw other bindings and have
    another summary; the 17 others draw other bindings too, but with the same summary."""
    path = baseline_tool.NORMALIZED_DIR / "corpus.json"
    current = json.loads(path.read_text(encoding="utf-8"))["packages"]
    moved = sorted(json.loads(MOVED_FILE.read_text(encoding="utf-8"))["packages"])
    exhaustive = [name for name in moved if FROZEN[name]["evaluation"]["mode"] == "exhaustive"]
    sampled = [name for name in moved if FROZEN[name]["evaluation"]["mode"] == "sample"]

    assert (len(exhaustive), len(sampled)) == (14, 50)
    assert all(current[name]["evaluation"]["summary"] == FROZEN[name]["evaluation"]["summary"] for name in exhaustive)
    assert [name for name in exhaustive if current[name]["evaluation"] == FROZEN[name]["evaluation"]] == [
        "examples/literature/zhang"
    ]
    assert len([name for name in sampled if current[name]["evaluation"]["summary"] != FROZEN[name]["evaluation"]["summary"]]) == 33


@pytest.mark.parametrize("relative", PATHS)
def test_a_package_evaluates_as_the_previous_toolchain_did(baseline_tool, evidence, relative: str) -> None:
    """Same members, same bindings (by identifier), same evaluations; exhaustive summaries as in the frozen corpus."""
    problem = compile_instance(load_package(require_corpus_path(relative)))
    found = baseline_tool.package_evidence(problem, relative)
    previous = evidence["packages"][relative]

    assert found["membersDigest"] == previous["membersDigest"], "a set of the IR has other members"
    assert len(found["bindings"]) == len(previous["bindings"])
    differing = [
        (old, new) for old, new in zip(previous["bindings"], found["bindings"], strict=True) if old != new
    ]
    assert differing == []

    expected = FROZEN[relative]["evaluation"]
    if expected["mode"] == "exhaustive":
        # Every binding is evaluated whatever the order: the summary does not depend on it.
        assert baseline_tool.evaluate_package(problem)["summary"] == expected["summary"]

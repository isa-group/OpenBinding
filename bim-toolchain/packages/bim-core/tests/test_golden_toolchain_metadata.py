"""The informative ``toolchain`` members of the goldens of the normalized IR are those of the installed toolchain.

``golden/bim_normalized/corpus.json`` records the ``compilerDigest`` and the ``irDigest`` of the toolchain that wrote it.
They are informative (``baseline_core.comparable`` drops them), which is why they drifted unnoticed once.  These tests fail
when the installed ``compilerDigest`` is not the registered one, so that an edit of ``bim_core`` cannot leave the metadata
behind: run ``python tools/regen_normalized_metadata.py --write`` (``docs/GOLDEN_METADATA.md``).
"""

from __future__ import annotations

import copy
import hashlib
import json

import regen_normalized_metadata as regen
from bim_core.toolchain import compiler_bundle_digest
from core_support import corpus_root, require_corpus_path

REGENERATE = "run tools/regen_normalized_metadata.py --write"
SHA = "sha256-" + "0" * 64


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def golden() -> dict:
    return json.loads(regen.NORMALIZED.read_text(encoding="utf-8"))


def comparison() -> dict:
    return json.loads(regen.COMPARISON.read_text(encoding="utf-8"))


def test_the_normalized_golden_registers_the_installed_compiler_digest() -> None:
    document = golden()
    installed = compiler_bundle_digest()
    assert document["toolchain"]["compilerDigest"] == installed, REGENERATE
    assert regen.toolchain_mismatches(document, installed) == [], REGENERATE


def test_every_package_entry_registers_the_installed_compiler_digest() -> None:
    document = golden()
    registered = {entry["toolchain"]["compilerDigest"] for entry in document["packages"].values()}
    assert registered == {compiler_bundle_digest()}, REGENERATE
    assert document["packageCount"] == len(document["packages"]) == 82


def test_a_golden_that_registers_another_toolchain_is_detected() -> None:
    document = golden()
    installed = compiler_bundle_digest()
    stale = copy.deepcopy(document)
    stale["toolchain"]["compilerDigest"] = SHA
    assert regen.toolchain_mismatches(stale, installed) == [
        f"toolchain.compilerDigest is {SHA}, the installed one is {installed}"
    ]

    path = sorted(document["packages"])[0]
    stale = copy.deepcopy(document)
    stale["packages"][path]["toolchain"]["compilerDigest"] = SHA
    assert regen.toolchain_mismatches(stale, installed) == [f"{path}: toolchain.compilerDigest is not the installed one"]

    expected = {name: entry["toolchain"]["irDigest"] for name, entry in document["packages"].items()}
    assert regen.toolchain_mismatches(document, installed, expected) == []
    expected[path] = SHA
    assert regen.toolchain_mismatches(document, installed, expected) == [
        f"{path}: toolchain.irDigest is not the one the installed toolchain compiles to"
    ]


def test_the_irdigests_registered_are_the_ones_the_installed_toolchain_compiles_to(baseline_tool) -> None:
    require_corpus_path("examples/demo/01_simple_seq")
    root = corpus_root()
    found = regen.installed_ir_digests(root, baseline_tool.package_directories(root))
    assert len(found) == 82
    assert regen.toolchain_mismatches(golden(), compiler_bundle_digest(), found) == [], REGENERATE


def test_the_gateway_copies_are_byte_copies_of_the_golden() -> None:
    directory = require_corpus_path("openbinding-gateway/tests/golden/bim_baseline")
    assert (directory / "corpus.json").read_bytes() == regen.NORMALIZED.read_bytes(), REGENERATE
    other = corpus_root() / "openbinding-gateway" / "tests" / "golden" / "bim_normalized" / "corpus.json"
    if other.is_file():
        assert other.read_bytes() == regen.NORMALIZED.read_bytes(), REGENERATE


def test_the_comparison_describes_the_current_golden_and_the_installed_toolchain() -> None:
    record, document, data = comparison(), golden(), regen.NORMALIZED.read_bytes()
    assert record["schema"] == regen.SCHEMA and record["golden"] == "golden/bim_normalized/corpus.json"
    assert record["after"] == {
        "compilerDigest": compiler_bundle_digest(), "sha256": sha256(data), "bytes": len(data),
    }, REGENERATE
    assert record["before"]["compilerDigest"].startswith("sha256-") and len(record["before"]["sha256"]) == 64
    assert record["packageCount"] == document["packageCount"] == 82
    assert set(record["changedMembers"]) == {
        "toolchain.compilerDigest", "packages[*].toolchain.compilerDigest", "packages[*].toolchain.irDigest",
    }


def test_the_comparison_records_that_nothing_but_the_toolchain_members_moved() -> None:
    record = comparison()
    unchanged = record["unchanged"]
    assert unchanged["everythingButToolchain"] is True
    assert unchanged["zipEquivalenceBytesIdentical"] is True
    assert (
        unchanged["semanticDigests"], unchanged["sectionDigests"], unchanged["evaluations"],
        unchanged["bindingSpaces"], unchanged["candidates"],
    ) == (82, 82, 82, 82, 82)
    assert unchanged["changedLinesNotAboutTheToolchain"] == 0
    zip_bytes = (regen.NORMALIZED.parent / "zip_equivalence.json").read_bytes()
    assert unchanged["zipEquivalenceSha256"] == sha256(zip_bytes)


def test_the_frozen_baselines_were_not_touched() -> None:
    record = comparison()
    evidence = json.loads((regen.ROOT / "golden" / "ir_previous" / "evidence.json").read_text(encoding="utf-8"))
    assert set(record["frozenNotTouched"]) == set(regen.FROZEN)
    for name, digest in record["frozenNotTouched"].items():
        assert sha256((regen.ROOT / name).read_bytes()) == digest, name
    for name, digest in evidence["frozenFiles"].items():
        assert record["frozenNotTouched"][f"golden/bim_baseline/{name}"] == digest, name


def test_the_document_shows_the_recorded_comparison() -> None:
    record = comparison()
    text = regen.DOC.read_text(encoding="utf-8")
    assert regen.current_block(text) == regen.render_doc_block(record), REGENERATE
    assert record["after"]["compilerDigest"] in text and record["after"]["sha256"] in text


# --- the helpers of the tool -------------------------------------------------------------------------------


def test_only_lines_that_hold_a_toolchain_digest_may_differ() -> None:
    before = b' "a": 1,\n "toolchain": {\n  "compilerDigest": "sha256-x"\n }\n'
    after = before.replace(b"sha256-x", b"sha256-y")
    assert regen.lines_not_about_the_toolchain(before, after) == []
    assert regen.lines_not_about_the_toolchain(before, after.replace(b'"a": 1', b'"a": 2'))
    assert regen.lines_not_about_the_toolchain(before, after + b" extra\n")


def test_with_toolchain_replaces_the_toolchain_members_and_nothing_else() -> None:
    old = {
        "toolchain": {"compilerDigest": "old"},
        "packages": {"p": {"semanticDigest": "s", "toolchain": {"compilerDigest": "old", "irDigest": "oldir"}}, "q": {"x": 1}},
    }
    fresh = {
        "toolchain": {"compilerDigest": "new"},
        "packages": {"p": {"semanticDigest": "CHANGED", "toolchain": {"compilerDigest": "new", "irDigest": "newir"}}, "q": {"x": 2}},
    }
    new = regen.with_toolchain(old, fresh)
    assert new == {
        "toolchain": {"compilerDigest": "new"},
        "packages": {"p": {"semanticDigest": "s", "toolchain": {"compilerDigest": "new", "irDigest": "newir"}}, "q": {"x": 1}},
    }
    assert old["toolchain"] == {"compilerDigest": "old"}
    assert regen.changed_members(old, new) == {
        "toolchain.compilerDigest": 1,
        "packages[*].toolchain.compilerDigest": 1,
        "packages[*].toolchain.irDigest": 1,
    }
    assert set(regen.changed_members(new, new).values()) == {0}


def test_the_tool_refuses_to_run_without_the_corpus(tmp_path, capsys) -> None:
    assert regen.main(["--write", "--corpus-root", str(tmp_path)]) == 2
    assert "corpus not found" in capsys.readouterr().err
    assert regen.main(["--check", "--corpus-root", str(tmp_path)]) == 2
    assert "corpus not found" in capsys.readouterr().err

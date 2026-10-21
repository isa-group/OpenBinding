"""Refresh the informative ``toolchain`` members of the goldens of the normalized IR, and nothing else.

``golden/bim_normalized/corpus.json`` records, next to the semantic digests and evaluations that must never move, the
``compilerDigest`` and the ``irDigest`` of the toolchain that wrote it.  Those members change with every edit of
``bim_core`` and are informative (``baseline_core.comparable`` removes them), so they drift.  This tool brings them up to
date, after *verifying* that everything else is identical before and after::

    python tools/regen_normalized_metadata.py --write --compare-out golden/toolchain_metadata_comparison.json
    python tools/regen_normalized_metadata.py --check

``--write`` compiles and evaluates the whole corpus (``BIM_CORPUS_ROOT``) and refuses to write unless the semantic and
section digests, the evaluations, the binding spaces and ``zip_equivalence.json`` (byte for byte) are the recorded ones.
It then rewrites only the ``toolchain`` members of ``golden/bim_normalized/corpus.json`` and of the byte copies the
gateway keeps (``openbinding-gateway/tests/golden/bim_baseline/corpus.json`` and ``bim_normalized/corpus.json`` if it
exists; the gateway test requires the copy to be byte-identical, so they move together), checks that every changed line
holds a ``compilerDigest`` or an ``irDigest``, writes the comparison to ``--compare-out`` and to
``docs/GOLDEN_METADATA.md`` and refreshes ``golden/synthetic/corpus.json`` (the corpus-independent golden) and the table
of ``docs/OMG_XSD_RIGHTS.md``.  ``golden/bim_baseline`` and ``golden/ir_previous`` (the frozen 0.1.x baseline) are never
touched.  ``--check`` fails when a golden registers a toolchain other than the installed one.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import baseline_core as bc  # noqa: E402
import xsd_inventory  # noqa: E402

ROOT = bc.ROOT
NORMALIZED = bc.NORMALIZED_DIR / "corpus.json"
ZIP_EQUIVALENCE = bc.NORMALIZED_DIR / "zip_equivalence.json"
SYNTHETIC = bc.SYNTHETIC_DIR / bc.SYNTHETIC_FILE
COMPARISON = bc.GOLDEN_ROOT / "toolchain_metadata_comparison.json"
DOC = ROOT / "docs" / "GOLDEN_METADATA.md"
#: Copies of the corpus golden kept by the gateway, relative to the OpenBinding root (the parent of ``bim-toolchain``).
GATEWAY_COPIES = (
    "openbinding-gateway/tests/golden/bim_baseline/corpus.json",
    "openbinding-gateway/tests/golden/bim_normalized/corpus.json",
)
FROZEN = (
    *(f"golden/bim_baseline/{name}" for name in bc.FROZEN_FILES),
    "golden/ir_previous/evidence.json",
)
BEGIN = "<!-- golden-metadata:begin -->"
END = "<!-- golden-metadata:end -->"
SCHEMA = "bim-toolchain/toolchain-metadata-comparison/1"
_TOOLCHAIN_LINE = re.compile(r'"(compilerDigest|irDigest)"')


class RegenError(RuntimeError):
    """The goldens are not in a state that allows a metadata-only refresh."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


# --- the toolchain members ---------------------------------------------------------------------------------


def with_toolchain(old: dict[str, Any], fresh: dict[str, Any]) -> dict[str, Any]:
    """``old`` with the ``toolchain`` members of ``fresh`` and everything else untouched."""
    new = copy.deepcopy(old)
    new["toolchain"] = copy.deepcopy(fresh["toolchain"])
    for path, entry in new["packages"].items():
        if "toolchain" in fresh["packages"][path]:
            entry["toolchain"] = copy.deepcopy(fresh["packages"][path]["toolchain"])
    return new


def changed_members(old: dict[str, Any], new: dict[str, Any]) -> dict[str, int]:
    """How many informative members differ between two corpus documents."""
    result = {"toolchain.compilerDigest": int(old["toolchain"] != new["toolchain"])}
    result["packages[*].toolchain.compilerDigest"] = sum(
        old["packages"][path].get("toolchain", {}).get("compilerDigest") != entry.get("toolchain", {}).get("compilerDigest")
        for path, entry in new["packages"].items()
    )
    result["packages[*].toolchain.irDigest"] = sum(
        old["packages"][path].get("toolchain", {}).get("irDigest") != entry.get("toolchain", {}).get("irDigest")
        for path, entry in new["packages"].items()
    )
    return result


def lines_not_about_the_toolchain(before: bytes, after: bytes) -> list[str]:
    """Lines that differ between two serializations without being a ``compilerDigest`` or ``irDigest`` line on both sides."""
    left, right = before.decode("utf-8").splitlines(), after.decode("utf-8").splitlines()
    if len(left) != len(right):
        return [f"the number of lines changed: {len(left)} -> {len(right)}"]
    return [
        f"line {number}: {old.strip()[:80]!r} -> {new.strip()[:80]!r}"
        for number, (old, new) in enumerate(zip(left, right, strict=True), start=1)
        if old != new and not (_TOOLCHAIN_LINE.search(old) and _TOOLCHAIN_LINE.search(new))
    ]


def toolchain_mismatches(
    document: dict[str, Any], compiler_digest: str, ir_digests: dict[str, str] | None = None
) -> list[str]:
    """What a corpus golden registers that is not the toolchain in use (``ir_digests``: path -> irDigest, when known)."""
    found = []
    registered = document.get("toolchain", {}).get("compilerDigest")
    if registered != compiler_digest:
        found.append(f"toolchain.compilerDigest is {registered}, the installed one is {compiler_digest}")
    for path, entry in sorted(document["packages"].items()):
        if entry.get("toolchain", {}).get("compilerDigest") != compiler_digest:
            found.append(f"{path}: toolchain.compilerDigest is not the installed one")
        if ir_digests is not None and entry.get("toolchain", {}).get("irDigest") != ir_digests.get(path):
            found.append(f"{path}: toolchain.irDigest is not the one the installed toolchain compiles to")
    return found


def installed_ir_digests(corpus_root: Path, directories: list[Path]) -> dict[str, str]:
    """``irDigest`` of every package, compiled now (no evaluation)."""
    return {
        directory.relative_to(corpus_root).as_posix(): bc.compile_instance(bc.load_package(directory)).digest
        for directory in directories
    }


# --- the documents -----------------------------------------------------------------------------------------


def build_comparison(
    old: dict[str, Any],
    new: dict[str, Any],
    fresh: dict[str, Any],
    old_bytes: bytes,
    new_bytes: bytes,
    zip_bytes: bytes,
    copies: dict[str, str],
) -> dict[str, Any]:
    paths = sorted(new["packages"])

    def same(key: str) -> int:
        return sum(fresh["packages"][path].get(key) == old["packages"][path].get(key) for path in paths)

    differing = len(lines_not_about_the_toolchain(old_bytes, new_bytes))
    changed_lines = sum(left != right for left, right in zip(old_bytes.decode().splitlines(), new_bytes.decode().splitlines()))
    return {
        "schema": SCHEMA,
        "note": (
            "Before and after of the informative toolchain members of golden/bim_normalized/corpus.json (and of the "
            "gateway's byte copies). Everything that is not a toolchain member was recomputed from the corpus with the "
            "installed toolchain and found identical to the recorded value before anything was written."
        ),
        "tool": "tools/regen_normalized_metadata.py",
        "golden": relative(NORMALIZED),
        "packageCount": len(paths),
        "before": {
            "compilerDigest": old["toolchain"]["compilerDigest"],
            "sha256": sha256(old_bytes),
            "bytes": len(old_bytes),
        },
        "after": {
            "compilerDigest": new["toolchain"]["compilerDigest"],
            "sha256": sha256(new_bytes),
            "bytes": len(new_bytes),
        },
        "changedMembers": changed_members(old, new),
        "unchanged": {
            "everythingButToolchain": bc.comparable(old) == bc.comparable(new) == bc.comparable(fresh),
            "semanticDigests": same("semanticDigest"),
            "sectionDigests": same("sectionDigests"),
            "evaluations": same("evaluation"),
            "bindingSpaces": same("bindingSpace"),
            "candidates": same("candidates"),
            "zipEquivalenceBytesIdentical": True,
            "zipEquivalenceSha256": sha256(zip_bytes),
            "changedLines": changed_lines,
            "changedLinesNotAboutTheToolchain": differing,
        },
        "gatewayCopies": copies,
        "frozenNotTouched": {name: sha256((ROOT / name).read_bytes()) for name in FROZEN if (ROOT / name).is_file()},
    }


def render_doc_block(comparison: dict[str, Any]) -> str:
    before, after, unchanged = comparison["before"], comparison["after"], comparison["unchanged"]
    count = comparison["packageCount"]
    lines = [
        BEGIN,
        "",
        f"Generated by `tools/regen_normalized_metadata.py` from `golden/toolchain_metadata_comparison.json` ({count} packages).",
        "",
        "| | Before | After |",
        "| --- | --- | --- |",
        f"| `compilerDigest` registered in `{comparison['golden']}` | `{before['compilerDigest']}` | `{after['compilerDigest']}` |",
        f"| SHA-256 of `{comparison['golden']}` | `{before['sha256']}` | `{after['sha256']}` |",
        f"| bytes of `{comparison['golden']}` | {before['bytes']} | {after['bytes']} |",
        "",
        "| Verified identical before writing | Packages |",
        "| --- | ---: |",
        f"| semantic digest | {unchanged['semanticDigests']} of {count} |",
        f"| section digests | {unchanged['sectionDigests']} of {count} |",
        f"| evaluations (`rollupDigest`, summaries, binding digests) | {unchanged['evaluations']} of {count} |",
        f"| binding space | {unchanged['bindingSpaces']} of {count} |",
        f"| candidate counts | {unchanged['candidates']} of {count} |",
        "",
        f"`golden/bim_normalized/zip_equivalence.json` recomputed and byte-identical (SHA-256 `{unchanged['zipEquivalenceSha256']}`). "
        f"Everything but the `toolchain` members equal: {unchanged['everythingButToolchain']}. "
        f"Lines changed: {unchanged['changedLines']}, of which not about `compilerDigest`/`irDigest`: "
        f"{unchanged['changedLinesNotAboutTheToolchain']}.",
        "",
        END,
    ]
    return "\n".join(lines)


def replace_block(text: str, block: str) -> str:
    start, end = text.find(BEGIN), text.find(END)
    if start < 0 or end < start:
        raise RegenError(f"the document has no {BEGIN} ... {END} block")
    return text[:start] + block + text[end + len(END):]


def current_block(text: str) -> str | None:
    start, end = text.find(BEGIN), text.find(END)
    if start < 0 or end < start:
        return None
    return text[start:end + len(END)]


def fresh_synthetic() -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as directory:
        return bc.build_synthetic(Path(directory))


def synthetic_problems(fresh: dict[str, Any]) -> list[str]:
    found = [f"{path}: {error}" for path, error in bc.zip_equivalence_failures(fresh["zipEquivalence"]).items()]
    found += [
        f"{path}: {entry['error']}" for path, entry in fresh["corpus"]["packages"].items() if entry["status"] != "compiled"
    ]
    return found


# --- commands ----------------------------------------------------------------------------------------------


def _corpus_directories(corpus_root: Path, expected: int) -> list[Path]:
    if not bc.corpus_available(corpus_root):
        raise RegenError(f"corpus not found under {corpus_root}; set BIM_CORPUS_ROOT or --corpus-root")
    directories = bc.package_directories(corpus_root)
    if len(directories) != expected:
        raise RegenError(f"expected {expected} packages, found {len(directories)}")
    return directories


def write(arguments: argparse.Namespace) -> int:
    repo_root = arguments.repo_root
    messages: list[str] = []
    old_comparison_exists = arguments.compare_out is not None and arguments.compare_out.is_file()
    comparison: dict[str, Any] | None = None

    if not arguments.synthetic_only:
        corpus_root = arguments.corpus_root
        directories = _corpus_directories(corpus_root, arguments.expected)
        old_bytes = NORMALIZED.read_bytes()
        old = json.loads(old_bytes)
        if bc.dump(old) != old_bytes:
            raise RegenError(f"{relative(NORMALIZED)} is not in the canonical byte form of baseline_core.dump")

        fresh = bc.build_corpus(directories, corpus_root, arguments.jobs)
        failed = {path: entry["error"] for path, entry in fresh["packages"].items() if entry["status"] != "compiled"}
        if failed:
            raise RegenError(f"packages that do not compile: {sorted(failed)[:3]}")
        zip_document = bc.build_zip_equivalence(directories, corpus_root, arguments.jobs)
        zip_failures = bc.zip_equivalence_failures(zip_document)
        if zip_failures:
            raise RegenError(f"directory/ZIP equivalence broken: {sorted(zip_failures)[:3]}")

        # Everything that is not a toolchain member must be what is recorded.
        moved = bc.differences("bim_normalized/corpus.json", fresh, old)
        if moved:
            raise RegenError(f"the corpus no longer matches the golden beyond its toolchain members: {moved[:5]}; this is not a metadata change")
        zip_bytes = ZIP_EQUIVALENCE.read_bytes()
        if bc.dump(zip_document) != zip_bytes:
            raise RegenError(f"{relative(ZIP_EQUIVALENCE)} is not what the toolchain computes: this is not a metadata change")

        new = with_toolchain(old, fresh)
        new_bytes = bc.dump(new)
        if bc.comparable(new) != bc.comparable(old):
            raise RegenError("internal error: the refreshed document differs in more than its toolchain members")
        stray = lines_not_about_the_toolchain(old_bytes, new_bytes)
        if stray:
            raise RegenError(f"lines other than compilerDigest/irDigest would change: {stray[:3]}")

        # The gateway's copies are byte copies of the golden; they must be so before and are written together.
        copies: dict[str, str] = {}
        targets = [NORMALIZED]
        for name in GATEWAY_COPIES:
            path = repo_root / name
            if path.is_file():
                if path.read_bytes() != old_bytes:
                    raise RegenError(f"{name} is not a byte copy of {relative(NORMALIZED)}: reconcile them first")
                targets.append(path)
                copies[name] = sha256(new_bytes)
        changed = new_bytes != old_bytes
        if changed:
            for path in targets:
                path.write_bytes(new_bytes)
            messages.append(f"toolchain members refreshed in {len(targets)} files ({sha256(old_bytes)[:12]} -> {sha256(new_bytes)[:12]})")
        else:
            messages.append("toolchain members already current")

        comparison = build_comparison(old, new, fresh, old_bytes, new_bytes, zip_bytes, copies)
        if arguments.compare_out is not None:
            if changed or not old_comparison_exists:
                arguments.compare_out.parent.mkdir(parents=True, exist_ok=True)
                arguments.compare_out.write_bytes(bc.dump(comparison))
                messages.append(f"comparison written to {arguments.compare_out}")
            else:
                comparison = json.loads(arguments.compare_out.read_text(encoding="utf-8"))
                messages.append(f"{arguments.compare_out} kept (nothing changed, so it still describes the last refresh)")
        if DOC.is_file():
            text = DOC.read_text(encoding="utf-8")
            updated = replace_block(text, render_doc_block(comparison))
            if updated != text:
                DOC.write_text(updated, encoding="utf-8")
                messages.append(f"{relative(DOC)} refreshed")

    fresh_documents = json.loads(bc.dump(fresh_synthetic()))
    broken = synthetic_problems(fresh_documents)
    if broken:
        raise RegenError(f"the synthetic packages do not compile or are not equivalent in every form: {broken[:3]}")
    if SYNTHETIC.is_file():
        existing = json.loads(SYNTHETIC.read_text(encoding="utf-8"))
        if bc.comparable(existing) != bc.comparable(fresh_documents):
            different = [key for key in fresh_documents if bc.comparable(existing.get(key)) != bc.comparable(fresh_documents[key])]
            raise RegenError(f"{relative(SYNTHETIC)} differs from what the toolchain computes beyond its toolchain members: {different}")
    data = bc.dump(fresh_documents)
    if not SYNTHETIC.is_file() or SYNTHETIC.read_bytes() != data:
        SYNTHETIC.parent.mkdir(parents=True, exist_ok=True)
        SYNTHETIC.write_bytes(data)
        messages.append(f"{relative(SYNTHETIC)} written ({sha256(data)[:12]})")
    else:
        messages.append(f"{relative(SYNTHETIC)} already current")

    messages.append("docs/OMG_XSD_RIGHTS.md table " + ("refreshed" if xsd_inventory.write(ROOT) else "already current"))
    for message in messages:
        print(message)
    if comparison is not None:
        print(
            f"compilerDigest {comparison['before']['compilerDigest']} -> {comparison['after']['compilerDigest']}; "
            f"golden sha256 {comparison['after']['sha256']}"
        )
    return 0


def check(arguments: argparse.Namespace) -> int:
    problems: list[str] = []
    installed = bc.compiler_bundle_digest()
    if not arguments.synthetic_only:
        corpus_root = arguments.corpus_root
        directories = _corpus_directories(corpus_root, arguments.expected)
        data = NORMALIZED.read_bytes()
        document = json.loads(data)
        if bc.dump(document) != data:
            problems.append(f"{relative(NORMALIZED)} is not in the canonical byte form")
        problems += toolchain_mismatches(document, installed, installed_ir_digests(corpus_root, directories))
        for name in GATEWAY_COPIES:
            path = arguments.repo_root / name
            if path.is_file() and path.read_bytes() != data:
                problems.append(f"{name} is not a byte copy of {relative(NORMALIZED)}")
        if not COMPARISON.is_file():
            problems.append(f"{relative(COMPARISON)} does not exist")
        else:
            comparison = json.loads(COMPARISON.read_text(encoding="utf-8"))
            if comparison["after"]["compilerDigest"] != installed:
                problems.append("the comparison does not describe the installed toolchain")
            if comparison["after"]["sha256"] != sha256(data):
                problems.append("the comparison does not describe the current golden (SHA-256 differs)")
            if DOC.is_file() and current_block(DOC.read_text(encoding="utf-8")) != render_doc_block(comparison):
                problems.append(f"{relative(DOC)} does not show the recorded comparison (run --write)")
    if not SYNTHETIC.is_file():
        problems.append(f"{relative(SYNTHETIC)} does not exist (run --write)")
    else:
        fresh = fresh_synthetic()
        if bc.dump(fresh) != SYNTHETIC.read_bytes():
            problems.append(f"{relative(SYNTHETIC)} is not what the installed toolchain computes (members or toolchain fields)")
    for item in problems:
        print(f"differs: {item}", file=sys.stderr)
    print(f"toolchain metadata check: installed {installed}; {len(problems)} problems")
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="refresh the toolchain members after verifying the rest is identical")
    mode.add_argument("--check", action="store_true", help="exit 1 if a golden registers another toolchain than the installed one")
    parser.add_argument("--compare-out", type=Path, help="write the before/after comparison here (with --write)")
    parser.add_argument("--corpus-root", type=Path, default=bc.default_corpus_root())
    parser.add_argument("--repo-root", type=Path, default=ROOT.parent, help="the OpenBinding root, for the gateway's copies")
    parser.add_argument("--expected", type=int, default=82)
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--synthetic-only", action="store_true", help="skip the corpus golden (a tree without the corpus)")
    arguments = parser.parse_args(argv)
    try:
        return write(arguments) if arguments.write else check(arguments)
    except RegenError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

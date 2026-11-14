#!/usr/bin/env python3
"""The phase F1 gate: every package the language claims to express survives a round trip.

For each package ``d`` of the gate,

    ir_digest(compile(emit(import_bim(d)))) == ir_digest(compile(d))

The gate is defined in ``docs/COMPOSITION2YAML.md`` section 11.2: the whole package set of
the normalized golden OpenBinding pins for its corpus,
``openbinding-gateway/tests/golden/bim_baseline/corpus.json`` (a byte copy of the release's
``golden/bim_normalized/corpus.json``), with no exclusions -- the language expresses every package in the corpus. Membership comes from the
golden file rather than from the walk, because the walk's membership is whatever is on disk;
the walk's job is finding the packages, and a package it finds that the golden does not hold
is reported rather than silently gated or silently skipped.

A BPMN workflow is read by delegation, so this passes the compiler to the importer. That is
the only reason the gate can hold the BPMN package at all, and the reduction it delegates is
exact: the BPMN package and its JSON twin compile to one IR digest.

This compares the **IR digest**, which strips a document's metadata, so it says nothing
about bytes. A package's own annotations do not survive a round trip and are not meant to:
reproducing a package byte for byte needs the opaque passthrough section 9 asks for.

Exit status is 0 when every gate package round trips, 1 otherwise. ``--json`` prints the
result as a document for a test to read instead of a human.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(name, None)
    return module


def _walk(root: Path) -> set[str]:
    """The packages on disk, through the same discovery CI uses."""
    tool = _load(root / "tools" / "check_bim_corpus.py", "_corpus_for_roundtrip")
    return {
        Path(directory).relative_to(root).as_posix()
        for directory in tool.package_directories(root)
    }


def gate(root: Path) -> tuple[list[str], list[str]]:
    """The gate, and the packages the walk finds that the golden does not hold."""
    corpus = json.loads(
        (root / "openbinding-gateway" / "tests" / "golden" / "bim_baseline" / "corpus.json").read_text(
            encoding="utf-8",
        ),
    )
    recorded = sorted(corpus["packages"])
    return recorded, sorted(_walk(root) - set(recorded))


def _files(directory: Path) -> dict[str, bytes]:
    return {entry.name: entry.read_bytes() for entry in directory.iterdir() if entry.is_file()}


def roundtrip(root: Path, package: str) -> dict[str, Any]:
    """One package through the round trip, reporting what happened rather than raising."""
    from bim_core import compile_instance, ir_digest
    from bim_core.package import InstancePackage
    from openbinding_gateway.composition.emit import emit
    from openbinding_gateway.composition.read import import_bim

    result: dict[str, Any] = {"package": package, "ok": False}
    try:
        original = _files(root / package)

        def compile(files: dict[str, bytes]) -> dict[str, Any]:
            return compile_instance(InstancePackage(files)).document

        before = ir_digest(compile(original))
        composition = import_bim(original, compile=compile)
        after = ir_digest(compile(emit(composition)))
    except Exception as error:  # noqa: BLE001 - every failure mode is a result, not a crash
        result["error"] = f"{type(error).__name__}: {error}"
        return result
    result["before"] = before
    result["after"] = after
    result["ok"] = before == after
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--json", action="store_true", help="print the result as a document")
    parser.add_argument("--expected", type=int, default=82, help="the gate's size")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    members, unrecorded = gate(root)
    results = [roundtrip(root, package) for package in members]
    failed = [item for item in results if not item["ok"]]
    document = {
        "gate": len(members),
        "unrecorded": unrecorded,
        "passed": len(results) - len(failed),
        "failed": failed,
    }
    if args.json:
        print(json.dumps(document, indent=2))
    else:
        print(f"gate: {len(members)} packages, the whole corpus")
        if unrecorded:
            print(f"  the walk finds {len(unrecorded)} the golden does not hold: {unrecorded}")
        print(f"round trip: {document['passed']} of {len(members)} reproduce their IR digest")
        for item in failed:
            reason = item.get("error") or f"{item['before'][:20]} -> {item['after'][:20]}"
            print(f"  FAILED {item['package']}: {reason}")
    if len(members) != args.expected:
        print(
            f"the gate holds {len(members)} packages, not {args.expected}: section 11.2 has to be "
            "re-read before this number is trusted",
            file=sys.stderr,
        )
        return 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

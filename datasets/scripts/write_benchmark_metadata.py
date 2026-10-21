#!/usr/bin/env python3
"""Write ``benchmark-metadata.json`` for every package of the six recovered suites.

The file is informational: the campaign identifies a package by its directory
and by the digest of its resources, which excludes this file
(``experimentation/qacobench/_common.py``). It records, for a reader of the
dataset deposit who does not have the software:

* the suite, the instance identity used in the campaign records and the
  admission class;
* the corrected provenance of the source benchmark, taken from the single
  source of truth ``datasets/recovery_catalogue.json`` (the first release
  carried attributions that did not match the sources);
* the transformation script, the package version and the fidelity annotations
  the transformer wrote into ``instance.json`` (source objective, attained
  extremes, value conventions, reference solutions);
* the SHA-256 of every resource and the package digest the campaign records,
  computed with the same recipe as the campaign.

QFBS packages are described by their generation manifest
(``datasets/07_qfbs/manifest.jsonl``) and get no file here.

Usage::

    python datasets/scripts/write_benchmark_metadata.py            # all six suites
    python datasets/scripts/write_benchmark_metadata.py --suite 06_bws_scp
    python datasets/scripts/write_benchmark_metadata.py --check    # verify, do not write
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
METADATA_VERSION = "qacobench/v2"
METADATA_FILE = "benchmark-metadata.json"
TRANSFORMERS = {
    "01_icws": "icws",
    "02_quantum": "quantum",
    "03_hsc_llm": "hsc",
    "04_rprsr15": "rprsr15",
    "05_iots": "iots",
    "06_bws_scp": "bws_scp",
}
# Annotation values larger than this (per-task tables such as avg_prescale) stay in instance.json only.
MAX_ANNOTATION_CHARS = 1500


def file_hashes(package_dir: Path) -> dict[str, str]:
    return {
        item.name: hashlib.sha256(item.read_bytes()).hexdigest()
        for item in sorted(package_dir.iterdir())
        if item.is_file() and item.name != METADATA_FILE
    }


def package_digest(hashes: dict[str, str]) -> str:
    # Identical to experimentation/qacobench/_common.py::package_digest_from_dir.
    digest = hashlib.sha256()
    for name, value in hashes.items():
        digest.update(f"{name}\0{value}\n".encode())
    return digest.hexdigest()


def packages(suite_dir: Path):
    for instance in sorted(suite_dir.rglob("instance.json")):
        yield instance.parent


def compact_annotations(annotations: dict) -> dict:
    kept = {}
    for key, value in sorted(annotations.items()):
        text = json.dumps(value, ensure_ascii=False, sort_keys=True)
        if len(text) <= MAX_ANNOTATION_CHARS:
            kept[key] = value
        else:
            kept[key] = f"(see instance.json; {len(text)} characters)"
    return kept


def build(entry: dict, suite_id: str, suite_dir: Path, package_dir: Path) -> dict:
    instance = json.loads((package_dir / "instance.json").read_text(encoding="utf-8"))
    metadata = instance.get("metadata", {}) if isinstance(instance, dict) else {}
    annotations = metadata.get("annotations", {}) if isinstance(metadata, dict) else {}
    hashes = file_hashes(package_dir)
    return {
        "metadata_version": METADATA_VERSION,
        "suite_id": suite_id,
        "suite_name": entry["name"],
        "instance_id": package_dir.relative_to(suite_dir).as_posix(),
        "instance_name": package_dir.name,
        "admission_class": entry["admission_class"],
        "audit_notes": entry.get("rationale", ""),
        "source": entry["source"],
        "transformation": {
            "script": f"datasets/scripts/transform_{TRANSFORMERS[suite_id]}.py",
            "package_version": metadata.get("version"),
            "annotations": compact_annotations(annotations) if isinstance(annotations, dict) else {},
        },
        "resources": sorted(hashes),
        "file_hashes": hashes,
        "package_hash": package_digest(hashes),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--datasets-root", type=Path, default=ROOT / "datasets")
    parser.add_argument("--catalogue", type=Path, default=ROOT / "datasets/recovery_catalogue.json")
    parser.add_argument("--suite", action="append", default=[], choices=sorted(TRANSFORMERS), help="restrict to a suite (repeatable)")
    parser.add_argument("--check", action="store_true", help="verify the existing files instead of writing them")
    args = parser.parse_args()

    catalogue = json.loads(args.catalogue.read_text(encoding="utf-8"))
    entries = {item["suite_id"]: item for item in catalogue.get("admitted_suites", [])}
    suites = args.suite or sorted(TRANSFORMERS)
    written = 0
    stale: list[str] = []
    for suite_id in suites:
        entry = entries.get(suite_id)
        suite_dir = args.datasets_root / suite_id
        if entry is None:
            print(f"{suite_id}: not in the recovery catalogue, skipped", file=sys.stderr)
            return 1
        if not suite_dir.is_dir():
            print(f"{suite_id}: {suite_dir} is missing, skipped")
            continue
        count = 0
        for package_dir in packages(suite_dir):
            document = build(entry, suite_id, suite_dir, package_dir)
            content = json.dumps(document, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
            target = package_dir / METADATA_FILE
            if args.check:
                if not target.is_file() or target.read_text(encoding="utf-8") != content:
                    stale.append(document["instance_id"])
            else:
                target.write_text(content, encoding="utf-8")
                written += 1
            count += 1
        expected = entry.get("instances_count")
        note = "" if expected in (None, count) else f" (catalogue expects {expected})"
        print(f"{suite_id}: {count} packages{note}")
    if args.check:
        if stale:
            print(f"{len(stale)} packages have missing or stale {METADATA_FILE}: {', '.join(stale[:5])}{' ...' if len(stale) > 5 else ''}")
            return 1
        print("all metadata files are current")
        return 0
    print(f"wrote {written} {METADATA_FILE} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

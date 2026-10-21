#!/usr/bin/env python3
"""Check that the instance packages under datasets/ are the ones a campaign ran on.

Every campaign record carries the digest of the package it was computed from
(sha256 over the package files, excluding benchmark-metadata.json). This script
recomputes that digest for every package found under the datasets root and
compares it with the records, so that the dataset archive released with the
results is exactly the corpus the results describe.

Usage: verify_dataset_digests.py [results.jsonl] [datasets-root]
       (defaults: .artifacts/qacobench/results.jsonl and datasets/, relative to the checkout)
Exit status 0 when every instance of the campaign is present with the same digest.
Standard library only, so it also runs where pandas is not installed.
"""
from __future__ import annotations

import collections
import hashlib
import json
import sys
from pathlib import Path


def package_digest(package_dir: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(package_dir.iterdir()):
        if item.is_file() and item.name != "benchmark-metadata.json":
            digest.update(f"{item.name}\0{hashlib.sha256(item.read_bytes()).hexdigest()}\n".encode())
    return digest.hexdigest()


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    results = Path(sys.argv[1]) if len(sys.argv) > 1 else root / ".artifacts/qacobench/results.jsonl"
    datasets = Path(sys.argv[2]) if len(sys.argv) > 2 else root / "datasets"

    recorded: dict[tuple[str, str], str] = {}
    with results.open() as handle:
        for line in handle:
            record = json.loads(line)
            suite, instance = record["suite"], record["instance_id"]
            if instance.startswith(suite + "/"):
                instance = instance[len(suite) + 1:]
            recorded[(suite, instance)] = record["package_digest"]

    found: dict[tuple[str, str], str] = {}
    for suite_dir in sorted(p for p in datasets.iterdir() if p.is_dir() and p.name[:2].isdigit()):
        for instance_file in suite_dir.rglob("instance.json"):
            package_dir = instance_file.parent
            found[(suite_dir.name, package_dir.relative_to(suite_dir).as_posix())] = package_digest(package_dir)

    missing = sorted(k for k in recorded if k not in found)
    mismatched = sorted(k for k in recorded if k in found and found[k] != recorded[k])
    extra = sorted(k for k in found if k not in recorded)
    by_suite = collections.Counter(k[0] for k in mismatched)

    print(f"campaign instances: {len(recorded)}  packages found: {len(found)}")
    print(f"missing: {len(missing)}  mismatched digests: {len(mismatched)}  packages not in the campaign: {len(extra)}")
    for suite, count in sorted(by_suite.items()):
        print(f"  mismatched in {suite}: {count}")
    for key in (missing + mismatched)[:10]:
        print("  e.g.", "/".join(key))
    ok = not missing and not mismatched
    print("OK: the packages match the campaign records" if ok else "NOT OK: regenerate the suites above (run.sh transform / generate) and check again")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

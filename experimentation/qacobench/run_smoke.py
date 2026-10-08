#!/usr/bin/env python3
"""Run one instance from each QFBS group through three engines."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from _common import discover_project_root

ROOT = discover_project_root(Path(__file__))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-url", default=os.environ.get("OPENBINDING_GATEWAY_URL", "http://localhost:8000"))
    parser.add_argument("--out", type=Path, default=ROOT / ".artifacts/qacobench/smoke.jsonl")
    parser.add_argument("--datasets-root", type=Path, default=ROOT / "datasets")
    args = parser.parse_args()
    args.datasets_root = args.datasets_root.resolve()
    root = args.datasets_root / "07_qfbs"
    packages = []
    for group in ("guaranteed", "non_guaranteed"):
        package = next((path.parent for path in sorted((root / group).rglob("instance.json"))), None)
        if package is None:
            raise SystemExit(f"missing QFBS smoke package: {group}")
        packages.append(package.relative_to(args.datasets_root))
    command = [
        sys.executable,
        str(Path(__file__).with_name("campaign.py")),
        "--gateway-url", args.gateway_url,
        "--instances-dir", str(args.datasets_root),
        "--timeout-ms", "5000",
        "--serial-engines",
        "--fresh",
        "--out", str(args.out),
    ]
    for package in packages:
        command.extend(("--package", str(package)))
    completed = subprocess.run(command, check=False)
    if completed.returncode:
        return completed.returncode
    failures = []
    records = [json.loads(line) for line in args.out.read_text(encoding="utf-8").splitlines()]
    for record in records:
        group = record["instance_id"].split("/", 1)[0]
        if record["status"] == "ERROR" or record.get("error"):
            failures.append({"record": record, "reason": "engine or infrastructure error"})
        if group == "guaranteed" and record["status"] == "UNSAT":
            failures.append({"record": record, "reason": "false UNSAT"})
        if record["status"] in {"OPTIMAL", "FEASIBLE"} and not record.get("binding"):
            failures.append({"record": record, "reason": "solution response has no binding"})
        if record["engine"] in {"random-search", "evolutionary-heuristics"} and record.get("binding") and not record.get("trace"):
            failures.append({"record": record, "reason": "missing heuristic incumbent trace"})
    for engine in ("minizinc-csp", "random-search", "evolutionary-heuristics"):
        if not any(record["engine"] == engine and record["instance_id"].startswith("guaranteed/")
                   and record.get("binding") for record in records):
            failures.append({"engine": engine, "reason": "guaranteed-feasible pilot returned no binding"})
    print(json.dumps({"runs": len(records), "failures": len(failures)}, indent=2))
    if failures:
        print(json.dumps(failures[:5], indent=2))
    return 2 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

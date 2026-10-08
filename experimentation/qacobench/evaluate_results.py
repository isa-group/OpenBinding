#!/usr/bin/env python3
"""Summarize recorded gateway outcomes without recompiling the corpus."""

from __future__ import annotations

import argparse
import collections
import csv
import json
import statistics
import time
from pathlib import Path
from typing import Any

from _common import DEFAULT_ENGINES, EXPECTED_SUITE_COUNTS, discover_project_root

ROOT = discover_project_root(Path(__file__))
STATUSES = ("OPTIMAL", "FEASIBLE", "UNSAT", "TIMEOUT", "INCOMPATIBLE", "ERROR")


def _write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _progress(path: Path, processed: int, status: str) -> None:
    path.write_text(json.dumps({
        "status": status,
        "records_processed": processed,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path, nargs="+")
    parser.add_argument("--datasets-root", type=Path, default=ROOT / "datasets")
    parser.add_argument("--out-dir", type=Path, default=ROOT / ".artifacts/qacobench/evaluation")
    parser.add_argument("--require-release-counts", action="store_true")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = args.datasets_root / "07_qfbs/manifest.jsonl"
    qfbs = {
        item["package_path"]: item
        for item in (json.loads(line) for line in manifest_path.read_text(encoding="utf-8").splitlines())
    }
    groups: dict[tuple[str, str], dict[str, Any]] = collections.defaultdict(
        lambda: {"submitted": 0, "processable": 0, "binding_returned": 0,
                 "statuses": collections.Counter(), "runtimes": []}
    )
    qfbs_groups: dict[tuple[str, str], dict[str, int]] = collections.defaultdict(
        lambda: {"runs": 0, "processable": 0, "binding_returned": 0, "timeout": 0, "unsat": 0}
    )
    seen: set[tuple[str, str, str]] = set()
    duplicates = infrastructure_errors = false_unsat = records = 0
    progress_path = args.out_dir / "progress.json"
    _progress(progress_path, 0, "running")
    for path in args.results:
        with path.open(encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, start=1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"{path}:{line_number}: {error}") from error
                records += 1
                suite, instance_id, engine = (str(record[key]) for key in ("suite", "instance_id", "engine"))
                identity = (suite, instance_id, engine)
                if identity in seen:
                    duplicates += 1
                seen.add(identity)
                status = str(record.get("status", "ERROR"))
                if status not in STATUSES:
                    raise ValueError(f"{path}:{line_number}: unclassified status {status!r}")
                if status == "ERROR" or (record.get("error") and status != "INCOMPATIBLE"):
                    infrastructure_errors += 1
                profile = qfbs.get(instance_id) if suite == "07_qfbs" else None
                if suite == "07_qfbs" and profile is None:
                    raise ValueError(f"{path}:{line_number}: QFBS package missing from generation manifest")
                group = groups[(suite, engine)]
                group["submitted"] += 1
                if status not in {"INCOMPATIBLE", "ERROR"}:
                    group["processable"] += 1
                returned = bool(record.get("binding")) and status in {"OPTIMAL", "FEASIBLE"}
                group["binding_returned"] += returned
                group["statuses"][status] += 1
                runtime = record.get("runtime_ms")
                if status not in {"INCOMPATIBLE", "ERROR"} and isinstance(runtime, (int, float)):
                    group["runtimes"].append(float(runtime))
                if profile:
                    qgroup = qfbs_groups[(profile["group"], engine)]
                    qgroup["runs"] += 1
                    qgroup["processable"] += status not in {"INCOMPATIBLE", "ERROR"}
                    qgroup["binding_returned"] += returned
                    qgroup["timeout"] += status == "TIMEOUT"
                    qgroup["unsat"] += status == "UNSAT"
                    false_unsat += profile["group"] == "guaranteed" and status == "UNSAT"
                if records % 5000 == 0:
                    _progress(progress_path, records, "running")
    outcomes = []
    summary = []
    for (suite, engine), group in sorted(groups.items()):
        row = {
            "suite": suite, "engine": engine,
            "submitted": group["submitted"],
            "processable": group["processable"],
            "binding_returned": group["binding_returned"],
            **{status.lower(): group["statuses"][status] for status in STATUSES},
        }
        outcomes.append(row)
        summary.append({
            "suite": suite, "engine": engine, "runs": group["submitted"],
            "binding_returned": group["binding_returned"],
            "return_rate": group["binding_returned"] / group["submitted"],
            "median_runtime_ms": statistics.median(group["runtimes"]) if group["runtimes"] else "",
        })
    _write_csv(args.out_dir / "outcomes_by_suite_engine.csv", outcomes,
               ["suite", "engine", "submitted", "processable", "binding_returned",
                *[status.lower() for status in STATUSES]])
    _write_csv(args.out_dir / "summary.csv", summary,
               ["suite", "engine", "runs", "binding_returned", "return_rate", "median_runtime_ms"])
    qfbs_rows = [
        {"group": group, "engine": engine, **values}
        for (group, engine), values in sorted(qfbs_groups.items())
    ]
    _write_csv(args.out_dir / "qfbs_outcomes.csv", qfbs_rows,
               ["group", "engine", "runs", "processable", "binding_returned", "timeout", "unsat"])
    latex = [r"\begin{tabular}{llrrrr}", r"\toprule",
             r"Suite & Engine & Runs & Binding & Return rate & Median ms \\",
             r"\midrule"]
    for row in summary:
        median = "--" if row["median_runtime_ms"] == "" else f'{row["median_runtime_ms"]:.1f}'
        latex.append(
            f'{row["suite"]} & {row["engine"]} & {row["runs"]} & '
            f'{row["binding_returned"]} & {100 * row["return_rate"]:.1f}\\% & {median} \\\\'
        )
    latex.extend([r"\bottomrule", r"\end{tabular}", ""])
    latex_dir = args.out_dir / "latex"
    latex_dir.mkdir(exist_ok=True)
    (latex_dir / "evaluation_results.tex").write_text("\n".join(latex), encoding="utf-8")
    expected_runs = sum(EXPECTED_SUITE_COUNTS.values()) * len(DEFAULT_ENGINES)
    count_ok = not args.require_release_counts or records == expected_runs
    acceptance = {
        "ok": count_ok and duplicates == 0 and infrastructure_errors == 0 and false_unsat == 0,
        "runs": records,
        "expected_runs": expected_runs if args.require_release_counts else None,
        "unique_triples": len(seen),
        "duplicates": duplicates,
        "infrastructure_errors": infrastructure_errors,
        "guaranteed_group_unsat_responses": false_unsat,
        "evaluation": "gateway outcomes and returned bindings; no independent binding re-evaluation",
    }
    (args.out_dir / "acceptance.json").write_text(json.dumps(acceptance, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    _progress(progress_path, records, "complete")
    print(json.dumps(acceptance, indent=2, sort_keys=True))
    return 0 if acceptance["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

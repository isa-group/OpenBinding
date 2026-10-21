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
    # Cross-engine reconciliation: per instance, the exact engine's label and every validated score.
    exact: dict[tuple[str, str], dict[str, Any]] = {}
    heuristic_scores: dict[tuple[str, str], list[tuple[str, float]]] = collections.defaultdict(list)
    reasons: collections.Counter = collections.Counter()
    incompatibilities: collections.Counter = collections.Counter()
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
                reasons[(suite, engine, status, str(record.get("termination_reason") or ""))] += 1
                if status == "INCOMPATIBLE":
                    messages = sorted({str(item.get("message") or "") for item in (record.get("diagnostics") or []) if isinstance(item, dict)})
                    incompatibilities[(suite, engine, " | ".join(messages)[:300] or str(record.get("error") or "")[:300])] += 1
                quality = record.get("quality")
                if int(record.get("repeat") or 0) == 0:
                    if engine == "minizinc-csp":
                        exact[(suite, instance_id)] = {"status": status, "quality": quality if isinstance(quality, (int, float)) else None}
                    elif returned and isinstance(quality, (int, float)):
                        heuristic_scores[(suite, instance_id)].append((engine, float(quality)))
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
    _write_csv(args.out_dir / "termination_reasons.csv",
               [{"suite": k[0], "engine": k[1], "status": k[2], "termination_reason": k[3], "runs": v}
                for k, v in sorted(reasons.items())],
               ["suite", "engine", "status", "termination_reason", "runs"])
    _write_csv(args.out_dir / "incompatibilities.csv",
               [{"suite": k[0], "engine": k[1], "diagnostics": k[2], "runs": v}
                for k, v in sorted(incompatibilities.items(), key=lambda item: (item[0][0], item[0][1], -item[1]))],
               ["suite", "engine", "diagnostics", "runs"])
    # Reconciliation of exact labels against validated heuristic bindings (tolerance 1e-9 on the score).
    unsat_with_binding: list[dict[str, Any]] = []
    optimal_beaten: list[dict[str, Any]] = []
    for key, label in exact.items():
        others = heuristic_scores.get(key, [])
        if label["status"] == "UNSAT" and others:
            unsat_with_binding.append({"suite": key[0], "instance_id": key[1], "engines": sorted({e for e, _q in others})})
        if label["status"] == "OPTIMAL" and label["quality"] is not None:
            best = min(others, key=lambda item: item[1], default=None)
            if best is not None and best[1] < label["quality"] - 1e-9:
                optimal_beaten.append({"suite": key[0], "instance_id": key[1], "optimal_score": label["quality"],
                                       "engine": best[0], "score": best[1]})
    (args.out_dir / "reconciliation_failures.json").write_text(json.dumps({
        "unsat_with_validated_binding": unsat_with_binding,
        "optimal_beaten_by_other_engine": optimal_beaten,
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    expected_runs = sum(EXPECTED_SUITE_COUNTS.values()) * len(DEFAULT_ENGINES)
    count_ok = not args.require_release_counts or records == expected_runs
    acceptance = {
        "ok": (count_ok and duplicates == 0 and infrastructure_errors == 0 and false_unsat == 0
               and not unsat_with_binding and not optimal_beaten),
        "runs": records,
        "expected_runs": expected_runs if args.require_release_counts else None,
        "unique_triples": len(seen),
        "duplicates": duplicates,
        "infrastructure_errors": infrastructure_errors,
        "guaranteed_group_unsat_responses": false_unsat,
        "unsat_with_validated_binding": len(unsat_with_binding),
        "optimal_beaten_by_other_engine": len(optimal_beaten),
        "evaluation": "gateway outcomes and returned bindings (validated by the gateway); exact labels are reconciled against the heuristic engines' validated scores with a 1e-9 tolerance",
    }
    (args.out_dir / "acceptance.json").write_text(json.dumps(acceptance, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    _progress(progress_path, records, "complete")
    print(json.dumps(acceptance, indent=2, sort_keys=True))
    return 0 if acceptance["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

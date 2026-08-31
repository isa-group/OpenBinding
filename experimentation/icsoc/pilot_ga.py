"""Preliminary study for the genetic-mode configuration on the hard app.

This pilot compares three valid ``elitist-genetic`` BIM engine configurations:

- ``pop20-default``        default variation, population 20
- ``pop50-default``        more diversity, population 50
- ``pop20-high-mutation``  population 20, higher mutation probability

Design: arOrch x sizes {70, 135, 220} x seeds {1, 2, 3} x 3 configs, run
sequentially (JMetalRandom is a JVM-global singleton), one wall-clock budget
T per run (default 300 s, same as the campaign). Results are appended to
``out/results/pilot_ga.csv`` (resumable; separate from the campaign files).

Decision rule: feasible-termination rate first, then median authoritative score
after the shared 1,000-evaluation cap.

Usage:
    python experimentation/icsoc/pilot_ga.py [--time-budget-ms 300000]
    python experimentation/icsoc/pilot_ga.py --summary   # analyze only
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
from typing import Any

from campaign import (
    DEFAULT_CORPUS,
    DEFAULT_GATEWAY,
    DEFAULT_RESULTS,
    RUN_FIELDS,
    RunSpec,
    _append_csv,
    _run_row,
    instance_meta,
    load_instance,
    solve_via_gateway,
)

PILOT_APP = "arOrch"
PILOT_SIZES = (70, 135, 220)
PILOT_SEEDS = (1, 2, 3)

PILOT_FIELDS = [RUN_FIELDS[0], "config", *RUN_FIELDS[1:]]


def pilot_configs(time_budget_ms: int) -> dict[str, dict[str, Any]]:
    base = {
        "algorithm": "elitist-genetic",
        "max_evaluations": 1000,
        "time_budget_ms": time_budget_ms,
    }
    return {
        "pop20-default": {**base, "population_size": 20},
        "pop50-default": {**base, "population_size": 50},
        "pop20-high-mutation": {
            **base,
            "population_size": 20,
            "mutation_probability": 0.2,
        },
    }


def _completed(pilot_csv: Path) -> set[str]:
    if not pilot_csv.exists():
        return set()
    with pilot_csv.open(encoding="utf-8") as fh:
        return {row["run_id"] for row in csv.DictReader(fh) if row.get("status") == "ok"}


def run_pilot(
    corpus: Path,
    results_dir: Path,
    base_url: str,
    time_budget_ms: int,
) -> None:
    pilot_csv = results_dir / "pilot_ga.csv"
    done = _completed(pilot_csv)

    instances = []
    for size in PILOT_SIZES:
        path = corpus / PILOT_APP / "146588263" / f"infrastructure_{size}" / "instance.json"
        instances.append((path, load_instance(path)))

    for config_name, options_base in pilot_configs(time_budget_ms).items():
        for path, instance in instances:
            meta = instance_meta(instance, path)
            for seed in PILOT_SEEDS:
                options = {**options_base, "seed": seed}
                run_id = f"{meta['instance_id']}|{config_name}#seed{seed}"
                if run_id in done:
                    continue
                spec = RunSpec("evolutionary-heuristics", seed, options)
                data, wall_s = solve_via_gateway(
                    base_url, spec.engine, instance, options,
                    max_poll_s=time_budget_ms / 1000 + 900,
                )
                row = _run_row(run_id, meta, spec, instance, data, wall_s)
                row["config"] = config_name
                _append_csv(pilot_csv, PILOT_FIELDS, [row])
                done.add(run_id)
                print(
                    f"{run_id}: status={row.get('status')} feasible={row.get('feasible')} "
                    f"obj={row.get('objective_value')} wall={row.get('wall_time_s')}s",
                    flush=True,
                )


def print_summary(results_dir: Path) -> None:
    import pandas as pd

    pilot_csv = results_dir / "pilot_ga.csv"
    runs = pd.read_csv(pilot_csv)
    runs["feasible"] = runs["feasible"].map(
        {True: True, False: False, "True": True, "False": False}
    ).astype("boolean")

    summary = runs.groupby("config").agg(
        runs=("run_id", "count"),
        feasibility_rate=("feasible", lambda s: s.fillna(False).mean()),
        median_J=("objective_value", lambda s: s[runs.loc[s.index, "feasible"].fillna(False)].median()),
        median_evals=("engine_evaluations", "median"),
    )
    print(summary.round(6).to_string())

    per_instance = runs[runs.feasible == True].pivot_table(
        index=["infra_size", "seed"], columns="config", values="objective_value"
    )
    print("\nPer-run canonical J (feasible only):")
    print(per_instance.round(6).to_string())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="3-way GA configuration pilot (arOrch)")
    parser.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    parser.add_argument("--results", default=str(DEFAULT_RESULTS))
    parser.add_argument("--gateway", default=DEFAULT_GATEWAY)
    parser.add_argument("--time-budget-ms", type=int, default=300_000)
    parser.add_argument("--summary", action="store_true", help="print the comparison and exit")
    args = parser.parse_args()

    if args.summary:
        print_summary(Path(args.results))
    else:
        run_pilot(Path(args.corpus), Path(args.results), args.gateway, args.time_budget_ms)
        print_summary(Path(args.results))

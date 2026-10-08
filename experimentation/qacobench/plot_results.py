#!/usr/bin/env python3
"""Rebuild the two paper figures from generation metadata and experiment CSV."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

STRUCTURES = ("Sequence", "Parallel", "XOR", "Repeat", "Parallel+XOR",
              "Parallel+repeat", "XOR+repeat", "Mixed")
ENGINES = ("minizinc-csp", "random-search", "evolutionary-heuristics")
SUITE_LABELS = {
    "01_icws": "OpenBinding scenarios",
    "02_quantum": "Quantum resource selection",
    "03_hsc_llm": "HSC",
    "04_rprsr15": "RPRSR15",
    "05_iots": "IoTS",
    "06_bws_scp": "BWS-SCP",
    "07_qfbs": "QFBS",
}


def _rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def rq1(manifest_rows: list[dict], output: Path) -> None:
    groups = ("guaranteed", "non_guaranteed")
    counts = np.zeros((2, 8, 3), dtype=int)
    seen = np.zeros((2, 8, 3), dtype=int)
    for row in manifest_rows:
        panel = groups.index(row["group"])
        structure = int(row["row"][0])
        seen[panel, structure] += 1
        for column, key in enumerate(("parallel", "xor", "repeat")):
            counts[panel, structure, column] += bool(row["observed_structure"][key])
    if (seen == 0).any():
        raise ValueError("RQ1 figure needs every QFBS structural profile")
    csv_path = output / "rq1_structure.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=["group", "structure", "construct", "observed", "instances", "proportion"])
        writer.writeheader()
        for panel, group in enumerate(groups):
            for i, structure in enumerate(STRUCTURES):
                for j, construct in enumerate(("Parallel", "XOR", "Repeat")):
                    writer.writerow({"group": group, "structure": structure, "construct": construct,
                                     "observed": counts[panel, i, j], "instances": seen[panel, i, j],
                                     "proportion": counts[panel, i, j] / seen[panel, i, j]})
    if not (np.array_equal(counts[0], counts[1]) and np.array_equal(seen[0], seen[1])):
        raise ValueError("A shared RQ1 panel requires identical structural counts in both groups")
    fig, ax = plt.subplots(figsize=(5.7, 3.8), layout="constrained")
    rows = _rows(csv_path)
    selected = [row for row in rows if row["group"] == groups[0]]
    proportions = np.array([float(row["proportion"]) for row in selected]).reshape(8, 3)
    image = ax.imshow(proportions, vmin=0, vmax=1, cmap="Blues", aspect="auto")
    ax.set_title("Control-flow constructs in QFBS")
    ax.set_xticks(range(3), ("Parallel", "XOR", "Repeat"))
    ax.set_yticks(range(8), STRUCTURES)
    ax.set_xlabel("Observed construct")
    ax.set_ylabel("Requested structure")
    for i in range(8):
        for j in range(3):
            row = selected[i * 3 + j]
            ax.text(j, i, f'{row["observed"]}/{row["instances"]}', ha="center", va="center",
                    color="white" if proportions[i, j] > 0.65 else "black", fontsize=8)
    fig.colorbar(image, ax=ax, label="Proportion within each group")
    fig.savefig(output / "rq1_structure.pdf")
    fig.savefig(output / "rq1_structure.svg")
    plt.close(fig)


def rq2(outcomes: list[dict[str, str]], output: Path) -> None:
    suites = sorted({row["suite"] for row in outcomes})
    by_key = {(row["suite"], row["engine"]): row for row in outcomes}
    if any((suite, engine) not in by_key for suite in suites for engine in ENGINES):
        raise ValueError("RQ2 figure needs all three engines for every suite")
    values = np.zeros((2, len(suites), len(ENGINES)))
    labels = [[[] for _ in suites] for _ in range(2)]
    for i, suite in enumerate(suites):
        for j, engine in enumerate(ENGINES):
            row = by_key[(suite, engine)]
            submitted, processable, returned = (int(row[key]) for key in ("submitted", "processable", "binding_returned"))
            values[0, i, j] = processable / submitted if submitted else 0
            values[1, i, j] = returned / processable if processable else np.nan
            labels[0][i].append(f"{processable}/{submitted}")
            labels[1][i].append(f"{returned}/{processable}")
    fig, axes = plt.subplots(2, 1, figsize=(7.2, 5.4), sharex=True, layout="constrained")
    for panel, (ax, title) in enumerate(zip(axes, ("Instance processability", "Binding yield among processable instances"))):
        image = ax.imshow(values[panel], vmin=0, vmax=1, cmap="Blues", aspect="auto")
        ax.set_title(title)
        ax.set_xticks(range(3), ("MiniZinc CSP", "Random Search", "Evolutionary\nHeuristics"))
        ax.set_yticks(range(len(suites)), [SUITE_LABELS.get(suite, suite) for suite in suites])
        for i in range(len(suites)):
            for j in range(3):
                ax.text(j, i, labels[panel][i][j], ha="center", va="center",
                        color="white" if values[panel, i, j] > 0.65 else "black", fontsize=8)
    fig.colorbar(image, ax=axes, label="Proportion")
    fig.savefig(output / "rq2_engine_coverage.pdf")
    fig.savefig(output / "rq2_engine_coverage.svg")
    plt.close(fig)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qfbs-manifest", type=Path, required=True)
    parser.add_argument("--outcomes-csv", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    manifest = [json.loads(line) for line in args.qfbs_manifest.read_text(encoding="utf-8").splitlines()]
    rq1(manifest, args.out_dir)
    rq2(_rows(args.outcomes_csv), args.out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

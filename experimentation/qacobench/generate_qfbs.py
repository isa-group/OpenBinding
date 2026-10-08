#!/usr/bin/env python3
"""Generate 5,200 QFBS instances through the HTTP API only."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path

import httpx

DESIGN_PATH = Path(__file__).with_name("design_matrix.json")
DESIGN = json.loads(DESIGN_PATH.read_text(encoding="utf-8"))
DESIGN_SHA256 = hashlib.sha256(DESIGN_PATH.read_bytes()).hexdigest()
ENGINES = DESIGN["engines"]
BASE_SEED = DESIGN["base_seed"]
STRUCTURES = (
    ("sequence", 0, 0, 0, 0), ("parallel", 35, 0, 0, 100),
    ("xor", 35, 0, 100, 0), ("repeat", 35, 100, 0, 0),
    ("parallel_xor", 40, 0, 50, 50), ("parallel_repeat", 40, 50, 0, 50),
    ("xor_repeat", 40, 50, 50, 0), ("mixed", 45, 33, 34, 33),
)
FEATURES = (
    ("cost", "EUR", "minimize", "selectedCandidate", 1, 100),
    ("latency", "ms", "minimize", "invocation", 1, 200),
    ("reliability", "1", "maximize", "selectedCandidate", 0.5, 1),
    ("availability", "1", "maximize", "selectedCandidate", 0.5, 1),
    ("security", "1", "maximize", "selectedCandidate", 0.5, 1),
)


def distribution(kind: str, low: float, high: float) -> dict:
    result = {"kind": kind, "minimum": low, "maximum": high}
    if kind == "normal":
        result.update(mean=(low + high) / 2, stddev=(high - low) / 6)
    return result


def features(value_distribution: int, aggregation: int, objectives: int) -> list[dict]:
    result = []
    for index, (name, unit, direction, scope, low, high) in enumerate(FEATURES):
        kind = "uniform" if value_distribution == 0 or (value_distribution == 2 and index >= 2) else "normal"
        if scope == "invocation":
            operators = ({"sequence": "max", "parallel": "max", "exclusive": "max", "repeat": "identity"}
                         if aggregation == 2 else
                         {"sequence": "sum", "parallel": "max", "exclusive": "weightedSum", "repeat": "scale"})
        else:
            operators = {"selection": "max" if name == "cost" and aggregation == 1 else
                         "sum" if name == "cost" else "min"}
        result.append({"id": name, "unit": unit, "direction": direction, "scope": scope,
                       "distribution": distribution(kind, low, high), "aggregation": operators,
                       "objective": index < objectives})
    return result


def request_for(row: tuple[int, ...], seed: int, name: str, *, group: str) -> dict:
    structure, candidate_kind, value_kind, count_mode, aggregation, size, tension, constraints, objectives = row
    _, flow, loops, branches, parallel = STRUCTURES[structure]
    result = {"tasks": (12, 24, 48)[size], "control_flow": flow, "constraints": (1, 3, 5)[constraints],
              "constraint_count_mode": ("exact", "expected")[count_mode],
              "features": features(value_kind, aggregation, (1, 3, 5)[objectives]),
              "target_engines": ENGINES, "optimization_mode": DESIGN["optimization_mode"],
              "guarantee_feasibility": DESIGN["groups"][group]["guarantee_feasibility"], "name": name, "seed": seed,
              "persist": False, "include_file_bytes": True}
    dists = {}
    if candidate_kind == 0:
        result["candidates"] = 5
    else:
        dists["candidate_count"] = distribution(("", "uniform", "normal")[candidate_kind], 3, 8)
    if flow:
        result.update(loops=loops, branches=branches, parallel=parallel, max_nesting=3)
        if loops:
            dists["loop_iterations"] = distribution("uniform", 2, 5)
        if branches:
            dists["branches_per_decision"] = distribution("uniform", 2, 4)
    settings = DESIGN["groups"][group]
    if settings["guarantee_feasibility"]:
        result["tension"] = settings["tension"][tension]
    else:
        dists["constraint_optimality_percent"] = distribution("uniform", *settings["threshold_percent"][tension])
    if dists:
        result["distributions"] = dists
    return result


def cases():
    for group in DESIGN["groups"]:
        for config in DESIGN["configurations"]:
            cell, row = config["cell"], tuple(config["levels"])
            for trial in range(config["trials"]):
                yield group, cell, trial, row, BASE_SEED + cell * 1000 + trial


def observed(node: dict) -> dict[str, bool]:
    found = {"parallel": False, "xor": False, "repeat": False}
    def visit(item: dict) -> None:
        for key, label in (("parallel", "parallel"), ("exclusive", "xor"), ("repeat", "repeat")):
            if key in item:
                found[label] = True
        for child in item.get("sequence", []) + item.get("parallel", []):
            visit(child)
        for branch in item.get("exclusive", []):
            visit(branch["flow"])
        if "repeat" in item:
            visit(item["repeat"]["body"])
    visit(node)
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-url", default=os.environ.get("OPENBINDING_GATEWAY_URL", "http://localhost:8000"))
    parser.add_argument("--target", type=Path, default=Path("datasets/07_qfbs"))
    parser.add_argument("--limit", type=int, default=5200, help="Number of instances; use a small value for smoke checks")
    parser.add_argument("--pilot", action="store_true", help="Generate one instance from each group")
    args = parser.parse_args()
    if not 1 <= args.limit <= 5200:
        parser.error("--limit must be between 1 and 5200")
    manifest = args.target / "manifest.jsonl"
    saved = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines()] if manifest.is_file() else []
    selected_cases = list(cases())
    selected_cases = [selected_cases[0], selected_cases[2600]] if args.pilot else selected_cases[:args.limit]
    expected_instances = len(selected_cases)
    if len(saved) > expected_instances:
        parser.error("manifest contains more instances than --limit")
    if any(item.get("design_sha256") != DESIGN_SHA256 for item in saved):
        parser.error("target contains a different design; choose a fresh directory")
    rows = []
    args.target.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=180) as client, manifest.open("a", encoding="utf-8") as output:
        for number, (group, cell, trial, row, seed) in enumerate(selected_cases):
            name = f"qfbs_{group}_{cell:02d}_{trial:03d}"
            request = request_for(row, seed, name, group=group)
            if number < len(saved):
                if saved[number]["request"] != request:
                    raise RuntimeError("existing manifest does not match the current QFBS design")
                continue
            response = client.post(args.gateway_url.rstrip("/") + "/v1/generator/instances", json=request)
            response.raise_for_status()
            data = response.json()
            raw = {filename: base64.b64decode(content, validate=True)
                   for filename, content in data["file_bytes_base64"].items()}
            package_dir = args.target / group / f"cell_{cell:02d}" / name
            package_dir.mkdir(parents=True, exist_ok=True)
            for filename, content in raw.items():
                (package_dir / filename).write_bytes(content)
            application = data["files"]["application.json"]["spec"]
            item = {"schema": "qacobench/qfbs-instance/v2", "design_sha256": DESIGN_SHA256,
                    "group": group, "cell": cell, "trial": trial, "row": list(row),
                    "seed": seed, "package_path": str(package_dir.relative_to(args.target)),
                    "request": request, "package_digest": data["package_digest"],
                    "compilation_digest": data["compilation_digest"],
                    "file_sha256": {filename: hashlib.sha256(content).hexdigest() for filename, content in sorted(raw.items())},
                    "actual_constraint_count": data["actual_constraint_count"],
                    "actual_task_count": len(application["tasks"]),
                    "actual_candidate_count": len(data["files"]["candidates.json"]["spec"]["candidates"]),
                    "observed_structure": observed(application["workflow"])}
            rows.append(item)
            output.write(json.dumps(item, sort_keys=True) + "\n")
            output.flush()
            os.fsync(output.fileno())
            if (number + 1) % 100 == 0:
                print(f"QFBS {number + 1}/{expected_instances} instances", flush=True)
    if len(saved) + len(rows) != expected_instances:
        raise RuntimeError("manifest remains incomplete")
    print(f"generated or resumed {expected_instances} instances")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

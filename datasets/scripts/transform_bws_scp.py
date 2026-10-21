#!/usr/bin/env python3
"""Transform BWS-SCP benchmark instances into BIM v1 packages.

Source: https://github.com/FMahroo/BWS-SCP (MIT)
Paper:  F. Mahroo, N. Moradi, N. Aftabi, M. Houshmand, O. Fatahi Valilai,
        "A Novel Integer Linear Model for Reliability-Centric Service Composition in Cloud
        Manufacturing", Computers & Industrial Engineering 211:111603, 2026.
        DOI: 10.1016/j.cie.2025.111603

The archive contains 90 ``.scp`` files (70 main, 14 alpha/beta scenarios, 6 validation cases).
Every instance assigns ``DIM_TASKS`` manufacturing tasks to ``DIM_SERVERS`` servers; a candidate is
one (task, server) pair with a completion time, a reliability and a cost.

Fidelity to the source MILP (``milp.py`` in the archive):

* **Objective.** The source minimises ``W1*T + W2*C - W3*sum(log r)`` with
  ``T = sum_i T[i,x_i]``, ``C = sum_i C[i,x_i]`` and ``sum_i log r[i,x_i]`` (the logarithm of the
  composite reliability, i.e. the classical logarithmic linearisation of the product) where the
  weights are the reciprocals of the attained ranges ``W1 = 1/(T_max - T_min)`` etc. computed from
  the per-task best and worst candidates. The BIM optimisation therefore carries three criteria
  normalised by exactly those attained extremes: ``execution_time`` (sum), ``cost`` (sum) and
  ``log_reliability`` (sum of ``ln r``, maximised). Up to a constant offset the weighted sum of
  normalised losses equals the source objective divided by three, so both have the same optima.
  The composite reliability itself is kept as the multiplicative feature ``reliability``
  (selected-candidate product) so that engines report it and so that the suite exercises product
  aggregation; it is not part of the objective because the source optimises its logarithm.
* **Capacity.** The source constraints ``sum_i D_i X_ij <= Cap_j`` are expressed with the
  ``qos-binding-placement/v1`` overlay: one pool per server with capacity ``units = Cap_j``, one
  demand per candidate ``units = D_i``, and a selected-candidate capacity rule. The source's
  ``cover`` constraint (the chosen server must be able to host the task) is implied.
* **Time-dependent cost scenarios** (``ALPHA``/``BETA`` sections, 14 instances) define
  ``C = sum_ij alpha_j T_ij X_ij + sum_j beta_j n_j^2`` where ``n_j`` is the number of tasks on
  server ``j``. The quadratic server-load term has no per-candidate counterpart in BIM; it is
  linearised as a per-assignment charge ``beta_j`` and the instances are annotated as
  ``cost_model = "alpha_time_plus_beta_linearised"``. Their optima are therefore not the optima of
  the source MINLP; the remaining 76 instances are exact.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "openbinding-gateway/src"))

from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import InstancePackage

PAPER = {
    "authors": "F. Mahroo, N. Moradi, N. Aftabi, M. Houshmand, O. Fatahi Valilai",
    "title": "A Novel Integer Linear Model for Reliability-Centric Service Composition in Cloud Manufacturing",
    "journal": "Computers & Industrial Engineering",
    "volume": 211,
    "pages": "111603",
    "year": 2026,
    "doi": "10.1016/j.cie.2025.111603",
}


def parse_scp(text: str) -> dict:
    d: dict = {}
    d["name"] = re.search(r"NAME\s*:\s*(\S+)", text).group(1)
    d["type"] = (re.search(r"TYPE\s*:\s*(\S+)", text) or [None, "SERVICE_COMPOSITION"])[1]
    d["tasks"] = int(re.search(r"DIM_TASKS\s*:\s*(\d+)", text).group(1))
    d["servers"] = int(re.search(r"DIM_SERVERS\s*:\s*(\d+)", text).group(1))

    sections = [
        "TIME_SECTION",
        "RELIABILITY_SECTION",
        "COST_SECTION",
        "ALPHA_SECTION",
        "BETA_SECTION",
        "DEMAND_SECTION",
        "CAPACITY_SECTION",
    ]
    for sec in sections:
        m = re.search(sec + r"\s*(.*?)(?=[A-Z_]+_SECTION|[A-Z_]+_RANGE|\Z)", text, re.DOTALL)
        if m:
            tokens = [x for x in m.group(1).split() if x != "EOF" and re.match(r"^-?[0-9.]", x)]
            d[sec] = [float(x) for x in tokens]
    nt, ns = d["tasks"], d["servers"]
    for sec, expected in (("TIME_SECTION", nt * ns), ("RELIABILITY_SECTION", nt * ns), ("DEMAND_SECTION", nt), ("CAPACITY_SECTION", ns)):
        if len(d.get(sec, [])) != expected:
            raise ValueError(f"{d['name']}: {sec} has {len(d.get(sec, []))} values, expected {expected}")
    if "COST_SECTION" in d and len(d["COST_SECTION"]) != nt * ns:
        raise ValueError(f"{d['name']}: COST_SECTION has {len(d['COST_SECTION'])} values, expected {nt * ns}")
    if "COST_SECTION" not in d and (len(d.get("ALPHA_SECTION", [])) != ns or len(d.get("BETA_SECTION", [])) != ns):
        raise ValueError(f"{d['name']}: time-dependent cost needs {ns} alpha and beta values")
    return d


def _attained_extremes(values: list[float], nt: int, ns: int) -> tuple[float, float]:
    """Sum over tasks of the per-task minimum / maximum candidate value (the source's T_min/T_max)."""
    lo = sum(min(values[i * ns:(i + 1) * ns]) for i in range(nt))
    hi = sum(max(values[i * ns:(i + 1) * ns]) for i in range(nt))
    return lo, hi


def transform_instance(name: str, raw_text: str) -> InstancePackage:
    d = parse_scp(raw_text)
    nt = d["tasks"]
    ns = d["servers"]

    times = d["TIME_SECTION"]
    rels = d["RELIABILITY_SECTION"]
    if any(r <= 0 for r in rels):
        raise ValueError(f"{name}: reliabilities must be positive for the logarithmic objective")
    demands = d["DEMAND_SECTION"]
    capacities = d["CAPACITY_SECTION"]

    if "COST_SECTION" in d:
        costs = d["COST_SECTION"]
        cost_model = "explicit"
    else:
        alpha = d["ALPHA_SECTION"]
        beta = d["BETA_SECTION"]
        costs = [alpha[j] * times[i * ns + j] + beta[j] for i in range(nt) for j in range(ns)]
        cost_model = "alpha_time_plus_beta_linearised"
    log_rels = [math.log(r) for r in rels]

    candidates = {}
    providers = {f"server_{j + 1}": {} for j in range(ns)}
    demand_entries = []
    for i in range(nt):
        tid = f"t_{i + 1}"
        for j in range(ns):
            idx = i * ns + j
            cid = f"c_{tid}_s{j + 1}"
            candidates[cid] = {
                "provides": f"service/{tid}",
                "provider": {"resource": "catalog", "id": f"server_{j + 1}"},
                "features": {
                    "execution_time": times[idx],
                    "reliability": rels[idx],
                    "log_reliability": log_rels[idx],
                    "cost": costs[idx],
                },
            }
            demand_entries.append({
                "candidate": {"resource": "catalog", "id": cid},
                "pool": {"resource": "placement", "id": f"server_{j + 1}"},
                "resources": {"units": demands[i]},
            })

    t_min, t_max = _attained_extremes(times, nt, ns)
    c_min, c_max = _attained_extremes(costs, nt, ns)
    lr_min, lr_max = _attained_extremes(log_rels, nt, ns)

    feature_defs = {
        "execution_time": {
            "direction": "minimize",
            "scope": "invocation",
            "aggregation": "sum",
            "domain": {"kind": "real", "minimum": 0.0, "maximum": max(times) * 1.5},
        },
        "cost": {
            "direction": "minimize",
            "scope": "selectedCandidate",
            "aggregation": "sum",
            "domain": {"kind": "real", "minimum": 0.0, "maximum": max(costs) * 1.5},
        },
        "reliability": {
            "direction": "maximize",
            "scope": "selectedCandidate",
            "aggregation": "product",
            "neutral": 1.0,
            "domain": {"kind": "ratio", "minimum": 0.0, "maximum": 1.0},
        },
        "log_reliability": {
            "direction": "maximize",
            "scope": "selectedCandidate",
            "aggregation": "sum",
            "domain": {"kind": "real", "minimum": min(log_rels) * 1.5, "maximum": 0.0},
        },
    }

    tasks_dict = {f"t_{i + 1}": f"service/t_{i + 1}" for i in range(nt)}
    workflow_seq = [{"task": {"resource": "application", "id": f"t_{i + 1}"}} for i in range(nt)]

    def _range(lo: float, hi: float) -> dict:
        # The source divides by the attained range; a degenerate range is widened by one unit so
        # that the normalised loss stays defined (every binding then scores the same on that term).
        return {"min": lo, "max": hi if hi > lo else lo + 1.0, "clamp": False}

    inst = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {
            "name": name,
            "version": "2.0.0",
            "description": f"BWS-SCP cloud manufacturing service composition instance {d['name']}: {nt} tasks, {ns} servers",
            "annotations": {
                "source": "https://github.com/FMahroo/BWS-SCP",
                "source_file": d["name"],
                "source_type": d["type"],
                "paper": PAPER,
                "license": "MIT",
                "cost_model": cost_model,
                "fidelity": "exact" if cost_model == "explicit" else "approximate (quadratic server-load cost term linearised)",
                "source_objective": "minimise W1*sum(T) + W2*sum(C) - W3*sum(log r); W = 1/(attained max - attained min)",
                "objective_weights": {"execution_time": 1.0, "cost": 1.0, "log_reliability": 1.0},
                "attained_extremes": {
                    "execution_time": [t_min, t_max],
                    "cost": [c_min, c_max],
                    "log_reliability": [lr_min, lr_max],
                },
                "capacity_model": "placement pools = servers (units = CAPACITY_SECTION); demands = DEMAND_SECTION per task; selected-candidate capacity rule",
            },
        },
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {"application": "application.json"},
                "candidateCatalog": {"catalog": "candidates.json", "placement": "placement.json"},
                "constraintSet": {"constraints": "constraints.json"},
                "optimization": {"optimization": "optimization.json"},
            },
        },
    }

    app = {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": f"{name}_application"},
        "spec": {
            "tasks": tasks_dict,
            "features": feature_defs,
            "workflow": {"sequence": workflow_seq},
        },
    }

    cat = {
        "apiVersion": "qos-binding/v1",
        "kind": "CandidateCatalog",
        "metadata": {"name": f"{name}_catalog"},
        "spec": {
            "providers": providers,
            "featureBindings": {k: {"resource": "application", "id": k} for k in feature_defs},
            "candidates": candidates,
        },
    }

    placement = {
        "apiVersion": "qos-binding-placement/v1",
        "kind": "Placement",
        "metadata": {"name": f"{name}_placement"},
        "spec": {
            "pools": {f"server_{j + 1}": {"kind": "SERVER", "capacity": {"units": capacities[j]}} for j in range(ns)},
            "demands": demand_entries,
            "capacityRules": [{"resources": ["units"], "scope": "selectedCandidate"}],
        },
    }

    cons = {
        "apiVersion": "qos-binding/v1",
        "kind": "ConstraintSet",
        "metadata": {"name": f"{name}_constraints"},
        "spec": {"constraints": {}},
    }

    opt = {
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "metadata": {"name": f"{name}_optimization"},
        "spec": {
            "criteria": [
                {
                    "id": "execution_time",
                    "feature": {"resource": "application", "id": "execution_time"},
                    "direction": "minimize",
                    "normalize": _range(t_min, t_max),
                },
                {
                    "id": "cost",
                    "feature": {"resource": "application", "id": "cost"},
                    "direction": "minimize",
                    "normalize": _range(c_min, c_max),
                },
                {
                    "id": "log_reliability",
                    "feature": {"resource": "application", "id": "log_reliability"},
                    "direction": "maximize",
                    "normalize": _range(lr_min, lr_max),
                },
            ]
        },
    }

    # The catalog and the demand table grow with tasks x servers (57,600 entries for
    # 240T240S); pretty-printed they exceed the gateway's 16 MiB per-entry limit, so
    # large tables are written compactly (same content, same digest rules).
    def _dump(document: dict, compact: bool) -> bytes:
        if compact:
            return (json.dumps(document, separators=(",", ":"), sort_keys=True) + "\n").encode()
        return (json.dumps(document, indent=2, sort_keys=True) + "\n").encode()

    compact = nt * ns > 2000
    files = {
        "instance.json": _dump(inst, False),
        "application.json": _dump(app, False),
        "candidates.json": _dump(cat, compact),
        "placement.json": _dump(placement, compact),
        "constraints.json": _dump(cons, False),
        "optimization.json": _dump(opt, False),
    }
    return InstancePackage(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--source",
        type=Path,
        default=ROOT / "datasets/sources/bws_scp",
        help="Path to uncompressed bws_scp directory or zip file",
    )
    parser.add_argument(
        "--target-dir",
        type=Path,
        default=ROOT / "datasets/06_bws_scp",
        help="Destination directory for transformed packages",
    )
    parser.add_argument("--compile-all", action="store_true", help="Compile every package (slow for the large category)")
    args = parser.parse_args()

    if not args.source.exists():
        raise SystemExit(f"Source not found: {args.source}")

    args.target_dir.mkdir(parents=True, exist_ok=True)

    entries: list[tuple[str, str, str]] = []  # (category, stem, text_content)
    if args.source.is_dir():
        for sp in sorted(args.source.glob("**/*.scp")):
            category = sp.parent.name
            entries.append((category, sp.stem, sp.read_text(encoding="utf-8")))
    else:
        zf = zipfile.ZipFile(args.source)
        scp_files = sorted([f for f in zf.namelist() if f.endswith(".scp")])
        for path_in_zip in scp_files:
            fn = Path(path_in_zip)
            category = fn.parent.name
            entries.append((category, fn.stem, zf.read(path_in_zip).decode("utf-8")))

    print(f"Transforming {len(entries)} BWS-SCP instances into {args.target_dir}...")
    written_count = 0
    sample_compiled = 0

    for idx, (category, stem, raw) in enumerate(entries):
        inst_name = f"bws_{category}_{stem.lower()}".replace("-", "_").replace(".", "_")
        inst_name = re.sub(r"_+", "_", inst_name)

        pkg = transform_instance(inst_name, raw)

        # Validate compilation on smaller categories and periodic samples
        if args.compile_all or category in ("small", "validation") or idx % 15 == 0:
            compile_instance(pkg)
            sample_compiled += 1

        out_dir = args.target_dir / inst_name
        out_dir.mkdir(parents=True, exist_ok=True)
        for stale in out_dir.iterdir():
            if stale.is_file() and stale.name not in pkg.files:
                stale.unlink()
        for rel_path, content in pkg.files.items():
            (out_dir / rel_path).write_bytes(content)

        written_count += 1
        if written_count % 15 == 0 or written_count == len(entries):
            print(f"  [{written_count}/{len(entries)}] Written {inst_name} (compiled sample: {sample_compiled})")

    print(f"Successfully transformed all {written_count}/{len(entries)} BWS-SCP instances ({sample_compiled} validated with full compiler)!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

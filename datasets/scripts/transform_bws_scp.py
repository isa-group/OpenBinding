#!/usr/bin/env python3
"""Transform BWS-SCP benchmark instances into BIM v1 packages.

Source: https://github.com/FMahroo/BWS-SCP
Paper: Mahroo et al., 'Reliability-centric cloud manufacturing business workflow service composition problem',
       Computers & Industrial Engineering, 2025. DOI: 10.1016/j.cie.2025.111603.
Archive contains 90 .scp benchmark files representing task allocation and service composition
with server capacities, task demands, and 3 QoS dimensions: Time, Cost, Reliability.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "openbinding-gateway/src"))

from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import InstancePackage


def parse_scp(text: str) -> dict:
    d = {}
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
    return d


def transform_instance(name: str, raw_text: str) -> InstancePackage:
    d = parse_scp(raw_text)
    nt = d["tasks"]
    ns = d["servers"]

    times = d["TIME_SECTION"]
    rels = d["RELIABILITY_SECTION"]

    if "COST_SECTION" in d:
        costs = d["COST_SECTION"]
    else:
        alpha = d["ALPHA_SECTION"]
        beta = d["BETA_SECTION"]
        costs = [alpha[j] * times[i * ns + j] + beta[j] for i in range(nt) for j in range(ns)]

    candidates = {}
    providers = {f"server_{j + 1}": {} for j in range(ns)}

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
                    "cost": costs[idx],
                },
            }

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
            "domain": {"kind": "real", "minimum": 0.0, "maximum": max(1.0, max(rels))},
        },
    }

    tasks_dict = {f"t_{i + 1}": f"service/t_{i + 1}" for i in range(nt)}
    workflow_seq = [{"task": {"resource": "application", "id": f"t_{i + 1}"}} for i in range(nt)]

    inst = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {
            "name": name,
            "version": "1.0.0",
            "description": f"BWS-SCP cloud manufacturing benchmark instance: {nt} tasks, {ns} servers",
            "annotations": {
                "source": "https://github.com/FMahroo/BWS-SCP",
                "paper": {
                    "authors": "F. Mahroo et al.",
                    "title": "Reliability-centric cloud manufacturing business workflow service composition problem",
                    "journal": "Computers & Industrial Engineering",
                    "year": 2025,
                    "doi": "10.1016/j.cie.2025.111603",
                },
                "server_capacities": d.get("CAPACITY_SECTION", []),
                "task_demands": d.get("DEMAND_SECTION", []),
                "license": "MIT",
            },
        },
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {"application": "application.json"},
                "candidateCatalog": {"catalog": "candidates.json"},
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
                    "id": k,
                    "feature": {"resource": "application", "id": k},
                    "direction": feature_defs[k]["direction"],
                    "normalize": {
                        "min": 0.0,
                        "max": float(max(times if k == "execution_time" else costs if k == "cost" else rels)),
                        "clamp": True,
                    },
                }
                for k in feature_defs
            ]
        },
    }

    files = {
        "instance.json": (json.dumps(inst, indent=2, sort_keys=True) + "\n").encode(),
        "application.json": (json.dumps(app, indent=2, sort_keys=True) + "\n").encode(),
        "candidates.json": (json.dumps(cat, indent=2, sort_keys=True) + "\n").encode(),
        "constraints.json": (json.dumps(cons, indent=2, sort_keys=True) + "\n").encode(),
        "optimization.json": (json.dumps(opt, indent=2, sort_keys=True) + "\n").encode(),
    }
    return InstancePackage(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
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
        if category in ("small", "validation") or idx % 15 == 0:
            compiled = compile_instance(pkg)
            sample_compiled += 1

        out_dir = args.target_dir / inst_name
        out_dir.mkdir(parents=True, exist_ok=True)
        for rel_path, content in pkg.files.items():
            (out_dir / rel_path).write_bytes(content)

        written_count += 1
        if written_count % 15 == 0 or written_count == len(entries):
            print(f"  [{written_count}/{len(entries)}] Written {inst_name} (compiled sample: {sample_compiled})")

    print(f"Successfully transformed all {written_count}/{len(entries)} BWS-SCP instances ({sample_compiled} validated with full compiler)!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

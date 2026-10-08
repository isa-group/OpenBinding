#!/usr/bin/env python3
"""Transform RPRSR15 benchmark instances (Ramirez et al. 2017 / Parejo et al. 2014) into BIM v1 packages.

Source: https://www.uco.es/grupos/kdis/sbse/RPRSR15/
Paper: Ramirez et al., 'Evolutionary composition of QoS-aware web services: a many-objective perspective',
       Expert Systems with Applications, 2017. DOI: 10.1016/j.eswa.2016.10.047.
Instance Generator: Parejo et al., 'QoS-aware web services composition using GRASP with path relinking',
       Expert Systems with Applications, 2014. DOI: 10.1016/j.eswa.2013.12.036.
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

FEATURE_DEFS = {
    "throughput": {
        "direction": "maximize",
        "scope": "invocation",
        "aggregation": "min",
        "domain": {"kind": "real", "minimum": 0.0, "maximum": 100.0},
    },
    "availability": {
        "direction": "maximize",
        "scope": "invocation",
        "aggregation": "product",
        "domain": {"kind": "real", "minimum": 0.0, "maximum": 100.0},
    },
    "latency": {
        "direction": "minimize",
        "scope": "invocation",
        "aggregation": "sum",
        "domain": {"kind": "real", "minimum": 0.0, "maximum": 10000.0},
    },
    "documentation": {
        "direction": "maximize",
        "scope": "invocation",
        "aggregation": "min",
        "domain": {"kind": "real", "minimum": 0.0, "maximum": 100.0},
    },
    "successability": {
        "direction": "maximize",
        "scope": "invocation",
        "aggregation": "product",
        "domain": {"kind": "real", "minimum": 0.0, "maximum": 100.0},
    },
    "bestpractices": {
        "direction": "maximize",
        "scope": "invocation",
        "aggregation": "min",
        "domain": {"kind": "real", "minimum": 0.0, "maximum": 100.0},
    },
    "reliability": {
        "direction": "maximize",
        "scope": "invocation",
        "aggregation": "product",
        "domain": {"kind": "real", "minimum": 0.0, "maximum": 100.0},
    },
    "responsetime": {
        "direction": "minimize",
        "scope": "invocation",
        "aggregation": "sum",
        "domain": {"kind": "real", "minimum": 0.0, "maximum": 10000.0},
    },
    "compliance": {
        "direction": "maximize",
        "scope": "invocation",
        "aggregation": "min",
        "domain": {"kind": "real", "minimum": 0.0, "maximum": 100.0},
    },
}


def parse_workflow(text: str) -> dict:
    text = re.sub(r"%\s*.*", "", text)
    tokens = re.findall(r"SEC\[|BRANCH\([^)]*\)\[|\]|,|\d+", text)
    pos = 0
    branch_counter = 0

    def parse_node():
        nonlocal pos, branch_counter
        if pos >= len(tokens):
            return {"empty": True}
        tok = tokens[pos]
        if tok == "SEC[":
            pos += 1
            seq = []
            while pos < len(tokens) and tokens[pos] != "]":
                if tokens[pos] == ",":
                    pos += 1
                    continue
                child = parse_node()
                if child:
                    seq.append(child)
            if pos < len(tokens) and tokens[pos] == "]":
                pos += 1
            if not seq:
                return {"empty": True}
            if len(seq) == 1:
                return seq[0]
            return {"sequence": seq}
        elif tok.startswith("BRANCH("):
            pos += 1
            branches = []
            while pos < len(tokens) and tokens[pos] != "]":
                if tokens[pos] == ",":
                    pos += 1
                    continue
                child = parse_node()
                branch_counter += 1
                b_id = f"b_{branch_counter}"
                branches.append({"id": b_id, "flow": child or {"empty": True}})
            if pos < len(tokens) and tokens[pos] == "]":
                pos += 1
            if not branches:
                return {"empty": True}
            return {"exclusive": branches}
        elif re.match(r"^\d+$", tok):
            tid = f"t_{tok}"
            pos += 1
            return {"task": {"resource": "application", "id": tid}}
        elif tok == ",":
            pos += 1
            return None
        else:
            pos += 1
            return None

    return parse_node()


def transform_instance_text(name: str, raw: str) -> tuple[dict, InstancePackage]:
    m_wf = re.search(r"% CompositionStructure:\s*%\s*-+\s*(.*?)(?=%#|\Z)", raw, re.DOTALL)
    if not m_wf:
        raise ValueError(f"No CompositionStructure found in {name}")
    wf_node = parse_workflow(m_wf.group(1).strip())

    cand_sec = raw.split("%#======================= CANDIDATE SERVICES =============================#")[1].split("%#======================= CONSTRAINTS =============================#")[0]
    cand_blocks = re.split(r"-{10,}\s*(\d+)\s*-{10,}", cand_sec)

    tasks_in_cand = set(cand_blocks[i].strip() for i in range(1, len(cand_blocks), 2))
    candidates = {}
    providers = {}

    for i in range(1, len(cand_blocks), 2):
        task_num = cand_blocks[i].strip()
        task_id = f"t_{task_num}"
        lines = cand_blocks[i + 1].strip().splitlines()
        for line_idx, line in enumerate(lines):
            line = line.strip()
            if not line or "(" not in line:
                continue
            svc_name, attrs_part = line.split("(", 1)
            svc_name = svc_name.strip()
            attrs_part = attrs_part.rstrip("),")
            qos_dict = {}
            for pair in attrs_part.split(","):
                if ":" in pair:
                    k, v = pair.split(":", 1)
                    k = k.strip().lower()
                    try:
                        val = float(v.strip())
                        if k in ("latency", "responsetime"):
                            val = abs(val)
                        qos_dict[k] = val
                    except ValueError:
                        pass
            cand_id = f"c_{task_num}_{line_idx}"
            prov_id = f"p_{re.sub(r'[^A-Za-z0-9_]+', '_', svc_name)}"[:60]
            providers[prov_id] = {}
            candidates[cand_id] = {
                "provides": f"service/{task_id}",
                "provider": {"resource": "catalog", "id": prov_id},
                "features": qos_dict,
            }

    tasks_dict = {f"t_{tid}": f"service/t_{tid}" for tid in sorted(tasks_in_cand, key=int)}

    has_exclusive = "exclusive" in json.dumps(wf_node)
    resources = {
        "application": {"application": "application.json"},
        "candidateCatalog": {"catalog": "candidates.json"},
        "constraintSet": {"constraints": "constraints.json"},
        "optimization": {"optimization": "optimization.json"},
    }
    if has_exclusive:
        resources["candidateCatalog"]["routing"] = "routing.json"

    inst = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {
            "name": name,
            "version": "1.0.0",
            "description": f"RPRSR15 many-objective QoS-aware service composition benchmark instance: {name}",
            "annotations": {
                "source": "https://www.uco.es/grupos/kdis/sbse/RPRSR15/",
                "paper": {
                    "authors": "J. Ramirez et al.",
                    "title": "Evolutionary composition of QoS-aware web services: a many-objective perspective",
                    "journal": "Expert Systems with Applications",
                    "year": 2017,
                    "doi": "10.1016/j.eswa.2016.10.047",
                },
                "generator_paper": {
                    "authors": "J. A. Parejo, S. Segura, P. Fernandez, A. Ruiz-Cortes",
                    "title": "QoS-aware web services composition using GRASP with path relinking",
                    "journal": "Expert Systems with Applications",
                    "year": 2014,
                    "doi": "10.1016/j.eswa.2013.12.036",
                },
                "source_license": "Academic / Research Open Benchmark",
            },
        },
        "spec": {
            "profile": "qos-binding/v1",
            "resources": resources,
        },
    }

    app = {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": f"{name}_application"},
        "spec": {
            "tasks": tasks_dict,
            "features": FEATURE_DEFS,
            "workflow": wf_node,
        },
    }

    cat = {
        "apiVersion": "qos-binding/v1",
        "kind": "CandidateCatalog",
        "metadata": {"name": f"{name}_catalog"},
        "spec": {
            "providers": providers,
            "featureBindings": {k: {"resource": "application", "id": k} for k in FEATURE_DEFS},
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
                    "direction": FEATURE_DEFS[k]["direction"],
                    "normalize": {"min": 0, "max": 100, "clamp": True},
                }
                for k in FEATURE_DEFS
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

    if has_exclusive:
        routing = {
            "apiVersion": "qos-binding/v1",
            "kind": "RoutingOverlay",
            "metadata": {"name": f"{name}_routing"},
            "spec": {"uniform": True},
        }
        files["routing.json"] = (json.dumps(routing, indent=2, sort_keys=True) + "\n").encode()

    pkg = InstancePackage(files)
    return inst, pkg


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=ROOT / "datasets/sources/rprsr15",
        help="Path to uncompressed rprsr15 directory or zip file",
    )
    parser.add_argument(
        "--target-dir",
        type=Path,
        default=ROOT / "datasets/04_rprsr15",
        help="Destination directory for transformed packages",
    )
    args = parser.parse_args()

    if not args.source.exists():
        raise SystemExit(f"Source not found: {args.source}")

    args.target_dir.mkdir(parents=True, exist_ok=True)
    
    entries: list[tuple[str, str, str]] = []  # (exp, base, text_content)
    if args.source.is_dir():
        txt_paths = sorted(args.source.glob("**/*.txt"))
        for tp in txt_paths:
            exp = tp.parent.name
            base = tp.stem
            entries.append((exp, base, tp.read_text(encoding="latin1")))
    else:
        zf = zipfile.ZipFile(args.source)
        txt_files = sorted([f for f in zf.namelist() if f.endswith(".txt")])
        for path_in_zip in txt_files:
            fn = Path(path_in_zip)
            exp = fn.parent.name
            base = fn.stem
            entries.append((exp, base, zf.read(path_in_zip).decode("latin1")))

    print(f"Transforming {len(entries)} RPRSR15 instances into {args.target_dir}...")
    compiled_count = 0

    for exp, base, raw in entries:
        inst_name = f"rprsr15_{exp}_{base}".replace("-", "_")

        _, pkg = transform_instance_text(inst_name, raw)
        compiled = compile_instance(pkg)

        out_dir = args.target_dir / inst_name
        out_dir.mkdir(parents=True, exist_ok=True)
        for rel_path, content in pkg.files.items():
            (out_dir / rel_path).write_bytes(content)

        compiled_count += 1

    print(f"Successfully transformed and compiled {compiled_count}/{len(entries)} RPRSR15 instances!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

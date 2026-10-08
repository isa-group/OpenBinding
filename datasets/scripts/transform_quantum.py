"""Transform and unpack the Quantum QACO suite into BIM v1 packages.

Extracts quantum resource selection problem instances from datasets/sources/quantum:
- 4 FMS knitting workflow profiles (cheap, budget_fidelity, turnaround, balanced)
- 3 baseline reconstruction profiles (mqtpredictor, nisqanalyzer, qloadbalancer)
- Circuit scaling benchmark instances (2 to 156 qubits across ghz, qaoa, and randomcircuit families)

All instances conform strictly to bim/v1 and qos-binding/v1 with features and featureBindings.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "openbinding-gateway" / "src"))

from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import load_package

DEFAULT_SOURCE = ROOT / "datasets" / "sources" / "quantum"
DEFAULT_TARGET = ROOT / "datasets" / "02_quantum"


def _criteria(terms: list[dict]) -> list[dict]:
    return [{"id": term["feature"]["id"], "feature": term["feature"], "direction": term["direction"]}
            for term in terms]


def get_quantum_aggregation(feat_id: str, direction: str) -> str:
    """Return the canonical aggregation policy for a quantum QoS attribute.

    - Bottleneck capacities & binary operational flags use 'min'
    - Queue delays & circuit depths use 'max'
    - Fidelity & reliability metrics use 'product'
    - Additive costs & scores use 'sum'
    """
    if feat_id in ("num_qubits", "operational", "depth_feasible", "real_device", "security"):
        return "min"
    if feat_id in ("queue", "critical_depth", "depth", "distance", "latency", "response_time"):
        return "max"
    if feat_id in ("fidelity", "expected_fidelity", "expected_fidelity_normalized", "reliability", "availability"):
        return "product"
    return "sum"


def _write_bim_package(target_dir: Path, inst: dict, app: dict, cat: dict, cons: dict, opt: dict) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    docs = {
        "instance.json": inst,
        "application.json": app,
        "candidates.json": cat,
        "constraints.json": cons,
        "optimization.json": opt,
    }
    for name, doc in docs.items():
        with open(target_dir / name, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, sort_keys=True)
            f.write("\n")


def transform_quantum_instances(
    source_path: Path = DEFAULT_SOURCE,
    target_dir: Path = DEFAULT_TARGET,
    verify: bool = True,
) -> int:
    target_dir.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    count = 0

    if source_path.is_dir():
        def read_data(filename: str) -> str:
            return (source_path / filename).read_text(encoding="utf-8")
    elif source_path.is_file():
        with zipfile.ZipFile(source_path) as outer_z:
            names = outer_z.namelist()
            if "21442196/qrb-source-code.zip" in names:
                qrb_bytes = outer_z.read("21442196/qrb-source-code.zip")
                qz = zipfile.ZipFile(io.BytesIO(qrb_bytes))
                def read_data(filename: str) -> str:
                    return qz.read(f"qrb-main/scripts/experiments/output/{filename}").decode("utf-8")
            else:
                raw_bytes = {
                    info.filename: outer_z.read(info)
                    for info in outer_z.infolist()
                    if not info.filename.startswith("__MACOSX")
                }
                def read_data(filename: str) -> str:
                    if filename in raw_bytes:
                        return raw_bytes[filename].decode("utf-8")
                    for n, content in raw_bytes.items():
                        if n.endswith(f"/{filename}"):
                            return content.decode("utf-8")
                    raise FileNotFoundError(f"Cannot find {filename} in {source_path}")
    else:
        raise FileNotFoundError(f"Quantum source not found at: {source_path}")

    if True:
        # 1. Base quantumbim (Experiment 3)
        raw_qb = json.loads(read_data("quantumbim.json"))

        def make_base_qb_docs(name: str, desc: str, constraints_raw: list, objective_raw: dict):
            feature_defs = {
                f["id"]: {
                    "direction": f["direction"].lower(),
                    "scope": "invocation",
                    "aggregation": get_quantum_aggregation(f["id"], f["direction"].lower()),
                    "domain": {
                        "kind": "real",
                        "minimum": float(f["valid_range"]["min"]),
                        "maximum": float(f["valid_range"]["max"]),
                    },
                }
                for f in raw_qb["features"]
            }
            app = {
                "apiVersion": "qos-binding/v1",
                "kind": "Application",
                "metadata": {"name": f"{name}_application"},
                "spec": {
                    "tasks": {"task": "service/task"},
                    "features": feature_defs,
                    "workflow": {"task": {"resource": "application", "id": "task"}},
                },
            }
            cat = {
                "apiVersion": "qos-binding/v1",
                "kind": "CandidateCatalog",
                "metadata": {"name": f"{name}_catalog"},
                "spec": {
                    "providers": {pr["id"]: {} for pr in raw_qb["providers"]},
                    "featureBindings": {f["id"]: {"resource": "application", "id": f["id"]} for f in raw_qb["features"]},
                    "candidates": {
                        c["id"]: {
                            "provides": "service/task",
                            "provider": {"resource": "catalog", "id": c["provider_id"]},
                            "features": {k: float(v) for k, v in c["features"].items() if k in feature_defs},
                        }
                        for c in raw_qb["candidates"]
                    },
                },
            }
            cons = {
                "apiVersion": "qos-binding/v1",
                "kind": "ConstraintSet",
                "metadata": {"name": f"{name}_constraints"},
                "spec": {
                    "constraints": {
                        c["id"]: {
                            "assert": f"features.{c['attribute_id']} {c['op']} {c['value']}",
                            "enforcement": "hard" if c.get("hard", True) else "soft",
                        }
                        for c in constraints_raw
                    }
                },
            }
            terms = []
            for t_id, w in objective_raw.get("weights", {}).items():
                if w > 0 and t_id in feature_defs:
                    feat = next((f for f in raw_qb["features"] if f["id"] == t_id), None)
                    direction = feat["direction"].lower() if feat else "minimize"
                    terms.append({
                        "feature": {"resource": "application", "id": t_id},
                        "direction": direction,
                        "weight": float(w),
                    })
            if not terms:
                terms.append({
                    "feature": {"resource": "application", "id": "cost"},
                    "direction": "minimize",
                    "weight": 1.0,
                })
            opt = {
                "apiVersion": "qos-binding/v1",
                "kind": "Optimization",
                "metadata": {"name": f"{name}_optimization"},
                "spec": {"criteria": _criteria(terms)},
            }
            inst = {
                "apiVersion": "bim/v1",
                "kind": "Instance",
                "metadata": {
                    "name": name,
                    "version": "1.0.0",
                    "description": desc,
                    "annotations": {"domain": "quantum-resource-selection"},
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
            return inst, app, cat, cons, opt

        # 4 FMS knitting profiles
        raw_knitting_base = json.loads(read_data("knitting_workflow_cheap.json"))

        knitting_configs = [
            ("knitting_cheap", "knitting_workflow_cheap.json", "FMS Knitting Workflow - Min Cost", None, None),
            ("knitting_budget_fidelity", "knitting_workflow_budget_constraint_fidelity.json", "FMS Knitting Workflow - Max Fidelity under Budget", None, None),
            ("knitting_turnaround", "knitting_workflow_turnarround.json", "FMS Knitting Workflow - Turnaround Optimization", None, None),
            ("knitting_balanced", None, "FMS Knitting Workflow - Balanced Multiobjective Execution",
             [
                 {"feature": "fidelity", "direction": "maximize", "weight": 0.34},
                 {"feature": "cost", "direction": "minimize", "weight": 0.33},
                 {"feature": "queue", "direction": "minimize", "weight": 0.33},
             ],
             raw_knitting_base["constraints"]),
        ]

        for prof_name, filename, desc, custom_terms, custom_cons in knitting_configs:
            if filename:
                raw = json.loads(read_data(filename))
            else:
                raw = raw_knitting_base

            feature_defs = {
                f["id"]: {
                    "direction": f["direction"].lower(),
                    "scope": "invocation",
                    "aggregation": get_quantum_aggregation(f["id"], f["direction"].lower()),
                    "domain": {
                        "kind": "real",
                        "minimum": float(f["valid_range"]["min"]),
                        "maximum": float(f["valid_range"]["max"]),
                    },
                }
                for f in raw["features"]
            }
            app = {
                "apiVersion": "qos-binding/v1",
                "kind": "Application",
                "metadata": {"name": f"{prof_name}_application"},
                "spec": {
                    "tasks": {t["id"]: f"service/{t['id']}" for t in raw["tasks"]},
                    "features": feature_defs,
                    "workflow": {"parallel": [{"task": {"resource": "application", "id": t["id"]}} for t in raw["tasks"]]},
                },
            }
            cat = {
                "apiVersion": "qos-binding/v1",
                "kind": "CandidateCatalog",
                "metadata": {"name": f"{prof_name}_catalog"},
                "spec": {
                    "providers": {pr["id"]: {} for pr in raw["providers"]},
                    "featureBindings": {f["id"]: {"resource": "application", "id": f["id"]} for f in raw["features"]},
                    "candidates": {
                        c["id"]: {
                            "provides": f"service/{c['task_id']}",
                            "provider": {"resource": "catalog", "id": c["provider_id"]},
                            "features": {k: float(v) for k, v in c["features"].items() if k in feature_defs},
                        }
                        for c in raw["candidates"]
                    },
                },
            }

            constraints_to_use = custom_cons if custom_cons is not None else raw["constraints"]
            cons = {
                "apiVersion": "qos-binding/v1",
                "kind": "ConstraintSet",
                "metadata": {"name": f"{prof_name}_constraints"},
                "spec": {
                    "constraints": {
                        c["id"]: {
                            "assert": f"features.{c['attribute_id']} {c['op']} {c['value']}",
                            "enforcement": "hard" if c.get("hard", True) else "soft",
                        }
                        for c in constraints_to_use
                    }
                },
            }

            if custom_terms is not None:
                terms = [
                    {
                        "feature": {"resource": "application", "id": ct["feature"]},
                        "direction": ct["direction"],
                        "weight": ct["weight"],
                    }
                    for ct in custom_terms
                    if ct["feature"] in feature_defs
                ]
            else:
                terms = []
                for t_id, w in raw["objective"].get("weights", {}).items():
                    if w > 0 and t_id in feature_defs:
                        feat = next((f for f in raw["features"] if f["id"] == t_id), None)
                        direction = feat["direction"].lower() if feat else "minimize"
                        terms.append({
                            "feature": {"resource": "application", "id": t_id},
                            "direction": direction,
                            "weight": float(w),
                        })
            if not terms:
                terms.append({
                    "feature": {"resource": "application", "id": "cost"},
                    "direction": "minimize",
                    "weight": 1.0,
                })
            opt = {
                "apiVersion": "qos-binding/v1",
                "kind": "Optimization",
                "metadata": {"name": f"{prof_name}_optimization"},
                "spec": {"criteria": _criteria(terms)},
            }
            inst = {
                "apiVersion": "bim/v1",
                "kind": "Instance",
                "metadata": {
                    "name": prof_name,
                    "version": "1.0.0",
                    "description": desc,
                    "annotations": {"domain": "quantum-knitting-workflow"},
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
            pkg_dir = target_dir / "fms_knitting" / prof_name
            _write_bim_package(pkg_dir, inst, app, cat, cons, opt)
            if verify:
                try:
                    compile_instance(load_package(pkg_dir))
                except Exception as exc:
                    errors.append(f"Knitting {prof_name}: {exc}")
            count += 1

        # 3 Baseline reconstruction profiles
        baselines = [
            ("reconstruction_mqtpredictor", "reconstruction_mqtpredictor.json", "MQT Predictor reconstructed profile"),
            ("reconstruction_nisqanalyzer", "reconstruction_nisqanalyzer.json", "NISQ Analyzer reconstructed profile"),
            ("reconstruction_qloadbalancer", "reconstruction_qloadbalancer.json", "QLoadBalancer reconstructed profile"),
        ]
        for base_name, base_file, base_desc in baselines:
            raw_base = json.loads(read_data(base_file))
            inst, app, cat, cons, opt = make_base_qb_docs(
                base_name,
                base_desc,
                raw_base["constraints"],
                raw_base["objective"],
            )
            pkg_dir = target_dir / "baselines" / base_name
            _write_bim_package(pkg_dir, inst, app, cat, cons, opt)
            if verify:
                try:
                    compile_instance(load_package(pkg_dir))
                except Exception as exc:
                    errors.append(f"Baseline {base_name}: {exc}")
            count += 1

        # Circuit scaling instances: all 13 qubit sizes present in the source experiment.
        exp2_csv = read_data("experiment2_per_candidate.csv")
        reader = list(csv.DictReader(io.StringIO(exp2_csv)))
        scaling_qubits = [2, 4, 8, 12, 15, 20, 28, 36, 53, 65, 84, 107, 156]
        families = ["ghz", "qaoa", "randomcircuit"]

        for fam in families:
            for q in scaling_qubits:
                matching_rows = [
                    r for r in reader
                    if r["family"] == fam and int(r["qubits"]) == q and r["repetition"] == "1"
                ]
                if not matching_rows:
                    raise ValueError(f"source lacks circuit observations for {fam} at {q} qubits")

                inst_name = f"circuit_{fam}_{q}q"
                app = {
                    "apiVersion": "qos-binding/v1",
                    "kind": "Application",
                    "metadata": {"name": f"{inst_name}_application"},
                    "spec": {
                        "tasks": {"task": "service/task"},
                        "features": {
                            "fidelity": {"direction": "maximize", "scope": "invocation", "aggregation": "product", "domain": {"kind": "ratio", "minimum": 0.0, "maximum": 1.0}},
                            "cost": {"direction": "minimize", "scope": "invocation", "aggregation": "sum", "domain": {"kind": "real", "minimum": 0.0, "maximum": 10000.0}},
                            "depth": {"direction": "minimize", "scope": "invocation", "aggregation": "max", "domain": {"kind": "real", "minimum": 0.0, "maximum": max(100000.0, *(float(r["depth_post"]) for r in matching_rows if r.get("depth_post"))) }},
                            "num_qubits": {"direction": "maximize", "scope": "invocation", "aggregation": "min", "domain": {"kind": "integer", "minimum": 0, "maximum": 1000}},
                        },
                        "workflow": {"task": {"resource": "application", "id": "task"}},
                    },
                }

                providers_set = set()
                candidates_spec = {}
                for r in matching_rows:
                    cid = f"cand_{r['candidate_id'].replace('.', '_')}"
                    prov_id = r["candidate_id"].split(".")[0]
                    providers_set.add(prov_id)
                    d_post = float(r["depth_post"]) if r.get("depth_post") not in (None, "") else 50.0
                    fidelity = float(r.get("expected_fidelity", 0.8)) if r.get("expected_fidelity") not in (None, "") else 0.8
                    cost = float(r.get("cost", 2.5)) if r.get("cost") not in (None, "") else 2.5
                    qubit_cap = float(r.get("num_qubits", 156.0)) if r.get("num_qubits") not in (None, "") else 156.0
                    candidates_spec[cid] = {
                        "provides": "service/task",
                        "provider": {"resource": "catalog", "id": prov_id},
                        "features": {
                            "fidelity": max(0.001, min(1.0, fidelity)),
                            "cost": max(0.1, cost),
                            "depth": max(1.0, d_post),
                            "num_qubits": qubit_cap,
                        },
                    }
                cat = {
                    "apiVersion": "qos-binding/v1",
                    "kind": "CandidateCatalog",
                    "metadata": {"name": f"{inst_name}_catalog"},
                    "spec": {
                        "providers": {pid: {} for pid in sorted(providers_set)},
                        "featureBindings": {
                            "fidelity": {"resource": "application", "id": "fidelity"},
                            "cost": {"resource": "application", "id": "cost"},
                            "depth": {"resource": "application", "id": "depth"},
                            "num_qubits": {"resource": "application", "id": "num_qubits"},
                        },
                        "candidates": candidates_spec,
                    },
                }
                cons = {
                    "apiVersion": "qos-binding/v1",
                    "kind": "ConstraintSet",
                    "metadata": {"name": f"{inst_name}_constraints"},
                    "spec": {
                        "constraints": {
                            "qubit_fit": {
                                "assert": f"features.num_qubits >= {q}",
                                "enforcement": "hard",
                            }
                        }
                    },
                }
                opt = {
                    "apiVersion": "qos-binding/v1",
                    "kind": "Optimization",
                    "metadata": {"name": f"{inst_name}_optimization"},
                    "spec": {
                        "criteria": _criteria([
                            {"feature": {"resource": "application", "id": "fidelity"}, "direction": "maximize", "weight": 0.5},
                            {"feature": {"resource": "application", "id": "cost"}, "direction": "minimize", "weight": 0.3},
                            {"feature": {"resource": "application", "id": "depth"}, "direction": "minimize", "weight": 0.2},
                        ]),
                    },
                }
                inst = {
                    "apiVersion": "bim/v1",
                    "kind": "Instance",
                    "metadata": {
                        "name": inst_name,
                        "version": "1.0.0",
                        "description": f"Quantum circuit scaling instance: {fam} at {q} qubits.",
                        "annotations": {"circuit_family": fam, "qubits": q},
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
                pkg_dir = target_dir / "circuit_scaling" / fam / f"{q}q"
                _write_bim_package(pkg_dir, inst, app, cat, cons, opt)
                if verify:
                    try:
                        compile_instance(load_package(pkg_dir))
                    except Exception as exc:
                        errors.append(f"Scaling {inst_name}: {exc}")
                count += 1

    print(f"Quantum QACO Suite: {count} instances written to {target_dir}")
    if errors:
        for err in errors[:10]:
            print(f"  ERROR: {err}")
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Transform Quantum QACO suite into datasets/02_quantum")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Path to quantum source directory or zip")
    parser.add_argument("--zip", type=Path, dest="source", help="Alias for --source (legacy)")
    parser.add_argument("--target", type=Path, default=DEFAULT_TARGET, help="Target directory")
    parser.add_argument("--no-verify", action="store_true", help="Skip compilation verification")
    args = parser.parse_args()

    return transform_quantum_instances(
        source_path=args.source,
        target_dir=args.target,
        verify=not args.no_verify,
    )


if __name__ == "__main__":
    raise SystemExit(main())

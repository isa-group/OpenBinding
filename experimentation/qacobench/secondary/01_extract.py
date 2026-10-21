#!/usr/bin/env python3
"""Step 1: flatten results.jsonl and the QFBS generation manifest into compact pickled tables.

Outputs (in the secondary directory): ``runs.pkl`` (one row per run, with the per-run objective
components, trace milestones, termination reason and repeat index), ``diagnostics.pkl`` (one row per
INCOMPATIBLE diagnostic, both the gateway's structured capability diagnostics and the engines' 422
texts) and ``qfbs_manifest.pkl`` (one row per QFBS instance with its design factors).
"""
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import RESULTS, QFBS_MANIFEST, OUT, FACTORS

rows = []
diag_rows = []
with open(RESULTS) as f:
    for line in f:
        r = json.loads(line)
        trace = r.get("trace") or []
        first = trace[0] if trace else None
        last = trace[-1] if trace else None
        binding = r.get("binding") or {}
        comps = (r.get("objectives") or {}).get("components") or []
        violations = r.get("violations") or []
        engine_ref = r.get("engine_ref") or (r.get("provenance") or {}).get("engine") or {}
        row = {
            "suite": r["suite"],
            "instance_id": r["instance_id"],
            "engine": r["engine"],
            "repeat": int(r.get("repeat") or 0),
            "seed": r.get("seed"),
            "status": r["status"],
            "termination": r.get("termination"),
            "termination_reason": r.get("termination_reason"),
            "runtime_ms": r.get("runtime_ms"),
            "wall_ms": r.get("wall_ms"),
            "overhead_ms": r.get("overhead_ms"),
            "quality": r.get("quality"),
            "penalty": (r.get("objectives") or {}).get("penalty"),
            "n_components": len(comps),
            "n_bound_tasks": len(binding),
            "n_violations": len(violations),
            "n_hard_violations": sum(1 for v in violations if isinstance(v, dict) and v.get("enforcement") == "hard"),
            "n_soft_violations": sum(1 for v in violations if isinstance(v, dict) and v.get("enforcement") == "soft"),
            "evaluations": r.get("engine_evaluations"),
            "trace_len": len(trace),
            "first_feasible_ms": first["elapsed_ms"] if first else None,
            "first_feasible_eval": first.get("eval_index") if first else None,
            "first_feasible_obj": first.get("best_objective") if first else None,
            "best_ms": last["elapsed_ms"] if last else None,
            "best_eval": last.get("eval_index") if last else None,
            "best_obj": last.get("best_objective") if last else None,
            "engine_version": engine_ref.get("version"),
            "package_digest": r.get("package_digest"),
        }
        for c in comps:
            row[f"val_{c['criteria']}"] = c.get("value")
            row[f"loss_{c['criteria']}"] = c.get("loss")
            row[f"w_{c['criteria']}"] = c.get("weight")
        for k, v in (r.get("features") or {}).items():
            row[f"feat_{k}"] = v
        rows.append(row)
        if r["status"] == "INCOMPATIBLE":
            for d in r.get("diagnostics") or []:
                diag_rows.append({"suite": r["suite"], "instance_id": r["instance_id"], "engine": r["engine"],
                                  "message": d.get("message") if isinstance(d, dict) else str(d),
                                  "raw": json.dumps(d)[:800]})
            if r.get("error") and not r.get("diagnostics"):
                diag_rows.append({"suite": r["suite"], "instance_id": r["instance_id"], "engine": r["engine"],
                                  "message": str(r["error"])[:400], "raw": str(r["error"])[:800]})

df = pd.DataFrame(rows)
df.to_pickle(f"{OUT}/runs.pkl")
pd.DataFrame(diag_rows, columns=["suite", "instance_id", "engine", "message", "raw"]).to_pickle(f"{OUT}/diagnostics.pkl")
print("runs", df.shape, "diagnostics", len(diag_rows), "repeats", int(df.repeat.max()) + 1 if len(df) else 0)

# QFBS manifest
mrows = []
with open(QFBS_MANIFEST) as f:
    for line in f:
        m = json.loads(line)
        req = m["request"]
        row = {
            "instance_id": m["package_path"],
            "group": m["group"], "cell": m["cell"], "trial": m["trial"], "seed": m["seed"],
            "n_tasks": m["actual_task_count"], "n_candidates": m["actual_candidate_count"],
            "n_constraints": m["actual_constraint_count"],
            "obs_parallel": m["observed_structure"]["parallel"],
            "obs_xor": m["observed_structure"]["xor"],
            "obs_repeat": m["observed_structure"]["repeat"],
            "req_tasks": req["tasks"], "req_constraints": req["constraints"],
            "req_constraint_count_mode": req["constraint_count_mode"],
            "req_control_flow": req.get("control_flow"),
            "req_tension": req.get("tension"),
            "req_threshold": json.dumps(req.get("distributions", {}).get("constraint_optimality_percent")),
            "n_objectives": sum(1 for ft in req["features"] if ft["objective"]),
            "sha_application": m["file_sha256"].get("application.json"),
            "sha_candidates": m["file_sha256"].get("candidates.json"),
            "sha_constraints": m["file_sha256"].get("constraints.json"),
            "sha_optimization": m["file_sha256"].get("optimization.json"),
            "sha_routing": m["file_sha256"].get("routing.json"),
            "package_digest": m["package_digest"],
        }
        for i, name in enumerate(FACTORS):
            row[f"f_{name}"] = m["row"][i]
        mrows.append(row)
mdf = pd.DataFrame(mrows)
mdf.to_pickle(f"{OUT}/qfbs_manifest.pkl")
print("manifest", mdf.shape)

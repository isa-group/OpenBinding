#!/usr/bin/env python3
"""Step 3: HSC characterisation and solution quality against the source reference compositions (RQ4).

HSC constraints are the soft, squared-violation penalties of the source paper (Eq. 2), so every
instance admits a binding and the question is quality, not feasibility. For each of the 10,000
instances this step records the workflow shape (levels, parallel activities, candidate pools), the
reference composition published by the authors (``best_solution.json``) with its objective recomputed
on the released data (Eq. 1 + Eq. 2; ``reference_objective`` in the package annotations), and, per
heuristic engine, the gateway-validated score, its penalty part, whether the binding equals the
reference and the gap ``score - reference_objective`` (negative: better than the authors' solution).

Outputs: ``hsc_instances.csv``, ``hsc_quality_summary.json``, ``hsc_quality_by_constraints.csv``,
``hsc_quality_by_space.csv``.
"""
import collections
import json
import math
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import HSC_SOURCE as SRC, HSC_DIR, RESULTS, OUT, TOL

wf = json.load(open(f"{SRC}/workflow.json"))
bs = json.load(open(f"{SRC}/best_solution.json"))
models = json.load(open(f"{SRC}/normalized_model.json"))

# Paper ordering: downloads, likes, response time, waiting time, reliability, successability
# (identical to datasets/scripts/transform_hsc.py::FEAT_META).
FEAT = {
    "normalized_downloads": ("maximize", "sum", "average number of downloads", False, 0.5),
    "normalized_likes": ("maximize", "sum", "average number of likes", False, 0.5),
    "normalized_response_times": ("minimize", "max", "average response time", False, 0.5),
    "normalized_waiting_times": ("minimize", "max", "average waiting time", False, 0.5),
    "reliabilities": ("maximize", "min", "reliability", True, 0.9),
    "successabilities": ("maximize", "min", "successability", True, 0.9),
}
by_func = collections.defaultdict(list)
for i, m in enumerate(models):
    by_func[m["function"]].append(i)


def feature_values(stages, binding_models):
    out = {}
    for fid, (_direction, par, _key, geometric, default) in FEAT.items():
        level_values = []
        k = 0
        for stage in stages:
            vals = []
            for _ in stage:
                vals.append(float(models[binding_models[k]].get(fid, default)))
                k += 1
            level_values.append(vals[0] if len(vals) == 1 else {"sum": sum, "max": max, "min": min}[par](vals))
        n = max(1, len(stages))
        if geometric:
            prod = 1.0
            for v in level_values:
                prod *= v
            out[fid] = prod ** (1.0 / n)
        else:
            out[fid] = sum(level_values) / n
    return out


def paper_objective(w, binding_models):
    """(Eq. 1 weighted objective, Eq. 2 squared-violation penalty) of a binding on the released data."""
    values = feature_values(w.get("flow", []), binding_models)
    objective = penalty = 0.0
    for fid, (direction, _par, key, _geo, _default) in FEAT.items():
        weight = float(w.get("obj_func", {}).get(key, 0.0))
        objective += weight * (values[fid] if direction == "minimize" else 1.0 - values[fid])
        c = float(w.get("cons", {}).get(key, 0.0))
        if c > 0:
            gap = values[fid] - c
            violation = max(0.0, gap) if direction == "minimize" else min(0.0, gap)
            penalty += violation * violation
    return objective, penalty


# ---- campaign records for HSC (reference repeat only), with bindings
recs = {}
with open(RESULTS) as f:
    for line in f:
        if '"03_hsc_llm"' not in line:
            continue
        r = json.loads(line)
        if r["suite"] != "03_hsc_llm" or int(r.get("repeat") or 0) != 0:
            continue
        recs.setdefault(r["instance_id"], {})[r["engine"]] = r

ENGINES = (("evolutionary-heuristics", "GA"), ("random-search", "RS"), ("minizinc-csp", "MZN"))
rows = []
annotation_checks = 0
for idx, w in enumerate(wf):
    stages = w["flow"]
    acts = [c for s in stages for c in s]
    n_tasks = len(acts)
    pools = [len(by_func[c]) for c in acts]
    cons = {k: v for k, v in w.get("cons", {}).items() if v > 0}
    objs = {k: v for k, v in w.get("obj_func", {}).items() if v > 0}
    b = bs[idx] if idx < len(bs) else {}
    ref = b.get("best_solution", []) or []
    instance_id = f"batch_{(idx // 1000) * 1000:04d}_{(idx // 1000) * 1000 + 999:04d}/hsc_{idx:04d}"
    row = {"idx": idx, "instance_id": instance_id,
           "n_tasks": n_tasks, "n_levels": len(stages), "max_parallel": max((len(s) for s in stages), default=0),
           "n_candidates_total": sum(pools), "cand_per_task_min": min(pools) if pools else 0, "cand_per_task_max": max(pools) if pools else 0,
           "log10_space": sum(math.log10(p) for p in pools if p > 0),
           "n_constraints": len(cons), "n_objectives": len(objs), "best_value": b.get("best_value"), "ref_complete": len(ref) == n_tasks}
    if row["ref_complete"]:
        objective, penalty = paper_objective(w, list(ref))
        row.update({"ref_objective": objective + penalty, "ref_objective_part": objective, "ref_penalty": penalty,
                    "ref_violates_own_constraints": penalty > 1e-12})
        # cross-check with the annotation the transformer wrote into the package (when present)
        package = HSC_DIR / instance_id / "instance.json"
        if package.is_file() and annotation_checks < 200:
            ann = json.load(open(package)).get("metadata", {}).get("annotations", {})
            if ann.get("reference_objective") is not None:
                annotation_checks += 1
                assert abs(float(ann["reference_objective"]) - (objective + penalty)) <= 1e-9, instance_id
    else:
        row.update({"ref_objective": np.nan, "ref_objective_part": np.nan, "ref_penalty": np.nan, "ref_violates_own_constraints": np.nan})
    rr = recs.get(instance_id, {})
    for engine, tag in ENGINES:
        r = rr.get(engine)
        row[f"status_{tag}"] = r["status"] if r else None
        row[f"quality_{tag}"] = r.get("quality") if r else None
        row[f"penalty_{tag}"] = (r.get("objectives") or {}).get("penalty") if r else None
        row[f"runtime_{tag}"] = r.get("runtime_ms") if r else None
        row[f"zero_penalty_{tag}"] = (row[f"penalty_{tag}"] is not None and row[f"penalty_{tag}"] <= 1e-12) if r and r.get("quality") is not None else None
        if r and r.get("binding") and row["ref_complete"]:
            chosen = [int(r["binding"][f"task_{t + 1}"]["id"].rsplit("_", 1)[1]) for t in range(n_tasks)]
            row[f"same_as_ref_{tag}"] = chosen == list(ref)
            row[f"gap_to_ref_{tag}"] = float(r["quality"]) - row["ref_objective"] if r.get("quality") is not None else np.nan
        else:
            row[f"same_as_ref_{tag}"] = None
            row[f"gap_to_ref_{tag}"] = np.nan
    rows.append(row)

df = pd.DataFrame(rows)
df.to_csv(f"{OUT}/hsc_instances.csv", index=False)
print("annotation cross-checks:", annotation_checks)

# ---- summaries
s = {}
s["instances"] = len(df)
s["tasks: min/median/max"] = [int(df.n_tasks.min()), float(df.n_tasks.median()), int(df.n_tasks.max())]
s["levels: min/median/max"] = [int(df.n_levels.min()), float(df.n_levels.median()), int(df.n_levels.max())]
s["instances with a parallel level"] = int((df.max_parallel > 1).sum())
s["candidates per task: min/median/max"] = [int(df.cand_per_task_min.min()), float(df.cand_per_task_max.median()), int(df.cand_per_task_max.max())]
s["log10 |B|: min/median/max"] = [float(df.log10_space.min()), float(df.log10_space.median()), float(df.log10_space.max())]
s["constraints: distribution"] = {int(k): int(v) for k, v in df.n_constraints.value_counts().sort_index().items()}
s["objectives: distribution"] = {int(k): int(v) for k, v in df.n_objectives.value_counts().sort_index().items()}
s["reference binding complete"] = int(df.ref_complete.sum())
s["reference violates its own soft constraints (penalty > 0)"] = int((df.ref_violates_own_constraints == True).sum())
s["reference median penalty when violated"] = float(df.ref_penalty[df.ref_penalty > 1e-12].median()) if (df.ref_penalty > 1e-12).any() else None
d = df[df.ref_objective.notna() & df.best_value.notna()]
if len(d) > 1:
    s["corr(authors' best_value, recomputed reference objective)"] = float(np.corrcoef(d.best_value, d.ref_objective)[0, 1])
    s["max |best_value - recomputed reference objective|"] = float((d.best_value - d.ref_objective).abs().max())
    s["share |best_value - recomputed| <= 1e-6"] = float(((d.best_value - d.ref_objective).abs() <= 1e-6).mean())
for tag in ("GA", "RS", "MZN"):
    st = df[f"status_{tag}"]
    s[f"{tag}: runs"] = int(st.notna().sum())
    s[f"{tag}: INCOMPATIBLE"] = int((st == "INCOMPATIBLE").sum())
    s[f"{tag}: binding yield"] = float(st.isin(["FEASIBLE", "OPTIMAL"]).sum() / st.notna().sum()) if st.notna().any() else None
    dd = df[df[f"quality_{tag}"].notna() & df.ref_objective.notna()]
    if not len(dd):
        continue
    gap = dd[f"gap_to_ref_{tag}"]
    s[f"{tag}: instances with binding and reference"] = len(dd)
    s[f"{tag}: zero-penalty bindings (all soft constraints met)"] = int(dd[f"zero_penalty_{tag}"].fillna(False).astype(bool).sum())
    s[f"{tag}: binding identical to reference"] = int(dd[f"same_as_ref_{tag}"].fillna(False).astype(bool).sum())
    s[f"{tag}: better than reference (<-1e-9)"] = int((gap < -TOL).sum())
    s[f"{tag}: equal to reference"] = int((gap.abs() <= TOL).sum())
    s[f"{tag}: worse than reference"] = int((gap > TOL).sum())
    s[f"{tag}: median gap to reference"] = float(gap.median())
    s[f"{tag}: median gap when worse"] = float(gap[gap > TOL].median()) if (gap > TOL).any() else None
    s[f"{tag}: median improvement when better"] = float((-gap[gap < -TOL]).median()) if (gap < -TOL).any() else None
    s[f"{tag}: median runtime ms"] = float(dd[f"runtime_{tag}"].median())
with open(f"{OUT}/hsc_quality_summary.json", "w") as f:
    json.dump(s, f, indent=1, default=str)
for k, v in s.items():
    print(f"{k}: {v}")


def quality_table(group_col):
    out = []
    for level, d in df.groupby(group_col, observed=True):
        row = {group_col: level, "instances": len(d), "ref_violates_constraints": int((d.ref_violates_own_constraints == True).sum())}
        for tag in ("GA", "RS"):
            dd = d[d[f"quality_{tag}"].notna() & d.ref_objective.notna()]
            gap = dd[f"gap_to_ref_{tag}"]
            row.update({f"{tag}_binding": int(d[f"status_{tag}"].isin(["FEASIBLE", "OPTIMAL"]).sum()),
                        f"{tag}_zero_penalty": int(dd[f"zero_penalty_{tag}"].fillna(False).astype(bool).sum()),
                        f"{tag}_better_than_ref": int((gap < -TOL).sum()), f"{tag}_equal_ref": int((gap.abs() <= TOL).sum()),
                        f"{tag}_worse_than_ref": int((gap > TOL).sum()), f"{tag}_median_gap": gap.median() if len(gap) else np.nan})
        out.append(row)
    return pd.DataFrame(out)


quality_table("n_constraints").to_csv(f"{OUT}/hsc_quality_by_constraints.csv", index=False)
df["space_bucket"] = pd.cut(df.log10_space, [-1, 3, 6, 9, 12, 100], labels=["<=3", "3-6", "6-9", "9-12", ">12"])
quality_table("space_bucket").to_csv(f"{OUT}/hsc_quality_by_space.csv", index=False)
print(quality_table("n_constraints").to_string())

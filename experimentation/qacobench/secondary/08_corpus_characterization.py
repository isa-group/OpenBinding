#!/usr/bin/env python3
"""Step 8: corpus characterization table from the BIM packages (all suites except HSC, whose
10,000 packages are characterized from the source files in 03_hsc_quality.py) and the QFBS manifest."""
import json, math, os, sys, collections
import pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import DATASETS, OUT, SUITE_NAMES

SUITES = ["01_icws", "02_quantum", "04_rprsr15", "05_iots", "06_bws_scp"]

def walk_packages(suite_dir):
    for dirpath, dirnames, filenames in os.walk(suite_dir):
        if "instance.json" in filenames and "application.json" in filenames:
            yield dirpath
            dirnames[:] = []

def constructs(node, found):
    if not isinstance(node, dict):
        return
    for k in ("parallel", "exclusive", "repeat"):
        if k in node:
            found.add({"parallel": "parallel", "exclusive": "xor", "repeat": "repeat"}[k])
    for child in node.get("sequence", []) + node.get("parallel", []):
        constructs(child, found)
    for br in node.get("exclusive", []):
        constructs(br.get("flow", {}), found)
    if "repeat" in node:
        constructs(node["repeat"].get("body", {}), found)
        if "expectedCount" in node["repeat"]:
            found.add("repeat.expectedCount")

rows = []
for suite in SUITES:
    sdir = DATASETS / suite
    if not sdir.is_dir():
        print("missing", sdir); continue
    for pkg in walk_packages(sdir):
        app = json.load(open(f"{pkg}/application.json"))["spec"]
        inst = json.load(open(f"{pkg}/instance.json"))
        res = inst["spec"]["resources"]
        cat_file = res.get("candidateCatalog", {}).get("catalog")
        cands = json.load(open(f"{pkg}/{cat_file}"))["spec"]["candidates"] if cat_file else {}
        cons = {}
        cfile = res.get("constraintSet", {}).get("constraints")
        if cfile and os.path.exists(f"{pkg}/{cfile}"):
            cons = json.load(open(f"{pkg}/{cfile}"))["spec"].get("constraints", {})
        opt = {}
        ofile = res.get("optimization", {}).get("optimization")
        if ofile and os.path.exists(f"{pkg}/{ofile}"):
            opt = json.load(open(f"{pkg}/{ofile}"))["spec"]
        tasks = {k: v for k, v in app["tasks"].items() if not (isinstance(v, dict) and v.get("kind") == "local")}  # bindable tasks only
        per_task = collections.Counter()
        for c in cands.values():
            per_task[c.get("provides")] += 1
        pools = [per_task.get(v if isinstance(v, str) else v.get("requires", v.get("provides")), 0) for v in tasks.values()]
        found = set(); constructs(app.get("workflow", {}), found)
        aggs = set()
        for f in app.get("features", {}).values():
            a = f.get("aggregation")
            if isinstance(a, str): aggs.add(a)
            elif isinstance(a, dict):
                for k, v in a.items():
                    aggs.add(f"{k}.{v if isinstance(v, str) else 'expression'}")
        rows.append({
            "suite": suite, "instance": os.path.relpath(pkg, sdir), "tasks": len(tasks), "local_tasks": len(app["tasks"]) - len(tasks), "candidates": len(cands),
            "cand_per_task_min": min(pools) if pools else 0, "cand_per_task_max": max(pools) if pools else 0,
            "log10_space": sum(math.log10(p) for p in pools if p > 0),
            "constraints": len(cons), "hard": sum(1 for c in cons.values() if c.get("enforcement", "hard") == "hard"),
            "soft": sum(1 for c in cons.values() if c.get("enforcement") == "soft"),
            "objectives": len(opt.get("criteria", [])), "features": len(app.get("features", {})),
            "constructs": "+".join(sorted(found)) or "sequence", "aggregations": ";".join(sorted(aggs)),
            "has_placement": any(k in res for k in ("placement", "placementOverlay")) or "placement.json" in os.listdir(pkg),
        })
df = pd.DataFrame(rows)
df.to_csv(OUT / "corpus_packages.csv", index=False)

# add QFBS (manifest) and HSC (source characterization)
man = pd.read_pickle(OUT / "qfbs_manifest.pkl")
hsc = pd.read_csv(OUT / "hsc_instances.csv")
def summarize(name, n, tasks, cand_min, cand_max, cands_total, logspace, cons, obj, constructs, note=""):
    return {"suite": name, "instances": n, "tasks (min/median/max)": f"{int(tasks.min())}/{int(tasks.median())}/{int(tasks.max())}",
            "candidates per task (min–max)": f"{int(cand_min)}–{int(cand_max)}", "candidates per instance (median)": int(cands_total.median()),
            "log10 |B| (median/max)": f"{logspace.median():.1f}/{logspace.max():.1f}", "constraints": cons,
            "objectives": obj, "constructs": constructs, "note": note}


def constraint_text(hard_min, hard_max, soft_min, soft_max, placement=False):
    parts = []
    if hard_max > 0:
        parts.append(f"{int(hard_min)}–{int(hard_max)} hard")
    if soft_max > 0:
        parts.append(f"{int(soft_min)}–{int(soft_max)} soft")
    if placement:
        parts.append("placement capacities")
    return "; ".join(parts) or "none"


def construct_text(found):
    names = {"parallel": "par", "xor": "xor", "repeat": "repeat", "repeat.expectedCount": "repeat"}
    seen = []
    for c in found:
        for part in c.split("+"):
            label = names.get(part, part)
            if label not in seen and label != "sequence":
                seen.append(label)
    return ", ".join(["seq"] + sorted(seen))


summary = []
for suite, d in df.groupby("suite"):
    summary.append(summarize(suite, len(d), d.tasks, d.cand_per_task_min.min(), d.cand_per_task_max.max(), d.candidates, d.log10_space,
                             constraint_text(d.hard.min(), d.hard.max(), d.soft.min(), d.soft.max(), bool(d.has_placement.any())),
                             "/".join(str(x) for x in sorted(d.objectives.unique())), construct_text(d.constructs.unique()),
                             f"soft constraints in {int((d.soft > 0).sum())} instances" if (d.soft > 0).any() else ""))
summary.append(summarize("03_hsc_llm", len(hsc), hsc.n_tasks, hsc.cand_per_task_min.min(), hsc.cand_per_task_max.max(), hsc.n_candidates_total, hsc.log10_space,
                         constraint_text(0, 0, hsc.n_constraints.min(), hsc.n_constraints.max()),
                         "/".join(str(x) for x in sorted(hsc.n_objectives.unique())), "seq, par (levels)", f"{int((hsc.max_parallel > 1).sum())} instances with a parallel level"))
man["log10_space"] = [math.log10(c) * 0 for c in man.n_candidates]  # placeholder, replaced below
# QFBS: candidates per task from eligibility counts is not in the manifest; approximate from totals
man["cand_per_task"] = man.n_candidates / man.n_tasks
man["log10_space"] = man.n_tasks * man.cand_per_task.map(math.log10)
summary.append(summarize("07_qfbs", len(man), man.n_tasks, 3, 8, man.n_candidates, man.log10_space,
                         constraint_text(man.n_constraints.min(), man.n_constraints.max(), 0, 0),
                         "1/3/5", "seq, par, xor, repeat (per design)", "log10|B| approximated from mean candidates per task"))
sm = pd.DataFrame(summary).sort_values("suite")
sm.to_csv(OUT / "corpus_characterization.csv", index=False)
print(sm.to_string())

# ---- LaTeX table
names = SUITE_NAMES
TEX = OUT / "latex"; TEX.mkdir(exist_ok=True)
lines = ["\\begin{tabular}{lrllllll}", "\\toprule", "Suite & Inst. & Tasks (min/med/max) & Cand./task & $\\log_{10}|\\mathcal{B}|$ (med/max) & Constraints & Objectives & Constructs \\\\", "\\midrule"]
for r in sm.itertuples():
    lines.append(f"{names.get(r.suite, r.suite)} & {r.instances:,} & {r._3} & {r._4} & {r._6} & {r.constraints} & {r.objectives} & {r.constructs} \\\\")
lines += ["\\bottomrule", "\\end{tabular}"]
(TEX / "table_corpus_characterization.tex").write_text("\n".join(lines) + "\n")
print("wrote", TEX / "table_corpus_characterization.tex")

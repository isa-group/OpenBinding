#!/usr/bin/env python3
"""Step 2: the tables behind RQ1-RQ4.

RQ1 (what makes a QFBS instance hard): ``factor_analysis.csv`` (marginal outcome rates per design
    factor level), ``factor_effects.csv`` (spread across levels per factor), ``cell_table.csv``.
RQ2 (applicability): ``capability_matrix.csv`` / ``capability_diagnostics.csv`` (why an engine rejected a
    suite, from the recorded diagnostics), ``timing_budget.csv`` (termination reasons, budgets, runtimes).
RQ3 (outcomes and agreement): ``labels_by_group*.csv``, ``reconciliation.csv``,
    ``reconciliation_summary.csv`` (QFBS groups, every recovered suite and the whole corpus),
    ``contradictions.csv`` (UNSAT proofs with a validated binding elsewhere; OPTIMAL labels beaten),
    ``paired_outcomes.csv`` / ``paired_summary.csv`` (same cell and trial across the two QFBS groups).
RQ4 (quality): ``optimality_gap.csv`` (gap to the certified optimum by QFBS subset and by suite),
    ``optimality_gap_instances.csv``, ``vs_cp_incumbent.csv``, ``virtual_best.csv``,
    ``repeat_variability.csv`` when the campaign ran heuristic repetitions.
Every table uses the gateway's authoritative score (``quality``); scores are comparable within an
instance because all engines are scored with the same normalised weighted sum.
"""
import json
import os
import re
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import OUT, ENGINES, SUITE_ORDER, TOL, FACTORS, LEVELS

all_runs = pd.read_pickle(f"{OUT}/runs.pkl")
man = pd.read_pickle(f"{OUT}/qfbs_manifest.pkl")
diag = pd.read_pickle(f"{OUT}/diagnostics.pkl")

all_runs["eng"] = all_runs.engine.map(ENGINES)
runs = all_runs[all_runs.repeat == 0].copy()
BINDING = ["OPTIMAL", "FEASIBLE"]

tables = {}


def save(name, df, index=True):
    tables[name] = df
    df.to_csv(f"{OUT}/{name}.csv", index=index)


def pivot_wide(frame):
    """One row per (suite, instance), one column per engine for the run fields."""
    values = ["status", "quality", "runtime_ms", "first_feasible_ms", "first_feasible_eval", "best_ms", "best_eval",
              "evaluations", "termination_reason", "penalty", "n_soft_violations"]
    wide = frame.pivot_table(index=["suite", "instance_id"], columns="eng", values=values, aggfunc="first")
    wide.columns = [f"{a}_{b}" for a, b in wide.columns]
    for e in ENGINES.values():
        for col in values:
            if f"{col}_{e}" not in wide.columns:
                wide[f"{col}_{e}"] = np.nan
    wide["has_binding_MZN"] = wide.status_MZN.isin(BINDING)
    wide["has_binding_GA"] = wide.status_GA.isin(BINDING)
    wide["has_binding_RS"] = wide.status_RS.isin(BINDING)
    wide["known_feasible"] = wide.has_binding_MZN | wide.has_binding_GA | wide.has_binding_RS
    wide["best_known"] = wide[["quality_MZN", "quality_GA", "quality_RS"]].min(axis=1)
    return wide


wide_all = pivot_wide(runs)
wide_all.to_csv(f"{OUT}/instances_wide.csv")

# ------------------------------------------------------------------ QFBS wide table with design factors
q = runs[runs.suite == "07_qfbs"].copy()
q["instance_id"] = q.instance_id.str.replace("^07_qfbs/", "", regex=True)
q = q.merge(man, on="instance_id", how="left")
assert q.group.notna().all(), "every QFBS run must match a manifest entry"
for f in FACTORS:
    q[f] = q[f"f_{f}"].map(lambda i, f=f: LEVELS[f][int(i)])
wide = wide_all.loc["07_qfbs"].copy() if "07_qfbs" in wide_all.index.get_level_values(0) else pivot_wide(q.assign(suite="07_qfbs")).loc["07_qfbs"]
wide = wide.join(man.set_index("instance_id"))
for f in FACTORS:
    wide[f] = wide[f"f_{f}"].map(lambda i, f=f: LEVELS[f][int(i)])
wide["proved"] = wide.status_MZN.isin(["OPTIMAL", "UNSAT"])
wide["unresolved"] = (~wide.known_feasible) & (wide.status_MZN != "UNSAT")
wide.to_csv(f"{OUT}/qfbs_wide.csv")

# ------------------------------------------------------------------ RQ3: certified labels and reconciliation
save("labels_by_group", pd.crosstab(wide.group, wide.status_MZN, margins=True))
save("labels_by_group_cell", pd.crosstab([wide.group, wide.cell], wide.status_MZN))
save("reconciliation", wide.groupby(["group", "status_MZN", "status_GA", "status_RS"], observed=True).size().rename("instances").reset_index(), index=False)


def reconciliation_row(label, w):
    kf = w[w.known_feasible]
    return {
        "subset": label, "instances": len(w),
        "MZN_OPTIMAL": int((w.status_MZN == "OPTIMAL").sum()), "MZN_FEASIBLE": int((w.status_MZN == "FEASIBLE").sum()),
        "MZN_UNSAT": int((w.status_MZN == "UNSAT").sum()), "MZN_TIMEOUT": int((w.status_MZN == "TIMEOUT").sum()),
        "MZN_INCOMPATIBLE": int((w.status_MZN == "INCOMPATIBLE").sum()),
        "GA_binding": int(w.has_binding_GA.sum()), "RS_binding": int(w.has_binding_RS.sum()),
        "known_feasible(any engine)": int(w.known_feasible.sum()),
        "unresolved(no engine binding, not UNSAT)": int(((~w.known_feasible) & (w.status_MZN != "UNSAT")).sum()),
        "GA_miss_on_known_feasible": int((~kf.has_binding_GA).sum()),
        "RS_miss_on_known_feasible": int((~kf.has_binding_RS).sum()),
        "GA_binding_on_MZN_UNSAT": int(((w.status_MZN == "UNSAT") & w.has_binding_GA).sum()),
        "RS_binding_on_MZN_UNSAT": int(((w.status_MZN == "UNSAT") & w.has_binding_RS).sum()),
        "GA_binding_on_MZN_TIMEOUT": int(((w.status_MZN == "TIMEOUT") & w.has_binding_GA).sum()),
        "RS_binding_on_MZN_TIMEOUT": int(((w.status_MZN == "TIMEOUT") & w.has_binding_RS).sum()),
        "MZN_TIMEOUT_no_heuristic_binding": int(((w.status_MZN == "TIMEOUT") & ~w.has_binding_GA & ~w.has_binding_RS).sum()),
        "GA_better_than_MZN_OPTIMAL": int(((w.status_MZN == "OPTIMAL") & (w.quality_GA < w.quality_MZN - TOL)).sum()),
        "RS_better_than_MZN_OPTIMAL": int(((w.status_MZN == "OPTIMAL") & (w.quality_RS < w.quality_MZN - TOL)).sum()),
    }


rec_rows = [reconciliation_row(f"qfbs:{grp}", w) for grp, w in wide.groupby("group", observed=True)]
rec_rows.append(reconciliation_row("qfbs:all", wide))
for suite in SUITE_ORDER[:-1]:
    if suite in wide_all.index.get_level_values(0):
        rec_rows.append(reconciliation_row(suite, wide_all.loc[suite]))
rec_rows.append(reconciliation_row("corpus", wide_all))
save("reconciliation_summary", pd.DataFrame(rec_rows), index=False)

contra = []
for (suite, inst), r in wide_all.iterrows():
    if r.status_MZN == "UNSAT" and (r.has_binding_GA or r.has_binding_RS):
        contra.append({"suite": suite, "instance_id": inst, "kind": "UNSAT proof with validated heuristic binding",
                       "engines": "+".join(e for e in ("GA", "RS") if r[f"has_binding_{e}"]), "mzn_score": np.nan,
                       "best_heuristic_score": np.nanmin([r.quality_GA, r.quality_RS])})
    if r.status_MZN == "OPTIMAL" and pd.notna(r.quality_MZN):
        for e in ("GA", "RS"):
            if pd.notna(r[f"quality_{e}"]) and r[f"quality_{e}"] < r.quality_MZN - TOL:
                contra.append({"suite": suite, "instance_id": inst, "kind": "OPTIMAL label beaten", "engines": e,
                               "mzn_score": r.quality_MZN, "best_heuristic_score": r[f"quality_{e}"]})
save("contradictions", pd.DataFrame(contra, columns=["suite", "instance_id", "kind", "engines", "mzn_score", "best_heuristic_score"]), index=False)

# ------------------------------------------------------------------ RQ4: optimality gap (QFBS subsets and every suite)
for e in ("GA", "RS"):
    wide_all[f"gap_{e}"] = wide_all[f"quality_{e}"] - wide_all["quality_MZN"]
    wide[f"gap_{e}"] = wide[f"quality_{e}"] - wide["quality_MZN"]
opt_all = wide_all[wide_all.status_MZN == "OPTIMAL"].copy()
opt = wide[wide.status_MZN == "OPTIMAL"].copy()
gap_rows = []


def gap_stats(df, by, level):
    for e in ("GA", "RS"):
        g = df[f"gap_{e}"]
        solved = g.notna()
        gs = g[solved]
        gap_rows.append({"by": by, "level": level, "engine": e, "instances": len(df), "with_binding": int(solved.sum()),
                         "share_with_binding": solved.mean() if len(df) else np.nan,
                         "matches_optimum(|gap|<=1e-9)": int((gs.abs() <= TOL).sum()),
                         "share_matches_optimum_of_bound": (gs.abs() <= TOL).mean() if len(gs) else np.nan,
                         "share_matches_optimum_of_all": (gs.abs() <= TOL).sum() / len(df) if len(df) else np.nan,
                         "negative_gap(<-1e-9)": int((gs < -TOL).sum()),
                         "gap_mean": gs.mean(), "gap_median": gs.median(), "gap_p90": gs.quantile(.9) if len(gs) else np.nan,
                         "gap_p99": gs.quantile(.99) if len(gs) else np.nan, "gap_max": gs.max(),
                         "share_gap<=0.01": (gs <= 0.01).mean() if len(gs) else np.nan,
                         "share_gap<=0.05": (gs <= 0.05).mean() if len(gs) else np.nan,
                         "share_gap>0.10": (gs > 0.10).mean() if len(gs) else np.nan})


gap_stats(opt, "qfbs", "all")
for grp, d in opt.groupby("group", observed=True):
    gap_stats(d, "group", grp)
for f in ("objective_count", "size", "structure", "constraint_count", "constraint_setting"):
    for lv in LEVELS[f]:
        d = opt[opt[f] == lv]
        if len(d):
            gap_stats(d, f, lv)
for suite in SUITE_ORDER:
    if suite in opt_all.index.get_level_values(0):
        gap_stats(opt_all.loc[suite], "suite", suite)
recovered = opt_all[opt_all.index.get_level_values(0) != "07_qfbs"]
gap_stats(recovered, "recovered", "all")
gap_stats(opt_all, "corpus", "all")
save("optimality_gap", pd.DataFrame(gap_rows), index=False)
inst_cols = ["status_MZN", "quality_MZN", "quality_GA", "quality_RS", "gap_GA", "gap_RS", "runtime_ms_MZN"]
opt_all[inst_cols].to_csv(f"{OUT}/optimality_gap_instances.csv")
opt[["group", "cell", "trial", *FACTORS, *inst_cols]].to_csv(f"{OUT}/optimality_gap_qfbs_instances.csv")

# vs time-limited CP incumbents (MZN FEASIBLE)
inc_rows = []


def incumbent_rows(label, d):
    for e in ("GA", "RS"):
        diff = d[f"quality_{e}"] - d["quality_MZN"]
        ok = diff.notna()
        better = diff[ok] < -TOL
        inc_rows.append({"subset": label, "engine": e, "MZN_FEASIBLE_instances": len(d), "heuristic_with_binding": int(ok.sum()),
                         "heuristic_better(<-1e-9)": int(better.sum()), "equal": int((diff[ok].abs() <= TOL).sum()),
                         "heuristic_worse(>1e-9)": int((diff[ok] > TOL).sum()),
                         "median_diff": diff[ok].median(), "mean_diff": diff[ok].mean(),
                         "median_improvement_when_better": (-diff[ok][better]).median() if better.any() else np.nan})


inc = wide[wide.status_MZN == "FEASIBLE"]
for grp, d in inc.groupby("group", observed=True):
    incumbent_rows(f"qfbs:{grp}", d)
incumbent_rows("qfbs:all", inc)
inc_all = wide_all[wide_all.status_MZN == "FEASIBLE"]
for suite in SUITE_ORDER[:-1]:
    if suite in inc_all.index.get_level_values(0):
        incumbent_rows(suite, inc_all.loc[suite])
incumbent_rows("corpus", inc_all)
save("vs_cp_incumbent", pd.DataFrame(inc_rows), index=False)

# best-known per instance (virtual best)
vb_rows = []


def virtual_best_rows(label, d):
    d = d[d.known_feasible]
    for e in ("MZN", "GA", "RS"):
        qq = d[f"quality_{e}"]
        others = d[[f"quality_{x}" for x in ("MZN", "GA", "RS") if x != e]].min(axis=1)
        vb_rows.append({"subset": label, "engine": e, "known_feasible_instances": len(d), "with_binding": int(qq.notna().sum()),
                        "attains_best_known": int(((qq - d.best_known).abs() <= TOL).sum()),
                        "share_attains_best_known_of_all": ((qq - d.best_known).abs() <= TOL).mean() if len(d) else np.nan,
                        "unique_best(strictly better than other two)": int(((qq - others) < -TOL).sum())})


for grp, d in wide.groupby("group", observed=True):
    virtual_best_rows(f"qfbs:{grp}", d)
virtual_best_rows("qfbs:all", wide)
for suite in SUITE_ORDER[:-1]:
    if suite in wide_all.index.get_level_values(0):
        virtual_best_rows(suite, wide_all.loc[suite])
virtual_best_rows("corpus", wide_all)
save("virtual_best", pd.DataFrame(vb_rows), index=False)

# ------------------------------------------------------------------ RQ1: hardness by design factor
fac_rows = []
ng = wide[wide.group == "non_guaranteed"]
gu = wide[wide.group == "guaranteed"]
for f in FACTORS:
    for lv in LEVELS[f]:
        d = wide[wide[f] == lv]
        if not len(d):
            continue
        dn = ng[ng[f] == lv]
        dg = gu[gu[f] == lv]
        o = opt[opt[f] == lv]
        kf = d[d.known_feasible]
        proofs = d[d.status_MZN == "OPTIMAL"]
        fac_rows.append({
            "factor": f, "level": lv, "instances": len(d), "cells": d.cell.nunique(),
            "MZN_proof_rate_all": d.proved.mean(),
            "MZN_OPTIMAL_rate_all": (d.status_MZN == "OPTIMAL").mean(),
            "MZN_OPTIMAL_rate_guaranteed": (dg.status_MZN == "OPTIMAL").mean() if len(dg) else np.nan,
            "MZN_UNSAT_rate_nonguaranteed": (dn.status_MZN == "UNSAT").mean() if len(dn) else np.nan,
            "MZN_FEASIBLE_rate_all": (d.status_MZN == "FEASIBLE").mean(),
            "MZN_TIMEOUT_rate_all": (d.status_MZN == "TIMEOUT").mean(),
            "MZN_median_proof_ms": proofs.runtime_ms_MZN.median() if len(proofs) else np.nan,
            "MZN_median_runtime_ms_guaranteed": dg.runtime_ms_MZN.median() if len(dg) else np.nan,
            "unresolved_rate": d.unresolved.mean(),
            "GA_miss_rate_known_feasible": (~kf.has_binding_GA).mean() if len(kf) else np.nan,
            "RS_miss_rate_known_feasible": (~kf.has_binding_RS).mean() if len(kf) else np.nan,
            "GA_share_matches_optimum": (o.gap_GA.abs() <= TOL).mean() if len(o) else np.nan,
            "GA_mean_gap_on_OPTIMAL": o.gap_GA.mean() if len(o) else np.nan,
            "RS_share_matches_optimum": (o.gap_RS.abs() <= TOL).mean() if len(o) else np.nan,
            "RS_mean_gap_on_OPTIMAL": o.gap_RS.mean() if len(o) else np.nan,
            "n_OPTIMAL": len(o),
        })
fac = pd.DataFrame(fac_rows)
save("factor_analysis", fac, index=False)
effect_rows = []
for f, d in fac.groupby("factor", sort=False):
    effect_rows.append({"factor": f, "levels": len(d),
                        "proof_rate_min": d.MZN_proof_rate_all.min(), "proof_rate_max": d.MZN_proof_rate_all.max(),
                        "proof_rate_spread": d.MZN_proof_rate_all.max() - d.MZN_proof_rate_all.min(),
                        "hardest_level(proof)": d.loc[d.MZN_proof_rate_all.idxmin(), "level"],
                        "GA_attains_min": d.GA_share_matches_optimum.min(), "GA_attains_max": d.GA_share_matches_optimum.max(),
                        "GA_attains_spread": d.GA_share_matches_optimum.max() - d.GA_share_matches_optimum.min(),
                        "hardest_level(GA)": d.loc[d.GA_share_matches_optimum.idxmin(), "level"] if d.GA_share_matches_optimum.notna().any() else "",
                        "unresolved_max": d.unresolved_rate.max()})
save("factor_effects", pd.DataFrame(effect_rows).sort_values("proof_rate_spread", ascending=False), index=False)

cell_rows = []
for (grp, cell), d in wide.groupby(["group", "cell"], observed=True):
    o = d[d.status_MZN == "OPTIMAL"]
    cell_rows.append({"group": grp, "cell": cell, **{f: d[f].iloc[0] for f in FACTORS}, "instances": len(d),
                      "MZN_OPTIMAL": int((d.status_MZN == "OPTIMAL").sum()), "MZN_FEASIBLE": int((d.status_MZN == "FEASIBLE").sum()),
                      "MZN_UNSAT": int((d.status_MZN == "UNSAT").sum()), "MZN_TIMEOUT": int((d.status_MZN == "TIMEOUT").sum()),
                      "GA_binding": int(d.has_binding_GA.sum()), "RS_binding": int(d.has_binding_RS.sum()),
                      "unresolved": int(d.unresolved.sum()),
                      "MZN_median_runtime_ms": d.runtime_ms_MZN.median(),
                      "GA_mean_gap_on_OPTIMAL": o.gap_GA.mean() if len(o) else np.nan, "RS_mean_gap_on_OPTIMAL": o.gap_RS.mean() if len(o) else np.nan,
                      "n_tasks": d.n_tasks.iloc[0], "median_candidates": d.n_candidates.median(), "median_constraints": d.n_constraints.median()})
save("cell_table", pd.DataFrame(cell_rows), index=False)

# ------------------------------------------------------------------ paired analysis (same cell/trial across groups)
pair_cols = ["status_MZN", "quality_MZN", "quality_GA", "quality_RS", "n_tasks", "n_candidates", "n_constraints", "sha_application", "sha_candidates", "seed"]
g = wide[wide.group == "guaranteed"].set_index(["cell", "trial"])
n = wide[wide.group == "non_guaranteed"].set_index(["cell", "trial"])
pair = g[pair_cols].join(n[pair_cols], lsuffix="_g", rsuffix="_n", how="inner")
save("paired_outcomes", pd.crosstab(pair.status_MZN_g, pair.status_MZN_n, margins=True))
both_opt = pair[(pair.status_MZN_g == "OPTIMAL") & (pair.status_MZN_n == "OPTIMAL")]
save("paired_summary", pd.DataFrame([{
    "pairs": len(pair),
    "same_seed_tasks_candidates_constraints": ((pair.n_tasks_g == pair.n_tasks_n) & (pair.n_candidates_g == pair.n_candidates_n)
                                               & (pair.n_constraints_g == pair.n_constraints_n) & (pair.seed_g == pair.seed_n)).mean() if len(pair) else np.nan,
    "both_MZN_OPTIMAL": len(both_opt),
    "nonguaranteed_optimum_worse_than_guaranteed(score higher)": int((both_opt.quality_MZN_n - both_opt.quality_MZN_g > TOL).sum()),
    "equal": int(((both_opt.quality_MZN_n - both_opt.quality_MZN_g).abs() <= TOL).sum()),
    "nonguaranteed_optimum_better": int((both_opt.quality_MZN_n - both_opt.quality_MZN_g < -TOL).sum()),
}]), index=False)

# ------------------------------------------------------------------ RQ2: capability diagnostics
PREFIX = re.compile(r"^engine rejected BindingProblem \(\d+\):\s*")
PAREN = re.compile(r"\s*\(([^()]*)\)\s*$")


def parse_reason(message, raw):
    """(reason, detail) pairs from one diagnostic: the gateway's structured capability diagnostics
    ({category, unsupported:[...]}) or an engine's 422 text ('X does not support Y (feature.context)')."""
    try:
        j = json.loads(raw) if isinstance(raw, str) else None
    except ValueError:
        j = None
    if isinstance(j, dict) and isinstance(j.get("unsupported"), list):
        return [(f"{j.get('category', 'capability')}: {u}", "") for u in j["unsupported"]] or [(str(j.get("message", "")), "")]
    text = PREFIX.sub("", str(message or "")).strip()
    m = PAREN.search(text)
    detail = m.group(1) if m else ""
    reason = PAREN.sub("", text) if m else text
    return [(reason[:160], detail[:160])]


if len(diag):
    rows = []
    for r in diag.itertuples():
        for reason, detail in parse_reason(r.message, r.raw):
            rows.append({"suite": r.suite, "instance_id": r.instance_id, "engine": r.engine, "reason": reason, "detail": detail})
    u = pd.DataFrame(rows)
    save("capability_diagnostics", u.groupby(["suite", "engine", "reason", "detail"]).instance_id.nunique().rename("instances").reset_index(), index=False)
    cap = u.groupby(["engine", "reason", "suite"]).instance_id.nunique().unstack("suite").fillna(0).astype(int)
    save("capability_matrix", cap)
else:
    save("capability_diagnostics", pd.DataFrame(columns=["suite", "engine", "reason", "detail", "instances"]), index=False)
    save("capability_matrix", pd.DataFrame())

# ------------------------------------------------------------------ timing, budgets and termination reasons
t_rows = []
for (suite, eng), d in runs.groupby(["suite", "eng"]):
    proc = d[d.status != "INCOMPATIBLE"]
    if not len(proc):
        continue
    bind = proc[proc.status.isin(BINDING)]
    nobind = proc[~proc.status.isin(BINDING + ["UNSAT"])]
    reasons = proc.termination_reason.value_counts(normalize=True)
    t_rows.append({
        "suite": suite, "engine": eng, "processed": len(proc),
        "share_proof": reasons.get("proof", 0.0), "share_evaluation_budget": reasons.get("evaluation_budget", 0.0),
        "share_time_budget": reasons.get("time_budget", 0.0), "share_engine_stop": reasons.get("engine_stop", 0.0),
        "runs_runtime>=4900ms": int((proc.runtime_ms >= 4900).sum()), "share_runtime>=4900ms": (proc.runtime_ms >= 4900).mean(),
        "evaluations_mode": proc.evaluations.mode().iloc[0] if proc.evaluations.notna().any() else np.nan,
        "runtime_median_ms": proc.runtime_ms.median(), "runtime_p90_ms": proc.runtime_ms.quantile(.9),
        "no_binding_runs": len(nobind), "no_binding_runtime_median_ms": nobind.runtime_ms.median() if len(nobind) else np.nan,
        "first_feasible_median_ms": bind.first_feasible_ms.median(), "first_feasible_p90_ms": bind.first_feasible_ms.quantile(.9) if bind.first_feasible_ms.notna().any() else np.nan,
        "first_feasible_median_eval": bind.first_feasible_eval.median(), "best_median_ms": bind.best_ms.median(), "best_median_eval": bind.best_eval.median(),
        "overhead_median_ms": proc.overhead_ms.median(),
    })
save("timing_budget", pd.DataFrame(t_rows), index=False)
mz = q[q.eng == "MZN"]
save("mzn_runtime_by_status", mz.groupby(["group", "status"], observed=True).runtime_ms.describe(percentiles=[.1, .5, .9, .99]))
tf = q[q.status.isin(BINDING) & q.eng.isin(["GA", "RS"])].groupby(["group", "eng"], observed=True)[["first_feasible_ms", "first_feasible_eval", "best_ms", "best_eval", "runtime_ms"]].describe(percentiles=[.5, .9, .99]).T
save("qfbs_time_to_feasible", tf)

# ------------------------------------------------------------------ heuristic repetitions (campaign --repeats k)
if int(all_runs.repeat.max()) > 0:
    rep = all_runs[all_runs.engine != "minizinc-csp"].copy()
    rep["eng"] = rep.engine.map(ENGINES)
    opt_idx = opt_all.reset_index()[["suite", "instance_id", "quality_MZN"]]
    rep = rep.merge(opt_idx, on=["suite", "instance_id"], how="left")
    rep_rows = []
    for (suite, eng), d in rep.groupby(["suite", "eng"]):
        per = d.groupby("instance_id").agg(repeats=("repeat", "nunique"), with_binding=("quality", "count"),
                                           q_min=("quality", "min"), q_max=("quality", "max"), q_std=("quality", "std"), opt=("quality_MZN", "first"))
        per["best_of_k_matches_optimum"] = (per.q_min - per.opt).abs() <= TOL
        per["any_repeat_misses_optimum"] = (per.q_max - per.opt) > TOL
        rep_rows.append({"suite": suite, "engine": eng, "instances": len(per), "repeats": int(per.repeats.max()),
                         "median_score_std_across_repeats": per.q_std.median(), "p90_score_std": per.q_std.quantile(.9),
                         "instances_with_OPTIMAL": int(per.opt.notna().sum()),
                         "best_of_k_matches_optimum": int(per.best_of_k_matches_optimum[per.opt.notna()].sum()),
                         "all_repeats_match_optimum": int(((per.q_max - per.opt).abs() <= TOL)[per.opt.notna()].sum()),
                         "mean_binding_yield_per_repeat": d.groupby("repeat").quality.apply(lambda s: s.notna().mean()).mean()})
    save("repeat_variability", pd.DataFrame(rep_rows), index=False)

# ------------------------------------------------------------------ corpus views from the run records
char_rows = []
for suite, d in runs.groupby("suite"):
    b = d[d.n_bound_tasks > 0].groupby("instance_id").n_bound_tasks.max()
    char_rows.append({"suite": suite, "instances": d.instance_id.nunique(), "instances_with_some_binding": len(b),
                      "bound_tasks_min": b.min() if len(b) else np.nan, "bound_tasks_median": b.median() if len(b) else np.nan,
                      "bound_tasks_max": b.max() if len(b) else np.nan,
                      "objective_components_mode": d[d.n_components > 0].n_components.mode().iloc[0] if (d.n_components > 0).any() else np.nan,
                      "objective_components_max": d.n_components.max()})
save("bound_tasks_by_suite", pd.DataFrame(char_rows), index=False)
save("qfbs_characterization", man.groupby("group").agg(
    instances=("instance_id", "size"), tasks_min=("n_tasks", "min"), tasks_median=("n_tasks", "median"), tasks_max=("n_tasks", "max"),
    candidates_min=("n_candidates", "min"), candidates_median=("n_candidates", "median"), candidates_max=("n_candidates", "max"),
    constraints_min=("n_constraints", "min"), constraints_median=("n_constraints", "median"), constraints_max=("n_constraints", "max"),
    objectives_min=("n_objectives", "min"), objectives_max=("n_objectives", "max"),
    parallel=("obs_parallel", "mean"), xor=("obs_xor", "mean"), repeat=("obs_repeat", "mean")))
h = wide_all.loc["03_hsc_llm"] if "03_hsc_llm" in wide_all.index.get_level_values(0) else pd.DataFrame(columns=["status_GA", "status_RS"])
save("hsc_llm_reconciliation", pd.crosstab(h.status_GA, h.status_RS, margins=True) if len(h) else pd.DataFrame())

print("tables:", ", ".join(sorted(tables)))

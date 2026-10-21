#!/usr/bin/env python3
"""Step 5: LaTeX tables (booktabs) from the secondary-analysis CSVs, one per research question.

table_rq1_factors         hardness by QFBS design-factor level
table_rq2_capabilities    why the exact engine rejects instances, by suite (from the recorded diagnostics)
table_rq3_labels          certified labels and cross-solver reconciliation per QFBS group
table_rq4_gap             gap to the certified optimum (QFBS subsets and recovered suites)
table_rq4_incumbent       heuristics against time-limited CP incumbents, best-known attainment
table_rq4_hsc             HSC: heuristics against the authors' reference compositions
table_timing_budget       termination reasons, budgets and runtimes per suite and engine
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import OUT, SUITE_NAMES, SUITE_ORDER, FACTOR_LABELS

TEX = f"{OUT}/latex"
os.makedirs(TEX, exist_ok=True)


def pct(x, d=1):
    return "--" if pd.isna(x) else f"{100 * x:.{d}f}\\%"


def num(x):
    return "--" if pd.isna(x) else f"{int(x):,}"


def f3(x):
    return "--" if pd.isna(x) else f"{x:.3f}"


def ms(x):
    return "--" if pd.isna(x) else f"{x:,.0f}"


def tex(s):
    return str(s).replace("_", "\\_").replace("%", "\\%").replace("&", "\\&")


def write(name, lines):
    open(f"{TEX}/{name}.tex", "w").write("\n".join(lines) + "\n")


# ---- RQ1: factors
f = pd.read_csv(f"{OUT}/factor_analysis.csv")
effects = pd.read_csv(f"{OUT}/factor_effects.csv")
lines = ["\\begin{tabular}{llrrrrrr}", "\\toprule",
         "Factor & Level & Inst. & Proof$^{a}$ & Median proof ms & Unresolved & GA attains opt.$^{b}$ & GA mean gap \\\\", "\\midrule"]
for fac in effects.factor:
    d = f[f.factor == fac]
    for i, r in enumerate(d.itertuples()):
        lines.append(f"{FACTOR_LABELS.get(fac, fac) if i == 0 else ''} & {tex(str(r.level).replace('_', ' '))} & {num(r.instances)} & {pct(r.MZN_proof_rate_all, 0)} & "
                     f"{ms(r.MZN_median_proof_ms)} & {pct(r.unresolved_rate, 1)} & {pct(r.GA_share_matches_optimum, 0)} & {f3(r.GA_mean_gap_on_OPTIMAL)} \\\\")
    lines.append("\\addlinespace[2pt]")
lines += ["\\bottomrule",
          "\\multicolumn{8}{p{0.95\\linewidth}}{\\footnotesize Marginal rates over the covering array (levels are not balanced across the other factors); factors ordered by the spread of the proof rate. "
          "$^{a}$ instances the exact solver settles within 5\\,s (OPTIMAL or UNSAT). $^{b}$ share of the instances with a certified optimum whose GA binding scores within $10^{-9}$ of it.}",
          "\\end{tabular}"]
write("table_rq1_factors", lines)

# Compact variant for the paper: one row per factor, extreme levels only (ordered by the proof-rate spread).
LEVEL_NAMES = {"fixed_5": "five fixed", "uniform_3_8": "uniform 3--8", "normal_3_8": "normal 3--8",
               "cost_max": "max cost", "latency_max": "max latency", "parallel_xor": "parallel+XOR",
               "parallel_repeat": "parallel+repeat", "xor_repeat": "XOR+repeat", "xor": "XOR"}
SETTING_NAMES = {"constraint_setting": {"0": "setting 1", "1": "setting 2"}}


def level_name(fac, level):
    level = str(level)
    return SETTING_NAMES.get(fac, {}).get(level) or LEVEL_NAMES.get(level, level.replace("_", " "))


def extremes(d, fac, column):
    lo, hi = d.loc[d[column].idxmin()], d.loc[d[column].idxmax()]
    if abs(float(hi[column]) - float(lo[column])) < 0.005:
        return f"{100 * float(lo[column]):.0f} (all levels)"
    return f"{100 * float(lo[column]):.0f} ({tex(level_name(fac, lo.level))}) -- {100 * float(hi[column]):.0f} ({tex(level_name(fac, hi.level))})"


lines = ["\\begin{tabular}{@{}llll@{}}", "\\toprule",
         "Factor & Proof within 5\\,s (\\%)$^{a}$ & Median proof (ms) & GA attains optimum (\\%)$^{b}$ \\\\", "\\midrule"]
for fac in effects.factor:
    d = f[f.factor == fac].reset_index(drop=True)
    lines.append(f"{FACTOR_LABELS.get(fac, fac)} & {extremes(d, fac, 'MZN_proof_rate_all')} & "
                 f"{ms(d.MZN_median_proof_ms.min())}--{ms(d.MZN_median_proof_ms.max())} & "
                 f"{extremes(d, fac, 'GA_share_matches_optimum')} \\\\")
lines += ["\\bottomrule",
          "\\multicolumn{4}{p{0.97\\linewidth}}{\\footnotesize Lowest and highest level of each factor (marginal rates over the covering array, in which levels are not balanced across the other factors); factors ordered by the spread of the proof rate. "
          "$^{a}$ instances settled by the exact solver (OPTIMAL or UNSAT). $^{b}$ share of the instances with a certified optimum whose GA binding scores within $10^{-9}$ of it.}",
          "\\end{tabular}"]
write("table_rq1_compact", lines)

# ---- RQ2: capabilities
cap = pd.read_csv(f"{OUT}/capability_matrix.csv") if os.path.getsize(f"{OUT}/capability_matrix.csv") > 1 else pd.DataFrame()
suites = [s for s in SUITE_ORDER if len(cap) and s in cap.columns]
lines = ["\\begin{tabular}{ll" + "r" * len(suites) + "}", "\\toprule",
         "Engine & Rejection reason (from the recorded diagnostics) & " + " & ".join(SUITE_NAMES[s] for s in suites) + " \\\\", "\\midrule"]
if len(cap):
    for _, r in cap.iterrows():
        cells = " & ".join((num(r[s]) if r[s] > 0 else "--") for s in suites)
        lines.append(f"{tex(r.engine)} & {tex(r.reason)} & {cells} \\\\")
else:
    lines.append("\\multicolumn{2}{l}{no rejections recorded} \\\\")
lines += ["\\bottomrule", "\\multicolumn{" + str(2 + len(suites)) + "}{l}{\\footnotesize Instances rejected before execution (HTTP 422 or capability negotiation); every rejection is recorded as INCOMPATIBLE with its reason.}", "\\end{tabular}"]
write("table_rq2_capabilities", lines)

# ---- RQ3: labels and reconciliation per QFBS group
rs = pd.read_csv(f"{OUT}/reconciliation_summary.csv").set_index("subset")
cols = [c for c in ("qfbs:guaranteed", "qfbs:non_guaranteed") if c in rs.index]
head = " & ".join(c.split(":")[1].replace("_", "-") for c in cols)
rows = [
    ("Instances", "instances", num),
    ("MiniZinc OPTIMAL (proof)", "MZN_OPTIMAL", num),
    ("MiniZinc FEASIBLE (incumbent at 5\\,s)", "MZN_FEASIBLE", num),
    ("MiniZinc UNSAT (proof)", "MZN_UNSAT", num),
    ("MiniZinc TIMEOUT (no incumbent)", "MZN_TIMEOUT", num),
    ("Known feasible (binding from any engine)", "known_feasible(any engine)", num),
    ("Unresolved (no binding, no UNSAT proof)", "unresolved(no engine binding, not UNSAT)", num),
    ("GA misses on known-feasible", "GA_miss_on_known_feasible", num),
    ("RS misses on known-feasible", "RS_miss_on_known_feasible", num),
]
lines = ["\\begin{tabular}{l" + "r" * len(cols) + "}", "\\toprule", f" & {head} \\\\", "\\midrule"]
for label, col, fn in rows:
    lines.append(f"{label} & " + " & ".join(fn(rs.loc[c, col]) for c in cols) + " \\\\")
lines.append("Heuristic binding on UNSAT instances (GA / RS) & " + " & ".join(f"{num(rs.loc[c, 'GA_binding_on_MZN_UNSAT'])} / {num(rs.loc[c, 'RS_binding_on_MZN_UNSAT'])}" for c in cols) + " \\\\")
lines.append("Heuristic binding on MiniZinc TIMEOUT (GA / RS) & " + " & ".join(f"{num(rs.loc[c, 'GA_binding_on_MZN_TIMEOUT'])} / {num(rs.loc[c, 'RS_binding_on_MZN_TIMEOUT'])}" for c in cols) + " \\\\")
lines.append("OPTIMAL labels beaten by a heuristic (GA / RS) & " + " & ".join(f"{num(rs.loc[c, 'GA_better_than_MZN_OPTIMAL'])} / {num(rs.loc[c, 'RS_better_than_MZN_OPTIMAL'])}" for c in cols) + " \\\\")
lines += ["\\bottomrule", "\\end{tabular}"]
write("table_rq3_labels", lines)

# ---- RQ4: gap to the certified optimum
g = pd.read_csv(f"{OUT}/optimality_gap.csv")


def gap_row(by, level, engine, label):
    sel = g[(g.by == by) & (g.level.astype(str) == str(level)) & (g.engine == engine)]
    if not len(sel):
        return None
    r = sel.iloc[0]
    return f"{label} & {engine} & {num(r.instances)} & {pct(r.share_with_binding)} & {pct(r.share_matches_optimum_of_bound)} & {f3(r.gap_mean)} & {f3(r.gap_p90)} & {f3(r.gap_max)} \\\\"


lines = ["\\begin{tabular}{llrrrrrr}", "\\toprule", "Subset & Engine & OPTIMAL inst. & With binding & Attains optimum$^{a}$ & Mean gap & P90 gap & Max gap \\\\", "\\midrule"]
subsets = [("qfbs", "all", "QFBS (all)"), ("group", "guaranteed", "\\quad guaranteed"), ("group", "non_guaranteed", "\\quad non-guaranteed"),
           ("objective_count", "1", "\\quad $k=1$ objective"), ("objective_count", "3", "\\quad $k=3$"), ("objective_count", "5", "\\quad $k=5$"),
           ("size", "12", "\\quad 12 tasks"), ("size", "24", "\\quad 24 tasks"), ("size", "48", "\\quad 48 tasks")]
subsets += [("suite", s, SUITE_NAMES[s]) for s in SUITE_ORDER[:-1]] + [("recovered", "all", "Recovered suites (all)"), ("corpus", "all", "Whole corpus")]
for by, level, label in subsets:
    a, b = gap_row(by, level, "GA", label), gap_row(by, level, "RS", "")
    if a:
        lines += [a, b, "\\addlinespace[2pt]"]
lines += ["\\bottomrule", "\\multicolumn{8}{p{0.95\\linewidth}}{\\footnotesize $^{a}$ share of the instances with a binding whose score equals the MiniZinc optimum ($|\\Delta| \\le 10^{-9}$); gaps are differences of the weighted-sum score in $[0,1]$.}", "\\end{tabular}"]
write("table_rq4_gap", lines)

# ---- RQ4: vs CP incumbent + best known
v = pd.read_csv(f"{OUT}/vs_cp_incumbent.csv"); vb = pd.read_csv(f"{OUT}/virtual_best.csv")
lines = ["\\begin{tabular}{llrrrrr}", "\\toprule", "Subset & Engine & CP FEASIBLE inst. & Heuristic binding & Better than CP incumbent & Equal & Worse \\\\", "\\midrule"]
labels = {"qfbs:guaranteed": "QFBS guaranteed", "qfbs:non_guaranteed": "QFBS non-guaranteed", "qfbs:all": "QFBS (all)", "corpus": "Whole corpus"}
labels.update({s: SUITE_NAMES[s] for s in SUITE_ORDER})
for subset in ["qfbs:guaranteed", "qfbs:non_guaranteed", "qfbs:all", *SUITE_ORDER[:-1], "corpus"]:
    d = v[v.subset == subset]
    for e in ("GA", "RS"):
        sel = d[d.engine == e]
        if not len(sel):
            continue
        r = sel.iloc[0]
        share = pct(r['heuristic_better(<-1e-9)'] / r.heuristic_with_binding, 0) if r.heuristic_with_binding else "--"
        lines.append(f"{labels.get(subset, subset) if e == 'GA' else ''} & {e} & {num(r.MZN_FEASIBLE_instances)} & {num(r.heuristic_with_binding)} & {num(r['heuristic_better(<-1e-9)'])} ({share}) & {num(r.equal)} & {num(r['heuristic_worse(>1e-9)'])} \\\\")
corpus_vb = vb[vb.subset == "corpus"]
if len(corpus_vb):
    n_known = int(corpus_vb.known_feasible_instances.iloc[0])
    lines += ["\\midrule", f"\\multicolumn{{7}}{{l}}{{Best-known score attained over the {n_known:,} known-feasible instances of the corpus: " +
              ", ".join(f"{r.engine} {num(r.attains_best_known)} ({pct(r.share_attains_best_known_of_all, 1)})" for r in corpus_vb.itertuples()) + "} \\\\"]
lines += ["\\bottomrule", "\\end{tabular}"]
write("table_rq4_incumbent", lines)

# ---- RQ4: HSC against the reference compositions
h = pd.read_csv(f"{OUT}/hsc_quality_by_constraints.csv")
lines = ["\\begin{tabular}{lrrrrrrr}", "\\toprule",
         "Soft constraints & Instances & Reference violates$^{c}$ & GA zero penalty & GA better / equal / worse$^{d}$ & GA median gap & RS zero penalty & RS better / equal / worse \\\\", "\\midrule"]
for r in h.itertuples():
    lines.append(f"{int(r.n_constraints)} & {num(r.instances)} & {num(r.ref_violates_constraints)} ({pct(r.ref_violates_constraints / r.instances, 0)}) & "
                 f"{num(r.GA_zero_penalty)} ({pct(r.GA_zero_penalty / r.instances, 0)}) & {num(r.GA_better_than_ref)} / {num(r.GA_equal_ref)} / {num(r.GA_worse_than_ref)} & {f3(r.GA_median_gap)} & "
                 f"{num(r.RS_zero_penalty)} ({pct(r.RS_zero_penalty / r.instances, 0)}) & {num(r.RS_better_than_ref)} / {num(r.RS_equal_ref)} / {num(r.RS_worse_than_ref)} \\\\")
t = h.sum(numeric_only=True)
lines += ["\\midrule", f"All & {num(t.instances)} & {num(t.ref_violates_constraints)} ({pct(t.ref_violates_constraints / t.instances, 0)}) & {num(t.GA_zero_penalty)} ({pct(t.GA_zero_penalty / t.instances, 0)}) & "
          f"{num(t.GA_better_than_ref)} / {num(t.GA_equal_ref)} / {num(t.GA_worse_than_ref)} & -- & {num(t.RS_zero_penalty)} ({pct(t.RS_zero_penalty / t.instances, 0)}) & {num(t.RS_better_than_ref)} / {num(t.RS_equal_ref)} / {num(t.RS_worse_than_ref)} \\\\",
          "\\bottomrule",
          "\\multicolumn{8}{p{0.95\\linewidth}}{\\footnotesize $^{c}$ the authors' reference composition incurs a non-zero Eq.\\,2 penalty on the released data. $^{d}$ gateway score of the heuristic binding against the reference composition's objective (Eq.\\,1\\,+\\,2 recomputed on the released data); gaps are differences of that objective.}",
          "\\end{tabular}"]
write("table_rq4_hsc", lines)

# ---- timing & budgets
t = pd.read_csv(f"{OUT}/timing_budget.csv")
lines = ["\\begin{tabular}{llrrrrrrr}", "\\toprule",
         "Suite & Engine & Processed & Proof & Eval. budget & Time budget & Median ms & No-binding runs & Median ms (no binding) \\\\", "\\midrule"]
for r in t.itertuples():
    lines.append(f"{SUITE_NAMES.get(r.suite, r.suite)} & {r.engine} & {num(r.processed)} & {pct(r.share_proof, 0)} & {pct(r.share_evaluation_budget, 0)} & {pct(r.share_time_budget, 0)} & "
                 f"{ms(r.runtime_median_ms)} & {num(r.no_binding_runs)} & {ms(r.no_binding_runtime_median_ms)} \\\\")
lines += ["\\bottomrule", "\\multicolumn{9}{l}{\\footnotesize Termination reasons as recorded per run: proof (exact engine), evaluation budget (1,000 / 10,000 evaluations) or the 5\\,s time budget.}", "\\end{tabular}"]
write("table_timing_budget", lines)
print("tables written to", TEX)

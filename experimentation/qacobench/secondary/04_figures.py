#!/usr/bin/env python3
"""Step 4: paper figures (vector PDF + SVG) for RQ1, RQ3 and RQ4; RQ2's coverage heat map is produced
by experimentation/qacobench/plot_results.py from the primary evaluation.

fig_rq1_hardness        proof rate of the exact solver and optimum attainment of the GA per QFBS design-factor level
fig_rq3_reconciliation  per-instance agreement between the exact labels and the heuristics' validated bindings (QFBS)
fig_rq4_gap             gap of the heuristics to the certified optimum (QFBS and recovered suites)
fig_rq4_hsc             HSC: heuristic scores against the authors' reference compositions
fig_time_to_binding     time to proof / first feasible binding / last improvement (QFBS)
"""
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import OUT, TOL, FACTORS, LEVELS, FACTOR_LABELS, SUITE_NAMES, SUITE_ORDER

FIG = f"{OUT}/figures"
os.makedirs(FIG, exist_ok=True)

C_MZN, C_GA, C_RS = "#2a78d6", "#eb6834", "#1baf7a"
C_Y, C_GRAY, C_TEXT, C_MUTED = "#eda100", "#9a9892", "#0b0b0b", "#52514e"
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 8, "axes.titlesize": 9, "axes.labelsize": 8,
    "axes.edgecolor": "#bdbbb4", "axes.linewidth": 0.6, "axes.spines.top": False, "axes.spines.right": False,
    "xtick.color": C_MUTED, "ytick.color": C_MUTED, "xtick.labelsize": 7.5, "ytick.labelsize": 7.5,
    "grid.color": "#e6e4de", "grid.linewidth": 0.5, "legend.fontsize": 7.5, "legend.frameon": False,
    "pdf.fonttype": 42, "svg.fonttype": "none",
})


def save(fig, name):
    fig.savefig(f"{FIG}/{name}.pdf", bbox_inches="tight")
    fig.savefig(f"{FIG}/{name}.svg", bbox_inches="tight")
    plt.close(fig)


def ecdf(ax, values, color, label, ls="-", clip_low=None):
    v = pd.Series(values).dropna()
    if clip_low is not None:
        v = v.clip(lower=clip_low)
    v = v.sort_values().to_numpy()
    if len(v) == 0:
        return 0
    ax.step(v, np.arange(1, len(v) + 1) / len(v), where="post", color=color, lw=1.5, ls=ls, label=f"{label} (n={len(v):,})")
    return len(v)


w = pd.read_csv(f"{OUT}/qfbs_wide.csv")
fac = pd.read_csv(f"{OUT}/factor_analysis.csv")
effects = pd.read_csv(f"{OUT}/factor_effects.csv")
gap_q = pd.read_csv(f"{OUT}/optimality_gap_qfbs_instances.csv")
gap_all = pd.read_csv(f"{OUT}/optimality_gap_instances.csv")

# ------------------------------------------------------------------ RQ1: hardness by design factor
order = list(effects.factor)
rows = []
for f in order:
    for lv in LEVELS[f]:
        r = fac[(fac.factor == f) & (fac.level.astype(str) == lv)]
        if len(r):
            rows.append(r.iloc[0])
t = pd.DataFrame(rows).reset_index(drop=True)
y = np.arange(len(t))[::-1]
fig, axes = plt.subplots(1, 3, figsize=(7.4, 0.19 * len(t) + 1.0), sharey=True)
fig.subplots_adjust(left=0.31, right=0.99, top=0.92, bottom=0.06, wspace=0.12)
labels = [str(r.level).replace("_", " ") for r in t.itertuples()]
panels = [
    ("MZN_proof_rate_all", C_MZN, "(a) Proof within 5 s"),
    ("GA_share_matches_optimum", C_GA, "(b) GA attains the optimum"),
    ("unresolved_rate", C_Y, "(c) Unresolved"),
]
for ax, (col, color, title) in zip(axes, panels):
    vals = t[col].to_numpy(dtype=float)
    ax.hlines(y, 0, vals, color="#dddbd4", lw=1.0)
    ax.plot(vals, y, "o", color=color, ms=4.0)
    ax.set_xlim(-0.02, 1.02); ax.set_xticks([0, .5, 1]); ax.set_xticklabels(["0%", "50%", "100%"])
    ax.grid(axis="x"); ax.set_axisbelow(True)
    ax.set_title(title, loc="left", fontsize=8)
    for yy, v in zip(y, vals):
        if np.isfinite(v):
            if v > 0.78:
                ax.text(v - 0.04, yy, f"{v:.0%}", va="center", ha="right", fontsize=6.2, color=C_MUTED)
            else:
                ax.text(v + 0.04, yy, f"{v:.0%}", va="center", ha="left", fontsize=6.2, color=C_MUTED)
ax = axes[0]
ax.set_yticks(y); ax.set_yticklabels(labels, fontsize=7)
ax.tick_params(axis="y", length=0)
start = 0
for f in order:
    n = sum(1 for r in t.itertuples() if r.factor == f)
    if n == 0:
        continue
    top, bottom = y[start], y[start + n - 1]
    if start > 0:
        for a in axes:
            a.axhline(top + 0.5, color="#e6e4de", lw=0.6)
    ax.text(-0.42, (top + bottom) / 2, FACTOR_LABELS[f], ha="right", va="center", fontsize=7, color=C_TEXT, fontweight="bold", transform=ax.get_yaxis_transform())
    start += n
fig.suptitle("QFBS hardness by design-factor level (marginals over the covering array; factors ordered by the spread of the proof rate)", x=0.01, ha="left", fontsize=8)
save(fig, "fig_rq1_hardness")

# ------------------------------------------------------------------ RQ3: reconciliation (both QFBS groups)
def heur(r):
    ga, rs = r.status_GA in ("FEASIBLE", "OPTIMAL"), r.status_RS in ("FEASIBLE", "OPTIMAL")
    return "both" if ga and rs else "GA only" if ga else "RS only" if rs else "none"


w["heur"] = w.apply(heur, axis=1)
order_s = ["OPTIMAL", "FEASIBLE", "TIMEOUT", "UNSAT"]
cats = ["both", "GA only", "RS only", "none"]
colors = {"both": C_GA, "GA only": "#f5a98a", "RS only": C_RS, "none": "#d9d7d0"}
hatch = {"both": None, "GA only": "////", "RS only": None, "none": None}
groups = [g for g in ("guaranteed", "non_guaranteed") if (w.group == g).any()]
fig, axes = plt.subplots(len(groups), 1, figsize=(7.2, 1.0 + 1.6 * len(groups)), sharex=True, squeeze=False)
for ax, grp in zip(axes[:, 0], groups):
    d = w[w.group == grp]
    tab = pd.crosstab(d.status_MZN, d.heur).reindex(index=order_s, columns=cats).fillna(0).astype(int)
    tab.to_csv(f"{OUT}/reconciliation_matrix_{grp}.csv")
    left = np.zeros(len(order_s))
    for c in cats:
        vals = tab[c].to_numpy()
        ax.barh(order_s, vals, left=left, color=colors[c], edgecolor="white", linewidth=1.0, label=c, hatch=hatch[c])
        for i, v in enumerate(vals):
            if v >= 0.05 * max(1, len(d)):
                ax.text(left[i] + v / 2, i, f"{v:,}", ha="center", va="center", fontsize=7, color=C_TEXT)
        left += vals
    ax.set_yticks(range(len(order_s))); ax.set_yticklabels([f"MiniZinc {s}\n(n={tab.loc[s].sum():,})" for s in order_s], fontsize=7.5)
    ax.invert_yaxis(); ax.grid(axis="x"); ax.set_axisbelow(True)
    unsat_contra = int(tab.loc["UNSAT", ["both", "GA only", "RS only"]].sum())
    to_res = int(tab.loc["TIMEOUT", ["both", "GA only", "RS only"]].sum())
    ax.set_title(f"QFBS {grp.replace('_', '-')} group (n={len(d):,}): {unsat_contra} UNSAT proofs contradicted by a validated binding; "
                 f"{to_res} of {int(tab.loc['TIMEOUT'].sum())} CP time-outs resolved by a heuristic", loc="left", fontsize=8)
axes[-1, 0].set_xlabel("Instances")
axes[-1, 0].legend(title="Heuristic(s) returning a gateway-validated binding", ncol=4, loc="upper center", bbox_to_anchor=(0.5, -0.45), title_fontsize=7.5)
fig.tight_layout()
save(fig, "fig_rq3_reconciliation")

# ------------------------------------------------------------------ RQ4: gap to the certified optimum
fig, axes = plt.subplots(1, 2, figsize=(7.4, 2.7), gridspec_kw={"width_ratios": [1.05, 1]})
ax = axes[0]
n_ga = ecdf(ax, gap_q.gap_GA, C_GA, "GA", clip_low=0)
n_rs = ecdf(ax, gap_q.gap_RS, C_RS, "RS", clip_low=0)
ax.set_xlim(-0.005, 0.5); ax.set_ylim(0, 1.02)
ax.set_xlabel("Gap to the certified optimum (weighted-sum score, 0-1 scale)")
ax.set_ylabel("Share of instances (ECDF)")
ax.grid(axis="y"); ax.set_axisbelow(True); ax.legend(loc="lower right")
if n_ga:
    ga_zero = (gap_q.gap_GA.dropna().abs() <= TOL).mean()
    ax.annotate(f"{ga_zero:.0%} match the optimum", xy=(0.0, ga_zero), xytext=(0.09, max(0.05, ga_zero - 0.13)), color=C_TEXT, fontsize=7.5,
                arrowprops=dict(arrowstyle="-", color=C_MUTED, lw=0.6))
if n_rs:
    rs_zero = (gap_q.gap_RS.dropna().abs() <= TOL).mean()
    ax.annotate(f"{rs_zero:.0%} match", xy=(0.0, rs_zero), xytext=(0.06, min(0.95, rs_zero + 0.1)), color=C_TEXT, fontsize=7.5,
                arrowprops=dict(arrowstyle="-", color=C_MUTED, lw=0.6))
ax.set_title(f"(a) QFBS: gap to the optimum ({len(gap_q):,} OPTIMAL instances)", loc="left", fontsize=8.5)

ax = axes[1]
rows = []
for size in (12, 24, 48):
    for k in (1, 3, 5):
        d = gap_q[(gap_q["size"].astype(str) == str(size)) & (gap_q.objective_count.astype(str) == str(k))]
        if len(d):
            # Conditional on the heuristic returning a binding (quality, not yield), as in panel (a).
            ga, rs = d.gap_GA.dropna(), d.gap_RS.dropna()
            rows.append({"size": size, "k": k, "n": len(ga),
                         "GA": (ga.abs() <= TOL).sum() / max(len(ga), 1), "RS": (rs.abs() <= TOL).sum() / max(len(rs), 1)})
t = pd.DataFrame(rows)
if len(t):
    xs = []; pos = 0.0; last = None
    for r in t.itertuples():
        if last is not None and r.size != last:
            pos += 0.7
        xs.append(pos); pos += 1.4; last = r.size
    xs = np.array(xs); bw = 0.55
    ax.bar(xs - bw / 2, t.GA, bw, color=C_GA, label="GA", linewidth=0)
    ax.bar(xs + bw / 2, t.RS, bw, color=C_RS, label="RS", linewidth=0)
    for xi, r in zip(xs, t.itertuples()):
        ax.text(xi - bw / 2, r.GA + 0.02, f"{r.GA:.0%}", ha="center", va="bottom", fontsize=6.5, color=C_TEXT)
    ax.set_xticks(xs); ax.set_xticklabels([f"k={r.k}\n{r.n:,}" for r in t.itertuples()], fontsize=6.2)
    for size in (12, 24, 48):
        sel = xs[t["size"].to_numpy() == size]
        if len(sel):
            ax.text(sel.mean(), 1.09, f"{size} tasks", ha="center", va="bottom", fontsize=7.5, color=C_MUTED)
            ax.plot([sel.min() - 0.45, sel.max() + 0.45], [1.07, 1.07], color="#bdbbb4", lw=0.6)
ax.set_ylim(0, 1.2); ax.set_yticks([0, .25, .5, .75, 1]); ax.set_yticklabels(["0%", "25%", "50%", "75%", "100%"])
ax.set_ylabel("Share attaining the optimum\n(of instances with a GA / RS binding)")
ax.grid(axis="y"); ax.set_axisbelow(True)
ax.set_title("(b) Optimum attained by size and k objectives (colours as in a; n = GA bindings)", loc="left", fontsize=8.5)
fig.tight_layout(w_pad=1.5)
save(fig, "fig_rq4_gap")

# recovered suites: one small panel per suite with a certified optimum
rec = gap_all[(gap_all.suite != "07_qfbs")]
suites = [s for s in SUITE_ORDER if s in set(rec.suite)]
if suites:
    fig, axes = plt.subplots(1, len(suites), figsize=(2.0 * len(suites) + 0.6, 2.5), sharey=True, squeeze=False)
    for ax, suite in zip(axes[0], suites):
        d = rec[rec.suite == suite]
        ecdf(ax, d.gap_GA, C_GA, "GA", clip_low=0); ecdf(ax, d.gap_RS, C_RS, "RS", clip_low=0)
        ax.set_xlim(-0.005, 0.5); ax.set_ylim(0, 1.02); ax.grid(axis="y"); ax.set_axisbelow(True)
        ax.set_title(f"{SUITE_NAMES[suite]}\n{len(d):,} certified optima", loc="left", fontsize=7.5)
        ax.set_xlabel("Gap to optimum"); ax.legend(loc="lower right", fontsize=6.5)
    axes[0, 0].set_ylabel("Share of instances (ECDF)")
    fig.tight_layout(w_pad=1.0)
    save(fig, "fig_rq4_gap_recovered")

# ------------------------------------------------------------------ RQ4: HSC against the reference compositions
hs = pd.read_csv(f"{OUT}/hsc_instances.csv")
fig, axes = plt.subplots(1, 2, figsize=(7.4, 2.6), gridspec_kw={"width_ratios": [1.1, 1]})
ax = axes[0]
for tag, color, label in (("GA", C_GA, "Elitist GA"), ("RS", C_RS, "Random search")):
    ecdf(ax, hs[f"gap_to_ref_{tag}"], color, label)
ax.axvline(0, color=C_MUTED, lw=0.6, ls=":")
ax.set_xlim(-0.4, 0.4); ax.set_ylim(0, 1.02)
ax.set_xlabel("Score minus the reference objective (negative: better than the authors' composition)")
ax.set_ylabel("Share of instances (ECDF)")
ax.grid(axis="y"); ax.set_axisbelow(True); ax.legend(loc="lower right")
for tag, yy in (("GA", 0.66), ("RS", 0.58)):
    g = hs[f"gap_to_ref_{tag}"].dropna()
    if len(g):
        ax.text(-0.39, yy, f"{tag}: better than the reference in {(g < -TOL).mean():.0%}, equal in {(g.abs() <= TOL).mean():.0%}", fontsize=7, color=C_TEXT)
ax.set_title(f"(a) HSC: score against the reference composition ({int(hs.ref_complete.sum()):,} inst.)", loc="left", fontsize=8.5)
ax = axes[1]
tab = pd.read_csv(f"{OUT}/hsc_quality_by_constraints.csv")
x = np.arange(len(tab)); bw = 0.38
for i, (tag, color, label) in enumerate((("GA", C_GA, "Elitist GA"), ("RS", C_RS, "Random search"))):
    share = tab[f"{tag}_zero_penalty"] / tab.instances
    ax.bar(x + (i - 0.5) * bw, share, bw, color=color, label=f"{label}: all soft constraints met", linewidth=0)
    for xi, v in zip(x, share):
        ax.text(xi + (i - 0.5) * bw, v + 0.02, f"{v:.0%}", ha="center", va="bottom", fontsize=6.3, color=C_TEXT)
ref_share = tab.ref_violates_constraints / tab.instances
ax.plot(x, 1 - ref_share, "D", color=C_MUTED, ms=4, label="reference composition meets its constraints")
ax.set_xticks(x); ax.set_xticklabels([f"{int(k)} constr.\n(n={int(n):,})" for k, n in zip(tab.n_constraints, tab.instances)], fontsize=6.8)
ax.set_ylim(0, 1.15); ax.set_yticks([0, .25, .5, .75, 1]); ax.set_yticklabels(["0%", "25%", "50%", "75%", "100%"])
ax.grid(axis="y"); ax.set_axisbelow(True); ax.legend(loc="upper center", fontsize=6.3, ncol=1, bbox_to_anchor=(0.5, -0.28))
ax.set_title("(b) Zero-penalty bindings by number of soft constraints", loc="left", fontsize=8.5)
fig.tight_layout(w_pad=1.5)
save(fig, "fig_rq4_hsc")

# ------------------------------------------------------------------ time to binding (QFBS)
q = pd.read_pickle(f"{OUT}/runs.pkl"); q = q[(q.suite == "07_qfbs") & (q.repeat == 0)].copy()
q["eng"] = q.engine.map({"minizinc-csp": "MZN", "evolutionary-heuristics": "GA", "random-search": "RS"})
q["group"] = np.where(q.instance_id.str.contains("non_guaranteed"), "non-guaranteed", "guaranteed")
fig, axes = plt.subplots(1, 2, figsize=(7.0, 2.4), sharey=True)
for ax, grp in zip(axes, ("guaranteed", "non-guaranteed")):
    d = q[q.group == grp]
    series = [
        ("MiniZinc: proof of optimality (OPTIMAL)", d[(d.eng == "MZN") & (d.status == "OPTIMAL")].runtime_ms, C_MZN, "-"),
        ("Elitist GA: first feasible binding", d[(d.eng == "GA") & (d.status == "FEASIBLE")].first_feasible_ms, C_GA, "-"),
        ("Elitist GA: last improvement", d[(d.eng == "GA") & (d.status == "FEASIBLE")].best_ms, C_GA, "--"),
        ("Random search: first feasible binding", d[(d.eng == "RS") & (d.status == "FEASIBLE")].first_feasible_ms, C_RS, "-"),
    ]
    for label, s, color, ls in series:
        ecdf(ax, s, color, label, ls=ls, clip_low=0.5)
    ax.set_xscale("log"); ax.set_xlim(0.5, 6000); ax.set_ylim(0, 1.02)
    ax.axvline(5000, color=C_MUTED, lw=0.6, ls=":"); ax.text(5000, 0.04, "5 s budget", rotation=90, fontsize=6.5, color=C_MUTED, ha="right", va="bottom")
    ax.set_xlabel("Milliseconds (log scale; 0 ms drawn at 0.5)"); ax.grid(axis="y"); ax.set_axisbelow(True)
    ax.set_title(f"QFBS {grp} group", loc="left", fontsize=8.5)
    if grp == "guaranteed":
        ax.set_ylabel("Share of runs (ECDF)")
    ax.legend(loc="lower right", fontsize=6.3)
fig.tight_layout(w_pad=1.2)
save(fig, "fig_time_to_binding")
print("figures written to", FIG)

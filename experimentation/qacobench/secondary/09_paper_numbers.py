#!/usr/bin/env python3
"""Step 9: LaTeX macros for every campaign-derived number quoted in the paper.

Writes ``latex/paper_numbers.tex`` (``\\newcommand`` per number) from the primary evaluation
(``../evaluation/*.csv``) and the secondary-analysis outputs, so that the manuscript text never
carries a hand-typed result: ``\\input{paper_numbers}`` and recompile after every campaign.
Macro names are letters only (LaTeX); values are formatted as printed (thousands separators,
percentages without the sign).
"""
import csv
import json
import os
import re
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import OUT, TOL

EVAL = OUT.parent / "evaluation"
TEX = OUT / "latex"
TEX.mkdir(parents=True, exist_ok=True)

macros: dict[str, str] = {}


def define(name: str, value) -> None:
    if not re.fullmatch(r"[A-Za-z]+", name):
        raise ValueError(f"macro names must be letters only: {name}")
    if name in macros:
        raise ValueError(f"duplicate macro {name}")
    macros[name] = str(value)


def count(name: str, value) -> None:
    define(name, f"{int(round(float(value))):,}")


def pct(name: str, value, digits: int = 1) -> None:
    define(name, f"{100 * float(value):.{digits}f}")


def dec(name: str, value, digits: int = 3) -> None:
    define(name, f"{float(value):.{digits}f}")


# ---- primary evaluation: outcomes and termination reasons
outcomes = {(r["suite"], r["engine"]): r for r in csv.DictReader(open(EVAL / "outcomes_by_suite_engine.csv"))}
ENG = {"MZN": "minizinc-csp", "GA": "evolutionary-heuristics", "RS": "random-search"}
SUITE = {"Icws": "01_icws", "Quantum": "02_quantum", "Hsc": "03_hsc_llm", "Rprsr": "04_rprsr15",
         "Iots": "05_iots", "Bws": "06_bws_scp", "Qfbs": "07_qfbs"}
for sname, sid in SUITE.items():
    for ename, eid in ENG.items():
        r = outcomes[(sid, eid)]
        count(f"{sname}{ename}Binding", r["binding_returned"])
        count(f"{sname}{ename}Optimal", r["optimal"])
        count(f"{sname}{ename}Feasible", r["feasible"])
        count(f"{sname}{ename}Unsat", r["unsat"])
        count(f"{sname}{ename}Timeout", r["timeout"])
        count(f"{sname}{ename}Incompatible", r["incompatible"])
        submitted = int(r["submitted"])
        pct(f"{sname}{ename}BindingPct", int(r["binding_returned"]) / submitted if submitted else 0)
acceptance = json.load(open(EVAL / "acceptance.json"))
count("Runs", acceptance["runs"])
count("Duplicates", acceptance["duplicates"])
count("InfrastructureErrors", acceptance["infrastructure_errors"])
count("OptimalBeaten", acceptance["optimal_beaten_by_other_engine"])
count("UnsatContradicted", acceptance["unsat_with_validated_binding"])

term = pd.read_csv(EVAL / "termination_reasons.csv")


def runs(suite, engine, reason, status=None):
    d = term[(term.suite == suite) & (term.engine == engine) & (term.termination_reason == reason)]
    if status:
        d = d[d.status == status]
    return int(d.runs.sum())


count("RprsrGATimeBudget", runs("04_rprsr15", ENG["GA"], "time_budget"))
count("BwsGATimeBudget", runs("06_bws_scp", ENG["GA"], "time_budget"))
count("BwsRSTimeBudget", runs("06_bws_scp", ENG["RS"], "time_budget"))
count("IotsGATimeBudget", runs("05_iots", ENG["GA"], "time_budget"))
count("QfbsGATimeBudget", runs("07_qfbs", ENG["GA"], "time_budget"))
count("QfbsRSTimeBudget", runs("07_qfbs", ENG["RS"], "time_budget"))
count("HscGATimeBudget", runs("03_hsc_llm", ENG["GA"], "time_budget"))

# ---- capability diagnostics (HSC rejections)
cap = pd.read_csv(OUT / "capability_matrix.csv")
for _, r in cap.iterrows():
    key = r["reason"].split(":")[-1].strip().replace(".", " ").title().replace(" ", "")
    count(f"HscReject{key}", r.get("03_hsc_llm", 0))

# ---- RQ1: hardness by factor
labels = pd.read_csv(OUT / "labels_by_group.csv").set_index("group")
count("QfbsSettled", labels.loc["All", "OPTIMAL"] + labels.loc["All", "UNSAT"])
pct("QfbsSettledPct", (labels.loc["All", "OPTIMAL"] + labels.loc["All", "UNSAT"]) / labels.loc["All", "All"])
fa = pd.read_csv(OUT / "factor_analysis.csv")


def level(fac, lvl):
    return fa[(fa.factor == fac) & (fa.level.astype(str) == str(lvl))].iloc[0]


for fac, lvl, tag in (("structure", "sequence", "StructSequence"), ("structure", "repeat", "StructRepeat"),
                      ("size", "12", "SizeTwelve"), ("size", "24", "SizeTwentyFour"), ("size", "48", "SizeFortyEight"),
                      ("objective_count", "1", "ObjOne"), ("objective_count", "3", "ObjThree"), ("objective_count", "5", "ObjFive"),
                      ("constraint_count_mode", "exact", "ModeExact"), ("constraint_count_mode", "expected", "ModeExpected"),
                      ("constraint_count", "1", "ConsOne"), ("constraint_count", "3", "ConsThree"), ("constraint_count", "5", "ConsFive"),
                      ("constraint_setting", "0", "SettingOne"), ("constraint_setting", "1", "SettingTwo")):
    r = level(fac, lvl)
    pct(f"Proof{tag}", r.MZN_proof_rate_all, 0)
    count(f"ProofMs{tag}", r.MZN_median_proof_ms)
    pct(f"GAAttains{tag}", r.GA_share_matches_optimum, 0)
    pct(f"UnsatNonG{tag}", r.MZN_UNSAT_rate_nonguaranteed, 1)
effects = pd.read_csv(OUT / "factor_effects.csv").set_index("factor")
pct("ProofSpreadMaxOther", effects.drop(["structure", "size", "objective_count", "constraint_count_mode"]).proof_rate_spread.max(), 1)
mzn_rt = pd.read_csv(OUT / "mzn_runtime_by_status.csv")
count("QfbsMznMedianMs", pd.read_csv(OUT / "timing_budget.csv").query("suite == '07_qfbs' and engine == 'MZN'").runtime_median_ms.iloc[0])
count("QfbsMznMaxProofMs", mzn_rt[mzn_rt.status.isin(["OPTIMAL", "UNSAT"])]["max"].max())

# ---- RQ3: groups, reconciliation, pairs
rec = pd.read_csv(OUT / "reconciliation_summary.csv").set_index("subset")
for group, tag in (("qfbs:guaranteed", "G"), ("qfbs:non_guaranteed", "NG"), ("qfbs:all", "All")):
    r = rec.loc[group]
    count(f"Qfbs{tag}Optimal", r.MZN_OPTIMAL)
    count(f"Qfbs{tag}Feasible", r.MZN_FEASIBLE)
    count(f"Qfbs{tag}Unsat", r.MZN_UNSAT)
    count(f"Qfbs{tag}MznTimeout", r.MZN_TIMEOUT)
    count(f"Qfbs{tag}GABinding", r.GA_binding)
    count(f"Qfbs{tag}RSBinding", r.RS_binding)
    count(f"Qfbs{tag}KnownFeasible", r["known_feasible(any engine)"])
    count(f"Qfbs{tag}Unresolved", r["unresolved(no engine binding, not UNSAT)"])
    count(f"Qfbs{tag}GAMiss", r.GA_miss_on_known_feasible)
    count(f"Qfbs{tag}RSMiss", r.RS_miss_on_known_feasible)
    pct(f"Qfbs{tag}UnsatPct", r.MZN_UNSAT / r.instances)
    pct(f"Qfbs{tag}OptimalPct", r.MZN_OPTIMAL / r.instances)
pairs = pd.read_csv(OUT / "paired_summary.csv").iloc[0]
count("PairsBothOptimal", pairs.both_MZN_OPTIMAL)
count("PairsNonGWorse", pairs["nonguaranteed_optimum_worse_than_guaranteed(score higher)"])
count("PairsEqual", pairs.equal)
count("PairsNonGBetter", pairs.nonguaranteed_optimum_better)
ttf = pd.read_csv(OUT / "qfbs_time_to_feasible.csv", header=[0, 1], index_col=[0, 1])
for group, tag in (("guaranteed", "G"), ("non_guaranteed", "NG")):
    for eng in ("GA", "RS"):
        count(f"FirstFeasibleEval{tag}{eng}", ttf.loc[("first_feasible_eval", "50%"), (group, eng)])

# ---- RQ4: gaps, incumbents, best known
gap = pd.read_csv(OUT / "optimality_gap.csv")


def gap_row(by, lvl, eng):
    return gap[(gap.by == by) & (gap.level.astype(str) == str(lvl)) & (gap.engine == eng)].iloc[0]


for by, lvl, tag in (("qfbs", "all", "QfbsAll"), ("group", "guaranteed", "QfbsG"), ("group", "non_guaranteed", "QfbsNG"),
                     ("objective_count", "1", "ObjOne"), ("objective_count", "3", "ObjThree"), ("objective_count", "5", "ObjFive"),
                     ("size", "12", "SizeTwelve"), ("size", "24", "SizeTwentyFour"), ("size", "48", "SizeFortyEight"),
                     ("suite", "01_icws", "Icws"), ("suite", "02_quantum", "Quantum"), ("suite", "04_rprsr15", "Rprsr"),
                     ("suite", "05_iots", "Iots"), ("suite", "06_bws_scp", "Bws"), ("recovered", "all", "Recovered"),
                     ("corpus", "all", "Corpus")):
    for eng in ("GA", "RS"):
        r = gap_row(by, lvl, eng)
        count(f"Gap{tag}{eng}Instances", r.instances)
        count(f"Gap{tag}{eng}WithBinding", r.with_binding)
        count(f"Gap{tag}{eng}Attains", r["matches_optimum(|gap|<=1e-9)"])
        pct(f"Gap{tag}{eng}AttainsPct", r.share_matches_optimum_of_bound)
        dec(f"Gap{tag}{eng}Median", r.gap_median)
        dec(f"Gap{tag}{eng}Mean", r.gap_mean)
        dec(f"Gap{tag}{eng}PNinety", r.gap_p90)
        dec(f"Gap{tag}{eng}Max", r.gap_max)
        pct(f"Gap{tag}{eng}WithinFive", r["share_gap<=0.05"], 0)
        pct(f"Gap{tag}{eng}AboveTen", r["share_gap>0.10"], 1)
inc = pd.read_csv(OUT / "vs_cp_incumbent.csv")


def inc_row(subset, eng):
    return inc[(inc.subset == subset) & (inc.engine == eng)].iloc[0]


for subset, tag in (("qfbs:all", "QfbsAll"), ("04_rprsr15", "Rprsr"), ("06_bws_scp", "Bws"), ("corpus", "Corpus")):
    for eng in ("GA", "RS"):
        r = inc_row(subset, eng)
        count(f"Inc{tag}{eng}Instances", r.MZN_FEASIBLE_instances)
        count(f"Inc{tag}{eng}WithBinding", r.heuristic_with_binding)
        count(f"Inc{tag}{eng}Better", r["heuristic_better(<-1e-9)"])
        count(f"Inc{tag}{eng}Equal", r.equal)
        count(f"Inc{tag}{eng}Worse", r["heuristic_worse(>1e-9)"])
        dec(f"Inc{tag}{eng}MedianImprovement", r.median_improvement_when_better if pd.notna(r.median_improvement_when_better) else 0)
vb = pd.read_csv(OUT / "virtual_best.csv")


def vb_row(subset, eng):
    return vb[(vb.subset == subset) & (vb.engine == eng)].iloc[0]


count("CorpusKnownFeasible", vb_row("corpus", "GA").known_feasible_instances)
for eng in ("MZN", "GA", "RS"):
    r = vb_row("corpus", eng)
    count(f"BestKnown{eng}", r.attains_best_known)
    count(f"BestKnown{eng}WithBinding", r.with_binding)
    pct(f"BestKnown{eng}PctAll", r.share_attains_best_known_of_all)
    pct(f"BestKnown{eng}PctBound", r.attains_best_known / r.with_binding if r.with_binding else 0)

# ---- HSC against the reference compositions
hsc = json.load(open(OUT / "hsc_quality_summary.json"))
count("HscInstances", hsc["instances"])
count("HscRefViolates", hsc["reference violates its own soft constraints (penalty > 0)"])
pct("HscRefViolatesPct", hsc["reference violates its own soft constraints (penalty > 0)"] / hsc["instances"], 0)
pct("HscBestValueMatchPct", hsc["share |best_value - recomputed| <= 1e-6"], 1)
for eng in ("GA", "RS"):
    count(f"Hsc{eng}ZeroPenalty", hsc[f"{eng}: zero-penalty bindings (all soft constraints met)"])
    count(f"Hsc{eng}Better", hsc[f"{eng}: better than reference (<-1e-9)"])
    count(f"Hsc{eng}Equal", hsc[f"{eng}: equal to reference"])
    count(f"Hsc{eng}Worse", hsc[f"{eng}: worse than reference"])
    pct(f"Hsc{eng}BetterPct", hsc[f"{eng}: better than reference (<-1e-9)"] / hsc["instances"], 0)
    pct(f"Hsc{eng}WorsePct", hsc[f"{eng}: worse than reference"] / hsc["instances"], 0)
    pct(f"Hsc{eng}ZeroPenaltyPct", hsc[f"{eng}: zero-penalty bindings (all soft constraints met)"] / hsc["instances"], 0)
by_c = pd.read_csv(OUT / "hsc_quality_by_constraints.csv").set_index("n_constraints")
pct("HscRefViolatesOneConstraintPct", by_c.loc[1, "ref_violates_constraints"] / by_c.loc[1, "instances"], 0)
pct("HscRefViolatesFourConstraintsPct", by_c.loc[4, "ref_violates_constraints"] / by_c.loc[4, "instances"], 0)
pct("HscGAZeroPenaltyOneConstraintPct", by_c.loc[1, "GA_zero_penalty"] / by_c.loc[1, "instances"], 0)
pct("HscGAZeroPenaltyFourConstraintsPct", by_c.loc[4, "GA_zero_penalty"] / by_c.loc[4, "instances"], 0)

with open(TEX / "paper_numbers.tex", "w") as out:
    out.write("% Generated by experimentation/qacobench/secondary/09_paper_numbers.py; do not edit by hand.\n")
    out.write("% Every macro ends with \\xspace; the manuscript adds \\xspaceaddexceptions{\\%}.\n")
    for name, value in macros.items():
        out.write(f"\\newcommand{{\\{name}}}{{{value}\\xspace}}\n")
print(f"wrote {TEX / 'paper_numbers.tex'} ({len(macros)} macros)")

"""Analysis helpers for the OpenBinding4Placement campaign results.

Keeps the evaluation notebook thin: loading, reference objectives (with the
exact-failure fallback protocol), offline cutoff studies over the best-so-far
traces, baseline improvements, performance profiles, statistics, and figure
export. Random search is the global baseline of the study; the reference per
instance is the exact solver's incumbent when available and the best heuristic
value at the standard 1000-evaluation cutoff otherwise.
"""

from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np
import pandas as pd

EXACT_ENGINE = "minizinc-csp"
BASELINE_ENGINE = "random-search"
HEURISTIC_ENGINES = ("random-search", "evolutionary-heuristics")
STANDARD_EVAL_CUTOFF = 1000

ENGINE_LABELS = {
    "minizinc-csp": "Exact (Gecode)",
    "random-search": "Random search",
    "evolutionary-heuristics": "NSGA-II",
}
ENGINE_COLORS = {
    "minizinc-csp": "#1f77b4",
    "random-search": "#7f7f7f",
    "evolutionary-heuristics": "#2ca02c",
}


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_results(results_dir: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    runs = pd.read_csv(results_dir / "runs.csv")
    traces = pd.read_csv(results_dir / "traces.csv")
    runs["feasible"] = runs["feasible"].map(
        {True: True, False: False, "True": True, "False": False}
    ).astype("boolean")
    traces["feasible"] = traces["feasible"].map(
        {True: True, False: False, "True": True, "False": False}
    ).astype("boolean")
    return runs, traces


def feasible_runs(runs: pd.DataFrame) -> pd.DataFrame:
    return runs[
        (runs.status == "ok")
        & runs.feasible.fillna(False)
        & runs.objective_value.notna()
    ]


# ---------------------------------------------------------------------------
# Offline cutoff studies over best-so-far traces
# ---------------------------------------------------------------------------

def j_at_cutoff(
    traces: pd.DataFrame,
    eval_cutoff: int | None = None,
    time_cutoff_ms: float | None = None,
) -> pd.DataFrame:
    """Best feasible objective per run at an evaluation and/or time cutoff.

    Cutoffs are applied to the improvement events recorded in the trace, so
    any tau below the campaign budget T can be studied without re-running.
    """
    subset = traces[traces.feasible == True]  # noqa: E712
    if eval_cutoff is not None:
        subset = subset[subset.eval_index.notna() & (subset.eval_index <= eval_cutoff)]
    if time_cutoff_ms is not None:
        subset = subset[subset.elapsed_ms <= time_cutoff_ms]
    best = subset.groupby("run_id").best_objective.min().rename("J")
    engines = traces.groupby("run_id").engine.first()
    seeds = traces.groupby("run_id").seed.first()
    return pd.concat([best, engines, seeds], axis=1).reset_index()


def step_best_so_far(trace_run: pd.DataFrame, grid: np.ndarray, x: str = "eval_index") -> np.ndarray | None:
    """Best-so-far value on a grid; step interpolation (curves are staircases)."""
    feasible = trace_run[trace_run.feasible == True].sort_values(x)  # noqa: E712
    feasible = feasible[feasible[x].notna()]
    if feasible.empty:
        return None
    idx = np.searchsorted(feasible[x].values, grid, side="right") - 1
    return np.where(idx >= 0, feasible.best_objective.values[np.clip(idx, 0, None)], np.nan)


def convergence_band(
    traces: pd.DataFrame,
    instance_id: str,
    engine: str,
    grid: np.ndarray,
    x: str = "eval_index",
) -> dict[str, np.ndarray] | None:
    """Median and IQR band of the best-so-far curves over the seeds of a run."""
    t = traces[(traces.engine == engine) & traces.run_id.str.startswith(instance_id + "|")]
    curves = [
        c for _, g in t.groupby("run_id") if (c := step_best_so_far(g, grid, x)) is not None
    ]
    if not curves:
        return None
    matrix = np.vstack(curves)
    with warnings.catch_warnings():
        # Grid points before the first feasible improvement of every seed are
        # all-NaN by construction; the resulting NaN aggregate is simply not
        # plotted, so the RuntimeWarning is noise.
        warnings.filterwarnings("ignore", message="All-NaN slice encountered")
        return {
            "median": np.nanmedian(matrix, axis=0),
            "q1": np.nanpercentile(matrix, 25, axis=0),
            "q3": np.nanpercentile(matrix, 75, axis=0),
            "n": matrix.shape[0],
        }


# ---------------------------------------------------------------------------
# Reference objectives (exact-failure fallback protocol) and baseline
# ---------------------------------------------------------------------------

def reference_objectives(runs: pd.DataFrame, traces: pd.DataFrame) -> pd.DataFrame:
    """Per-instance reference objective:

    - ``exact_optimal``: the exact engine proved optimality;
    - ``exact_incumbent``: exact returned its best (unproven) incumbent;
    - ``heuristic_fallback``: exact returned no solution — the reference is
      the best heuristic value at the standard 1000-evaluation cutoff.
    """
    ok = feasible_runs(runs)
    # Keep one exact row per instance (the best incumbent) — robust against
    # accidental duplicate rows in a merged/resumed runs.csv.
    exact = (
        ok[ok.engine == EXACT_ENGINE]
        .sort_values("objective_value")
        .drop_duplicates("instance_id")
        .set_index("instance_id")
    )

    fallback = j_at_cutoff(traces, eval_cutoff=STANDARD_EVAL_CUTOFF)
    fallback["instance_id"] = fallback.run_id.str.split("|").str[0]
    fallback_best = fallback.groupby("instance_id").J.min()

    rows = []
    for instance_id in runs.instance_id.unique():
        if instance_id in exact.index:
            row = exact.loc[instance_id]
            source = (
                "exact_optimal" if row.solver_status == "OPTIMAL" else "exact_incumbent"
            )
            rows.append({
                "instance_id": instance_id,
                "reference_J": row.objective_value,
                "reference_source": source,
            })
        elif instance_id in fallback_best.index:
            rows.append({
                "instance_id": instance_id,
                "reference_J": fallback_best.loc[instance_id],
                "reference_source": "heuristic_fallback",
            })
        else:
            rows.append({
                "instance_id": instance_id,
                "reference_J": np.nan,
                "reference_source": "none",
            })
    return pd.DataFrame(rows)


def gaps_to_reference(runs: pd.DataFrame, references: pd.DataFrame) -> pd.DataFrame:
    """Relative gap of every feasible heuristic run to the instance reference."""
    ok = feasible_runs(runs)
    merged = ok[ok.engine != EXACT_ENGINE].merge(references, on="instance_id")
    merged = merged[merged.reference_J.notna()]
    merged["gap"] = (merged.objective_value - merged.reference_J) / merged.reference_J.abs().clip(lower=1e-9)
    return merged


def improvement_over_baseline(runs: pd.DataFrame) -> pd.DataFrame:
    """Median % improvement over the random-search baseline, per instance/engine.

    improvement = (J_baseline_median - J_engine_median) / J_baseline_median.
    Positive values mean the engine beats the baseline.
    """
    empty = pd.DataFrame(columns=["instance_id", "engine", "improvement_vs_baseline"])
    ok = feasible_runs(runs)
    if ok.empty:
        return empty
    medians = (
        ok.groupby(["instance_id", "engine"]).objective_value.median().unstack("engine")
    )
    if BASELINE_ENGINE not in medians.columns:
        # The baseline found no feasible solution anywhere: improvements over
        # it are undefined (report feasibility rates instead).
        return empty
    baseline = medians[BASELINE_ENGINE]
    rows = []
    for engine in medians.columns:
        if engine == BASELINE_ENGINE:
            continue
        improvement = (baseline - medians[engine]) / baseline.abs().clip(lower=1e-9)
        rows.append(pd.DataFrame({
            "instance_id": medians.index,
            "engine": engine,
            "improvement_vs_baseline": improvement.values,
        }))
    if not rows:
        return empty
    return pd.concat(rows, ignore_index=True).dropna()


def first_feasible_vs_best(traces: pd.DataFrame) -> pd.DataFrame:
    """Per-run quality of the first feasible solution vs the final best.

    The first feasible improvement event in a trace is the closest observable
    proxy for what a feasibility-oriented placer (eligibility-only, a la
    SecFaaS2Fog) would return; the drop to the final best quantifies what
    optimization adds on top of mere validity.

    optimization_gain = (J_first_feasible - J_best) / J_first_feasible.
    """
    feas = traces[traces.feasible == True].sort_values("elapsed_ms")  # noqa: E712
    grouped = feas.groupby("run_id")
    out = pd.DataFrame({
        "J_first_feasible": grouped.best_objective.first(),
        "J_best": grouped.best_objective.min(),
        "first_feasible_ms": grouped.elapsed_ms.first(),
        "engine": grouped.engine.first(),
    }).reset_index()
    out["instance_id"] = out.run_id.str.split("|").str[0]
    out["optimization_gain"] = (
        (out.J_first_feasible - out.J_best)
        / out.J_first_feasible.abs().clip(lower=1e-9)
    )
    return out


def time_to_reference(
    runs: pd.DataFrame,
    traces: pd.DataFrame,
    references: pd.DataFrame,
    engine: str = "evolutionary-heuristics",
    tolerance: float = 0.0,
) -> pd.DataFrame:
    """Per-instance time for an engine to reach the instance reference J.

    For every run, the elapsed time of the first feasible best-so-far value
    within ``tolerance`` of ``reference_J``. Per instance, the median over the
    seeds is taken with non-reaching seeds counted as +inf, so ``t_reach_ms``
    is NaN unless the majority of seeds actually reach the reference. The
    exact solver's time and completion status are attached for comparison.
    """
    ref = references.set_index("instance_id")
    feas = traces[(traces.engine == engine) & (traces.feasible == True)].copy()  # noqa: E712
    feas["instance_id"] = feas.run_id.str.split("|").str[0]

    rows = []
    for (instance_id, run_id), g in feas.groupby(["instance_id", "run_id"]):
        if instance_id not in ref.index or pd.isna(ref.loc[instance_id, "reference_J"]):
            continue
        target = ref.loc[instance_id, "reference_J"] * (1 + tolerance) + 1e-12
        hit = g[g.best_objective <= target].elapsed_ms
        rows.append({
            "instance_id": instance_id,
            "run_id": run_id,
            "t_reach_ms": hit.min() if len(hit) else np.nan,
        })
    per_run = pd.DataFrame(rows)

    def strict_median(s: pd.Series) -> float:
        med = np.median(s.fillna(np.inf).values)
        return med if np.isfinite(med) else np.nan

    per_instance = per_run.groupby("instance_id").t_reach_ms.agg(
        t_reach_ms=strict_median,
        reach_rate=lambda s: s.notna().mean(),
    ).reset_index()

    exact = (
        runs[runs.engine == EXACT_ENGINE]
        [["instance_id", "engine_execution_time_ms", "solver_status"]]
        .rename(columns={"engine_execution_time_ms": "exact_ms"})
    )
    return (per_instance
            .merge(exact, on="instance_id", how="left")
            .merge(references, on="instance_id", how="left"))


# ---------------------------------------------------------------------------
# Performance profiles (Dolan & More, 2002)
# ---------------------------------------------------------------------------

def performance_profile(
    runs: pd.DataFrame,
    engines: list[str] | None = None,
    taus: np.ndarray | None = None,
) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """rho_e(tau) = fraction of instances where engine e's median J is within
    a factor tau of the best median J on that instance. Instances where an
    engine has no feasible run count as failures for that engine."""
    ok = feasible_runs(runs)
    medians = ok.groupby(["instance_id", "engine"]).objective_value.median().unstack("engine")
    engines = engines or list(medians.columns)
    instances = medians.index
    best = medians[engines].min(axis=1)
    taus = taus if taus is not None else np.linspace(1.0, 3.0, 200)

    profiles: dict[str, np.ndarray] = {}
    for engine in engines:
        # Shift-safe ratio (J can be near zero): use (J + eps) / (best + eps).
        eps = 1e-9
        ratio = (medians[engine] + eps) / (best + eps)
        ratio = ratio.fillna(np.inf)
        profiles[engine] = np.array([(ratio <= tau).mean() for tau in taus])
    return taus, profiles


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def mean_ranks(runs: pd.DataFrame, engines: list[str] | None = None) -> tuple[pd.Series, dict]:
    """Demšar-style mean ranks of the engines over the instances + Friedman test.

    Per instance, engines are ranked by their median feasible canonical J
    (rank 1 = best; ties get average ranks). Engines with no feasible run on
    an instance rank worst on it. Rank-based aggregation is scale-free, so it
    is safe across instances despite per-instance normalization bounds.
    """
    from scipy.stats import friedmanchisquare, rankdata

    ok = feasible_runs(runs)
    medians = ok.groupby(["instance_id", "engine"]).objective_value.median().unstack("engine")
    engines = engines or [e for e in (EXACT_ENGINE, "evolutionary-heuristics", BASELINE_ENGINE)
                          if e in medians.columns]
    medians = medians.reindex(columns=engines)

    rank_rows = []
    for _, row in medians.iterrows():
        values = row.values.astype(float)
        # Missing (no feasible run) ranks worst: substitute +inf before ranking.
        values = np.where(np.isnan(values), np.inf, values)
        rank_rows.append(rankdata(values, method="average"))
    ranks = pd.DataFrame(rank_rows, columns=engines, index=medians.index)

    result: dict = {"n_instances": len(ranks)}
    if len(ranks) >= 3 and len(engines) >= 3:
        stat, p = friedmanchisquare(*[ranks[e].values for e in engines])
        result.update({"friedman_statistic": float(stat), "friedman_p_value": float(p)})
    return ranks.mean().rename("mean_rank"), result


def a12(x, y) -> float:
    """Vargha-Delaney A12: P(X < Y) + 0.5 P(X = Y).

    For minimization, values > 0.5 mean X tends to be smaller (better) than Y.
    """
    x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    wins = sum((xi < y).sum() + 0.5 * (xi == y).sum() for xi in x)
    return wins / (len(x) * len(y))


def pairwise_engine_stats(
    runs: pd.DataFrame,
    engine_a: str = "random-search",
    engine_b: str = "evolutionary-heuristics",
    alpha: float = 0.05,
) -> pd.DataFrame:
    """Per-instance Mann-Whitney U + A12 between two stochastic engines."""
    from scipy.stats import mannwhitneyu

    ok = feasible_runs(runs)
    rows = []
    for instance_id, group in ok.groupby("instance_id"):
        a = group[group.engine == engine_a].objective_value.values
        b = group[group.engine == engine_b].objective_value.values
        if len(a) < 3 or len(b) < 3:
            continue
        _, p = mannwhitneyu(a, b, alternative="two-sided")
        effect = a12(a, b)
        winner = "tie"
        if p < alpha:
            winner = engine_a if effect > 0.5 else engine_b
        rows.append({
            "instance_id": instance_id,
            "n_a": len(a), "n_b": len(b),
            "p_value": p,
            f"A12_{engine_a}_vs_{engine_b}": effect,
            "median_a": np.median(a), "median_b": np.median(b),
            "winner": winner,
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Plot utilities
# ---------------------------------------------------------------------------

def ecdf(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    values = np.sort(np.asarray(values, dtype=float))
    return values, np.arange(1, len(values) + 1) / len(values)


def save_fig(fig, name: str, figures_dir: Path) -> None:
    """Export a figure as paper-ready PDF plus a PNG preview."""
    figures_dir.mkdir(parents=True, exist_ok=True)
    fig.savefig(figures_dir / f"{name}.pdf", bbox_inches="tight")
    fig.savefig(figures_dir / f"{name}.png", bbox_inches="tight", dpi=180)


def instance_size(run_or_instance_id: str) -> int:
    return int(str(run_or_instance_id).split("infrastructure_")[1].split("|")[0].split(".")[0])

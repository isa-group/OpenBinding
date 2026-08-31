"""Analysis helpers for BIM v1 placement campaign results.

The campaign stores one authoritative end-of-run evaluation per engine seed.
This module deliberately analyses that contract only: it does not reconstruct
incumbent traces or compare gateway values with engine-reported QoS, because
the BIM v1 gateway is the sole evaluator for metrics, objectives, penalties,
and violations.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

BASELINE_ENGINE = "random-search"
CAMPAIGN_ENGINES = ("random-search", "evolutionary-heuristics")

ENGINE_LABELS = {
    "random-search": "Seeded random search",
    "evolutionary-heuristics": "Elitist genetic search",
}
ENGINE_COLORS = {
    "random-search": "#7f7f7f",
    "evolutionary-heuristics": "#2ca02c",
}

REQUIRED_COLUMNS = {
    "run_id",
    "instance_id",
    "engine",
    "mode",
    "algorithm",
    "status",
    "termination",
    "feasible",
    "objective_value",
    "hard_violations",
    "soft_violations",
    "instance_digest",
    "ir_digest",
    "engine_digest",
}


def load_results(results_dir: Path) -> pd.DataFrame:
    """Load a current BIM v1 ``runs.csv`` and validate its public columns."""
    runs = pd.read_csv(results_dir / "runs.csv")
    missing = REQUIRED_COLUMNS.difference(runs.columns)
    if missing:
        raise ValueError(f"runs.csv is not a BIM v1 campaign result; missing {sorted(missing)}")
    runs["feasible"] = runs["feasible"].map(
        {True: True, False: False, "True": True, "False": False}
    ).astype("boolean")
    for column in (
        "objective_value",
        "penalty",
        "hard_violations",
        "soft_violations",
        "engine_execution_time_ms",
        "engine_evaluations",
        "wall_time_s",
    ):
        if column in runs:
            runs[column] = pd.to_numeric(runs[column], errors="coerce")
    return runs


def feasible_runs(runs: pd.DataFrame) -> pd.DataFrame:
    """Return successfully evaluated feasible bindings with scalar scores."""
    return runs[
        (runs.status == "ok")
        & runs.feasible.fillna(False)
        & runs.termination.isin(["OPTIMAL", "FEASIBLE"])
        & runs.objective_value.notna()
        & (runs.hard_violations.fillna(0) == 0)
    ]


def provenance_summary(runs: pd.DataFrame) -> pd.DataFrame:
    """Count immutable execution contracts represented by each engine lane."""
    fields = [
        "engine",
        "mode",
        "algorithm",
        "engine_digest",
        "profile_digest",
        "protocol_digest",
        "compiler_digest",
        "evaluator_digest",
    ]
    return runs.groupby(fields, dropna=False).size().rename("runs").reset_index()


def termination_rates(runs: pd.DataFrame) -> pd.DataFrame:
    """Fraction of runs by explicit BIM termination and engine."""
    counts = runs.groupby(["engine", "termination"]).size().rename("runs").reset_index()
    counts["rate"] = counts["runs"] / counts.groupby("engine")["runs"].transform("sum")
    return counts


def per_instance_medians(runs: pd.DataFrame) -> pd.DataFrame:
    """Median authoritative score of feasible seeds per instance and engine."""
    ok = feasible_runs(runs)
    return (
        ok.groupby(["instance_id", "engine"], as_index=False)
        .objective_value.median()
        .rename(columns={"objective_value": "median_objective"})
    )


def improvement_over_baseline(
    runs: pd.DataFrame,
    baseline_engine: str = BASELINE_ENGINE,
) -> pd.DataFrame:
    """Relative median improvement over a baseline; positive means better."""
    medians = per_instance_medians(runs).pivot(
        index="instance_id", columns="engine", values="median_objective"
    )
    empty = pd.DataFrame(columns=["instance_id", "engine", "improvement_vs_baseline"])
    if baseline_engine not in medians:
        return empty
    baseline = medians[baseline_engine]
    rows = []
    for engine in medians.columns:
        if engine == baseline_engine:
            continue
        improvement = (baseline - medians[engine]) / baseline.abs().clip(lower=1e-12)
        rows.append(pd.DataFrame({
            "instance_id": medians.index,
            "engine": engine,
            "improvement_vs_baseline": improvement.values,
        }))
    return pd.concat(rows, ignore_index=True).dropna() if rows else empty


def performance_profile(
    runs: pd.DataFrame,
    engines: list[str] | None = None,
    taus: np.ndarray | None = None,
) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Dolan–Moré profile over per-instance median authoritative scores."""
    medians = per_instance_medians(runs).pivot(
        index="instance_id", columns="engine", values="median_objective"
    )
    engines = engines or [engine for engine in CAMPAIGN_ENGINES if engine in medians]
    medians = medians.reindex(columns=engines)
    taus = taus if taus is not None else np.linspace(1.0, 3.0, 200)
    best = medians.min(axis=1)
    profiles: dict[str, np.ndarray] = {}
    for engine in engines:
        ratio = ((medians[engine] + 1e-12) / (best + 1e-12)).fillna(np.inf)
        profiles[engine] = np.asarray([(ratio <= tau).mean() for tau in taus])
    return taus, profiles


def mean_ranks(
    runs: pd.DataFrame,
    engines: list[str] | None = None,
) -> tuple[pd.Series, dict[str, float | int]]:
    """Mean per-instance ranks plus a paired test when it is well-defined."""
    from scipy.stats import friedmanchisquare, rankdata, wilcoxon

    medians = per_instance_medians(runs).pivot(
        index="instance_id", columns="engine", values="median_objective"
    )
    engines = engines or [engine for engine in CAMPAIGN_ENGINES if engine in medians]
    medians = medians.reindex(columns=engines)
    ranks = pd.DataFrame(
        [rankdata(np.where(np.isnan(row), np.inf, row), method="average") for row in medians.values],
        columns=engines,
        index=medians.index,
    )
    result: dict[str, float | int] = {"n_instances": len(ranks)}
    complete = medians.dropna()
    if len(engines) == 2 and len(complete) > 0:
        statistic, p_value = wilcoxon(complete[engines[0]], complete[engines[1]])
        result.update({"wilcoxon_statistic": float(statistic), "wilcoxon_p_value": float(p_value)})
    elif len(engines) >= 3 and len(complete) >= 3:
        statistic, p_value = friedmanchisquare(*[complete[engine] for engine in engines])
        result.update({"friedman_statistic": float(statistic), "friedman_p_value": float(p_value)})
    return ranks.mean().rename("mean_rank"), result


def a12(x, y) -> float:
    """Vargha–Delaney A12; above 0.5 favours the first minimizer."""
    x_values = np.asarray(x, dtype=float)
    y_values = np.asarray(y, dtype=float)
    wins = sum(
        (value < y_values).sum() + 0.5 * (value == y_values).sum()
        for value in x_values
    )
    return wins / (len(x_values) * len(y_values))


def pairwise_engine_stats(
    runs: pd.DataFrame,
    engine_a: str = "evolutionary-heuristics",
    engine_b: str = BASELINE_ENGINE,
    alpha: float = 0.05,
) -> pd.DataFrame:
    """Per-instance Mann–Whitney U and A12 for two stochastic modes."""
    from scipy.stats import mannwhitneyu

    rows = []
    for instance_id, group in feasible_runs(runs).groupby("instance_id"):
        values_a = group[group.engine == engine_a].objective_value.values
        values_b = group[group.engine == engine_b].objective_value.values
        if len(values_a) < 3 or len(values_b) < 3:
            continue
        _, p_value = mannwhitneyu(values_a, values_b, alternative="two-sided")
        effect = a12(values_a, values_b)
        winner = "tie" if p_value >= alpha else engine_a if effect > 0.5 else engine_b
        rows.append({
            "instance_id": instance_id,
            "n_a": len(values_a),
            "n_b": len(values_b),
            "p_value": p_value,
            f"A12_{engine_a}_vs_{engine_b}": effect,
            "median_a": np.median(values_a),
            "median_b": np.median(values_b),
            "winner": winner,
        })
    return pd.DataFrame(rows)


def ecdf(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    values = np.sort(np.asarray(values, dtype=float))
    return values, np.arange(1, len(values) + 1) / len(values)


def save_fig(fig, name: str, figures_dir: Path) -> None:
    """Export a paper-ready PDF and a PNG preview."""
    figures_dir.mkdir(parents=True, exist_ok=True)
    fig.savefig(figures_dir / f"{name}.pdf", bbox_inches="tight")
    fig.savefig(figures_dir / f"{name}.png", bbox_inches="tight", dpi=180)


def instance_size(run_or_instance_id: str) -> int:
    return int(str(run_or_instance_id).split("infrastructure_")[1].split("|")[0].split(".")[0])

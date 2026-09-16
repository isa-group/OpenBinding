"""Empirical engine calibration, hypervolume indicator computation, and surrogate model fitting."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Sequence

from .features import WorkloadFeatures


def is_pareto_dominated(p1: Sequence[float], p2: Sequence[float]) -> bool:
    """Return True if p1 is weakly dominated by p2 (assuming minimization)."""
    better_or_equal = all(b <= a for a, b in zip(p1, p2))
    strictly_better = any(b < a for a, b in zip(p1, p2))
    return better_or_equal and strictly_better


def filter_pareto_front(points: Sequence[Sequence[float]]) -> list[list[float]]:
    """Filter a set of points to its non-dominated Pareto subset (minimization)."""
    front: list[list[float]] = []
    for p in points:
        dominated = False
        to_remove = []
        for member in front:
            if is_pareto_dominated(p, member):
                dominated = True
                break
            if is_pareto_dominated(member, p):
                to_remove.append(member)
        if not dominated:
            front = [m for m in front if m not in to_remove]
            front.append(list(p))
    return front


def compute_hypervolume_2d(points: Sequence[Sequence[float]], ref: Sequence[float]) -> float:
    """Compute 2D hypervolume bounded by reference point ref (minimization)."""
    non_dom = filter_pareto_front(points)
    # Filter points strictly dominated by ref
    valid = [p for p in non_dom if p[0] <= ref[0] and p[1] <= ref[1]]
    if not valid:
        return 0.0

    # Sort by first coordinate ascending
    sorted_pts = sorted(valid, key=lambda p: (p[0], p[1]))
    volume = 0.0
    cur_y = ref[1]

    for p in sorted_pts:
        if p[1] < cur_y:
            volume += (ref[0] - p[0]) * (cur_y - p[1])
            cur_y = p[1]

    return max(0.0, volume)


def compute_hypervolume_nd(points: Sequence[Sequence[float]], ref: Sequence[float], sample_count: int = 5000) -> float:
    """Compute hypervolume using dimension reduction or Monte Carlo approximation for M >= 3."""
    if not points:
        return 0.0
    m = len(ref)
    if m == 1:
        best = min(p[0] for p in points if p[0] <= ref[0])
        return max(0.0, ref[0] - best)
    if m == 2:
        return compute_hypervolume_2d(points, ref)

    non_dom = filter_pareto_front(points)
    valid = [p for p in non_dom if all(coord <= r for coord, r in zip(p, ref))]
    if not valid:
        return 0.0

    # Bounding box for Monte Carlo sampling: [min_val, ref]
    mins = [min(p[i] for p in valid) for i in range(m)]
    total_box_vol = 1.0
    for i in range(m):
        total_box_vol *= max(0.0, ref[i] - mins[i])

    if total_box_vol <= 0.0:
        return 0.0

    # Monte Carlo integration with deterministic quasi-random/seeded sampling
    import random
    rng = random.Random(42)
    dominated_count = 0

    for _ in range(sample_count):
        sample = [mins[i] + rng.random() * (ref[i] - mins[i]) for i in range(m)]
        # Sample is in hypervolume if it dominates at least one point in valid (point <= sample)
        if any(all(p[i] <= sample[i] for i in range(m)) for p in valid):
            dominated_count += 1

    return total_box_vol * (dominated_count / float(sample_count))


def compute_hvr(
    candidate_points: Sequence[Sequence[float]],
    reference_front: Sequence[Sequence[float]],
    ref_point: Sequence[float] | None = None,
) -> float:
    """Compute Normalized Hypervolume Ratio HVR in [0, 1]."""
    if not candidate_points:
        return 0.0
    if not reference_front:
        return 1.0

    m = len(reference_front[0])
    if ref_point is None:
        ref_point = [1.1] * m

    hv_ref = compute_hypervolume_nd(reference_front, ref_point)
    if hv_ref <= 0.0:
        return 1.0

    hv_cand = compute_hypervolume_nd(candidate_points, ref_point)
    return max(0.0, min(1.0, hv_cand / hv_ref))


@dataclass
class CalibrationObservation:
    workload_features: dict[str, Any]
    latency: float
    quality: float
    success: bool = True


@dataclass
class CalibratedSurrogate:
    engine: str
    mode: str
    sample_count: int
    latency_coefficients: dict[str, float]
    quality_coefficients: dict[str, float]
    failure_risk_coefficients: dict[str, float]
    r2_score: float

    def predict_latency(self, features: WorkloadFeatures) -> float:
        w = self.latency_coefficients
        log_lat = (
            w.get("intercept", 0.0)
            + w.get("S", 0.0) * features.S
            + w.get("D_constr", 0.0) * features.D_constr
            + w.get("N_tasks", 0.0) * features.N_tasks
            + w.get("N_cap", 0.0) * features.N_cap
            + w.get("D_obj", 0.0) * features.D_obj
        )
        return max(0.005, math.exp(min(10.0, log_lat)))

    def predict_quality(self, features: WorkloadFeatures) -> float:
        w = self.quality_coefficients
        q = (
            w.get("intercept", 0.85)
            + w.get("S", 0.0) * features.S
            + w.get("D_obj", 0.0) * features.D_obj
            + w.get("D_constr", 0.0) * features.D_constr
        )
        return max(0.0, min(1.0, q))

    def predict_failure_risk(self, features: WorkloadFeatures) -> float:
        w = self.failure_risk_coefficients
        z = (
            w.get("intercept", -3.0)
            + w.get("S", 0.0) * features.S
            + w.get("D_constr", 0.0) * features.D_constr
            - w.get("T_budget", 0.0) * features.T_budget
        )
        if z > 15.0:
            return 0.999
        if z < -15.0:
            return 0.001
        return 1.0 / (1.0 + math.exp(-z))


def fit_linear_regression(X: list[list[float]], y: list[float]) -> tuple[list[float], float]:
    """Fit ordinary least squares beta = (X^T X)^-1 X^T y and calculate R²."""
    n = len(X)
    k = len(X[0])
    if n < k:
        # Fallback to mean
        mean_y = sum(y) / max(1, n)
        return [mean_y] + [0.0] * (k - 1), 0.0

    # X^T X
    XtX = [[sum(X[r][i] * X[r][j] for r in range(n)) for j in range(k)] for i in range(k)]
    # Regularization for stability
    for i in range(k):
        XtX[i][i] += 1e-5

    # X^T y
    Xty = [sum(X[r][i] * y[r] for r in range(n)) for i in range(k)]

    # Solve via Gaussian elimination
    aug = [row[:] + [Xty[i]] for i, row in enumerate(XtX)]
    for i in range(k):
        max_row = max(range(i, k), key=lambda r: abs(aug[r][i]))
        aug[i], aug[max_row] = aug[max_row], aug[i]
        pivot = aug[i][i]
        if abs(pivot) < 1e-9:
            continue
        for col in range(i, k + 1):
            aug[i][col] /= pivot
        for r in range(k):
            if r != i:
                factor = aug[r][i]
                for col in range(i, k + 1):
                    aug[r][col] -= factor * aug[i][col]

    beta = [aug[i][-1] for i in range(k)]

    # Compute R²
    y_mean = sum(y) / float(n)
    ss_tot = sum((val - y_mean) ** 2 for val in y)
    ss_res = sum((y[r] - sum(X[r][j] * beta[j] for j in range(k))) ** 2 for r in range(n))
    r2 = 1.0 - (ss_res / ss_tot) if ss_tot > 1e-9 else 1.0

    return beta, max(0.0, min(1.0, r2))


def fit_surrogate_model(
    engine: str,
    mode: str,
    observations: list[CalibrationObservation],
) -> CalibratedSurrogate:
    """Fit empirical regression models for latency, quality and failure risk."""
    if not observations:
        return CalibratedSurrogate(
            engine=engine,
            mode=mode,
            sample_count=0,
            latency_coefficients={"intercept": 0.0},
            quality_coefficients={"intercept": 0.80},
            failure_risk_coefficients={"intercept": -3.5},
            r2_score=0.0,
        )

    X_lat = []
    y_lat = []
    X_qual = []
    y_qual = []
    failures = 0

    for obs in observations:
        wf = obs.workload_features
        s = float(wf.get("S", 0.0))
        d_constr = float(wf.get("D_constr", 0.0))
        n_tasks = float(wf.get("N_tasks", 1.0))
        n_cap = float(wf.get("N_cap", 1.0))
        d_obj = float(wf.get("D_obj", 1.0))

        # Latency features: [1, S, D_constr, N_tasks, N_cap, D_obj]
        X_lat.append([1.0, s, d_constr, n_tasks, n_cap, d_obj])
        lat = max(0.001, obs.latency)
        y_lat.append(math.log(lat))

        # Quality features: [1, S, D_obj, D_constr]
        X_qual.append([1.0, s, d_obj, d_constr])
        y_qual.append(max(0.0, min(1.0, obs.quality)))

        if not obs.success:
            failures += 1

    beta_lat, r2_lat = fit_linear_regression(X_lat, y_lat)
    beta_qual, r2_qual = fit_linear_regression(X_qual, y_qual)

    lat_coefs = {
        "intercept": round(beta_lat[0], 4),
        "S": round(beta_lat[1], 4),
        "D_constr": round(beta_lat[2], 4),
        "N_tasks": round(beta_lat[3], 4),
        "N_cap": round(beta_lat[4], 4),
        "D_obj": round(beta_lat[5], 4),
    }

    qual_coefs = {
        "intercept": round(beta_qual[0], 4),
        "S": round(beta_qual[1], 4),
        "D_obj": round(beta_qual[2], 4),
        "D_constr": round(beta_qual[3], 4),
    }

    fail_rate = failures / float(len(observations))
    # Logit of fail_rate
    safe_rate = max(0.001, min(0.999, fail_rate))
    fail_intercept = math.log(safe_rate / (1.0 - safe_rate))
    fail_coefs = {
        "intercept": round(fail_intercept, 4),
        "S": 0.05,
        "D_constr": 0.1,
        "T_budget": 0.02,
    }

    return CalibratedSurrogate(
        engine=engine,
        mode=mode,
        sample_count=len(observations),
        latency_coefficients=lat_coefs,
        quality_coefficients=qual_coefs,
        failure_risk_coefficients=fail_coefs,
        r2_score=round(r2_lat, 4),
    )

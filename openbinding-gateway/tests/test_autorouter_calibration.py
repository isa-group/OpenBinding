"""Tests for autorouter surrogate calibration and hypervolume calculation."""

from __future__ import annotations

import math
import pytest
from sqlalchemy import select

from openbinding_gateway.engine_routing.calibration import (
    CalibrationObservation,
    CalibratedSurrogate,
    compute_hvr,
    compute_hypervolume_2d,
    compute_hypervolume_nd,
    filter_pareto_front,
    fit_linear_regression,
    fit_surrogate_model,
    is_pareto_dominated,
)
from openbinding_gateway.engine_routing.features import WorkloadFeatures
from openbinding_gateway.engine_routing.profiler import EngineProfiler
from openbinding_gateway.db.models import EngineProfileSurrogate


def test_pareto_dominance_and_filter():
    p1 = [1.0, 2.0]
    p2 = [0.5, 1.5]  # p2 strictly dominates p1 (minimization)
    assert is_pareto_dominated(p1, p2) is True
    assert is_pareto_dominated(p2, p1) is False

    points = [
        [1.0, 5.0],
        [2.0, 3.0],
        [3.0, 2.0],
        [5.0, 1.0],
        [2.5, 4.0],  # dominated by [2.0, 3.0]
        [4.0, 4.0],  # dominated
    ]
    front = filter_pareto_front(points)
    assert len(front) == 4
    assert [1.0, 5.0] in front
    assert [2.0, 3.0] in front
    assert [3.0, 2.0] in front
    assert [5.0, 1.0] in front


def test_hypervolume_2d_and_nd():
    # Unit box from [0, 0] to [1, 1] with point at [0, 0]
    points = [[0.0, 0.0]]
    ref = [1.0, 1.0]
    hv_2d = compute_hypervolume_2d(points, ref)
    assert pytest.approx(hv_2d, rel=1e-3) == 1.0

    # Half box with point at [0.5, 0.0] and [0.0, 0.5]
    pts2 = [[0.5, 0.0], [0.0, 0.5]]
    # Area is 1.0 - (0.5 * 0.5) = 0.75
    hv_2d_half = compute_hypervolume_2d(pts2, ref)
    assert pytest.approx(hv_2d_half, rel=1e-3) == 0.75

    # 3D hypervolume unit cube
    pts_3d = [[0.0, 0.0, 0.0]]
    ref_3d = [1.0, 1.0, 1.0]
    hv_3d = compute_hypervolume_nd(pts_3d, ref_3d, sample_count=10000)
    assert pytest.approx(hv_3d, abs=0.05) == 1.0

    # HVR check
    hvr = compute_hvr(pts_3d, pts_3d, ref_3d)
    assert pytest.approx(hvr, rel=1e-3) == 1.0


def test_linear_regression_fit():
    # y = 2.0 + 3.0 * x
    X = [[1.0, float(i)] for i in range(10)]
    y = [2.0 + 3.0 * float(i) for i in range(10)]

    beta, r2 = fit_linear_regression(X, y)
    assert len(beta) == 2
    assert pytest.approx(beta[0], abs=1e-2) == 2.0
    assert pytest.approx(beta[1], abs=1e-2) == 3.0
    assert pytest.approx(r2, abs=1e-2) == 1.0


def test_fit_surrogate_model():
    obs_list = []
    for i in range(10):
        # Latency grows with search space S
        s = float(i) * 2.0
        features = {
            "S": s,
            "D_constr": 1.0,
            "N_tasks": 10.0,
            "N_cap": 5.0,
            "D_obj": 1.0,
            "T_budget": 60.0,
        }
        lat = math.exp(0.5 + 0.1 * s)
        qual = max(0.5, 0.95 - 0.02 * s)
        obs_list.append(CalibrationObservation(workload_features=features, latency=lat, quality=qual, success=True))

    surrogate = fit_surrogate_model("evolutionary-heuristics", "single-term", obs_list)
    assert surrogate.engine == "evolutionary-heuristics"
    assert surrogate.sample_count == 10
    assert "S" in surrogate.latency_coefficients

    wf = WorkloadFeatures(
        S=15.0,
        D_constr=1.0,
        N_tasks=10,
        N_cap=5,
        opt_mode="weighted",
        D_obj=1,
        T_budget=60.0,
    )

    pred_lat = surrogate.predict_latency(wf)
    pred_qual = surrogate.predict_quality(wf)
    pred_risk = surrogate.predict_failure_risk(wf)

    assert pred_lat > 0.0
    assert 0.0 <= pred_qual <= 1.0
    assert 0.0 <= pred_risk <= 1.0


def test_engine_profiler_with_surrogate():
    profiler = EngineProfiler()
    wf = WorkloadFeatures(
        S=10.0,
        D_constr=1.0,
        N_tasks=10,
        N_cap=5,
        opt_mode="weighted",
        D_obj=1,
        T_budget=60.0,
    )

    # Base profile before surrogate
    base_prof = profiler.profile("evolutionary-heuristics", "single-term", wf)

    # Calibrate a surrogate with custom high latency intercept
    custom_surrogate = CalibratedSurrogate(
        engine="evolutionary-heuristics",
        mode="single-term",
        sample_count=20,
        latency_coefficients={"intercept": 3.0, "S": 0.05},
        quality_coefficients={"intercept": 0.99, "S": 0.0},
        failure_risk_coefficients={"intercept": -5.0},
        r2_score=0.95,
    )
    profiler.register_surrogate(custom_surrogate)

    calib_prof = profiler.profile("evolutionary-heuristics", "single-term", wf)
    assert calib_prof.latency != base_prof.latency
    assert pytest.approx(calib_prof.quality, abs=1e-2) == 0.99


@pytest.mark.asyncio
async def test_engine_profile_surrogate_db_model(db_session):
    surrogate_row = EngineProfileSurrogate(
        engine="many-heuristic",
        mode="pareto-nsga2",
        sample_count=50,
        latency_coefficients={"intercept": 0.2, "S": 0.08},
        quality_coefficients={"intercept": 0.88, "D_obj": -0.05},
        failure_risk_coefficients={"intercept": -4.0},
        r2_score=0.92,
        metadata_info={"notes": "Calibrated from 50 synthetic runs"},
    )
    db_session.add(surrogate_row)
    await db_session.commit()

    # Query back
    result = await db_session.execute(
        select(EngineProfileSurrogate).where(EngineProfileSurrogate.engine == "many-heuristic")
    )
    loaded = result.scalar_one_or_none()
    assert loaded is not None
    assert loaded.sample_count == 50
    assert loaded.latency_coefficients["S"] == 0.08
    assert loaded.r2_score == 0.92

"""Verification of the autonomic MAPE-K loop and observation persistence."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from openbinding_gateway.db.models import AdaptationObservation, User, UserRole
from openbinding_gateway.engine_routing import (
    extract_features,
    get_adaptation_manager,
    get_confidence_estimator,
)


@pytest.fixture
def mock_problem():
    return {
        "spec": {
            "application": {
                "tasks": {
                    "t1": {"kind": "task"},
                    "t2": {"kind": "task"},
                    "t3": {"kind": "task"},
                }
            },
            "eligibility": {
                "t1": [{"resource": "r", "id": "1"}, {"resource": "r", "id": "2"}],
                "t2": [{"resource": "r", "id": "1"}, {"resource": "r", "id": "2"}],
                "t3": [{"resource": "r", "id": "1"}, {"resource": "r", "id": "2"}],
            },
            "constraints": [
                {"assert": {"op": "eq", "left": 1, "right": 1}}
            ],
            "optimization": {
                "terms": [
                    {"metric": {"id": "latency"}, "direction": "minimize", "weight": 1.0}
                ]
            },
        }
    }


@pytest.mark.asyncio
async def test_adaptation_manager_planning(mock_problem):
    manager = get_adaptation_manager()
    plan = await manager.plan_routing(
        problem=mock_problem,
        options={
            "routing": {
                "hardConstraints": {
                    "maxTimeBudgetMs": 10000,
                    "maxCredits": 50,
                },
                "softPreferences": {
                    "weights": {
                        "quality": 0.50,
                        "latency": 0.30,
                        "costCredits": 0.20,
                    }
                }
            }
        }
    )

    assert plan.selected_engine in ("evolutionary-heuristics", "minizinc-csp", "random-search", "many-heuristic")
    assert plan.credits_cost >= 0
    assert plan.adaptation_loop_id.startswith("adp-")

    # User provenance check
    user_prov = plan.provenance_user
    assert "selectedEngine" in user_prov
    assert "selectedMode" in user_prov
    assert "utilityScore" in user_prov
    assert "creditsCost" in user_prov
    assert "adaptationReason" in user_prov

    # Admin provenance check
    admin_prov = plan.provenance_admin
    assert admin_prov["adaptationLoopId"] == plan.adaptation_loop_id
    assert "workloadFeatures" in admin_prov
    assert "engineHealthSnapshot" in admin_prov
    assert len(admin_prov["candidateEvaluations"]) > 0


@pytest.mark.asyncio
async def test_observation_persistence_and_residuals(db_session, mock_problem):
    manager = get_adaptation_manager()
    plan = await manager.plan_routing(mock_problem)

    features = extract_features(mock_problem)
    pred = {"latency": 2.5, "quality": 0.95, "credits": 8}

    obs = await manager.observe_execution(
        adaptation_loop_id=plan.adaptation_loop_id,
        engine=plan.selected_engine,
        features_dict=features.to_dict(),
        predicted_metrics=pred,
        actual_latency=2.1,
        actual_quality=0.96,
        actual_credits=8,
        outcome="OPTIMAL",
        candidate_evaluations=plan.provenance_admin["candidateEvaluations"],
        engine_health_snapshot=plan.provenance_admin["engineHealthSnapshot"],
        job_id=None,
        session=db_session,
    )
    await db_session.commit()

    assert obs is not None
    # Verify in DB
    result = await db_session.execute(
        select(AdaptationObservation).where(AdaptationObservation.adaptation_loop_id == plan.adaptation_loop_id)
    )
    saved = result.scalar_one_or_none()
    assert saved is not None
    assert saved.engine_selected == plan.selected_engine
    assert saved.outcome == "OPTIMAL"

    # Residuals
    residuals = saved.residuals
    assert round(residuals["residualLatency"], 3) == 0.4
    assert round(residuals["residualQuality"], 3) == 0.01
    assert residuals["residualCredits"] == 0
    assert residuals["conceptDriftDetected"] is False


@pytest.mark.asyncio
async def test_empirical_confidence_updating(mock_problem):
    estimator = get_confidence_estimator()
    features = extract_features(mock_problem)
    eng = "evolutionary-heuristics"

    initial_conf = estimator.estimate_confidence(eng, features)
    for _ in range(10):
        estimator.record_observation(eng, features)
    updated_conf = estimator.estimate_confidence(eng, features)

    assert updated_conf >= initial_conf


@pytest.mark.asyncio
async def test_meta_router_hidden_from_public_catalog(api_client, registration):
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    assert created.status_code == 201
    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    # Authenticated catalogue must never list the internal meta-router-csp engine
    response = await api_client.get("/v1/engines", headers=headers)
    assert response.status_code == 200
    engines = response.json().get("engines", [])
    assert not any(e.get("name") == "meta-router-csp" for e in engines)

    # Public exploration endpoint must also exclude internal engines
    explore = await api_client.get("/v1/explore/engines")
    assert explore.status_code == 200
    explore_engines = explore.json().get("engines", [])
    assert not any(e.get("name") == "meta-router-csp" for e in explore_engines)

    # Direct manifest lookup must 404
    direct = await api_client.get(
        "/v1/engines/meta-router-csp?namespace=bim.builtin&version=1.0.0&digest=none",
        headers=headers,
    )
    assert direct.status_code == 404


@pytest.mark.asyncio
async def test_admin_engine_routing_endpoints(api_client, db_session, registration):
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    assert created.status_code == 201

    # Escalate to admin
    user = (
        await db_session.execute(select(User).where(User.username == details["username"]))
    ).scalars().one()
    user.role = UserRole.ADMIN
    await db_session.flush()

    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login.status_code == 200
    admin_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    # 1. GET metrics
    metrics_res = await api_client.get("/v1/admin/engine-routing/metrics", headers=admin_headers)
    assert metrics_res.status_code == 200
    metrics_body = metrics_res.json()
    assert "summary" in metrics_body
    assert "engines" in metrics_body
    assert metrics_body["summary"]["totalEngines"] >= 4

    # 2. GET observations
    obs_res = await api_client.get("/v1/admin/engine-routing/observations", headers=admin_headers)
    assert obs_res.status_code == 200
    obs_body = obs_res.json()
    assert "total" in obs_body
    assert "observations" in obs_body

    # 3. POST recalibrate
    recal_res = await api_client.post("/v1/admin/engine-routing/recalibrate", headers=admin_headers)
    assert recal_res.status_code == 200
    recal_body = recal_res.json()
    assert recal_body["status"] == "recalibrated"
    assert "calibratedEngines" in recal_body


@pytest.mark.asyncio
async def test_create_job_with_engine_auto(api_client, registration, monkeypatch):
    from openbinding_gateway.routes import v1 as routes
    from openbinding_gateway.v1.package import load_package
    from _repo import REPO_ROOT

    async def mock_solve(*args, **kwargs):
        return {
            "termination": "OPTIMAL",
            "solutions": [
                {
                    "decision": {
                        "kind": "binding",
                        "binding": {"t1": {"resource": "catalog", "id": "c1a"}},
                    },
                    "objectives": {"score": 0.95},
                }
            ],
            "provenance": {"engineReported": "mock"},
        }

    monkeypatch.setattr(routes, "solve_remote", mock_solve)

    details = registration()
    await api_client.post("/v1/auth/register", json=details)
    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    user_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    example_dir = REPO_ROOT / "examples/demo/01_simple_seq"
    package = load_package(example_dir)
    created = await api_client.post(
        "/v1/instances",
        headers={**user_headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )
    assert created.status_code == 201
    snapshot_id = created.json()["id"]

    # Submit job with engine: auto
    job_req = await api_client.post(
        "/v1/jobs",
        headers=user_headers,
        json={
            "snapshot": snapshot_id,
            "engine": "auto",
            "options": {
                "routing": {
                    "hardConstraints": {"maxCredits": 20},
                    "softPreferences": {"weights": {"quality": 0.5, "latency": 0.5}},
                }
            },
        },
    )
    assert job_req.status_code == 202, job_req.json()
    job_id = job_req.json()["id"]

    # Check job details
    job_res = await api_client.get(f"/v1/jobs/{job_id}", headers=user_headers)
    assert job_res.status_code == 200
    prov = job_res.json().get("provenance", {})
    assert "engineRouting" in prov
    assert "selectedEngine" in prov["engineRouting"]
    # Regular user must NOT see engineRoutingAdmin
    assert "engineRoutingAdmin" not in prov


@pytest.mark.asyncio
async def test_adversarial_feature_extraction_and_capacity():
    from openbinding_gateway.engine_routing.capacity_model import get_capacity_model
    from openbinding_gateway.engine_routing.features import WorkloadFeatures

    # Test adversarial / invalid options
    empty_problem = {"spec": {}}
    features = extract_features(empty_problem, options={"time_budget_ms": float("nan")})
    assert features.S >= 0.0
    assert features.D_constr >= 0.0
    assert features.T_budget > 0.0

    features_inf = extract_features(empty_problem, options={"time_budget_ms": float("inf")})
    assert features_inf.T_budget <= 3600.0

    # Ensure CapacityModel does not crash on NaN or Inf
    cap_model = get_capacity_model()
    nan_features = WorkloadFeatures(
        S=float("nan"),
        D_constr=float("nan"),
        N_tasks=1,
        N_cap=1,
        opt_mode="weighted",
        D_obj=1,
        T_budget=float("nan"),
    )
    cu = cap_model.calculate_capacity_units("minizinc-csp", nan_features)
    assert isinstance(cu, int)
    assert cu >= 1


@pytest.mark.asyncio
async def test_failed_auto_job_records_observation_and_failure(api_client, registration, db_session, monkeypatch):
    from openbinding_gateway.routes import v1 as routes
    from openbinding_gateway.routes.v1 import RemoteEngineError
    from openbinding_gateway.v1.package import load_package
    from openbinding_gateway.engine_routing import get_health_monitor
    from _repo import REPO_ROOT

    async def failing_solve(*args, **kwargs):
        raise RemoteEngineError("Engine crashed unexpectedly")

    monkeypatch.setattr(routes, "solve_remote", failing_solve)

    details = registration()
    await api_client.post("/v1/auth/register", json=details)
    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    user_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    example_dir = REPO_ROOT / "examples/demo/01_simple_seq"
    package = load_package(example_dir)
    created = await api_client.post(
        "/v1/instances",
        headers={**user_headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )
    assert created.status_code == 201
    snapshot_id = created.json()["id"]

    # Submit job with engine: auto
    job_req = await api_client.post(
        "/v1/jobs",
        headers=user_headers,
        json={
            "snapshot": snapshot_id,
            "engine": "auto",
        },
    )
    assert job_req.status_code == 202
    job_id = job_req.json()["id"]

    # Check job failed
    job_res = await api_client.get(f"/v1/jobs/{job_id}", headers=user_headers)
    assert job_res.status_code == 200
    assert job_res.json()["status"] == "failed"

    # Verify that an observation was persisted with outcome="failed" and quality=0.0
    result = await db_session.execute(
        select(AdaptationObservation).order_by(AdaptationObservation.created_at.desc())
    )
    obs = result.scalars().first()
    assert obs is not None
    assert obs.outcome == "failed"
    assert obs.actual_metrics["actualQuality"] == 0.0

    # Verify that HealthMonitor recorded the failure
    health = get_health_monitor().get_health(obs.engine_selected)
    assert health.recent_failure_rate > 0.0


@pytest.mark.asyncio
async def test_fallback_engine_activation_on_primary_failure(api_client, registration, monkeypatch):
    from openbinding_gateway.routes import v1 as routes
    from openbinding_gateway.routes.v1 import RemoteEngineError
    from openbinding_gateway.v1.package import load_package
    from _repo import REPO_ROOT

    attempt_count = 0

    async def fallback_aware_solve(transport, *args, **kwargs):
        nonlocal attempt_count
        attempt_count += 1
        # Fail the first attempt (primary engine)
        if attempt_count == 1:
            raise RemoteEngineError("Primary engine node unreachable")
        # Succeed on fallback engine
        return {
            "termination": "OPTIMAL",
            "solutions": [
                {
                    "decision": {
                        "kind": "binding",
                        "binding": {"t1": {"resource": "catalog", "id": "c1a"}},
                    },
                    "objectives": {"score": 0.90},
                }
            ],
            "provenance": {"engineReported": "fallback-mock"},
        }

    monkeypatch.setattr(routes, "solve_remote", fallback_aware_solve)

    details = registration()
    await api_client.post("/v1/auth/register", json=details)
    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    user_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    example_dir = REPO_ROOT / "examples/demo/01_simple_seq"
    package = load_package(example_dir)
    created = await api_client.post(
        "/v1/instances",
        headers={**user_headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )
    assert created.status_code == 201
    snapshot_id = created.json()["id"]

    # Submit job with engine: auto
    job_req = await api_client.post(
        "/v1/jobs",
        headers=user_headers,
        json={
            "snapshot": snapshot_id,
            "engine": "auto",
        },
    )
    assert job_req.status_code == 202
    job_id = job_req.json()["id"]

    # Job should complete via fallback!
    job_res = await api_client.get(f"/v1/jobs/{job_id}", headers=user_headers)
    assert job_res.status_code == 200
    assert job_res.json()["status"] == "completed"
    prov = job_res.json().get("provenance", {})
    assert prov.get("fallbackActivated") is True





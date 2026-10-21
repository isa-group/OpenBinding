"""POST /v1/jobs under ``SPACE_ENABLED=false`` (the open gate) and under a plan that exceeds a technical ceiling.

The open gate used to grant unbounded timeout and payload allowances, which
``access.policy`` refuses on purpose (a real plan above the technical ceiling
fails closed), so every job launch answered an unhandled 500. The open gate now
grants the ceilings themselves; a real plan above them still fails closed, now
as a 503 ``pricing_misconfigured`` problem.
"""

from __future__ import annotations

import pytest

from _repo import REPO_ROOT

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.space_client import OpenCaps, OpenGate, PlanCaps
from bim_core.package import load_package

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}


class UnboundedPlanGate(OpenGate):
    """A real-looking plan whose payload allowance is unlimited, above any technical ceiling."""

    async def caps(self, user_id):
        limits = dict(OpenCaps().limits)
        limits["maxPayloadBytes"] = float("inf")
        return PlanCaps(plan="REAL", features={"solve": True}, limits=limits)


@pytest.fixture
def no_dispatch(monkeypatch):
    async def queued(*args, **kwargs):
        return None

    monkeypatch.setattr(routes, "dispatch_persisted_job", queued)


async def _account_and_snapshot(client, registration):
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert logged.status_code == 200, logged.text
    headers = {"Authorization": f"Bearer {logged.json()['access_token']}"}
    snapshot = await client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=load_package(EXAMPLE).to_zip(),
    )
    assert snapshot.status_code == 201, snapshot.text
    return headers, snapshot.json()["id"]


def _job(snapshot, **extra):
    return {
        "snapshot": snapshot,
        "engine": "random-search",
        "mode": "seeded",
        "optimization": OPTIMIZATION,
        **extra,
    }


async def test_a_job_launches_through_the_open_gate(api_client, registration, no_dispatch):
    space_client.set_gate(OpenGate())
    headers, snapshot = await _account_and_snapshot(api_client, registration)

    launched = await api_client.post("/v1/jobs", headers=headers, json=_job(snapshot))

    assert launched.status_code == 202, launched.text


async def test_the_open_gate_still_clamps_a_time_budget_beyond_the_technical_timeout(
    api_client, registration, no_dispatch
):
    space_client.set_gate(OpenGate())
    headers, snapshot = await _account_and_snapshot(api_client, registration)
    beyond = int(get_settings().engine_solve_timeout_s * 1000) + 1

    launched = await api_client.post(
        "/v1/jobs", headers=headers, json=_job(snapshot, options={"time_budget_ms": beyond})
    )

    assert launched.status_code == 202, launched.text


async def test_a_real_plan_above_the_technical_ceiling_fails_closed_with_a_controlled_problem(
    api_client, registration, no_dispatch
):
    space_client.set_gate(UnboundedPlanGate())
    headers, snapshot = await _account_and_snapshot(api_client, registration)

    launched = await api_client.post("/v1/jobs", headers=headers, json=_job(snapshot))

    assert launched.status_code == 503, launched.text
    assert "pricing_misconfigured" in launched.text

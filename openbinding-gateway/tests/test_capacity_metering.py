"""Verification of capacity-aware metering (capacityUnits) and zero-quota meta-routing."""

from __future__ import annotations

import uuid
import pytest

from openbinding_gateway.access import metering
from openbinding_gateway.db.models import User, UserRole
from openbinding_gateway.engine_routing.capacity_model import get_capacity_model
from openbinding_gateway.engine_routing.features import WorkloadFeatures
from openbinding_gateway.space_client import FakePricingGate
from _pricing import fake_pricing_gate, pricing_catalog

CATALOG = pricing_catalog()


@pytest.fixture
def gate() -> FakePricingGate:
    return fake_pricing_gate()


@pytest.fixture
async def owner(db_session) -> User:
    user = User(
        username=f"cap_user_{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache="BASIC",
    )
    db_session.add(user)
    await db_session.flush()
    return user


def test_capacity_model_calibration_points():
    model = get_capacity_model()

    # 1. Trivial instance (S <= 3) with random-search consumes 1 CU
    f_trivial = WorkloadFeatures(S=2.5, D_constr=0.5, N_tasks=3, N_cap=6, opt_mode="weighted", D_obj=1, T_budget=30.0)
    assert model.calculate_capacity_units("random-search", f_trivial) == 1

    # 2. Medium instance (S = 8) with evolutionary-heuristics consumes 8 CUs
    f_medium = WorkloadFeatures(S=8.0, D_constr=1.0, N_tasks=10, N_cap=50, opt_mode="weighted", D_obj=1, T_budget=30.0)
    assert model.calculate_capacity_units("evolutionary-heuristics", f_medium) == 8

    # 3. Complex instance (S = 12) with minizinc-csp consumes 35 CUs
    f_complex = WorkloadFeatures(S=12.0, D_constr=1.0, N_tasks=25, N_cap=200, opt_mode="weighted", D_obj=1, T_budget=60.0)
    assert model.calculate_capacity_units("minizinc-csp", f_complex) == 35

    # 4. Meta-router has zero capacity cost (0 CU)
    assert model.calculate_capacity_units("meta-router-csp", f_medium) == 0


@pytest.mark.asyncio
async def test_meta_router_is_zero_quota(gate, owner):
    verdict, reservation = await metering.reserve(
        gate,
        owner.id,
        engine_name="meta-router-csp",
    )

    assert verdict.allowed is True
    assert reservation is not None
    assert reservation.increments == {}  # Zero quota taken


@pytest.mark.asyncio
async def test_capacity_units_reservation(gate, owner):
    # Reserve 25 capacityUnits
    verdict, reservation = await metering.reserve(
        gate,
        owner.id,
        capacity_units=25,
    )

    assert verdict.allowed is True
    assert reservation is not None
    assert reservation.increments.get("capacityUnits") == 25
    assert reservation.increments.get("concurrentJobs") == 1

    # Check consumed in gate
    consumed = gate._consumed(owner.id)
    assert consumed.get("capacityUnits") == 25


@pytest.mark.asyncio
async def test_backward_compatibility_without_capacity_units(gate, owner, monkeypatch):
    # Simulate an older plan or contract where capacityUnits is not in limits
    caps = await gate.caps(owner.id)
    legacy_limits = {k: v for k, v in caps.limits.items() if k != "capacityUnits"}

    from openbinding_gateway.space_client.gate import PlanCaps
    legacy_caps = PlanCaps(plan="LEGACY", features=caps.features, limits=legacy_limits)

    async def mock_caps(user_id):
        return legacy_caps

    monkeypatch.setattr(gate, "caps", mock_caps)

    # Calling reserve with capacity_units falls back to taskStarts: 1
    verdict, reservation = await metering.reserve(
        gate,
        owner.id,
        capacity_units=15,
    )

    assert verdict.allowed is True
    assert reservation is not None
    assert "capacityUnits" not in reservation.increments
    assert reservation.increments.get("taskStarts") == 1

"""Charging for a solve exactly once, including the ones nobody watches.

The failure this guards against is not over-charging. It is a concurrency slot
that is never given back: an account allowed one solve at a time, whose client
stopped polling, can never solve again. So most of what is asserted here is
about settling jobs that finished without an audience, and about doing it once
however many things try at the same time.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
import pytest_asyncio

from openbinding_gateway.access import metering
from openbinding_gateway.db.models import Job, JobState, User, UserRole, utcnow
from openbinding_gateway.space_client import FakePricingGate, PricingUnavailable
from _pricing import fake_pricing_gate, pricing_catalog

CATALOG = pricing_catalog()
TASKS = "taskStarts"
FEDERATED_TASKS = "federatedTaskStarts"
CONCURRENT = "concurrentJobs"
SOLVER_TIME = "solverSeconds"


@pytest.fixture
def gate() -> FakePricingGate:
    return fake_pricing_gate()


@pytest_asyncio.fixture
async def owner(db_session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=CATALOG.default_plan,
    )
    db_session.add(user)
    await db_session.flush()
    return user


async def a_job(session, owner, *, budget_s=60.0, age_s=0.0, state=JobState.QUEUED) -> Job:
    job = Job(
        owner_id=owner.id if owner else None,
        engine_id="random-search",
        engine_job_id="engine-1",
        service_url="http://engine",
        state=state,
        requested_budget_s=budget_s,
        created_at=utcnow() - timedelta(seconds=age_s),
    )
    session.add(job)
    await session.flush()
    return job


# -- Reserving --------------------------------------------------------------


async def test_a_fresh_account_may_reserve(gate, owner):
    verdict, reservation = await metering.reserve(gate, owner.id)

    assert verdict.allowed is True
    assert reservation is not None


async def test_reserving_takes_a_task_and_a_slot(gate, owner):
    await metering.reserve(gate, owner.id)

    usage = await gate.usage(owner.id)
    assert usage.limits[TASKS].used == 1
    assert usage.limits[CONCURRENT].used == 1


async def test_reserving_does_not_charge_solver_time(gate, owner):
    # Nobody knows how long a solve will take until it has taken it.
    await metering.reserve(gate, owner.id)

    assert (await gate.usage(owner.id)).limits[SOLVER_TIME].used == 0


async def test_an_exhausted_account_reserves_nothing(gate, owner):
    gate.exhaust(owner.id, "taskStarts")

    verdict, reservation = await metering.reserve(gate, owner.id)

    assert verdict.allowed is False
    assert reservation is None


async def test_a_refused_reservation_spends_nothing(gate, owner):
    gate.exhaust(owner.id, "taskStarts")

    await metering.reserve(gate, owner.id)

    assert (await gate.usage(owner.id)).limits[CONCURRENT].used == 0


async def test_a_federated_solve_draws_on_its_own_allowance(gate, owner):
    # The computation happens on somebody else's machine; what OpenBinding
    # spends is a connection, not a CPU.
    await metering.reserve(gate, owner.id, federated=True)

    usage = await gate.usage(owner.id)
    assert usage.limits[FEDERATED_TASKS].used == 1
    assert usage.limits[TASKS].used == 0
    assert usage.limits[CONCURRENT].used == 1


async def test_releasing_gives_everything_back(gate, owner):
    _, reservation = await metering.reserve(gate, owner.id)

    await metering.release(gate, reservation)

    usage = await gate.usage(owner.id)
    assert usage.limits[TASKS].used == 0
    assert usage.limits[CONCURRENT].used == 0


async def test_releasing_nothing_is_harmless(gate):
    await metering.release(gate, None)


async def test_releasing_survives_the_pricing_service_being_down(gate, owner):
    # Losing a task from an allowance is worse than crashing the request that
    # was already failing for another reason.
    _, reservation = await metering.reserve(gate, owner.id)
    gate.unavailable = True

    await metering.release(gate, reservation)


# -- Settling ---------------------------------------------------------------


async def test_settling_charges_the_time_and_frees_the_slot(gate, db_session, owner):
    _, _ = await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner)

    settled = await metering.settle(gate, db_session, job.id, solver_seconds=12.5)

    usage = await gate.usage(owner.id)
    assert settled is True
    assert usage.limits[SOLVER_TIME].used == 12.5
    assert usage.limits[CONCURRENT].used == 0


async def test_a_job_is_settled_only_once(gate, db_session, owner):
    # Two polls arriving together must not charge the same solve twice, nor
    # release a slot somebody else has since taken.
    await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner)

    first = await metering.settle(gate, db_session, job.id, solver_seconds=10.0)
    second = await metering.settle(gate, db_session, job.id, solver_seconds=10.0)

    assert (first, second) == (True, False)
    assert (await gate.usage(owner.id)).limits[SOLVER_TIME].used == 10.0


async def test_settling_marks_the_job(gate, db_session, owner):
    job = await a_job(db_session, owner)

    await metering.settle(gate, db_session, job.id, solver_seconds=1.0)

    refreshed = await db_session.get(Job, job.id)
    assert refreshed.metered is True
    assert refreshed.concurrency_released is True
    assert refreshed.finished_at is not None


async def test_a_solve_that_took_no_measurable_time_still_frees_its_slot(gate, db_session, owner):
    await metering.reserve(gate, owner.id)
    job = await a_job(db_session, owner)

    await metering.settle(gate, db_session, job.id, solver_seconds=0.0)

    assert (await gate.usage(owner.id)).limits[CONCURRENT].used == 0


async def test_an_unowned_job_is_settled_without_charging_anybody(gate, db_session):
    # A gateway running without accounts still produces jobs.
    job = await a_job(db_session, None)

    assert await metering.settle(gate, db_session, job.id, solver_seconds=5.0) is True


async def test_settling_an_unknown_job_changes_nothing(gate, db_session):
    assert await metering.settle(gate, db_session, uuid.uuid4(), solver_seconds=5.0) is False


# -- Sweeping abandoned jobs ------------------------------------------------


async def test_a_job_still_within_its_budget_is_left_alone(gate, db_session, owner):
    await a_job(db_session, owner, budget_s=300.0, age_s=10.0)

    assert await metering.sweep_abandoned(gate, db_session) == 0


async def test_a_job_past_its_budget_and_grace_is_settled(gate, db_session, owner):
    await metering.reserve(gate, owner.id)
    await a_job(db_session, owner, budget_s=60.0, age_s=60 + metering.SETTLEMENT_GRACE_S + 1)

    settled = await metering.sweep_abandoned(gate, db_session)

    assert settled == 1
    assert (await gate.usage(owner.id)).limits[CONCURRENT].used == 0


async def test_an_abandoned_job_is_charged_for_the_budget_it_held(gate, db_session, owner):
    # An abandoned solve that costs nothing is an invitation to abandon every
    # solve: the engine was holding the work either way.
    await a_job(db_session, owner, budget_s=60.0, age_s=60 + metering.SETTLEMENT_GRACE_S + 1)

    await metering.sweep_abandoned(gate, db_session)

    assert (await gate.usage(owner.id)).limits[SOLVER_TIME].used == 60.0


async def test_an_abandoned_job_is_marked_failed(gate, db_session, owner):
    job = await a_job(db_session, owner, budget_s=1.0, age_s=metering.SETTLEMENT_GRACE_S + 10)

    await metering.sweep_abandoned(gate, db_session)

    assert (await db_session.get(Job, job.id)).state is JobState.FAILED


async def test_a_job_within_the_grace_period_is_left_alone(gate, db_session, owner):
    # The engine may answer slightly late and the client poll later still.
    await a_job(db_session, owner, budget_s=60.0, age_s=61.0)

    assert await metering.sweep_abandoned(gate, db_session) == 0


async def test_an_already_settled_job_is_not_swept(gate, db_session, owner):
    job = await a_job(db_session, owner, budget_s=1.0, age_s=metering.SETTLEMENT_GRACE_S + 10)
    await metering.settle(gate, db_session, job.id, solver_seconds=1.0)

    assert await metering.sweep_abandoned(gate, db_session) == 0


async def test_a_finished_job_is_not_swept(gate, db_session, owner):
    await a_job(
        db_session,
        owner,
        budget_s=1.0,
        age_s=metering.SETTLEMENT_GRACE_S + 10,
        state=JobState.COMPLETED,
    )

    assert await metering.sweep_abandoned(gate, db_session) == 0


async def test_a_sweep_settles_every_stale_job_it_finds(gate, db_session, owner):
    for _ in range(3):
        await a_job(db_session, owner, budget_s=1.0, age_s=metering.SETTLEMENT_GRACE_S + 10)

    assert await metering.sweep_abandoned(gate, db_session) == 3


async def test_a_space_outage_leaves_settlement_retryable(gate, db_session, owner):
    job = await a_job(db_session, owner)
    gate.unavailable = True

    with pytest.raises(PricingUnavailable):
        await metering.settle(gate, db_session, job.id, solver_seconds=1.0)
    assert job.metered is False

    gate.unavailable = False
    assert await metering.settle(gate, db_session, job.id, solver_seconds=1.0) is True
    assert job.metered is True

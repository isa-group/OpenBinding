"""Two concurrent creations cannot both take the last slot of the plan's ``concurrentJobs``.

The deployment's cap is eight here and the plan declares one (or two), so the slot they race
for is the plan's. Needs PostgreSQL (``TEST_DATABASE_URL``, see docs/qa/PG_HARNESS.md): the
``FOR UPDATE`` on the account row that serialises the two is not exercised by SQLite, and the
``two_sessions`` fixture skips without it.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from _pricing import pricing_catalog
from openbinding_gateway.db.models import Job, JobState, User, UserRole
from openbinding_gateway.jobs import limits
from openbinding_gateway.space_client import PlanCaps

TECHNICAL_CAP = 8


async def an_account(session) -> User:
    owner = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    session.add(owner)
    await session.commit()
    return owner


async def create(session, owner: User, caps: PlanCaps):
    """What a creation does: check the limit and insert the job in one transaction."""
    refusal = await limits.enforce_concurrency_limit(session, owner.id, limit=TECHNICAL_CAP, caps=caps)
    if refusal is None:
        session.add(Job(
            owner_id=owner.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()),
            service_url="http://engine", state=JobState.QUEUED,
        ))
    await session.commit()
    return refusal


@pytest.mark.asyncio
async def test_two_concurrent_creations_cannot_pass_the_last_slot_of_the_plan(two_sessions):
    first, second = two_sessions
    owner = await an_account(first)
    caps = PlanCaps(plan="TEST", limits={"concurrentJobs": 1.0})

    refusals = await asyncio.gather(create(first, owner, caps), create(second, owner, caps))

    assert sorted(refusal is None for refusal in refusals) == [False, True]
    loser = next(refusal for refusal in refusals if refusal is not None)
    assert (loser.status, loser.extra["concurrency"]["source"], loser.extra["concurrency"]["limit"]) == (429, "plan", 1)
    assert await limits.count_in_flight(first, owner.id) == 1


@pytest.mark.asyncio
async def test_with_one_slot_left_in_the_plan_exactly_one_of_two_creations_takes_it(two_sessions):
    first, second = two_sessions
    owner = await an_account(first)
    caps = PlanCaps(plan="TEST", limits={"concurrentJobs": 2.0})
    assert await create(first, owner, caps) is None  # one of the plan's two slots is taken

    refusals = await asyncio.gather(create(first, owner, caps), create(second, owner, caps))

    assert sorted(refusal is None for refusal in refusals) == [False, True]
    assert await limits.count_in_flight(first, owner.id) == 2


@pytest.mark.asyncio
async def test_a_plan_without_the_limit_is_held_to_the_cap_under_the_same_race(two_sessions):
    first, second = two_sessions
    owner = await an_account(first)
    caps = PlanCaps(plan="BARE")  # declares nothing: the cap decides
    for _ in range(TECHNICAL_CAP - 1):
        assert await create(first, owner, caps) is None

    refusals = await asyncio.gather(create(first, owner, caps), create(second, owner, caps))

    assert sorted(refusal is None for refusal in refusals) == [False, True]
    loser = next(refusal for refusal in refusals if refusal is not None)
    assert loser.extra["concurrency"]["source"] == "technical"
    assert await limits.count_in_flight(first, owner.id) == TECHNICAL_CAP

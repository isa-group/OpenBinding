"""Two workers racing for one queued job: the database picks exactly one."""

from __future__ import annotations

import asyncio

import pytest

from openbinding_gateway.access import metering
from openbinding_gateway.db.models import Job, JobState


@pytest.mark.asyncio
async def test_two_concurrent_claims_of_one_job_have_one_winner(two_sessions):
    first, second = two_sessions
    job = Job(
        engine_id="random-search",
        engine_job_id="engine-1",
        service_url="http://engine",
        state=JobState.QUEUED,
    )
    first.add(job)
    await first.commit()

    async def claim(session):
        token = await metering.claim_job(session, job.id)
        await session.commit()
        return token

    tokens = await asyncio.gather(claim(first), claim(second))

    winners = [token for token in tokens if token is not None]
    assert len(winners) == 1
    await first.refresh(job)
    assert job.state is JobState.RUNNING
    assert job.lease_token == winners[0]
    assert job.attempt == 1

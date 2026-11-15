"""Concurrent run requests with one Idempotency-Key create exactly one job.

Needs PostgreSQL (``TEST_DATABASE_URL``): the `two_sessions` fixture skips
otherwise, because the account row lock that serialises the requests is not
exercised by SQLite.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from _problem_helpers import problem_for

from openbinding_gateway.db.models import Job, User
from openbinding_gateway.modules.execution.adapters import routes as runs_routes
from openbinding_gateway.modules.execution.application import RunRequest
from openbinding_gateway.services.job_submission import JobSubmission

OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}


@pytest.mark.asyncio
async def test_concurrent_requests_with_one_key_create_one_job(two_sessions, monkeypatch):
    first, _second = two_sessions

    async def queued(*args, **kwargs):
        return None

    monkeypatch.setattr(runs_routes, "dispatch_persisted_job", queued)

    user = User(username="pg-idem", email="pg-idem@example.org", password_hash="x", plan_cache="free")
    first.add(user)
    await first.commit()
    upload = await problem_for(first, user)
    revision_id, organization_id = str(upload.revision.id), upload.problem.organization_id

    factory = async_sessionmaker(first.bind, expire_on_commit=False)
    payload = {
        "revision": revision_id,
        "engine": "random-search",
        "mode": "seeded",
        "optimization": OPTIMIZATION,
    }

    async def submit():
        async with factory() as session:
            caller = (await session.execute(select(User).where(User.id == user.id))).scalars().one()
            request = RunRequest.from_document(organization_id, payload, idempotency_key="concurrent-key")
            result = await JobSubmission(session, caller).submit(request)
            return result.status, result.body

    results = await asyncio.gather(*(submit() for _ in range(6)))

    assert {status for status, _ in results} == {202}
    assert len({body["id"] for _, body in results}) == 1
    count = (await first.execute(select(func.count()).select_from(Job))).scalar_one()
    assert count == 1

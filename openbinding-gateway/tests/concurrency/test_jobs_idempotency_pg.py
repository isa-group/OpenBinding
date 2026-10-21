"""Concurrent POST /v1/jobs with one Idempotency-Key create exactly one job.

Needs PostgreSQL (``TEST_DATABASE_URL``): the `two_sessions` fixture skips
otherwise, because the account row lock that serialises the requests is not
exercised by SQLite.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from _repo import REPO_ROOT

from openbinding_gateway import study_jobs
from openbinding_gateway.db.models import Job, User
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services.snapshots import compile_resolved, persist_snapshot
from bim_core.package import load_package

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}


@pytest.mark.asyncio
async def test_concurrent_requests_with_one_key_create_one_job(two_sessions, monkeypatch):
    first, _second = two_sessions

    async def queued(*args, **kwargs):
        return None

    monkeypatch.setattr(routes, "dispatch_persisted_job", queued)

    user = User(username="pg-idem", email="pg-idem@example.org", password_hash="x", plan_cache="free")
    first.add(user)
    await first.commit()
    compilation = await compile_resolved(load_package(EXAMPLE).to_zip(), first, user)
    snapshot_id = await persist_snapshot(compilation, user, first)
    await first.commit()
    assert snapshot_id

    factory = async_sessionmaker(first.bind, expire_on_commit=False)
    payload = {
        "snapshot": snapshot_id,
        "engine": "random-search",
        "mode": "seeded",
        "optimization": OPTIMIZATION,
    }

    async def submit():
        async with factory() as session:
            caller = (await session.execute(select(User).where(User.id == user.id))).scalars().one()
            request = study_jobs._job_request(payload)
            request.scope["headers"].append((b"idempotency-key", b"concurrent-key"))
            response = await routes.create_job(request, caller=caller, session=session)
            return getattr(response, "status_code", 202), study_jobs._response_payload(response)

    results = await asyncio.gather(*(submit() for _ in range(6)))

    assert {status for status, _ in results} == {202}
    assert len({body["id"] for _, body in results}) == 1
    count = (await first.execute(select(func.count()).select_from(Job))).scalar_one()
    assert count == 1

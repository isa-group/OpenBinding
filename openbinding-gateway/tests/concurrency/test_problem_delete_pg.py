"""Deleting a problem that runs name answers 409 ``problem_has_runs``, never a 500.

Needs PostgreSQL (``TEST_DATABASE_URL``): the ``RESTRICT`` foreign keys and row locks are the ones a
deployment gets.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from _problem_helpers import problem_for, run_refs, seed_problem_run
from openbinding_gateway.db.models import BindingCase, Job, JobState, User
from openbinding_gateway.modules.problems.application import delete_problem

pytestmark = pytest.mark.asyncio


async def _user(session) -> User:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    return user


def _job(user, refs) -> Job:
    return Job(
        owner_id=user.id, engine_id="random-search", engine_job_id="", service_url="http://engine",
        state=JobState.QUEUED, **refs,
    )


async def _refused(session, problem_id, user) -> HTTPException:
    problem = await session.get(BindingCase, problem_id)
    with pytest.raises(HTTPException) as caught:
        await delete_problem(session, problem, user)
    await session.rollback()
    return caught.value


async def test_a_problem_named_by_a_run_is_kept(two_sessions):
    session, _ = two_sessions
    user = await _user(session)
    seeded = await seed_problem_run(session, owner_id=user.id)
    session.add(_job(user, run_refs(seeded)))
    await session.commit()

    refused = await _refused(session, seeded["problem_id"], user)

    assert refused.status_code == 409
    assert refused.detail["code"] == "problem_has_runs"
    assert await session.get(BindingCase, seeded["problem_id"]) is not None


async def test_a_run_committed_after_the_check_is_caught_by_the_foreign_key(two_sessions, monkeypatch):
    """The check and the delete are not atomic: the RESTRICT foreign key catches the run in between."""
    first, second = two_sessions
    user = await _user(first)
    seeded = await seed_problem_run(first, owner_id=user.id)
    await first.commit()
    refs = run_refs(seeded)

    original_scalar = first.scalar
    checks = 0

    async def scalar_then_launch(statement, *args, **kwargs):
        nonlocal checks
        value = await original_scalar(statement, *args, **kwargs)
        checks += 1
        if checks == 2:  # the second reference check (runs, then study cells): launch a run from the other session now
            second.add(_job(await second.get(User, user.id), refs))
            await second.commit()
        return value

    monkeypatch.setattr(first, "scalar", scalar_then_launch)
    problem = await first.get(BindingCase, seeded["problem_id"])
    with pytest.raises(HTTPException) as caught:
        await delete_problem(first, problem, user)
    await first.rollback()

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "problem_has_runs"
    assert await second.scalar(select(BindingCase.id).where(BindingCase.id == seeded["problem_id"])) is not None


async def test_an_unused_problem_is_deleted(two_sessions):
    session, _ = two_sessions
    user = await _user(session)
    upload = await problem_for(session, user)
    await session.commit()

    await delete_problem(session, upload.problem, user)
    await session.commit()

    assert await session.get(BindingCase, upload.problem.id) is None

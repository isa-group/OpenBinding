"""Two requests compiling one revision at once store one compilation (D6), and a run names a consistent pair.

Needs PostgreSQL (``TEST_DATABASE_URL``): the ``two_sessions`` fixture skips anywhere else.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from _problem_helpers import problem_for, seed_problem_run
from openbinding_gateway.db.models import (
    BindingCaseRevision,
    Job,
    JobState,
    ProblemCompilation,
    User,
)
from openbinding_gateway.modules.problems.application import problems as problems_module

pytestmark = pytest.mark.asyncio


async def _user(session) -> User:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    return user


async def _uncompiled_revision(session) -> uuid.UUID:
    """A real uploaded revision whose compilation by the installed toolchain was removed again."""
    user = await _user(session)
    upload = await problem_for(session, user)
    revision_id = upload.revision.id
    await session.commit()
    await session.execute(delete(ProblemCompilation).where(ProblemCompilation.revision_id == revision_id))
    await session.commit()
    return revision_id


async def test_concurrent_compile_or_get_stores_one_compilation(two_sessions, monkeypatch):
    first, second = two_sessions
    revision_id = await _uncompiled_revision(first)

    real = problems_module.compile_package
    entered = 0
    both_compiling = asyncio.Event()

    async def compile_together(archive):
        nonlocal entered
        entered += 1
        if entered == 2:
            both_compiling.set()
        await asyncio.wait_for(both_compiling.wait(), timeout=20)
        return await real(archive)

    monkeypatch.setattr(problems_module, "compile_package", compile_together)

    async def compile_in(session):
        revision = await session.get(BindingCaseRevision, revision_id)
        row = await problems_module.compile_or_get(session, revision)
        await session.commit()
        return row.id

    ids = await asyncio.gather(compile_in(first), compile_in(second))

    assert entered == 2
    assert ids[0] == ids[1]
    count = await first.scalar(
        select(func.count()).select_from(ProblemCompilation).where(ProblemCompilation.revision_id == revision_id)
    )
    assert count == 1


async def test_a_run_cannot_name_the_compilation_of_another_revision(two_sessions):
    session, _ = two_sessions
    user = await _user(session)
    one = await seed_problem_run(session, created_by_id=user.id)
    other = await seed_problem_run(session, created_by_id=user.id, organization_id=one["organization_id"])
    await session.commit()

    session.add(Job(
        created_by_id=user.id, state=JobState.QUEUED, engine_id="random-search", engine_job_id="",
        service_url="http://engine",
        organization_id=one["organization_id"], revision_id=one["revision_id"],
        compilation_id=other["compilation_id"],
    ))
    with pytest.raises(IntegrityError):
        await session.flush()
    await session.rollback()

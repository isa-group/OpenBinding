"""Value origins on PostgreSQL: written with their revision, refused to every UPDATE, and gone with the revision
(``ON DELETE CASCADE``) or the problem.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import DBAPIError

from _problem_helpers import problem_for
from openbinding_gateway.db.models import BindingCaseRevision, ProblemCompilation, ProblemValueOrigin, User
from openbinding_gateway.modules.problems.application import create_problem, delete_problem
from problems._sphere_helpers import flagship

pytestmark = pytest.mark.asyncio


async def _user(session) -> User:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    return user


async def _count(session, revision_id) -> int:
    return int(await session.scalar(
        select(func.count()).select_from(ProblemValueOrigin).where(ProblemValueOrigin.revision_id == revision_id)
    ) or 0)


async def test_origins_are_immutable_and_cascade_with_their_revision(pg) -> None:
    generated = flagship()
    async with pg.session() as session:
        user = await _user(session)
        seed = await problem_for(session, user)
        made = await create_problem(session, await _organization(session, seed), generated.archive(), user,
                                    slug=f"t-{uuid.uuid4().hex[:8]}", value_origins=generated.origins)
        revision_id = made.revision.id
        assert await _count(session, revision_id) == len(generated.origins)
        with pytest.raises(DBAPIError):
            await session.execute(
                update(ProblemValueOrigin).where(ProblemValueOrigin.revision_id == revision_id).values(value=1)
            )
        await session.rollback()
        await session.execute(delete(ProblemCompilation).where(ProblemCompilation.revision_id == revision_id))
        await session.execute(delete(BindingCaseRevision).where(BindingCaseRevision.id == revision_id))
        await session.commit()
        assert await _count(session, revision_id) == 0


async def test_deleting_the_problem_deletes_its_origins(pg) -> None:
    generated = flagship()
    async with pg.session() as session:
        user = await _user(session)
        seed = await problem_for(session, user)
        made = await create_problem(session, await _organization(session, seed), generated.archive(), user,
                                    slug=f"t-{uuid.uuid4().hex[:8]}", value_origins=generated.origins)
        await session.commit()
        await delete_problem(session, made.problem, user)
        await session.commit()
        assert await _count(session, made.revision.id) == 0


async def _organization(session, seed):
    from openbinding_gateway.db.models import Organization

    return await session.get(Organization, seed.problem.organization_id)

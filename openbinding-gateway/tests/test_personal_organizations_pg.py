"""Personal organizations on PostgreSQL: one per account, always a root, and an account that has one is not deleted.

SQLite enforces neither the CHECK nor the RESTRICT in the suite, so these are their only checks.

Needs ``TEST_DATABASE_URL`` (the ``pg`` fixture skips without it); synthetic data, no network.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete, update
from sqlalchemy.exc import IntegrityError

from openbinding_gateway.db.models import Organization, User
from openbinding_gateway.services.organizations import ensure_personal_organization

pytestmark = pytest.mark.asyncio


async def a_user(session) -> User:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="FREE")
    session.add(user)
    await session.flush()
    return user


async def test_an_account_has_one_personal_organization(pg) -> None:
    async with pg.session() as session:
        user = await a_user(session)
        await ensure_personal_organization(session, user)
        await session.commit()
        with pytest.raises(IntegrityError, match="uq_organizations_personal_owner_id"):
            session.add(Organization(
                slug=f"second-{uuid.uuid4().hex[:6]}", name="Second", created_by_id=user.id, personal_owner_id=user.id,
            ))
            await session.flush()
        await session.rollback()


async def test_a_personal_organization_is_always_a_root(pg) -> None:
    async with pg.session() as session:
        user = await a_user(session)
        parent = Organization(slug=f"p-{uuid.uuid4().hex[:6]}", name="Parent", created_by_id=user.id)
        session.add(parent)
        personal = await ensure_personal_organization(session, user)
        await session.commit()
        personal_id, parent_id, user_id = personal.id, parent.id, user.id
        with pytest.raises(IntegrityError, match="ck_organizations_personal_organization_is_root"):
            await session.execute(update(Organization).where(Organization.id == personal_id).values(parent_id=parent_id))
        await session.rollback()
        # An ordinary organization takes a parent as before.
        child = Organization(slug=f"c-{uuid.uuid4().hex[:6]}", name="Child", created_by_id=user_id, parent_id=parent_id)
        session.add(child)
        await session.commit()


async def test_an_account_with_a_personal_organization_is_not_deleted(pg) -> None:
    async with pg.session() as session:
        user = await a_user(session)
        personal = await ensure_personal_organization(session, user)
        await session.commit()
        personal_id, user_id = personal.id, user.id
        # The organization's creator is RESTRICT already; the personal owner is too, so a cleared creator would not
        # let a stray hard delete through either.
        await session.execute(
            update(Organization).where(Organization.id == personal_id).values(created_by_id=(await a_user(session)).id)
        )
        await session.commit()
        with pytest.raises(IntegrityError, match="fk_organizations_personal_owner_id_users"):
            await session.execute(delete(User).where(User.id == user_id))
        await session.rollback()
        # With the owner cleared it is an ordinary organization, and the account may go (nothing in the gateway clears it:
        # DELETE /v1/users/me deletes the organization instead).
        await session.execute(update(Organization).where(Organization.id == personal_id).values(personal_owner_id=None))
        await session.commit()

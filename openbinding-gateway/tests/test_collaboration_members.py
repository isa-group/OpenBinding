"""``collaboration.members_with_role``: who holds at least a role on an organization, inherited roles included (F6)."""

from __future__ import annotations

import uuid

import pytest

from openbinding_gateway.collaboration import members_with_role
from openbinding_gateway.db.models import Organization, OrganizationMembership, OrganizationRole, User, utcnow

pytestmark = pytest.mark.asyncio


async def _user(session, **values) -> User:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.org", password_hash="x", plan_cache="FREE", **values)
    session.add(user)
    await session.flush()
    return user


async def test_a_three_level_tree_inherits_the_strongest_role(db_session) -> None:
    owner = await _user(db_session)
    root = Organization(slug=f"r-{uuid.uuid4().hex[:6]}", name="Root", created_by_id=owner.id)
    db_session.add(root)
    await db_session.flush()
    middle = Organization(slug=f"m-{uuid.uuid4().hex[:6]}", name="Middle", parent_id=root.id, created_by_id=owner.id)
    db_session.add(middle)
    await db_session.flush()
    leaf = Organization(slug=f"l-{uuid.uuid4().hex[:6]}", name="Leaf", parent_id=middle.id, created_by_id=owner.id)
    db_session.add(leaf)
    await db_session.flush()

    admin = await _user(db_session)
    member = await _user(db_session)
    viewer = await _user(db_session)
    promoted = await _user(db_session)
    gone = await _user(db_session, is_active=False)
    deleted = await _user(db_session, deleted_at=utcnow())
    db_session.add_all([
        OrganizationMembership(organization_id=root.id, user_id=admin.id, role=OrganizationRole.ADMIN),
        OrganizationMembership(organization_id=leaf.id, user_id=member.id, role=OrganizationRole.MEMBER),
        OrganizationMembership(organization_id=leaf.id, user_id=viewer.id, role=OrganizationRole.VIEWER),
        OrganizationMembership(organization_id=leaf.id, user_id=promoted.id, role=OrganizationRole.VIEWER),
        OrganizationMembership(organization_id=middle.id, user_id=promoted.id, role=OrganizationRole.MEMBER),
        OrganizationMembership(organization_id=leaf.id, user_id=gone.id, role=OrganizationRole.OWNER),
        OrganizationMembership(organization_id=leaf.id, user_id=deleted.id, role=OrganizationRole.OWNER),
    ])
    await db_session.commit()
    found = set(await members_with_role(db_session, leaf.id, OrganizationRole.MEMBER))
    assert found == {admin.id, member.id, promoted.id}
    assert set(await members_with_role(db_session, middle.id, OrganizationRole.MEMBER)) == {admin.id, promoted.id}
    assert viewer.id in set(await members_with_role(db_session, leaf.id, OrganizationRole.VIEWER))


async def test_a_personal_organization_is_its_owner(db_session) -> None:
    from openbinding_gateway.services.organizations import ensure_personal_organization

    user = await _user(db_session)
    personal = await ensure_personal_organization(db_session, user)
    await db_session.commit()
    assert await members_with_role(db_session, personal.id, OrganizationRole.MEMBER) == [user.id]

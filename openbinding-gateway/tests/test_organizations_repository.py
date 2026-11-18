"""Organization queries stay inside the organization they are asked about."""

import uuid
from types import SimpleNamespace

import pytest
import pytest_asyncio
from fastapi import HTTPException

from openbinding_gateway import collaboration
from openbinding_gateway.db.models import (
    AuditEvent,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    User,
)
from openbinding_gateway.repositories import organizations as organization_repository
from _pricing import fixture_catalog


async def _user(session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        plan_cache=fixture_catalog().default_plan,
    )
    session.add(user)
    await session.flush()
    return user


async def _organization(session, creator: User, slug: str, name: str = "Org", parent=None) -> Organization:
    organization = Organization(
        slug=slug, name=name, created_by_id=creator.id,
        parent_id=parent.id if parent else None,
    )
    session.add(organization)
    await session.flush()
    return organization


async def _member(session, organization: Organization, user: User, role: OrganizationRole):
    membership = OrganizationMembership(organization_id=organization.id, user_id=user.id, role=role)
    session.add(membership)
    await session.flush()
    return membership


@pytest_asyncio.fixture
async def two_tenants(db_session):
    """Org A and org B, each with its own owner, and a viewer of A only."""
    owner_a, owner_b, viewer, outsider = [await _user(db_session) for _ in range(4)]
    org_a = await _organization(db_session, owner_a, "alpha", "Alpha")
    org_b = await _organization(db_session, owner_b, "beta", "Beta")
    await _member(db_session, org_a, owner_a, OrganizationRole.OWNER)
    await _member(db_session, org_b, owner_b, OrganizationRole.OWNER)
    await _member(db_session, org_a, viewer, OrganizationRole.VIEWER)
    return SimpleNamespace(
        org_a=org_a, org_b=org_b, owner_a=owner_a, owner_b=owner_b, viewer=viewer, outsider=outsider,
    )


@pytest.mark.asyncio
async def test_resolving_by_slug_never_crosses_organizations(db_session, two_tenants):
    t = two_tenants

    assert (await collaboration.organization_by_ref(db_session, "alpha")).id == t.org_a.id
    assert (await collaboration.organization_by_ref(db_session, "beta")).id == t.org_b.id
    assert (await collaboration.organization_by_ref(db_session, str(t.org_b.id))).id == t.org_b.id
    assert await collaboration.organization_by_ref(db_session, "gamma") is None


@pytest.mark.asyncio
async def test_membership_in_one_organization_reveals_nothing_about_another(db_session, two_tenants):
    t = two_tenants

    found = await organization_repository.get_membership(db_session, t.org_a.id, t.viewer.id)
    assert found.role is OrganizationRole.VIEWER
    assert await organization_repository.get_membership(db_session, t.org_b.id, t.viewer.id) is None
    assert await organization_repository.get_membership(db_session, t.org_a.id, t.outsider.id) is None
    assert await organization_repository.get_membership(db_session, t.org_a.id, t.owner_b.id) is None

    assert await collaboration.effective_role(db_session, t.org_a.id, t.viewer) is OrganizationRole.VIEWER
    assert await collaboration.effective_role(db_session, t.org_b.id, t.viewer) is None
    assert await collaboration.effective_role(db_session, t.org_a.id, t.outsider) is None


@pytest.mark.asyncio
async def test_member_listing_and_owner_count_are_per_organization(db_session, two_tenants):
    t = two_tenants

    members_a = await organization_repository.list_members(db_session, t.org_a.id)
    members_b = await organization_repository.list_members(db_session, t.org_b.id)
    assert {row.user_id for row in members_a} == {t.owner_a.id, t.viewer.id}
    assert {row.user_id for row in members_b} == {t.owner_b.id}
    locked = await organization_repository.lock_members(db_session, t.org_a.id)
    assert {row.id for row in locked} == {row.id for row in members_a}

    assert await organization_repository.count_owners(db_session, t.org_a.id) == 1
    await _member(db_session, t.org_b, t.outsider, OrganizationRole.OWNER)
    assert await organization_repository.count_owners(db_session, t.org_b.id) == 2
    assert await organization_repository.count_owners(db_session, t.org_a.id) == 1


@pytest.mark.asyncio
async def test_a_child_organization_does_not_leak_into_its_parents_direct_members(db_session, two_tenants):
    t = two_tenants
    child = await _organization(db_session, t.owner_a, "alpha-child", "Child", parent=t.org_a)
    await _member(db_session, child, t.outsider, OrganizationRole.MEMBER)

    assert await organization_repository.get_membership(db_session, t.org_a.id, t.outsider.id) is None
    assert [row.user_id for row in await organization_repository.list_members(db_session, child.id)] == [
        t.outsider.id
    ]
    # Roles flow down from the parent, never up from the child.
    assert await collaboration.effective_role(db_session, child.id, t.viewer) is OrganizationRole.VIEWER
    assert await collaboration.effective_role(db_session, t.org_a.id, t.outsider) is None


@pytest.mark.asyncio
async def test_a_viewer_passes_and_an_outsider_is_refused(db_session, two_tenants):
    t = two_tenants

    role = await collaboration.require_role(db_session, t.org_a, t.viewer, OrganizationRole.VIEWER)
    assert role is OrganizationRole.VIEWER

    # An outsider is refused in either organization, and a viewer of A in B.
    for organization, user in ((t.org_a, t.outsider), (t.org_b, t.outsider), (t.org_b, t.viewer)):
        with pytest.raises(HTTPException) as refused:
            await collaboration.require_role(db_session, organization, user, OrganizationRole.VIEWER)
        assert refused.value.status_code == 403
        assert refused.value.detail["code"] == "organization_forbidden"


@pytest.mark.asyncio
async def test_listing_every_organization_is_ordered_by_name(db_session, two_tenants):
    t = two_tenants

    names = [o.name for o in await organization_repository.list_all(db_session)]
    assert names == sorted(names)
    assert {t.org_a.id, t.org_b.id} <= {o.id for o in await organization_repository.list_all(db_session)}


@pytest.mark.asyncio
async def test_audit_events_are_scoped_filtered_and_paged(db_session, two_tenants):
    t = two_tenants
    for organization, action, count in ((t.org_a, "problem.created", 3), (t.org_a, "problem.updated", 1),
                                        (t.org_b, "problem.created", 2)):
        for _ in range(count):
            db_session.add(AuditEvent(
                organization_id=organization.id, actor_id=t.owner_a.id, action=action,
                target_type="BindingCase", detail={},
            ))
    await db_session.flush()

    assert await organization_repository.count_audit_events(db_session, t.org_a.id) == 4
    assert await organization_repository.count_audit_events(db_session, t.org_b.id) == 2
    assert await organization_repository.count_audit_events(db_session, t.org_a.id, action="problem.created") == 3
    assert await organization_repository.count_audit_events(db_session, t.org_a.id, action="nothing") == 0

    events = await organization_repository.list_audit_events(db_session, t.org_a.id)
    assert len(events) == 4 and {e.organization_id for e in events} == {t.org_a.id}
    created = await organization_repository.list_audit_events(db_session, t.org_b.id, action="problem.updated")
    assert created == []
    page = await organization_repository.list_audit_events(db_session, t.org_a.id, offset=3, limit=5)
    assert len(page) == 1

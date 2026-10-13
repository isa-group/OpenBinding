"""Organization queries stay inside the organization they are asked about."""

import uuid
from types import SimpleNamespace

import pytest
import pytest_asyncio
from fastapi import HTTPException

from openbinding_gateway import collaboration
from openbinding_gateway.access import public_read
from openbinding_gateway.db.models import (
    AuditEvent,
    Organization,
    OrganizationInvitation,
    OrganizationMembership,
    OrganizationRole,
    Project,
    User,
    Visibility,
    utcnow,
)
from openbinding_gateway.repositories import organizations as organization_repository
from _pricing import pricing_catalog


async def _user(session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        plan_cache=pricing_catalog().default_plan,
    )
    session.add(user)
    await session.flush()
    return user


async def _organization(session, sponsor: User, slug: str, name: str = "Org", parent=None) -> Organization:
    organization = Organization(
        slug=slug, name=name, billing_sponsor_user_id=sponsor.id, created_by_id=sponsor.id,
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


async def _project(session, organization: Organization, creator: User, slug: str, visibility, name=None):
    project = Project(
        organization_id=organization.id, slug=slug, name=name or slug, created_by_id=creator.id,
        visibility=visibility,
    )
    session.add(project)
    await session.flush()
    return project


@pytest_asyncio.fixture
async def two_tenants(db_session):
    """Org A and org B, each with its own owner, a viewer (A only), and public and private projects."""
    owner_a, owner_b, viewer, outsider = [await _user(db_session) for _ in range(4)]
    org_a = await _organization(db_session, owner_a, "alpha", "Alpha")
    org_b = await _organization(db_session, owner_b, "beta", "Beta")
    await _member(db_session, org_a, owner_a, OrganizationRole.OWNER)
    await _member(db_session, org_b, owner_b, OrganizationRole.OWNER)
    await _member(db_session, org_a, viewer, OrganizationRole.VIEWER)
    projects = SimpleNamespace(
        a_private=await _project(db_session, org_a, owner_a, "shared-slug", Visibility.PRIVATE, "Zeta"),
        a_public=await _project(db_session, org_a, owner_a, "open", Visibility.PUBLIC, "Alpha open"),
        b_private=await _project(db_session, org_b, owner_b, "shared-slug", Visibility.PRIVATE, "Beta secret"),
        b_public=await _project(db_session, org_b, owner_b, "b-open", Visibility.PUBLIC, "Beta open"),
    )
    return SimpleNamespace(
        org_a=org_a, org_b=org_b, owner_a=owner_a, owner_b=owner_b, viewer=viewer, outsider=outsider,
        projects=projects,
    )


@pytest.mark.asyncio
async def test_resolving_by_slug_never_crosses_organizations(db_session, two_tenants):
    t = two_tenants

    assert (await collaboration.organization_by_ref(db_session, "alpha")).id == t.org_a.id
    assert (await collaboration.organization_by_ref(db_session, "beta")).id == t.org_b.id
    assert (await collaboration.organization_by_ref(db_session, str(t.org_b.id))).id == t.org_b.id
    assert await collaboration.organization_by_ref(db_session, "gamma") is None

    # The same project slug exists in both organizations: each resolves only in its own.
    in_a = await collaboration.project_by_ref(db_session, t.org_a.id, "shared-slug")
    in_b = await collaboration.project_by_ref(db_session, t.org_b.id, "shared-slug")
    assert (in_a.id, in_b.id) == (t.projects.a_private.id, t.projects.b_private.id)
    assert await collaboration.project_by_ref(db_session, t.org_a.id, "b-open") is None
    assert await collaboration.project_by_ref(db_session, t.org_a.id, t.projects.b_public.id) is None


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
async def test_project_listing_is_scoped_ordered_and_unfiltered_by_visibility(db_session, two_tenants):
    t = two_tenants

    ordered = await organization_repository.list_projects(db_session, t.org_a.id)
    assert [p.id for p in ordered] == [t.projects.a_public.id, t.projects.a_private.id]  # by name
    unordered = await organization_repository.list_projects(db_session, t.org_a.id, ordered=False)
    assert {p.id for p in unordered} == {p.id for p in ordered}
    assert {p.id for p in await organization_repository.list_projects(db_session, t.org_b.id)} == {
        t.projects.b_private.id,
        t.projects.b_public.id,
    }
    assert await organization_repository.list_projects(db_session, uuid.uuid4()) == []

    assert await organization_repository.project_slug_in_use(db_session, t.org_a.id, "open")
    assert not await organization_repository.project_slug_in_use(db_session, t.org_b.id, "open")
    assert await organization_repository.project_slug_in_use(db_session, t.org_b.id, "shared-slug")
    assert not await organization_repository.project_slug_in_use(db_session, t.org_a.id, "b-open")


@pytest.mark.asyncio
async def test_project_listing_is_open_to_a_viewer_and_closed_to_an_outsider(db_session, two_tenants):
    t = two_tenants

    # The route lists with the repository only after require_role(VIEWER): a viewer passes and sees
    # every project of that organization, private ones included; nothing of org B.
    role = await collaboration.require_role(db_session, t.org_a, t.viewer, OrganizationRole.VIEWER)
    assert role is OrganizationRole.VIEWER
    visible = await organization_repository.list_projects(db_session, t.org_a.id)
    assert {p.visibility for p in visible} == {Visibility.PRIVATE, Visibility.PUBLIC}
    assert {p.organization_id for p in visible} == {t.org_a.id}

    # An outsider is refused before any listing, in either organization, and a viewer of A in B.
    for organization, user in ((t.org_a, t.outsider), (t.org_b, t.outsider), (t.org_b, t.viewer)):
        with pytest.raises(HTTPException) as refused:
            await collaboration.require_role(db_session, organization, user, OrganizationRole.VIEWER)
        assert refused.value.status_code == 403
        assert refused.value.detail["code"] == "organization_forbidden"


@pytest.mark.asyncio
async def test_an_outsider_reads_only_public_projects_through_a_read_grant(db_session, two_tenants):
    t = two_tenants
    public_read.reset_rate_limits()

    # Without a read grant (any non-eligible request) a project is not reachable at all.
    with pytest.raises(HTTPException) as refused:
        await collaboration.require_project(
            db_session, t.org_a, "open", t.outsider, OrganizationRole.VIEWER
        )
    assert refused.value.status_code == 403

    db_session.info[public_read._KEY] = public_read.ReadGrant(caller_key="ip:test", template="t")
    try:
        public = await collaboration.require_project(
            db_session, t.org_a, "open", t.outsider, OrganizationRole.VIEWER
        )
        assert public.id == t.projects.a_public.id
        assert public_read.is_public_read(db_session)

        db_session.info[public_read._KEY] = public_read.ReadGrant(caller_key="ip:test", template="t")
        with pytest.raises(HTTPException) as private:
            await collaboration.require_project(
                db_session, t.org_a, "shared-slug", t.outsider, OrganizationRole.VIEWER
            )
        assert private.value.status_code == 403
        assert not public_read.is_public_read(db_session)

        # A public project of B is not reachable through org A, nor by B's slug under A.
        with pytest.raises(HTTPException):
            await collaboration.require_project(
                db_session, t.org_a, "b-open", t.outsider, OrganizationRole.VIEWER
            )
    finally:
        db_session.info.pop(public_read._KEY, None)
        public_read.reset_rate_limits()


@pytest.mark.asyncio
async def test_a_member_is_not_treated_as_a_public_reader(db_session, two_tenants):
    t = two_tenants
    db_session.info[public_read._KEY] = public_read.ReadGrant(caller_key="ip:test", template="t")
    try:
        project = await collaboration.require_project(
            db_session, t.org_a, "shared-slug", t.viewer, OrganizationRole.VIEWER
        )
        assert project.id == t.projects.a_private.id
        assert not public_read.is_public_read(db_session)
    finally:
        db_session.info.pop(public_read._KEY, None)


@pytest.mark.asyncio
async def test_listing_every_organization_is_ordered_by_name(db_session, two_tenants):
    t = two_tenants

    names = [o.name for o in await organization_repository.list_all(db_session)]
    assert names == sorted(names)
    assert {t.org_a.id, t.org_b.id} <= {o.id for o in await organization_repository.list_all(db_session)}


@pytest.mark.asyncio
async def test_invitations_resolve_by_prefix_only(db_session, two_tenants):
    t = two_tenants
    invitation = OrganizationInvitation(
        organization_id=t.org_a.id, email="x@example.org", role=OrganizationRole.MEMBER,
        token_prefix="obi_aaaaaaaaaaaa", token_hash="0" * 64, invited_by_id=t.owner_a.id,
        expires_at=utcnow(),
    )
    db_session.add(invitation)
    await db_session.flush()

    found = await organization_repository.find_invitation_by_prefix(db_session, "obi_aaaaaaaaaaaa")
    assert found.id == invitation.id and found.organization_id == t.org_a.id
    assert await organization_repository.find_invitation_by_prefix(db_session, "obi_bbbbbbbbbbbb") is None


@pytest.mark.asyncio
async def test_audit_events_are_scoped_filtered_and_paged(db_session, two_tenants):
    t = two_tenants
    for organization, action, count in ((t.org_a, "project.created", 3), (t.org_a, "project.updated", 1),
                                        (t.org_b, "project.created", 2)):
        for _ in range(count):
            db_session.add(AuditEvent(
                organization_id=organization.id, actor_id=t.owner_a.id, action=action,
                target_type="Project", detail={},
            ))
    await db_session.flush()

    assert await organization_repository.count_audit_events(db_session, t.org_a.id) == 4
    assert await organization_repository.count_audit_events(db_session, t.org_b.id) == 2
    assert await organization_repository.count_audit_events(db_session, t.org_a.id, action="project.created") == 3
    assert await organization_repository.count_audit_events(db_session, t.org_a.id, action="nothing") == 0

    events = await organization_repository.list_audit_events(db_session, t.org_a.id)
    assert len(events) == 4 and {e.organization_id for e in events} == {t.org_a.id}
    created = await organization_repository.list_audit_events(db_session, t.org_b.id, action="project.updated")
    assert created == []
    page = await organization_repository.list_audit_events(db_session, t.org_a.id, offset=3, limit=5)
    assert len(page) == 1

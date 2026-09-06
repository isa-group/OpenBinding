"""Organization trees, members, projects and immutable binding cases."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..collaboration import (
    assert_acyclic_move,
    descendant_ids,
    effective_role,
    enforce_sponsor_capacity,
    enforce_sponsor_usage,
    organization_usage,
    organization_by_ref,
    require_project,
    require_role,
    sponsor_has_member,
    sponsor_organization_ids,
)
from ..db.models import (
    ApiKey,
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    InstanceSnapshot,
    Organization,
    OrganizationInvitation,
    OrganizationMembership,
    OrganizationRole,
    Project,
    ProjectResource,
    ProjectResourceRevision,
    User,
    Visibility,
    utcnow,
)
from ..models.errors import api_error
from ..models.platform import (
    BindingCaseCreate,
    BindingCaseView,
    CaseRevisionCreate,
    CaseRevisionView,
    InvitationAccept,
    InvitationCreate,
    InvitationCreated,
    MemberBatchUpdate,
    MemberUpsert,
    MemberView,
    OrganizationCreate,
    OrganizationUpdate,
    OrganizationView,
    ProjectCreate,
    ProjectUpdate,
    ProjectView,
    ProjectResourceCreate,
    ProjectResourceRevisionCreate,
    ProjectResourceRevisionView,
    ProjectResourceView,
)
from ..access.dependencies import get_current_user, session_dependency
from ..v1.canonical import digest

router = APIRouter(prefix="/v1/organizations", tags=["Organizations"])
invitation_router = APIRouter(prefix="/v1/invitations", tags=["Organizations"])


def _audit(session: AsyncSession, user: User, action: str, target, organization_id=None, **detail) -> None:
    session.add(
        AuditEvent(
            organization_id=organization_id,
            actor_id=user.id,
            action=action,
            target_type=target.__class__.__name__,
            target_id=getattr(target, "id", None),
            detail=detail,
        )
    )


async def _required_org(session: AsyncSession, reference: str) -> Organization:
    organization = await organization_by_ref(session, reference)
    if organization is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    return organization


async def _org_view(session: AsyncSession, organization: Organization, user: User) -> OrganizationView:
    role = await effective_role(session, organization.id, user)
    return OrganizationView(
        id=organization.id,
        slug=organization.slug,
        name=organization.name,
        parent_id=organization.parent_id,
        billing_sponsor_user_id=organization.billing_sponsor_user_id,
        effective_role=role.value if role else None,
        created_at=organization.created_at,
    )


@router.get("", response_model=list[OrganizationView], operation_id="listOrganizations")
async def list_organizations(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[OrganizationView]:
    organizations = (await session.execute(select(Organization).order_by(Organization.name))).scalars().all()
    views = [await _org_view(session, organization, user) for organization in organizations]
    return [view for view in views if view.effective_role is not None]


@router.post(
    "",
    response_model=OrganizationView,
    status_code=status.HTTP_201_CREATED,
    operation_id="createOrganization",
)
async def create_organization(
    payload: OrganizationCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    if await organization_by_ref(session, payload.slug) is not None:
        raise api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That organization slug is in use.")
    parent = await session.get(Organization, payload.parent_id) if payload.parent_id else None
    if payload.parent_id and parent is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Parent organization not found.")
    if parent is not None:
        await require_role(session, parent, user, OrganizationRole.ADMIN)
    sponsor_id = payload.billing_sponsor_user_id or (
        parent.billing_sponsor_user_id if parent is not None else user.id
    )
    sponsor = await session.get(User, sponsor_id)
    if sponsor is None or not sponsor.is_active:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_sponsor", "Sponsor must be an active user.")
    if sponsor.id != user.id and not user.is_admin and (parent is None or sponsor.id != parent.billing_sponsor_user_id):
        raise api_error(status.HTTP_403_FORBIDDEN, "invalid_sponsor", "Only an administrator may assign another sponsor.")
    await enforce_sponsor_capacity(session, sponsor, "organizations")
    if not await sponsor_has_member(session, sponsor.id, user.id):
        await enforce_sponsor_capacity(session, sponsor, "members")
    organization = Organization(
        parent_id=parent.id if parent else None,
        slug=payload.slug,
        name=payload.name,
        billing_sponsor_user_id=sponsor.id,
        created_by_id=user.id,
    )
    session.add(organization)
    await session.flush()
    membership = OrganizationMembership(
        organization_id=organization.id, user_id=user.id, role=OrganizationRole.OWNER
    )
    session.add(membership)
    _audit(session, user, "organization.created", organization, organization.id)
    await session.flush()
    return await _org_view(session, organization, user)


@router.get("/{org}", response_model=OrganizationView, operation_id="getOrganization")
async def get_organization(
    org: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.VIEWER)
    return await _org_view(session, organization, user)


@router.patch("/{org}", response_model=OrganizationView, operation_id="updateOrganization")
async def update_organization(
    org: str,
    payload: OrganizationUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.ADMIN)
    if payload.name is not None:
        organization.name = payload.name
    if payload.move_to_root and payload.parent_id is not None:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "ambiguous_parent", "Choose a parent or root, not both.")
    if payload.move_to_root or payload.parent_id is not None:
        new_parent_id = None if payload.move_to_root else payload.parent_id
        await assert_acyclic_move(session, organization.id, new_parent_id)
        if new_parent_id is not None:
            new_parent = await session.get(Organization, new_parent_id)
            if new_parent is None:
                raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "New parent not found.")
            await require_role(session, new_parent, user, OrganizationRole.ADMIN)
        organization.parent_id = new_parent_id
    if payload.billing_sponsor_user_id is not None and payload.billing_sponsor_user_id != organization.billing_sponsor_user_id:
        if not user.is_admin:
            raise api_error(status.HTTP_403_FORBIDDEN, "sponsor_transfer_forbidden", "Only a platform administrator may transfer sponsorship.")
        sponsor = await session.get(User, payload.billing_sponsor_user_id)
        if sponsor is None or not sponsor.is_active:
            raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_sponsor", "Sponsor must be active.")
        await session.execute(select(User.id).where(User.id == sponsor.id).with_for_update())
        subtree = set(await descendant_ids(session, organization.id))
        sponsored = set(await sponsor_organization_ids(session, sponsor.id))
        hypothetical = await organization_usage(session, subtree | sponsored)
        await enforce_sponsor_usage(session, sponsor, hypothetical)
        await session.execute(
            update(Organization)
            .where(Organization.id.in_(subtree))
            .values(billing_sponsor_user_id=sponsor.id)
        )
        organization.billing_sponsor_user_id = sponsor.id
    _audit(session, user, "organization.updated", organization, organization.id)
    await session.flush()
    return await _org_view(session, organization, user)


async def _member_views(
    session: AsyncSession, organization: Organization
) -> list[MemberView]:
    rows = (
        await session.execute(
            select(OrganizationMembership)
            .where(OrganizationMembership.organization_id == organization.id)
            .order_by(OrganizationMembership.created_at)
        )
    ).scalars().all()
    members = []
    for row in rows:
        member = await session.get(User, row.user_id)
        members.append(MemberView(
            id=row.id, organization_id=row.organization_id, user_id=row.user_id,
            username=member.username if member else None,
            email=member.email if member else None,
            role=row.role.value, created_at=row.created_at,
        ))
    return members


@router.get("/{org}/members", response_model=list[MemberView], operation_id="listOrganizationMembers")
async def list_members(
    org: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[MemberView]:
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.VIEWER)
    return await _member_views(session, organization)


@router.post(
    "/{org}/members/batch",
    response_model=list[MemberView],
    operation_id="updateOrganizationMembersBatch",
)
async def update_members_batch(
    org: str,
    payload: MemberBatchUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[MemberView]:
    """Apply a staged set of direct-member changes in one transaction."""

    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.ADMIN)
    sponsor = await session.get(User, organization.billing_sponsor_user_id)
    if sponsor is None or not sponsor.is_active:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "invalid_sponsor",
            "The organization sponsor is not active.",
        )

    # Serialize all structural mutations for this sponsor and lock the direct
    # membership rows that this batch will replace.
    await session.execute(select(User.id).where(User.id == sponsor.id).with_for_update())
    existing_rows = (
        await session.execute(
            select(OrganizationMembership)
            .where(OrganizationMembership.organization_id == organization.id)
            .with_for_update()
        )
    ).scalars().all()
    existing = {row.user_id: row for row in existing_rows}
    final_roles = {member_id: row.role for member_id, row in existing.items()}

    upsert_ids = {change.user_id for change in payload.changes if change.role is not None}
    users = {
        value.id: value
        for value in (
            await session.execute(select(User).where(User.id.in_(upsert_ids)))
        ).scalars()
    } if upsert_ids else {}
    missing = sorted(str(member_id) for member_id in upsert_ids if member_id not in users or not users[member_id].is_active)
    if missing:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            "not_found",
            "Every added member must be an active user.",
            user_ids=missing,
        )

    for change in payload.changes:
        if change.role is None:
            if change.user_id not in existing:
                raise api_error(
                    status.HTTP_404_NOT_FOUND,
                    "not_found",
                    f"Member {change.user_id} was not found.",
                )
            final_roles.pop(change.user_id, None)
        else:
            final_roles[change.user_id] = OrganizationRole(change.role)
    if OrganizationRole.OWNER not in final_roles.values():
        raise api_error(
            status.HTTP_409_CONFLICT,
            "last_owner",
            "The last owner cannot be removed.",
        )

    sponsored_ids = await sponsor_organization_ids(session, sponsor.id)
    sponsored_memberships = (
        await session.execute(
            select(
                OrganizationMembership.organization_id,
                OrganizationMembership.user_id,
            ).where(OrganizationMembership.organization_id.in_(sponsored_ids))
        )
    ).all()
    hypothetical_members = {
        member_id
        for organization_id, member_id in sponsored_memberships
        if organization_id != organization.id
    } | set(final_roles)
    await enforce_sponsor_usage(
        session, sponsor, {"members": len(hypothetical_members)}
    )

    removed_ids: set[uuid.UUID] = set()
    for change in payload.changes:
        membership = existing.get(change.user_id)
        if change.role is None:
            removed_ids.add(change.user_id)
            await session.delete(membership)
        elif membership is None:
            session.add(
                OrganizationMembership(
                    organization_id=organization.id,
                    user_id=change.user_id,
                    role=OrganizationRole(change.role),
                )
            )
        else:
            membership.role = OrganizationRole(change.role)
    if removed_ids:
        await session.execute(
            ApiKey.__table__.update()
            .where(ApiKey.user_id.in_(removed_ids), ApiKey.revoked_at.is_(None))
            .values(revoked_at=utcnow())
        )
    _audit(
        session,
        user,
        "organization.members.batch_updated",
        organization,
        organization.id,
        changes=[change.model_dump(mode="json") for change in payload.changes],
    )
    await session.flush()
    return await _member_views(session, organization)


@router.put("/{org}/members/{member_id}", response_model=MemberView, operation_id="upsertOrganizationMember")
async def upsert_member(
    org: str,
    member_id: uuid.UUID,
    payload: MemberUpsert,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> MemberView:
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.ADMIN)
    if payload.user_id != member_id:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "member_mismatch", "Path and payload user differ.")
    member_user = await session.get(User, member_id)
    if member_user is None or not member_user.is_active:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "User not found.")
    existing = (
        await session.execute(
            select(OrganizationMembership).where(
                OrganizationMembership.organization_id == organization.id,
                OrganizationMembership.user_id == member_id,
            )
        )
    ).scalars().first()
    if existing is None:
        sponsor = await session.get(User, organization.billing_sponsor_user_id)
        if not await sponsor_has_member(session, sponsor.id, member_id):
            await enforce_sponsor_capacity(session, sponsor, "members")
        existing = OrganizationMembership(organization_id=organization.id, user_id=member_id)
        session.add(existing)
    elif existing.role is OrganizationRole.OWNER and payload.role != OrganizationRole.OWNER.value:
        await _protect_last_owner(session, existing)
    existing.role = OrganizationRole(payload.role)
    await session.flush()
    _audit(session, user, "organization.member.upserted", existing, organization.id, role=payload.role)
    return MemberView(
        id=existing.id, organization_id=existing.organization_id, user_id=existing.user_id,
        username=member_user.username, email=member_user.email,
        role=existing.role.value, created_at=existing.created_at,
    )


async def _protect_last_owner(session: AsyncSession, membership: OrganizationMembership) -> None:
    if membership.role is not OrganizationRole.OWNER:
        return
    owners = await session.scalar(
        select(func.count(OrganizationMembership.id)).where(
            OrganizationMembership.organization_id == membership.organization_id,
            OrganizationMembership.role == OrganizationRole.OWNER,
        )
    )
    if int(owners or 0) <= 1:
        raise api_error(status.HTTP_409_CONFLICT, "last_owner", "The last owner cannot be removed.")


@router.delete("/{org}/members/{member_id}", status_code=204, operation_id="removeOrganizationMember")
async def remove_member(
    org: str,
    member_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.ADMIN)
    membership = (
        await session.execute(
            select(OrganizationMembership).where(
                OrganizationMembership.organization_id == organization.id,
                OrganizationMembership.user_id == member_id,
            )
        )
    ).scalars().first()
    if membership is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Member not found.")
    await _protect_last_owner(session, membership)
    await session.delete(membership)
    now = utcnow()
    await session.execute(
        ApiKey.__table__.update().where(
            ApiKey.user_id == member_id, ApiKey.revoked_at.is_(None)
        ).values(revoked_at=now)
    )
    _audit(session, user, "organization.member.removed", membership, organization.id)


@router.post(
    "/{org}/invitations", response_model=InvitationCreated,
    status_code=201, operation_id="inviteOrganizationMember"
)
async def invite_member(
    org: str,
    payload: InvitationCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> InvitationCreated:
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.ADMIN)
    secret = secrets.token_urlsafe(32)
    prefix = secrets.token_hex(6)
    token = f"obi_{prefix}_{secret}"
    invitation = OrganizationInvitation(
        organization_id=organization.id,
        email=str(payload.email).lower(),
        role=OrganizationRole(payload.role),
        token_prefix=f"obi_{prefix}",
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        invited_by_id=user.id,
        expires_at=utcnow() + timedelta(days=7),
    )
    session.add(invitation)
    await session.flush()
    _audit(session, user, "organization.invitation.created", invitation, organization.id)
    return InvitationCreated(
        id=invitation.id, organization_id=organization.id, email=invitation.email,
        role=invitation.role.value, expires_at=invitation.expires_at, token=token
    )


@invitation_router.post("/accept", response_model=MemberView, operation_id="acceptOrganizationInvitation")
async def accept_invitation(
    payload: InvitationAccept,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> MemberView:
    parts = payload.token.split("_", 2)
    if len(parts) != 3 or parts[0] != "obi":
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Invitation is invalid.")
    prefix = f"obi_{parts[1]}"
    invitation = (
        await session.execute(select(OrganizationInvitation).where(OrganizationInvitation.token_prefix == prefix))
    ).scalars().first()
    actual = hashlib.sha256(payload.token.encode()).hexdigest()
    if (
        invitation is None
        or not hmac.compare_digest(actual, invitation.token_hash)
        or invitation.accepted_at is not None
        or invitation.expires_at.replace(tzinfo=invitation.expires_at.tzinfo or utcnow().tzinfo) <= utcnow()
        or invitation.email.casefold() != user.email.casefold()
    ):
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Invitation is invalid or expired.")
    organization = await session.get(Organization, invitation.organization_id)
    membership = (
        await session.execute(
            select(OrganizationMembership).where(
                OrganizationMembership.organization_id == organization.id,
                OrganizationMembership.user_id == user.id,
            )
        )
    ).scalars().first()
    if membership is None:
        sponsor = await session.get(User, organization.billing_sponsor_user_id)
        if not await sponsor_has_member(session, sponsor.id, user.id):
            await enforce_sponsor_capacity(session, sponsor, "members")
        membership = OrganizationMembership(
            organization_id=organization.id, user_id=user.id, role=invitation.role
        )
        session.add(membership)
    invitation.accepted_at = utcnow()
    invitation.accepted_by_id = user.id
    await session.flush()
    _audit(session, user, "organization.invitation.accepted", invitation, organization.id)
    return MemberView(
        id=membership.id, organization_id=membership.organization_id, user_id=membership.user_id,
        username=user.username, email=user.email,
        role=membership.role.value, created_at=membership.created_at,
    )


def _project_view(project: Project) -> ProjectView:
    return ProjectView(
        id=project.id, organization_id=project.organization_id, slug=project.slug,
        name=project.name, description=project.description, visibility=project.visibility.value,
        created_by_id=project.created_by_id, created_at=project.created_at, updated_at=project.updated_at
    )


@router.get("/{org}/projects", response_model=list[ProjectView], operation_id="listProjects")
async def list_projects(
    org: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[ProjectView]:
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.VIEWER)
    rows = (await session.execute(select(Project).where(Project.organization_id == organization.id).order_by(Project.name))).scalars().all()
    return [_project_view(row) for row in rows]


@router.post("/{org}/projects", response_model=ProjectView, status_code=201, operation_id="createProject")
async def create_project(
    org: str,
    payload: ProjectCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProjectView:
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.MEMBER)
    sponsor = await session.get(User, organization.billing_sponsor_user_id)
    await enforce_sponsor_capacity(session, sponsor, "projects")
    if payload.visibility == "private":
        await enforce_sponsor_capacity(session, sponsor, "privateProjects")
    duplicate = await session.scalar(
        select(func.count(Project.id)).where(Project.organization_id == organization.id, Project.slug == payload.slug)
    )
    if duplicate:
        raise api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That project slug is in use.")
    project = Project(
        organization_id=organization.id, slug=payload.slug, name=payload.name,
        description=payload.description, visibility=Visibility(payload.visibility), created_by_id=user.id
    )
    session.add(project)
    await session.flush()
    _audit(session, user, "project.created", project, organization.id)
    return _project_view(project)


@router.get("/{org}/projects/{project}", response_model=ProjectView, operation_id="getProject")
async def get_project(
    org: str, project: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProjectView:
    organization = await _required_org(session, org)
    found = await require_project(session, organization, project, user, OrganizationRole.VIEWER)
    return _project_view(found)


@router.patch("/{org}/projects/{project}", response_model=ProjectView, operation_id="updateProject")
async def update_project(
    org: str, project: str, payload: ProjectUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProjectView:
    organization = await _required_org(session, org)
    found = await require_project(session, organization, project, user, OrganizationRole.ADMIN)
    if payload.name is not None:
        found.name = payload.name
    if payload.description is not None:
        found.description = payload.description
    if payload.visibility is not None and payload.visibility != found.visibility.value:
        if payload.visibility == "private":
            sponsor = await session.get(User, organization.billing_sponsor_user_id)
            await enforce_sponsor_capacity(session, sponsor, "privateProjects")
        found.visibility = Visibility(payload.visibility)
    _audit(session, user, "project.updated", found, organization.id)
    await session.flush()
    return _project_view(found)


@router.get("/{org}/projects/{project}/cases", response_model=list[BindingCaseView], operation_id="listBindingCases")
async def list_cases(
    org: str, project: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[BindingCaseView]:
    organization = await _required_org(session, org)
    found = await require_project(session, organization, project, user, OrganizationRole.VIEWER)
    rows = (await session.execute(select(BindingCase).where(BindingCase.project_id == found.id).order_by(BindingCase.name))).scalars().all()
    return [BindingCaseView.model_validate(row, from_attributes=True) for row in rows]


@router.post("/{org}/projects/{project}/cases", response_model=BindingCaseView, status_code=201, operation_id="createBindingCase")
async def create_case(
    org: str, project: str, payload: BindingCaseCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> BindingCaseView:
    organization = await _required_org(session, org)
    found = await require_project(session, organization, project, user, OrganizationRole.MEMBER)
    duplicate = await session.scalar(select(func.count(BindingCase.id)).where(BindingCase.project_id == found.id, BindingCase.slug == payload.slug))
    if duplicate:
        raise api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That case slug is in use.")
    case = BindingCase(project_id=found.id, created_by_id=user.id, **payload.model_dump())
    session.add(case)
    await session.flush()
    _audit(session, user, "binding_case.created", case, organization.id)
    return BindingCaseView.model_validate(case, from_attributes=True)


async def _case(session: AsyncSession, project_id: uuid.UUID, reference: str) -> BindingCase:
    try:
        parsed = uuid.UUID(reference)
    except ValueError:
        parsed = None
    found = (await session.execute(select(BindingCase).where(
        BindingCase.project_id == project_id,
        BindingCase.id == parsed if parsed else BindingCase.slug == reference,
    ))).scalars().first()
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Binding case not found.")
    return found


@router.get("/{org}/projects/{project}/cases/{case}/revisions", response_model=list[CaseRevisionView], operation_id="listBindingCaseRevisions")
async def list_case_revisions(
    org: str, project: str, case: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[CaseRevisionView]:
    organization = await _required_org(session, org)
    found_project = await require_project(session, organization, project, user, OrganizationRole.VIEWER)
    found_case = await _case(session, found_project.id, case)
    rows = (await session.execute(select(BindingCaseRevision).where(BindingCaseRevision.binding_case_id == found_case.id).order_by(BindingCaseRevision.revision))).scalars().all()
    return [CaseRevisionView.model_validate(row, from_attributes=True) for row in rows]


@router.post("/{org}/projects/{project}/cases/{case}/revisions", response_model=CaseRevisionView, status_code=201, operation_id="createBindingCaseRevision")
async def create_case_revision(
    org: str, project: str, case: str, payload: CaseRevisionCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CaseRevisionView:
    organization = await _required_org(session, org)
    found_project = await require_project(session, organization, project, user, OrganizationRole.MEMBER)
    found_case = await _case(session, found_project.id, case)
    if payload.source_snapshot_id is not None:
        snapshot = await session.get(InstanceSnapshot, payload.source_snapshot_id)
        if snapshot is None or snapshot.owner_id != user.id:
            raise api_error(
                status.HTTP_404_NOT_FOUND,
                "not_found",
                "Source snapshot not found.",
            )
    document_digest = digest(payload.document)
    existing = (await session.execute(select(BindingCaseRevision).where(
        BindingCaseRevision.binding_case_id == found_case.id,
        BindingCaseRevision.digest == document_digest,
    ))).scalars().first()
    if existing is not None:
        return CaseRevisionView.model_validate(existing, from_attributes=True)
    await session.execute(
        select(BindingCase.id)
        .where(BindingCase.id == found_case.id)
        .with_for_update()
    )
    latest = await session.scalar(select(func.max(BindingCaseRevision.revision)).where(BindingCaseRevision.binding_case_id == found_case.id))
    revision = BindingCaseRevision(
        binding_case_id=found_case.id, revision=int(latest or 0) + 1,
        digest=document_digest, document=payload.document,
        source_snapshot_id=payload.source_snapshot_id, created_by_id=user.id,
    )
    session.add(revision)
    await session.flush()
    _audit(session, user, "binding_case.revision.created", revision, organization.id, digest=document_digest)
    return CaseRevisionView.model_validate(revision, from_attributes=True)


@router.get(
    "/{org}/projects/{project}/resources",
    response_model=list[ProjectResourceView],
    operation_id="listProjectResources",
)
async def list_project_resources(
    org: str,
    project: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[ProjectResourceView]:
    organization = await _required_org(session, org)
    found_project = await require_project(
        session, organization, project, user, OrganizationRole.VIEWER
    )
    rows = (
        await session.execute(
            select(ProjectResource)
            .where(ProjectResource.project_id == found_project.id)
            .order_by(ProjectResource.name)
        )
    ).scalars().all()
    return [ProjectResourceView.model_validate(row, from_attributes=True) for row in rows]


@router.post(
    "/{org}/projects/{project}/resources",
    response_model=ProjectResourceView,
    status_code=201,
    operation_id="createProjectResource",
)
async def create_project_resource(
    org: str,
    project: str,
    payload: ProjectResourceCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProjectResourceView:
    organization = await _required_org(session, org)
    found_project = await require_project(
        session, organization, project, user, OrganizationRole.MEMBER
    )
    duplicate = await session.scalar(
        select(func.count(ProjectResource.id)).where(
            ProjectResource.project_id == found_project.id,
            ProjectResource.slug == payload.slug,
        )
    )
    if duplicate:
        raise api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That resource slug is in use.")
    resource = ProjectResource(
        project_id=found_project.id, created_by_id=user.id, **payload.model_dump()
    )
    session.add(resource)
    await session.flush()
    _audit(session, user, "project_resource.created", resource, organization.id)
    return ProjectResourceView.model_validate(resource, from_attributes=True)


async def _project_resource(
    session: AsyncSession, project_id: uuid.UUID, reference: str
) -> ProjectResource:
    try:
        parsed = uuid.UUID(reference)
    except ValueError:
        parsed = None
    found = (
        await session.execute(
            select(ProjectResource).where(
                ProjectResource.project_id == project_id,
                ProjectResource.id == parsed if parsed else ProjectResource.slug == reference,
            )
        )
    ).scalars().first()
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Project resource not found.")
    return found


@router.get(
    "/{org}/projects/{project}/resources/{resource}/revisions",
    response_model=list[ProjectResourceRevisionView],
    operation_id="listProjectResourceRevisions",
)
async def list_project_resource_revisions(
    org: str,
    project: str,
    resource: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[ProjectResourceRevisionView]:
    organization = await _required_org(session, org)
    found_project = await require_project(
        session, organization, project, user, OrganizationRole.VIEWER
    )
    found_resource = await _project_resource(session, found_project.id, resource)
    rows = (
        await session.execute(
            select(ProjectResourceRevision)
            .where(ProjectResourceRevision.project_resource_id == found_resource.id)
            .order_by(ProjectResourceRevision.revision)
        )
    ).scalars().all()
    return [
        ProjectResourceRevisionView.model_validate(row, from_attributes=True) for row in rows
    ]


@router.post(
    "/{org}/projects/{project}/resources/{resource}/revisions",
    response_model=ProjectResourceRevisionView,
    status_code=201,
    operation_id="createProjectResourceRevision",
)
async def create_project_resource_revision(
    org: str,
    project: str,
    resource: str,
    payload: ProjectResourceRevisionCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProjectResourceRevisionView:
    organization = await _required_org(session, org)
    found_project = await require_project(
        session, organization, project, user, OrganizationRole.MEMBER
    )
    found_resource = await _project_resource(session, found_project.id, resource)
    document_digest = digest(payload.document)
    existing = (
        await session.execute(
            select(ProjectResourceRevision).where(
                ProjectResourceRevision.project_resource_id == found_resource.id,
                ProjectResourceRevision.digest == document_digest,
            )
        )
    ).scalars().first()
    if existing is not None:
        return ProjectResourceRevisionView.model_validate(existing, from_attributes=True)
    await session.execute(
        select(ProjectResource.id)
        .where(ProjectResource.id == found_resource.id)
        .with_for_update()
    )
    latest = await session.scalar(
        select(func.max(ProjectResourceRevision.revision)).where(
            ProjectResourceRevision.project_resource_id == found_resource.id
        )
    )
    revision = ProjectResourceRevision(
        project_resource_id=found_resource.id,
        revision=int(latest or 0) + 1,
        digest=document_digest,
        document=payload.document,
        created_by_id=user.id,
    )
    session.add(revision)
    await session.flush()
    _audit(
        session,
        user,
        "project_resource.revision.created",
        revision,
        organization.id,
        digest=document_digest,
    )
    return ProjectResourceRevisionView.model_validate(revision, from_attributes=True)

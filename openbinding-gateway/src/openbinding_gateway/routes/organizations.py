"""Organization trees, members and invitations. Problems are ``modules.problems``."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..collaboration import (
    assert_acyclic_move,
    descendant_ids,
    effective_role,
    organization_by_ref,
    require_role,
)
from ..db.models import (
    Blob,
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    Job,
    Organization,
    OrganizationInvitation,
    OrganizationMembership,
    OrganizationRole,
    ProblemCompilation,
    Study,
    StudyRun,
    User,
    utcnow,
)
from ..core import revision
from ..models.errors import ErrorResponse, api_error
from ..models.platform import (
    InvitationAccept,
    InvitationCreate,
    InvitationCreated,
    MemberBatchUpdate,
    MemberUpsert,
    MemberView,
    OrganizationCreate,
    OrganizationUpdate,
    OrganizationView,
    RESERVED_ORGANIZATION_SLUGS,
)
from ..repositories import organizations as organization_repository
from ..access.dependencies import get_current_user, session_dependency

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


OWNER_ROLE_RESPONSES = {
    403: {
        "model": ErrorResponse,
        "description": (
            "The caller lacks ADMIN access to the organization (code `organization_forbidden`), "
            "or the change grants OWNER or alters or removes an existing owner and the caller "
            "is not an organization owner (code `owner_role_requires_owner`)."
        ),
    }
}


def _touches_owner(current: OrganizationMembership | None, new_role: str | None) -> bool:
    """Whether a membership change grants OWNER or alters an existing owner."""

    return new_role == OrganizationRole.OWNER.value or (
        current is not None and current.role is OrganizationRole.OWNER
    )


def _may_manage_owners(actor_role: OrganizationRole, actor: User) -> bool:
    """Owners, and platform administrators who already hold ADMIN access."""

    return actor_role is OrganizationRole.OWNER or actor.is_admin


def _owner_role_refusal(**detail):
    return api_error(
        status.HTTP_403_FORBIDDEN,
        "owner_role_requires_owner",
        "Only an organization owner may grant the OWNER role or change or remove an owner.",
        **detail,
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
        effective_role=role.value if role else None,
        created_at=organization.created_at,
    )


@router.get("", response_model=list[OrganizationView], operation_id="listOrganizations")
async def list_organizations(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[OrganizationView]:
    organizations = await organization_repository.list_all(session)
    views = [await _org_view(session, organization, user) for organization in organizations]
    return [view for view in views if view.effective_role is not None]


@router.post(
    "",
    response_model=OrganizationView,
    status_code=status.HTTP_201_CREATED,
    operation_id="createOrganization",
    responses={
        409: {"model": ErrorResponse, "description": "`slug_conflict`: the slug is in use."},
        422: {
            "description": "`slug_reserved` (the slug names a page of the application) and request validation errors.",
        },
    },
)
async def create_organization(
    payload: OrganizationCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    if payload.slug in RESERVED_ORGANIZATION_SLUGS:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "slug_reserved",
            f"The slug '{payload.slug}' names a page of the application; choose another.",
        )
    if await organization_by_ref(session, payload.slug) is not None:
        raise api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That organization slug is in use.")
    parent = await session.get(Organization, payload.parent_id) if payload.parent_id else None
    if payload.parent_id and parent is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Parent organization not found.")
    if parent is not None:
        await require_role(session, parent, user, OrganizationRole.ADMIN)
    organization = Organization(
        parent_id=parent.id if parent else None,
        slug=payload.slug,
        name=payload.name,
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


@router.get(
    "/{org}", response_model=OrganizationView, operation_id="getOrganization", responses=revision.ETAG_RESPONSE
)
async def get_organization(
    org: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.VIEWER)
    revision.set_etag(response, organization)
    return await _org_view(session, organization, user)


@router.patch(
    "/{org}",
    response_model=OrganizationView,
    operation_id="updateOrganization",
    responses={
        **revision.EDIT_RESPONSES,
        422: {"description": "`ambiguous_parent` and request validation errors."},
    },
)
async def update_organization(
    org: str,
    payload: OrganizationUpdate,
    response: Response,
    if_match: str | None = revision.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.ADMIN)
    # The target parent is an authorisation question too, so it is settled
    # before the revision is checked; validation comes after it.
    new_parent = None
    if payload.parent_id is not None and not payload.move_to_root:
        new_parent = await session.get(Organization, payload.parent_id)
        if new_parent is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "New parent not found.")
        await require_role(session, new_parent, user, OrganizationRole.ADMIN)
    await revision.guard(session, organization, if_match)
    if payload.name is not None:
        organization.name = payload.name
    if payload.move_to_root and payload.parent_id is not None:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "ambiguous_parent", "Choose a parent or root, not both.")
    if payload.move_to_root or payload.parent_id is not None:
        new_parent_id = None if payload.move_to_root else payload.parent_id
        await assert_acyclic_move(session, organization.id, new_parent_id)
        organization.parent_id = new_parent_id
    _audit(session, user, "organization.updated", organization, organization.id)
    await session.flush()
    await session.refresh(organization, ["updated_at"])
    revision.set_etag(response, organization)
    return await _org_view(session, organization, user)


@router.delete(
    "/{org}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteOrganization",
    responses={
        409: {
            "model": ErrorResponse,
            "description": "`historical_references`: the organization or one below it has runs or study runs.",
        },
    },
)
async def delete_organization(
    org: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Delete an organization and every organization below it, in one transaction.

    Runs and study runs are history, so a subtree that holds any is refused. Otherwise its studies,
    problems (revisions and compilations), blob rows, invitations, memberships and audit events go.
    Stored files are not unlinked here: they are content addressed and shared (D14).

    The subtree's studies, problems and organizations are locked before the history check, in the order
    concurrent writers take them (a study-run start locks its study, a revision upload its problem, and every
    insert into an organization takes a key-share lock on its row): a writer that got there first commits
    before the check sees the subtree, and a later one waits for the delete. A foreign key that still catches
    a concurrent write is answered with the same 409.
    """
    organization = await _required_org(session, org)
    if not user.is_admin:
        await require_role(session, organization, user, OrganizationRole.ADMIN)

    descendants = await descendant_ids(session, organization.id)
    unique_descendants = list(dict.fromkeys(descendants))
    for model, column in ((Study, Study.organization_id), (BindingCase, BindingCase.organization_id),
                          (Organization, Organization.id)):
        await session.execute(
            select(model.id).where(column.in_(unique_descendants)).order_by(model.id).with_for_update()
        )
    # Runs and study runs are history: an organization that has any is kept.
    if await session.scalar(select(Job.id).where(Job.organization_id.in_(unique_descendants)).limit(1)) or await session.scalar(
        select(StudyRun.id).join(Study, Study.id == StudyRun.study_id)
        .where(Study.organization_id.in_(unique_descendants)).limit(1)
    ):
        raise _historical_references()
    try:
        await _delete_subtree(session, organization, unique_descendants)
    except IntegrityError as exc:
        raise _historical_references() from exc


def _historical_references() -> HTTPException:
    return api_error(409, "historical_references", "Organizations with runs or study runs cannot be deleted; their history is kept.")


async def _delete_subtree(session: AsyncSession, organization: Organization, unique_descendants: list[uuid.UUID]) -> None:
    for oid in unique_descendants:
        await session.execute(
            delete(OrganizationMembership).where(OrganizationMembership.organization_id == oid)
        )
        await session.execute(
            delete(OrganizationInvitation).where(OrganizationInvitation.organization_id == oid)
        )
        await session.execute(
            delete(AuditEvent).where(AuditEvent.organization_id == oid)
        )
        await session.execute(delete(Study).where(Study.organization_id == oid))
        cases = select(BindingCase.id).where(BindingCase.organization_id == oid)
        revisions = select(BindingCaseRevision.id).where(BindingCaseRevision.binding_case_id.in_(cases))
        await session.execute(delete(ProblemCompilation).where(ProblemCompilation.revision_id.in_(revisions)))
        await session.execute(delete(BindingCaseRevision).where(BindingCaseRevision.binding_case_id.in_(cases)))
        await session.execute(delete(BindingCase).where(BindingCase.organization_id == oid))
        await session.execute(
            delete(Blob).where(Blob.organization_id == oid)
        )

    descendant_ids_only = [oid for oid in reversed(unique_descendants) if oid != organization.id]
    for oid in descendant_ids_only:
        child = await session.get(Organization, oid)
        if child is not None:
            await session.delete(child)

    await session.flush()
    await session.delete(organization)
    await session.flush()


@router.get("/{org}/audit", operation_id="listOrganizationAuditEvents")
async def list_organization_audit_events(
    org: str,
    action: str | None = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.ADMIN)
    total = await organization_repository.count_audit_events(session, organization.id, action=action)
    rows = await organization_repository.list_audit_events(
        session, organization.id, action=action, offset=offset, limit=limit
    )
    return {
        "events": [
            {
                "id": str(item.id),
                "organizationId": str(item.organization_id) if item.organization_id else None,
                "actorId": str(item.actor_id) if item.actor_id else None,
                "action": item.action,
                "targetType": item.target_type,
                "targetId": str(item.target_id) if item.target_id else None,
                "detail": item.detail,
                "createdAt": item.created_at.isoformat(),
            }
            for item in rows
        ],
        "total": total,
        "offset": offset,
        "limit": limit,
    }



async def _member_views(
    session: AsyncSession, organization: Organization
) -> list[MemberView]:
    rows = await organization_repository.list_members(session, organization.id)
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
    responses=OWNER_ROLE_RESPONSES,
)
async def update_members_batch(
    org: str,
    payload: MemberBatchUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[MemberView]:
    """Apply a staged set of direct-member changes in one transaction."""

    organization = await _required_org(session, org)
    actor_role = await require_role(session, organization, user, OrganizationRole.ADMIN)

    # Serialize the member batches of this organization and lock the direct
    # membership rows that this batch will replace.
    await session.execute(select(Organization.id).where(Organization.id == organization.id).with_for_update())
    existing_rows = await organization_repository.lock_members(session, organization.id)
    existing = {row.user_id: row for row in existing_rows}
    final_roles = {member_id: row.role for member_id, row in existing.items()}

    # The batch is all-or-nothing: nothing is written until every change has
    # passed, so one change touching an owner refuses the whole batch.
    for index, change in enumerate(payload.changes):
        current = existing.get(change.user_id)
        if _touches_owner(current, change.role) and not _may_manage_owners(actor_role, user):
            raise _owner_role_refusal(index=index, user_id=str(change.user_id))

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


@router.put(
    "/{org}/members/{member_id}",
    response_model=MemberView,
    operation_id="upsertOrganizationMember",
    responses=OWNER_ROLE_RESPONSES,
)
async def upsert_member(
    org: str,
    member_id: uuid.UUID,
    payload: MemberUpsert,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> MemberView:
    organization = await _required_org(session, org)
    actor_role = await require_role(session, organization, user, OrganizationRole.ADMIN)
    if payload.user_id != member_id:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "member_mismatch", "Path and payload user differ.")
    member_user = await session.get(User, member_id)
    if member_user is None or not member_user.is_active:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "User not found.")
    existing = await organization_repository.get_membership(session, organization.id, member_id)
    if _touches_owner(existing, payload.role) and not _may_manage_owners(actor_role, user):
        raise _owner_role_refusal(user_id=str(member_id))
    if existing is None:
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
    if await organization_repository.count_owners(session, membership.organization_id) <= 1:
        raise api_error(status.HTTP_409_CONFLICT, "last_owner", "The last owner cannot be removed.")


@router.delete(
    "/{org}/members/{member_id}",
    status_code=204,
    operation_id="removeOrganizationMember",
    responses=OWNER_ROLE_RESPONSES,
)
async def remove_member(
    org: str,
    member_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    organization = await _required_org(session, org)
    actor_role = await require_role(session, organization, user, OrganizationRole.ADMIN)
    membership = await organization_repository.get_membership(session, organization.id, member_id)
    if membership is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Member not found.")
    if _touches_owner(membership, None) and not _may_manage_owners(actor_role, user):
        raise _owner_role_refusal(user_id=str(member_id))
    await _protect_last_owner(session, membership)
    await session.delete(membership)
    _audit(session, user, "organization.member.removed", membership, organization.id)


@router.post(
    "/{org}/invitations", response_model=InvitationCreated,
    status_code=201, operation_id="inviteOrganizationMember",
    responses=OWNER_ROLE_RESPONSES,
)
async def invite_member(
    org: str,
    payload: InvitationCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> InvitationCreated:
    organization = await _required_org(session, org)
    actor_role = await require_role(session, organization, user, OrganizationRole.ADMIN)
    if _touches_owner(None, payload.role) and not _may_manage_owners(actor_role, user):
        raise _owner_role_refusal()
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
    invitation = await organization_repository.find_invitation_by_prefix(session, prefix)
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
    membership = await organization_repository.get_membership(session, organization.id, user.id)
    if membership is None:
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

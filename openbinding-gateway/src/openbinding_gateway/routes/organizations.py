"""Organization trees, members and invitations. Problems are ``modules.problems``.

The profile, public, hierarchy, invitation-code and ownership routes are adapted from SPHERE (SCORELabUS/SPHERE,
MIT licence, revision 73779a8a), ``api/src/main/services/OrganizationService.ts`` (``indexPublicRoots``,
``getHierarchy``, ``createInvitation``, ``previewInvitation``, ``joinViaInvitation``, ``inviteUsersToOrganization``,
``transferOwnership``, ``removeMember``) and ``api/src/main/routes/OrganizationRoutes.ts``, with OpenBinding's
rules: one transaction instead of SPHERE's undo list, 404 for whoever cannot read an organization, and a public
profile only for an organization with a public composition.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
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
    Composition,
    CompositionDerivation,
    CompositionEvaluation,
    CompositionFollow,
    CompositionVersion,
    Job,
    Organization,
    OrganizationInvitationCode,
    OrganizationMembership,
    OrganizationRole,
    ProblemCompilation,
    ProblemValueOrigin,
    OrgConnection,
    PricingSnapshot,
    RunPreset,
    Study,
    StudyRun,
    User,
    utcnow,
)
from ..core import revision
from ..models.errors import ErrorResponse, api_error
from ..models.platform import (
    AvatarSelection,
    CodeInvitationCreate,
    CodeInvitationView,
    InvitationPreview,
    InviteUsers,
    OwnerTransfer,
    UserRef,
    HierarchyNode,
    OrganizationRef,
    PublicOrganizationList,
    PublicOrganizationView,
    MemberBatchUpdate,
    MemberUpsert,
    MemberView,
    OrganizationCreate,
    OrganizationUpdate,
    OrganizationView,
    RESERVED_ORGANIZATION_SLUGS,
)
from ..repositories import organizations as organization_repository
from ..access.dependencies import get_current_user, get_reader, session_dependency
from ..access.work_limits import charge_anonymous_read
from ..modules.shared.application import ORGANIZATION_INVITATION, SYSTEM, notify, put_row, read_verified, write_file
from ..services import organizations as profiles

router = APIRouter(prefix="/v1/organizations", tags=["Organizations"])
invitation_router = APIRouter(prefix="/v1/invitations", tags=["Organizations"])
#: The predefined avatars, open to anybody (an ``<img>`` sends no credential).
avatar_router = APIRouter(prefix="/v1/avatars", tags=["Organizations"])
#: The routes anybody reads answer by credential, so caches key on it.
_VARY = "Authorization, X-API-Key"


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


OWNER_SEAT_RESPONSES = {
    409: {
        "model": ErrorResponse,
        "description": (
            "The change names the owner (code `owner_transfer_required`): an organization has one owner, and the seat "
            "moves only by `PUT .../owner`."
        ),
    }
}


def _owner_seat_refusal(**detail):
    return api_error(
        status.HTTP_409_CONFLICT,
        "owner_transfer_required",
        "The owner's seat moves only by a transfer (PUT .../owner).",
        **detail,
    )


async def _required_org(session: AsyncSession, reference: str) -> Organization:
    organization = await organization_by_ref(session, reference)
    if organization is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    return organization


def _profile_view(organization: Organization, role: OrganizationRole | None, stats=None) -> OrganizationView:
    return OrganizationView(
        id=organization.id,
        slug=organization.slug,
        name=organization.name,
        description=organization.description or "",
        avatar=profiles.avatar_view(organization),
        parent_id=organization.parent_id,
        effective_role=role.value if role else None,
        stats=stats,
        created_at=organization.created_at,
    )


async def _org_view(session: AsyncSession, organization: Organization, user: User) -> OrganizationView:
    role = await effective_role(session, organization.id, user)
    counted = await profiles.stats(session, [organization.id])
    return _profile_view(organization, role, counted[organization.id])


def _ref(organization: Organization | None) -> OrganizationRef | None:
    return OrganizationRef(id=organization.id, slug=organization.slug, name=organization.name) if organization else None


@router.get(
    "",
    response_model=list[OrganizationView],
    operation_id="listOrganizations",
    responses={200: {"headers": {"X-Total-Count": {
        "description": "How many organizations (with `tree=true`, top-level nodes) there are in all.",
        "schema": {"type": "integer"},
    }}}},
)
async def list_organizations(
    response: Response,
    tree: bool = Query(
        default=False,
        description="Nest the organizations: the top-level nodes of the caller's tree, each with its `children` "
        "and the `role_source` of its role, as SPHERE's `/users/me/orgs`.",
    ),
    limit: int | None = Query(default=None, ge=1, le=200, description="At most this many (top-level) nodes."),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[OrganizationView]:
    """The organizations the caller holds a role in, directly or through an ancestor, by name; ``tree=true``
    nests them under the organizations the caller reaches first."""
    placed = await profiles.caller_tree(session, user.id)
    counted = await profiles.stats(session, list(placed))
    by_name = sorted(placed.values(), key=lambda node: (node.organization.name.casefold(), node.organization.slug))

    def view(node: profiles.Placed, nested: bool) -> OrganizationView:
        built = _profile_view(node.organization, node.role, counted[node.organization.id])
        built.role_source = _ref(node.source)
        if nested:
            built.children = [
                view(child, True) for child in by_name if child.organization.parent_id == node.organization.id
            ]
        return built

    chosen = [node for node in by_name if not tree or node.organization.parent_id not in placed]
    response.headers["X-Total-Count"] = str(len(chosen))
    page = chosen[offset:offset + limit if limit is not None else None]
    return [view(node, tree) for node in page]


@router.get(
    "/public",
    response_model=PublicOrganizationList,
    operation_id="listPublicOrganizations",
    dependencies=[Depends(charge_anonymous_read)],
)
async def list_public_organizations(
    response: Response,
    q: str | None = Query(default=None, max_length=100, description="Text in the slug, the name or the description."),
    limit: int = Query(default=12, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> PublicOrganizationList:
    """The root organizations that publish at least one composition, by name; anybody reads them.

    SPHERE lists every root organization (``GET /orgs/public``); OpenBinding shows an organization to
    non-members only once it has a public composition (Q8), so no other organization appears here.
    """
    rows, total = await profiles.public_roots(session, q=(q or "").strip() or None, limit=limit, offset=offset)
    response.headers["Vary"] = _VARY
    response.headers["Cache-Control"] = "private, no-cache"
    return PublicOrganizationList(items=[_public_view(row, count) for row, count in rows], total=total)


def _public_view(organization: Organization, count: int) -> PublicOrganizationView:
    return PublicOrganizationView(
        id=organization.id, slug=organization.slug, name=organization.name,
        description=organization.description or "", avatar=profiles.avatar_view(organization),
        public_compositions=count,
    )


@router.post(
    "",
    response_model=OrganizationView,
    status_code=status.HTTP_201_CREATED,
    operation_id="createOrganization",
    responses={
        409: {"model": ErrorResponse, "description": "`slug_conflict`: the slug is in use."},
        422: {
            "description": "`slug_reserved` (the slug names a page of the application), `slug_underivable` (no "
            "slug given, and the name yields fewer than three letters or digits) and request validation errors.",
        },
    },
)
async def create_organization(
    payload: OrganizationCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    """Create an organization, its caller its OWNER. Without a slug, one is derived from the name and made
    unique with a numeric suffix (SPHERE's ``deduplicateSlug``); a derived slug is never a reserved one."""
    slug = payload.slug
    if slug is None:
        slug = await profiles.derived_slug(session, payload.name)
        if slug is None:
            raise api_error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "slug_underivable",
                "The name must yield a slug of at least three letters or digits; give a slug instead.",
            )
    elif slug in RESERVED_ORGANIZATION_SLUGS:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "slug_reserved",
            f"The slug '{slug}' names a page of the application; choose another.",
        )
    elif await organization_by_ref(session, slug) is not None:
        raise api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That organization slug is in use.")
    parent = await session.get(Organization, payload.parent_id) if payload.parent_id else None
    if payload.parent_id and parent is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Parent organization not found.")
    if parent is not None:
        await require_role(session, parent, user, OrganizationRole.ADMIN)
    organization = Organization(
        parent_id=parent.id if parent else None,
        slug=slug,
        name=payload.name,
        description=payload.description,
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


@router.get(
    "/{org}/profile",
    response_model=PublicOrganizationView,
    operation_id="getOrganizationProfile",
    dependencies=[Depends(charge_anonymous_read)],
    responses={404: {"model": ErrorResponse, "description": "No such organization, or it shows nothing to the caller."}},
)
async def get_organization_profile(
    org: str,
    response: Response,
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> PublicOrganizationView:
    """An organization's public profile: who it is, its avatar and description, and how many compositions it
    publishes. Anybody reads the profile of an organization with a public composition (Q8); its members read
    it always. Any other caller gets the 404 of a missing organization."""
    organization = await organization_by_ref(session, org)
    count = await profiles.public_composition_count(session, organization.id) if organization else 0
    member = organization is not None and user is not None and await effective_role(session, organization.id, user)
    if organization is None or (count == 0 and not member):
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    response.headers["Vary"] = _VARY
    response.headers["Cache-Control"] = "private, no-cache"
    return _public_view(organization, count)


@router.get(
    "/{org}/hierarchy",
    response_model=list[HierarchyNode],
    operation_id="getOrganizationHierarchy",
    responses={404: {"model": ErrorResponse, "description": "No such organization, or the caller is not a member of it."}},
)
async def get_organization_hierarchy(
    org: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[HierarchyNode]:
    """The whole branch the organization sits in (its root, and everything below the root), flat and by name,
    each node saying whether the caller opens it, as SPHERE's ``GET /orgs/{id}/hierarchy``. For its members
    only: anybody else gets 404."""
    organization, _ = await _readable_org(session, org, user)
    nodes = await profiles.branch(session, organization, user.id)
    return [
        HierarchyNode(
            id=node.organization.id, slug=node.organization.slug, name=node.organization.name,
            avatar=profiles.avatar_view(node.organization), parent_id=node.organization.parent_id,
            has_access=node.role is not None, effective_role=node.role.value if node.role else None,
        )
        for node in sorted(nodes.values(), key=lambda node: (node.organization.name.casefold(), node.organization.slug))
    ]


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
    if payload.description is not None:
        organization.description = payload.description
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


async def _readable_org(
    session: AsyncSession, reference: str, user: User, minimum: OrganizationRole = OrganizationRole.VIEWER,
) -> tuple[Organization, OrganizationRole]:
    """The organization ``reference`` for a caller who holds ``minimum`` there.

    404 ``not_found`` when it does not exist **or the caller holds no role in it or above it**, so a
    non-member learns nothing of it; 403 ``organization_forbidden`` for a member whose role is too weak.
    """
    organization = await organization_by_ref(session, reference)
    role = await effective_role(session, organization.id, user) if organization is not None else None
    if organization is None or role is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    return organization, await require_role(session, organization, user, minimum)


_MANAGE_RESPONSES = {
    404: {"model": ErrorResponse, "description": "No such organization, or the caller is not a member of it."},
    403: {"model": ErrorResponse, "description": "The caller is a member without ADMIN (`organization_forbidden`)."},
}


async def _avatar_changed(
    session: AsyncSession, organization: Organization, user: User, response: Response, **detail,
) -> OrganizationView:
    _audit(session, user, "organization.avatar.updated", organization, organization.id, **detail)
    await session.flush()
    await session.refresh(organization, ["updated_at"])
    revision.set_etag(response, organization)
    return await _org_view(session, organization, user)


_AVATAR_BODY = {
    "requestBody": {
        "required": True,
        "description": "The image itself as the raw request body: PNG, JPEG or WebP, at most 2 MiB.",
        "content": {media: {"schema": {"type": "string", "format": "binary"}} for media in profiles.AVATAR_MEDIA_TYPES},
    }
}


@router.post(
    "/{org}/avatar",
    response_model=OrganizationView,
    operation_id="uploadOrganizationAvatar",
    openapi_extra=_AVATAR_BODY,
    responses={
        **revision.EDIT_RESPONSES,
        **_MANAGE_RESPONSES,
        413: {"model": ErrorResponse, "description": "`avatar_too_large`: the image is over 2 MiB."},
        415: {"model": ErrorResponse, "description": "`avatar_unsupported`: the body is not a PNG, JPEG or WebP image."},
    },
)
async def upload_organization_avatar(
    org: str,
    request: Request,
    response: Response,
    if_match: str | None = revision.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    """Set an uploaded image as the organization's avatar (ADMIN), keeping its colours.

    The image is the raw body (no multipart). Its type is read from its bytes, never from the request's
    ``Content-Type``, and only PNG, JPEG and WebP are kept, so an upload is only ever served as an image. It
    is stored once per content as a blob of the organization; the previous upload's file is never deleted on
    the request path (D14).
    """
    organization, _ = await _readable_org(session, org, user, OrganizationRole.ADMIN)
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > profiles.MAX_AVATAR_BYTES:
            raise api_error(413, "avatar_too_large", "The avatar must be at most 2 MiB.")
    media_type = profiles.sniff_image(bytes(data))
    if media_type is None:
        raise api_error(415, "avatar_unsupported", "The avatar must be a PNG, JPEG or WebP image.")
    await revision.guard(session, organization, if_match)
    stored = write_file(bytes(data))
    await put_row(session, organization.id, stored, media_type, user.id)
    organization.avatar = stored.digest
    return await _avatar_changed(session, organization, user, response, kind="upload")


@router.put(
    "/{org}/avatar-colors",
    response_model=OrganizationView,
    operation_id="selectOrganizationAvatar",
    responses={
        **revision.EDIT_RESPONSES,
        **_MANAGE_RESPONSES,
        422: {"description": "`avatar_unknown` (not one of the predefined avatars) and request validation errors."},
    },
)
async def select_organization_avatar(
    org: str,
    payload: AvatarSelection,
    response: Response,
    if_match: str | None = revision.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    """Choose a predefined avatar, or none (the initials), and the colours it is drawn with (ADMIN).

    As SPHERE's ``updateAvatarColors``: a colour left out is SPHERE's default. ``avatar`` left out keeps the
    current image, an upload too, so the colours change alone.
    """
    organization, _ = await _readable_org(session, org, user, OrganizationRole.ADMIN)
    choosing = "avatar" in payload.model_fields_set
    if choosing and not profiles.is_selectable_avatar(payload.avatar):
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "avatar_unknown", "The avatar must be one of the predefined avatars.",
        )
    await revision.guard(session, organization, if_match)
    if choosing:
        organization.avatar = payload.avatar
    organization.avatar_bg_color = payload.bg_color or profiles.DEFAULT_AVATAR_BG_COLOR
    organization.avatar_fg_color = payload.fg_color or profiles.DEFAULT_AVATAR_FG_COLOR
    return await _avatar_changed(session, organization, user, response, kind="predefined" if choosing else "colors")


@router.delete(
    "/{org}/avatar",
    response_model=OrganizationView,
    operation_id="removeOrganizationAvatar",
    responses={**revision.EDIT_RESPONSES, **_MANAGE_RESPONSES},
)
async def remove_organization_avatar(
    org: str,
    response: Response,
    if_match: str | None = revision.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    """Clear the image and its colours, leaving the initials (ADMIN), as SPHERE's ``removeAvatar``."""
    organization, _ = await _readable_org(session, org, user, OrganizationRole.ADMIN)
    await revision.guard(session, organization, if_match)
    organization.avatar = None
    organization.avatar_bg_color = None
    organization.avatar_fg_color = None
    return await _avatar_changed(session, organization, user, response, kind="removed")


_IMAGE_RESPONSE = {
    200: {
        "description": "The image.",
        "content": {media: {"schema": {"type": "string", "format": "binary"}} for media in profiles.AVATAR_MEDIA_TYPES},
    },
    404: {"model": ErrorResponse, "description": "No such organization, or the digest is not its current avatar."},
}
#: An avatar is served to anybody holding its URL (an ``<img>`` sends no credential), and never sniffed or run.
_IMAGE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
}


@router.get(
    "/{org}/avatar/{digest}",
    operation_id="getOrganizationAvatar",
    response_class=Response,
    responses=_IMAGE_RESPONSE,
)
async def get_organization_avatar(
    org: uuid.UUID,
    digest: str,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    """An organization's uploaded avatar, by the organization's id and the image's digest (64 hex characters).

    Anybody holding the URL reads it, as SPHERE serves avatars from its static folder: the URL is in the
    organization's views, and names both the organization's id and the content. Any other digest, an image no
    longer current included, answers 404 as a missing organization does.
    """
    organization = await session.get(Organization, org)
    blob = await profiles.uploaded_avatar(session, organization, digest) if organization is not None else None
    if blob is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Avatar not found.")
    return Response(
        read_verified(blob), media_type=blob.media_type,
        headers={**_IMAGE_HEADERS, "Cache-Control": "private, max-age=31536000, immutable"},
    )


@avatar_router.get("", response_model=list[str], operation_id="listDefaultAvatars")
async def list_default_avatars() -> list[str]:
    """The predefined avatars' file names, the ones ``PUT /v1/organizations/{org}/avatar-colors`` accepts."""
    return list(profiles.DEFAULT_AVATAR_FILES)


@avatar_router.get(
    "/{name}",
    operation_id="getDefaultAvatar",
    response_class=FileResponse,
    responses={
        200: {"description": "The SVG, drawn in `currentColor`.", "content": {"image/svg+xml": {"schema": {"type": "string"}}}},
        404: {"model": ErrorResponse, "description": "Not a predefined avatar."},
    },
)
async def get_default_avatar(name: str) -> FileResponse:
    """A predefined avatar (SPHERE's ``static/avatars/users/default``), open to anybody."""
    if name not in profiles.DEFAULT_AVATAR_FILES:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Avatar not found.")
    return FileResponse(
        profiles.DEFAULT_AVATAR_DIRECTORY / name, media_type="image/svg+xml",
        headers={**_IMAGE_HEADERS, "Cache-Control": "public, max-age=86400"},
    )


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

    Runs and study runs are history, so a subtree that holds any is refused. Otherwise its studies, run
    presets, compositions (their versions and evaluations first), problems (revisions and compilations), blob rows,
    invitations, memberships and audit events go. A version's evidence names a run of the subtree, so a
    subtree that reaches the delete has none to name. Stored files are not unlinked here: they are content addressed and shared (D14).

    The subtree's studies, compositions, problems and organizations are locked before the history check, in
    the order concurrent writers take them (a study-run start locks its study, a revision upload its problem,
    and every insert into an organization takes a key-share lock on its row). Compositions come before
    problems because a composition write that reads a problem locks the composition first. A writer that got
    there first commits before the check sees the subtree, and a later one waits for the delete. A foreign key
    that still catches a concurrent write is answered with the same 409.
    """
    organization = await _required_org(session, org)
    if not user.is_admin:
        await require_role(session, organization, user, OrganizationRole.ADMIN)

    descendants = await descendant_ids(session, organization.id)
    unique_descendants = list(dict.fromkeys(descendants))
    for model, column in ((Study, Study.organization_id), (Composition, Composition.organization_id),
                          (BindingCase, BindingCase.organization_id), (Organization, Organization.id)):
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
            delete(OrganizationInvitationCode).where(OrganizationInvitationCode.organization_id == oid)
        )
        await session.execute(
            delete(AuditEvent).where(AuditEvent.organization_id == oid)
        )
        await session.execute(delete(Study).where(Study.organization_id == oid))
        # Run presets: no run or history refers to one, a run copies the settings it expands.
        await session.execute(delete(RunPreset).where(RunPreset.organization_id == oid))
        held = select(Composition.id).where(Composition.organization_id == oid)
        await session.execute(delete(CompositionFollow).where(CompositionFollow.composition_id.in_(held)))
        versions = select(CompositionVersion.id).where(CompositionVersion.composition_id.in_(held))
        await session.execute(delete(CompositionDerivation).where(CompositionDerivation.version_id.in_(versions)))
        await session.execute(delete(CompositionEvaluation).where(CompositionEvaluation.version_id.in_(versions)))
        await session.execute(delete(CompositionVersion).where(CompositionVersion.composition_id.in_(held)))
        await session.execute(delete(Composition).where(Composition.organization_id == oid))
        cases = select(BindingCase.id).where(BindingCase.organization_id == oid)
        revisions = select(BindingCaseRevision.id).where(BindingCaseRevision.binding_case_id.in_(cases))
        await session.execute(delete(ProblemValueOrigin).where(ProblemValueOrigin.revision_id.in_(revisions)))
        await session.execute(delete(ProblemCompilation).where(ProblemCompilation.revision_id.in_(revisions)))
        await session.execute(delete(BindingCaseRevision).where(BindingCaseRevision.binding_case_id.in_(cases)))
        await session.execute(delete(BindingCase).where(BindingCase.organization_id == oid))
        # The organization's own pricing snapshots (private SPHERE versions, URLs), once nothing above refers to
        # them; shared (public, registry) snapshots are never deleted. Their bytes follow the blob store's rule.
        await session.execute(delete(PricingSnapshot).where(PricingSnapshot.organization_id == oid))
        # Its connections: the encrypted key goes with the organization (its audit trail went above).
        await session.execute(delete(OrgConnection).where(OrgConnection.organization_id == oid))
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
    responses=OWNER_SEAT_RESPONSES,
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
        if current is not None and current.role is OrganizationRole.OWNER:
            raise _owner_seat_refusal(index=index, user_id=str(change.user_id))

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
    responses=OWNER_SEAT_RESPONSES,
)
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
    existing = await organization_repository.get_membership(session, organization.id, member_id)
    if existing is not None and existing.role is OrganizationRole.OWNER:
        raise _owner_seat_refusal(user_id=str(member_id))
    if existing is None:
        existing = OrganizationMembership(organization_id=organization.id, user_id=member_id)
        session.add(existing)
    existing.role = OrganizationRole(payload.role)
    await session.flush()
    _audit(session, user, "organization.member.upserted", existing, organization.id, role=payload.role)
    return MemberView(
        id=existing.id, organization_id=existing.organization_id, user_id=existing.user_id,
        username=member_user.username, email=member_user.email,
        role=existing.role.value, created_at=existing.created_at,
    )


@router.delete(
    "/{org}/members/{member_id}",
    status_code=204,
    operation_id="removeOrganizationMember",
    responses={
        **OWNER_SEAT_RESPONSES,
        404: {"model": ErrorResponse, "description": "No such member, or a caller leaving is not a member."},
    },
)
async def remove_member(
    org: str,
    member_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Remove a direct member (ADMIN), or leave: any member but an owner removes themselves, as in SPHERE.

    An owner hands the organization over first (``PUT .../owner``); a caller who is not a member gets 404.
    """
    if member_id == user.id:
        organization, _ = await _readable_org(session, org, user)
        own = await organization_repository.get_membership(session, organization.id, user.id)
        if own is not None and own.role is not OrganizationRole.OWNER:
            await session.delete(own)
            _audit(session, user, "organization.member.left", own, organization.id, role=own.role.value)
            return
    organization = await _required_org(session, org)
    await require_role(session, organization, user, OrganizationRole.ADMIN)
    membership = await organization_repository.get_membership(session, organization.id, member_id)
    if membership is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Member not found.")
    if membership.role is OrganizationRole.OWNER:
        raise _owner_seat_refusal(user_id=str(member_id))
    await session.delete(membership)
    _audit(session, user, "organization.member.removed", membership, organization.id)


def _code_view(invitation: OrganizationInvitationCode, creator: User | None) -> CodeInvitationView:
    return CodeInvitationView(
        id=invitation.id, organization_id=invitation.organization_id, code=invitation.code,
        created_by=_user_ref(creator), expires_at=invitation.expires_at, max_uses=invitation.max_uses,
        use_count=invitation.use_count, created_at=invitation.created_at,
    )


def _user_ref(user: User | None) -> UserRef | None:
    return UserRef(id=user.id, username=user.username) if user is not None else None


async def _new_code(
    session: AsyncSession, organization: Organization, user: User, *, expires_in_days: int | None, max_uses: int | None,
) -> OrganizationInvitationCode:
    invitation = OrganizationInvitationCode(
        organization_id=organization.id,
        code=secrets.token_hex(8),
        created_by_id=user.id,
        expires_at=utcnow() + timedelta(days=expires_in_days) if expires_in_days else None,
        max_uses=max_uses,
        use_count=0,
    )
    session.add(invitation)
    await session.flush()
    await session.refresh(invitation, ["created_at"])
    _audit(session, user, "organization.invitation_code.created", invitation, organization.id, max_uses=max_uses)
    return invitation


@router.get(
    "/{org}/invitations",
    response_model=list[CodeInvitationView],
    operation_id="listOrganizationInvitations",
    responses=_MANAGE_RESPONSES,
)
async def list_invitations(
    org: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[CodeInvitationView]:
    """The organization's invitation codes, the newest first, used up and expired ones too (ADMIN)."""
    organization, _ = await _readable_org(session, org, user, OrganizationRole.ADMIN)
    rows = (await session.scalars(
        select(OrganizationInvitationCode).where(OrganizationInvitationCode.organization_id == organization.id)
        .order_by(OrganizationInvitationCode.created_at.desc(), OrganizationInvitationCode.id)
    )).all()
    creators = {
        row.id: row for row in (await session.scalars(
            select(User).where(User.id.in_({invitation.created_by_id for invitation in rows}))
        )).all()
    } if rows else {}
    return [_code_view(row, creators.get(row.created_by_id)) for row in rows]


@router.put(
    "/{org}/owner",
    response_model=list[MemberView],
    operation_id="transferOrganizationOwnership",
    responses={
        403: {
            "model": ErrorResponse,
            "description": "`owner_transfer_requires_owner`: the caller is not this organization's owner.",
        },
        404: {"model": ErrorResponse, "description": "No such organization, the caller is not a member of it, or "
              "the recipient is not (code `not_found`)."},
        422: {"description": "`already_owner` (the caller names themselves) and request validation errors."},
    },
)
async def transfer_ownership(
    org: str,
    payload: OwnerTransfer,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[MemberView]:
    """Hand the organization, and everything below it, to another member, as SPHERE's ``transferOwnership``.

    A swap, not a promotion: the recipient takes the owner's seat and every owner seat of the branch (this
    organization and its descendants) steps down to ADMIN, the caller's too, so whoever held one keeps working
    access. Only the owner hands it over (a direct OWNER membership here; a platform administrator has nothing
    to give), and the recipient must already be a member, here or above. One transaction, under the lock of the
    organization's row and of the branch's memberships, so a half handover never shows.
    """
    organization, _ = await _readable_org(session, org, user)
    if payload.user_id == user.id:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "already_owner", "You own this organization already.")
    await session.execute(select(Organization.id).where(Organization.id == organization.id).with_for_update())
    own = await organization_repository.get_membership(session, organization.id, user.id)
    if own is None or own.role is not OrganizationRole.OWNER:
        raise api_error(
            status.HTTP_403_FORBIDDEN, "owner_transfer_requires_owner",
            "Only the owner of the organization can hand it over.",
        )
    recipient = await session.get(User, payload.user_id)
    if (
        recipient is None or not recipient.is_active
        or await effective_role(session, organization.id, recipient) is None
    ):
        raise api_error(
            status.HTTP_404_NOT_FOUND, "not_found", "The new owner must already be a member of the organization.",
        )
    branch = list(dict.fromkeys(await descendant_ids(session, organization.id)))
    rows = (await session.scalars(
        select(OrganizationMembership).where(OrganizationMembership.organization_id.in_(branch))
        .order_by(OrganizationMembership.id).with_for_update()
    )).all()
    stepped_down = []
    for row in rows:
        if row.role is OrganizationRole.OWNER and row.user_id != recipient.id:
            row.role = OrganizationRole.ADMIN
            stepped_down.append(str(row.user_id))
    seat = next(
        (row for row in rows if row.organization_id == organization.id and row.user_id == recipient.id), None,
    )
    if seat is None:
        seat = OrganizationMembership(organization_id=organization.id, user_id=recipient.id)
        session.add(seat)
    seat.role = OrganizationRole.OWNER
    await session.flush()
    _audit(
        session, user, "organization.owner.transferred", organization, organization.id,
        to=str(recipient.id), stepped_down=sorted(set(stepped_down)),
    )
    await notify(
        session, recipient.id, SYSTEM, "You are now an owner",
        f"@{user.username} handed you ownership of \"{organization.name}\"",
        organization_id=str(organization.id), organization_slug=organization.slug, previous_owner_id=str(user.id),
    )
    await session.flush()
    return await _member_views(session, organization)


@router.post(
    "/{org}/invitations", response_model=CodeInvitationView,
    status_code=201, operation_id="createOrganizationInvitation",
    responses={404: _MANAGE_RESPONSES[404]},
)
async def create_invitation(
    org: str,
    payload: CodeInvitationCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CodeInvitationView:
    """A shareable invitation code (ADMIN), as SPHERE's: whoever holds it joins as MEMBER
    (``POST /v1/invitations/{code}/join``); an empty body takes the defaults. A non-member gets 404."""
    organization, _ = await _readable_org(session, org, user, OrganizationRole.ADMIN)
    invitation = await _new_code(
        session, organization, user, expires_in_days=payload.expires_in_days, max_uses=payload.max_uses,
    )
    return _code_view(invitation, user)


@router.post(
    "/{org}/invitations/invite-users",
    response_model=CodeInvitationView,
    status_code=201,
    operation_id="inviteUsersToOrganization",
    responses={
        **_MANAGE_RESPONSES,
        409: {"model": ErrorResponse, "description": "`already_member`: every user named is a member already."},
    },
)
async def invite_users(
    org: str,
    payload: InviteUsers,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CodeInvitationView:
    """Invite named users (ADMIN): one code, valid seven days, with a use for each user who is not a member
    yet, and an ``OrganizationInvitation`` notification to each of them, as SPHERE's ``inviteUsers``. A user
    who is a member already is left out; an unknown or inactive one is 404."""
    organization, _ = await _readable_org(session, org, user, OrganizationRole.ADMIN)
    found = {
        row.id: row for row in (await session.scalars(
            select(User).where(User.id.in_(payload.user_ids), User.is_active.is_(True), User.deleted_at.is_(None))
        )).all()
    }
    missing = sorted(str(user_id) for user_id in payload.user_ids if user_id not in found)
    if missing:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Every invited user must be an active user.", user_ids=missing)
    invited = [found[user_id] for user_id in payload.user_ids if await effective_role(session, organization.id, found[user_id]) is None]
    if not invited:
        raise api_error(status.HTTP_409_CONFLICT, "already_member", "Every user named is a member already.")
    invitation = await _new_code(session, organization, user, expires_in_days=7, max_uses=len(invited))
    for person in invited:
        await notify(
            session, person.id, ORGANIZATION_INVITATION,
            f"You've been invited to join {organization.name}",
            f"@{user.username} has invited you to join \"{organization.name}\". Open the invitation to accept it.",
            invitation_code=invitation.code, organization_id=str(organization.id),
            organization_slug=organization.slug, organization_name=organization.name,
            invited_by=user.username, invited_by_id=str(user.id),
        )
    return _code_view(invitation, user)


@router.delete(
    "/{org}/invitations/{invitation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="revokeOrganizationInvitation",
    responses={**_MANAGE_RESPONSES, 404: {"model": ErrorResponse, "description": "No such organization or invitation, or the caller is not a member."}},
)
async def revoke_invitation(
    org: str,
    invitation_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Revoke an invitation code (ADMIN): it stops working at once."""
    organization, _ = await _readable_org(session, org, user, OrganizationRole.ADMIN)
    invitation = await session.get(OrganizationInvitationCode, invitation_id)
    if invitation is None or invitation.organization_id != organization.id:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Invitation not found.")
    _audit(session, user, "organization.invitation_code.revoked", invitation, organization.id)
    await session.delete(invitation)


async def _usable_code(session: AsyncSession, code: str, *, lock: bool = False) -> OrganizationInvitationCode:
    """The invitation ``code`` while it can still be used; else the one 404 (unknown, expired, used up)."""
    query = select(OrganizationInvitationCode).where(OrganizationInvitationCode.code == code)
    invitation = await session.scalar(query.with_for_update() if lock else query)
    if invitation is not None and invitation.expires_at is not None:
        expires = invitation.expires_at.replace(tzinfo=invitation.expires_at.tzinfo or utcnow().tzinfo)
        if expires <= utcnow():
            invitation = None
    if invitation is not None and invitation.max_uses is not None and invitation.use_count >= invitation.max_uses:
        invitation = None
    if invitation is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Invitation not found, expired or used up.")
    return invitation


@invitation_router.get(
    "/{code}/preview",
    response_model=InvitationPreview,
    operation_id="previewInvitation",
    dependencies=[Depends(charge_anonymous_read)],
    responses={404: {"model": ErrorResponse, "description": "No such code, or it expired or was used up."}},
)
async def preview_invitation(
    code: str,
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> InvitationPreview:
    """What an invitation code joins, for its holder to decide: the organization's identity, avatar and
    description, who invited them and until when. Anybody holding the code reads it."""
    invitation = await _usable_code(session, code)
    organization = await session.get(Organization, invitation.organization_id)
    creator = await session.get(User, invitation.created_by_id)
    count = await profiles.public_composition_count(session, organization.id)
    return InvitationPreview(
        code=invitation.code, organization=_public_view(organization, count),
        expires_at=invitation.expires_at, invited_by=_user_ref(creator),
    )


@invitation_router.post(
    "/{code}/join",
    response_model=OrganizationView,
    operation_id="joinOrganization",
    responses={
        404: {"model": ErrorResponse, "description": "No such code, or it expired or was used up."},
        409: {"model": ErrorResponse, "description": "`already_member`: the caller holds a role there already."},
    },
)
async def join_organization(
    code: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    """Join the organization of an invitation code as MEMBER, using one of its uses, as SPHERE's
    ``joinViaInvitation``. A caller who holds a role there already (directly or above it) gets 409."""
    invitation = await _usable_code(session, code, lock=True)
    organization = await session.get(Organization, invitation.organization_id)
    if await effective_role(session, organization.id, user) is not None:
        raise api_error(status.HTTP_409_CONFLICT, "already_member", "You are a member of this organization already.")
    membership = OrganizationMembership(organization_id=organization.id, user_id=user.id, role=OrganizationRole.MEMBER)
    session.add(membership)
    invitation.use_count += 1
    await session.flush()
    _audit(session, user, "organization.invitation_code.joined", invitation, organization.id)
    return await _org_view(session, organization, user)

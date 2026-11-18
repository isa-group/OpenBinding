"""The plans routes: an organization's connections (``/v1/organizations/{org}/connections``).

Connections are an organization ADMIN's: the key is written, validated by SPHERE and never read back.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, session_dependency
from ....access.work_limits import limit_work
from ....collaboration import organization_by_ref, require_role
from ....core import revision as etags
from ....db.models import Organization, OrganizationRole, User
from ....models.errors import NOT_FOUND_RESPONSE, ErrorResponse, api_error
from ..application import connections
from .schemas import ConnectionList, ConnectionScope, ConnectionView, SphereConnectionUpdate

router = APIRouter(prefix="/v1/organizations/{org}", tags=["Organizations"])

FORBIDDEN_RESPONSE = {"model": ErrorResponse, "description": "The caller is not an ADMIN of the organization."}


async def _organization(session: AsyncSession, org: str, user: User, minimum: OrganizationRole) -> Organization:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    await require_role(session, organization, user, minimum)
    return organization


def _connection(row) -> ConnectionView:
    shown = connections.view(row)
    return ConnectionView(
        kind=shown.kind,  # type: ignore[arg-type]
        status=shown.status,  # type: ignore[arg-type]
        username=shown.username,
        scopes=[ConnectionScope(organization_id=s["organizationId"], scope=s["scope"]) for s in shown.scopes]
        if shown.scopes is not None else None,
        key_hint=shown.key_hint,
        validated_at=etags.normalise(shown.validated_at) if shown.validated_at else None,
        expires_at=shown.expires_at,
    )


@router.get(
    "/connections",
    operation_id="listOrganizationConnections",
    summary="The organization's connections (never their secrets)",
    response_model=ConnectionList,
    responses={403: FORBIDDEN_RESPONSE, 404: NOT_FOUND_RESPONSE},
)
async def list_connections(
    org: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ConnectionList:
    organization = await _organization(session, org, user, OrganizationRole.ADMIN)
    rows = await connections.list_connections(session, organization.id)
    return ConnectionList(connections=[_connection(row) for row in rows])


@router.put(
    "/connections/sphere",
    operation_id="putOrganizationSphereConnection",
    summary="Connect the organization to SPHERE with an API key (write-only)",
    response_model=ConnectionView,
    dependencies=[Depends(limit_work)],
    responses={
        **etags.EDIT_RESPONSES,
        403: FORBIDDEN_RESPONSE,
        404: NOT_FOUND_RESPONSE,
        422: {
            "model": ErrorResponse,
            "description": "The key is malformed (`sphere_key_malformed`) or SPHERE refused it (`sphere_key_rejected`).",
        },
        503: {
            "model": ErrorResponse,
            "description": "No secrets can be kept (`secrets_unavailable`), or SPHERE is busy or unreachable "
            "(`sphere_busy`, `sphere_unavailable`).",
        },
    },
)
async def put_sphere_connection(
    org: str,
    body: SphereConnectionUpdate,
    response: Response,
    if_match: str | None = etags.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ConnectionView:
    organization = await _organization(session, org, user, OrganizationRole.ADMIN)
    row = await connections.put_sphere_key(session, organization.id, body.api_key, user, if_match)
    etags.set_etag(response, row)
    return _connection(row)


@router.delete(
    "/connections/sphere",
    operation_id="deleteOrganizationSphereConnection",
    summary="Remove the organization's SPHERE connection and its key",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={403: FORBIDDEN_RESPONSE, 404: NOT_FOUND_RESPONSE},
)
async def delete_sphere_connection(
    org: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    organization = await _organization(session, org, user, OrganizationRole.ADMIN)
    if not await connections.delete_connection(session, organization.id, user):
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "The organization has no SPHERE connection.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)

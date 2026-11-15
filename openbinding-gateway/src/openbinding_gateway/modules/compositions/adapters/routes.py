"""The compositions of an organization: ``/v1/organizations/{org}/compositions``.

VIEWER reads, MEMBER creates and edits, ADMIN deletes. A composition the caller cannot read answers as a
missing one: 404 for a non-member and for a composition of another organization, never 403. A member
whose role is too weak for a write gets 403 ``organization_forbidden``. Edits take an optional
``If-Match`` (the ``ETag`` of a read or an earlier edit).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, session_dependency
from ....core import revision as etags
from ....db.models import Composition, CompositionKind, Organization, OrganizationRole, User
from ....models.errors import CONFLICT_RESPONSE, NOT_FOUND_RESPONSE
from ..application import compositions
from .schemas import (
    CompositionCreate,
    CompositionKindName,
    CompositionList,
    CompositionOrganization,
    CompositionUpdate,
    CompositionView,
)

router = APIRouter(prefix="/v1/organizations/{org}/compositions", tags=["Compositions"])

_UNREADABLE: dict[int | str, dict[str, Any]] = {
    404: {**NOT_FOUND_RESPONSE, "description": "No such organization or composition, or the caller cannot read it."},
}


def _view(composition: Composition, organization: Organization) -> CompositionView:
    return CompositionView(
        id=composition.id, slug=composition.slug, name=composition.name, description=composition.description,
        kind=composition.kind.value, archived=composition.archived,
        organization=CompositionOrganization(id=organization.id, slug=organization.slug),
        created_by_id=composition.created_by_id, created_at=composition.created_at, updated_at=composition.updated_at,
    )


@router.get("", response_model=CompositionList, operation_id="listCompositions", responses=_UNREADABLE)
async def list_compositions(
    org: str,
    kind: CompositionKindName | None = Query(default=None),
    q: str | None = Query(default=None, max_length=160, description="Text in the name or the slug."),
    archived: bool | None = Query(default=None, description="Only archived (`true`) or only active (`false`) ones."),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionList:
    """The organization's compositions, by name."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    page = await compositions.list_compositions(
        session, organization.id, kind=CompositionKind(kind) if kind else None, q=q, archived=archived,
        limit=limit, offset=offset,
    )
    return CompositionList(
        compositions=[_view(row, organization) for row in page.compositions],
        total=page.total, limit=limit, offset=offset,
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=CompositionView,
    operation_id="createComposition",
    responses={
        201: {"headers": {"ETag": etags.ETAG_HEADER}},
        **_UNREADABLE,
        409: {**CONFLICT_RESPONSE, "description": "The slug is in use in this organization (`slug_conflict`)."},
    },
)
async def create_composition(
    org: str,
    payload: CompositionCreate,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionView:
    """Create an empty composition: no version yet."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    created = await compositions.create_composition(
        session, organization, user, slug=payload.slug, name=payload.name, description=payload.description,
        kind=CompositionKind(payload.kind),
    )
    etags.set_etag(response, created)
    return _view(created, organization)


@router.get(
    "/{composition}",
    response_model=CompositionView,
    operation_id="getComposition",
    responses={**etags.ETAG_RESPONSE, **_UNREADABLE},
)
async def get_composition(
    org: str,
    composition: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionView:
    """One composition, by slug or id."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.VIEWER)
    found = await compositions.required_composition(session, organization, composition)
    etags.set_etag(response, found)
    return _view(found, organization)


@router.patch(
    "/{composition}",
    response_model=CompositionView,
    operation_id="updateComposition",
    responses={**etags.EDIT_RESPONSES, **_UNREADABLE},
)
async def update_composition(
    org: str,
    composition: str,
    payload: CompositionUpdate,
    response: Response,
    if_match: str | None = etags.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionView:
    """Rename, describe, archive or restore a composition."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.MEMBER)
    found = await compositions.required_composition(session, organization, composition)
    await etags.guard(session, found, if_match)
    updated = await compositions.update_composition(
        session, found, user, name=payload.name, description=payload.description, archived=payload.archived,
    )
    etags.set_etag(response, updated)
    return _view(updated, organization)


@router.delete(
    "/{composition}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteComposition",
    responses=_UNREADABLE,
)
async def delete_composition(
    org: str,
    composition: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Delete a composition."""
    organization = await compositions.organization_for(session, org, user, OrganizationRole.ADMIN)
    found = await compositions.required_composition(session, organization, composition)
    await compositions.delete_composition(session, found, user)

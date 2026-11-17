"""The public compositions of every organization: ``GET /v1/compositions``.

What the public list and fork discovery read: every ``public`` composition that is not archived and has a
version, from any organization, the most recently changed first. Anybody reads it, with no credential too; a
credential that names nobody is ``401``, as on the reads of a public composition. Only a visitor is charged,
against the ``read`` class's anonymous budget (``ANONYMOUS_READ_ROUTES``).

An organization's own list (``GET /v1/organizations/{org}/compositions``) stays for its members, so this route
is the only one that lists across organizations, and it names only organizations that published something.
Its views carry no member id and no lineage. The path is outside the problem+json prefix
(``/v1/compositions/``), so it answers in the platform JSON envelope.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, get_reader, session_dependency
from ....access.work_limits import charge_anonymous_read
from ....db.models import CompositionKind, User
from ....models.errors import UNAUTHORIZED_RESPONSE
from ..application import compositions, listing
from .list_query import BY_NAME, BY_UPDATE, ListQuery, facets_view
from .routes import entry_view, figures_of
from .schemas import (
    CompositionKindName,
    CompositionList,
    PublicCompositionList,
    PublicCompositionOrganization,
    PublicCompositionView,
    PublicVersionSummary,
)

router = APIRouter(prefix="/v1/compositions", tags=["Compositions"])
#: The caller's own compositions, across their organizations (``/v1/users/me/*``, as the design's user routes).
me_router = APIRouter(prefix="/v1/users/me/compositions", tags=["Compositions"])

#: The list answers by credential (a visitor is charged, a credential that names nobody is refused), so caches
#: key on it; and it is revalidated each time, so a composition made private again leaves it at once.
_VARY = "Authorization, X-API-Key"


@router.get(
    "",
    response_model=PublicCompositionList,
    operation_id="listPublicCompositions",
    dependencies=[Depends(charge_anonymous_read)],
)
async def list_public_compositions(
    response: Response,
    q: str | None = Query(default=None, max_length=160, description="Text in the name or the slug."),
    kind: CompositionKindName | None = Query(default=None),
    organization: str | None = Query(
        default=None, max_length=64, description="Only the public compositions of this organization (its slug).",
    ),
    query: ListQuery = Depends(BY_UPDATE),
    limit: int = Query(default=24, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> PublicCompositionList:
    """The public compositions of every organization, the most recently changed first (or by name, tasks or
    cost), with the facets of every match; anybody reads them."""
    kinds = (query.kinds or set()) | ({CompositionKind(kind)} if kind else set())
    rows = await compositions.matching(
        session, public_only=True, kinds=kinds or None, q=q, organization_slug=organization or None,
    )
    listed = listing.arrange(
        await listing.gather(session, rows), owners=query.owners, bounds=query.bounds, sort=query.sort,
        order=query.order, limit=limit, offset=offset,
    )
    response.headers["Vary"] = _VARY
    response.headers["Cache-Control"] = "private, no-cache"
    views = []
    for entry in listed.entries:
        summary, version = entry.summary, entry.summary.latest
        views.append(PublicCompositionView(
            organization=PublicCompositionOrganization(slug=entry.organization.slug, name=entry.organization.name),
            slug=entry.composition.slug, name=entry.composition.name, description=entry.composition.description,
            kind=entry.composition.kind.value,
            latest_version=PublicVersionSummary(
                label=version.label, ordinal=version.ordinal, values_status=version.values_status.value,
                verified=summary.verified, created_at=version.created_at, figures=figures_of(entry),
            ),
            version_count=summary.count, updated_at=entry.composition.updated_at,
        ))
    return PublicCompositionList(
        compositions=views, total=listed.total, limit=limit, offset=offset, facets=facets_view(listed.facets),
    )


@me_router.get(
    "",
    response_model=CompositionList,
    operation_id="listOwnCompositions",
    responses={401: UNAUTHORIZED_RESPONSE},
)
async def list_own_compositions(
    q: str | None = Query(default=None, max_length=160, description="Text in the name or the slug."),
    archived: bool | None = Query(default=None, description="Only archived (`true`) or only active (`false`) ones."),
    query: ListQuery = Depends(BY_NAME),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionList:
    """The compositions the caller reads as a member, across every organization they hold a role in (directly or
    through an ancestor), as SPHERE's ``/me/pricings``; ``owners`` narrows them to some of those organizations."""
    organization_ids = await compositions.readable_organization_ids(session, user)
    rows = await compositions.matching(
        session, organization_ids=organization_ids, kinds=query.kinds, q=q, archived=archived,
    ) if organization_ids else []
    listed = listing.arrange(
        await listing.gather(session, rows), owners=query.owners, bounds=query.bounds, sort=query.sort,
        order=query.order, limit=limit, offset=offset,
    )
    return CompositionList(
        compositions=[entry_view(entry) for entry in listed.entries],
        total=listed.total, limit=limit, offset=offset, facets=facets_view(listed.facets),
    )

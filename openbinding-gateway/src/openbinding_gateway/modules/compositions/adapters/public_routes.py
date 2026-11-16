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

from ....access.dependencies import get_reader, session_dependency
from ....access.work_limits import charge_anonymous_read
from ....db.models import CompositionKind, User
from ..application import compositions, versions
from .schemas import (
    CompositionKindName,
    PublicCompositionList,
    PublicCompositionOrganization,
    PublicCompositionView,
    PublicVersionSummary,
)

router = APIRouter(prefix="/v1/compositions", tags=["Compositions"])

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
    limit: int = Query(default=24, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> PublicCompositionList:
    """The public compositions of every organization, the most recently changed first; anybody reads them."""
    page = await compositions.list_public(
        session, kind=CompositionKind(kind) if kind else None, q=q, organization=organization,
        limit=limit, offset=offset,
    )
    found = await versions.summaries(session, [composition.id for composition, _ in page.compositions])
    response.headers["Vary"] = _VARY
    response.headers["Cache-Control"] = "private, no-cache"
    views = []
    for composition, owner in page.compositions:
        summary = found[composition.id]
        version = summary.latest
        if version is None:  # deleted between the two reads: the next page read leaves it out
            continue
        views.append(PublicCompositionView(
            organization=PublicCompositionOrganization(slug=owner.slug, name=owner.name),
            slug=composition.slug, name=composition.name, description=composition.description,
            kind=composition.kind.value,
            latest_version=PublicVersionSummary(
                label=version.label, ordinal=version.ordinal, values_status=version.values_status.value,
                verified=summary.verified, created_at=version.created_at,
            ),
            version_count=summary.count, updated_at=composition.updated_at,
        ))
    return PublicCompositionList(compositions=views, total=page.total, limit=limit, offset=offset)

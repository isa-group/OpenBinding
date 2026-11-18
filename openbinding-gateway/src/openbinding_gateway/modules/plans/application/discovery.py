"""What a member needs before a recipe exists: SPHERE search, a family's versions, one version read and kept.

Discovery goes through the gateway, never from the browser (the CSP is ``connect-src 'self'``, and a browser holds
neither the organization's key nor a registry alias). Facets are SPHERE's whole-result histograms, never computed
from one page.

``resolve_family`` turns the readable label ``owner/name`` into a family (``pricingId``). ``owner/name`` is not a
key in SPHERE (two ``sphere/resend`` families exist) and SPHERE's ``name`` filter is a regex on the display name,
not on the slug, so a family is resolved by organization:

1. stored snapshots first: a snapshot labelled ``owner/slug`` answers with no request, and any snapshot of
   ``owner`` gives the SPHERE organization id;
2. the organization id from ``/orgs/public?q=<owner>`` (an exact name; non-personal organizations only), else
   from discovery rows (for the slug, and the slug with ``-`` and ``_`` read as spaces) whose organization is
   named ``owner`` exactly, at most three pages each;
3. the family from ``/pricings/<organizationId>``, paged (24 a page) until exhausted or 20 pages, rows whose slug
   is ``slug`` exactly: one is the family; several are ``FamilyAmbiguous`` (unless ``version_id`` names a version
   only one of them lists); none is ``PricingNotFound``.

Anonymous resolutions are cached for ``SPHERE_CACHE_TTL_S``; a keyed one is not.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.settings import get_settings
from ....db.models import PricingSnapshot
from ..domain.errors import PricingError
from ..domain.pricing2yaml import summary
from ..domain.sources import (
    Credential,
    Manifest,
    NotModified,
    SearchPage,
    SearchQuery,
    SearchRow,
    SphereEndpoint,
    is_sphere_id,
)
from .pricing_source import PricingNotFound, PricingSource, PricingSourceUnavailable, get_pricing_source
from .snapshots import Snapshotted, normalised, snapshot_version

DISCOVERY_PAGES = 3
FAMILY_PAGES = 20


class FamilyAmbiguous(PricingError):
    """``owner/name`` names several families; ``candidates`` are their ``pricingId``s."""

    def __init__(self, candidates: list[str]) -> None:
        super().__init__(f"{len(candidates)} families share that name")
        self.candidates = candidates


@dataclass(frozen=True)
class SearchResult:
    rows: list[SearchRow]
    total: int
    facets: dict[str, Any]


async def search(
    where: SphereEndpoint,
    query: SearchQuery,
    credential: Credential | None,
    *,
    private_organization: str | None = None,
    source: PricingSource | None = None,
) -> SearchResult:
    """Public discovery, plus a connected scope organization's private list when ``private_organization`` names one
    of the connection's scopes; rows merged by ``pricingId`` (the private row wins)."""
    source = source or get_pricing_source()
    page = await source.search(where, query, None)
    rows: dict[str, SearchRow] = {row.pricing_id: row for row in page.rows}
    total = page.total
    if private_organization is not None and credential is not None:
        listing = await source.organization_pricings(where, private_organization, credential)
        for row in listing.rows:
            if row.private or row.pricing_id not in rows:
                if row.pricing_id not in rows:
                    total += 1
                rows[row.pricing_id] = row
    return SearchResult(list(rows.values()), total, dict(page.facets))


async def manifest(where: SphereEndpoint, pricing_id: str, credential: Credential | None, *,
                   source: PricingSource | None = None) -> Manifest:
    if not is_sphere_id(pricing_id):
        raise PricingNotFound("not a SPHERE pricing id")
    answer = await (source or get_pricing_source()).manifest(where, pricing_id, credential)
    if isinstance(answer, NotModified):  # pragma: no cover - no condition was sent
        raise PricingSourceUnavailable("unavailable")
    return answer


@dataclass(frozen=True)
class VersionView:
    taken: Snapshotted
    summary: dict[str, Any]
    diagnostics: list[dict[str, Any]]


async def version_view(
    session: AsyncSession,
    organization_id: uuid.UUID,
    where: SphereEndpoint,
    pricing_id: str,
    version_id: str,
    credential: Credential | None,
    *,
    actor_id: uuid.UUID | None,
    source: PricingSource | None = None,
) -> VersionView:
    """Snapshot the version (once) and read it: the normalised summary and its diagnostics.

    A version the normaliser does not read (Pricing2Yaml 2.x) raises its ``PricingInvalid`` refusal.
    """
    taken = await snapshot_version(session, organization_id, where, pricing_id, version_id, credential,
                                   actor_id=actor_id, source=source)
    parsed = await normalised(taken.snapshot)
    if parsed.normalised is None:
        assert parsed.refusal is not None
        raise parsed.refusal
    view = summary(parsed.normalised)
    return VersionView(taken, view, view["diagnostics"])


# --- owner/name -> family -------------------------------------------------------------------------------------------

_RESOLVED: dict[tuple[str, str, str], tuple[float, str]] = {}


def _terms(slug: str) -> list[str]:
    spaced = slug.replace("-", " ").replace("_", " ")
    return list(dict.fromkeys([slug, spaced]))


async def _organization_id(
    session: AsyncSession, source: PricingSource, where: SphereEndpoint, owner: str, slug: str,
) -> str | None:
    stored = await session.scalar(
        select(PricingSnapshot.sphere_organization_id)
        .where(PricingSnapshot.owner == owner, PricingSnapshot.sphere_organization_id.is_not(None),
               PricingSnapshot.registry.is_(where.registry) if where.registry is None
               else PricingSnapshot.registry == where.registry)
        .limit(1)
    )
    if stored:
        return stored
    for organization in await source.public_organizations(where, owner):
        if organization.name == owner:
            return organization.id
    for term in _terms(slug):
        for page in range(DISCOVERY_PAGES):
            found = await source.search(where, SearchQuery(name=term, offset=page * 24), None)
            for row in found.rows:
                if row.organization is not None and row.organization.name == owner:
                    return row.organization.id
            if (page + 1) * 24 >= found.total:
                break
    return None


async def resolve_family(
    session: AsyncSession,
    where: SphereEndpoint,
    owner: str,
    slug: str,
    credential: Credential | None = None,
    *,
    version_id: str | None = None,
    source: PricingSource | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> str:
    """The ``pricingId`` of ``owner/slug`` (see the module docstring)."""
    source = source or get_pricing_source()
    if where.registry is not None:
        credential = None
    stored = list(await session.scalars(
        select(PricingSnapshot.pricing_id)
        .where(PricingSnapshot.owner == owner, PricingSnapshot.slug == slug, PricingSnapshot.pricing_id.is_not(None))
        .distinct()
    ))
    if len(stored) == 1 and (version_id is None or await _lists(source, where, stored[0], version_id, credential)):
        return stored[0]
    key = (where.key, owner, slug)
    if credential is None and version_id is None:
        cached = _RESOLVED.get(key)
        if cached is not None and cached[0] > clock():
            return cached[1]
    organization_id = await _organization_id(session, source, where, owner, slug)
    if organization_id is None:
        raise PricingNotFound(f"no SPHERE organization named {owner}")
    matches: list[str] = []
    for page in range(FAMILY_PAGES):
        listing = await source.organization_pricings(where, organization_id, credential, offset=page * 24)
        matches.extend(row.pricing_id for row in listing.rows if row.slug == slug and row.pricing_id not in matches)
        if (page + 1) * 24 >= listing.total or not listing.rows:
            break
    if not matches:
        raise PricingNotFound(f"{owner}/{slug} is not found or not visible")
    if len(matches) > 1 and version_id is not None:
        listing_it = [m for m in matches if await _lists(source, where, m, version_id, credential)]
        if len(listing_it) == 1:
            return listing_it[0]
    if len(matches) > 1:
        raise FamilyAmbiguous(matches)
    if credential is None and version_id is None:
        _RESOLVED[key] = (clock() + float(get_settings().sphere_cache_ttl_s), matches[0])
    return matches[0]


async def _lists(source: PricingSource, where: SphereEndpoint, pricing_id: str, version_id: str,
                 credential: Credential | None) -> bool:
    try:
        answer = await source.manifest(where, pricing_id, credential)
    except PricingNotFound:
        return False
    return not isinstance(answer, NotModified) and answer.version(version_id) is not None


def clear_resolution_cache() -> None:
    _RESOLVED.clear()


__all__ = [
    "FamilyAmbiguous",
    "SearchPage",
    "SearchResult",
    "VersionView",
    "clear_resolution_cache",
    "manifest",
    "resolve_family",
    "search",
    "version_view",
]

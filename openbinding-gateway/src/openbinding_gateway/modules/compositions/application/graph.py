"""The version graph of a composition, drawn like a commit graph.

Ported from SPHERE (SCORELabUS/SPHERE, MIT licence, revision 73779a8a), ``api/src/main/services/PricingService.ts``
(``graph``, ``_graphLane``, ``_unavailableSourceLane``, ``GRAPH_MAX_LANES``): one lane for the composition and one
for each composition a version of it was forked from, each with the versions the caller reads. A fork names its
source by composition, version and label (``forked_from``), which gives the edges between the lanes; only where a
composition came from is drawn, never the forks made of it.

A source the caller does not read keeps a lane with only what the fork already names (its labels and names),
marked unavailable, for a member of the composition. A reader who is not a member is not shown even that, as
``forked_from`` is redacted for them (``adapters/routes._public_version``): such a source has no lane.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from ....collaboration import effective_role
from ....db.models import Composition, CompositionVersion, Organization, User

#: The most source lanes a graph draws (SPHERE's ``GRAPH_MAX_LANES``).
GRAPH_MAX_LANES = 20
PUBLIC = "public"


@dataclass(frozen=True)
class GraphVersion:
    id: uuid.UUID | None
    label: str
    created_at: Any
    forked_from: dict[str, Any] | None


@dataclass(frozen=True)
class Lane:
    role: str
    available: bool
    composition_id: uuid.UUID
    organization: dict[str, Any] | None
    slug: str | None
    name: str | None
    versions: list[GraphVersion]


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


def _edge(version: CompositionVersion) -> dict[str, Any] | None:
    origin = version.forked_from or {}
    source = _uuid(origin.get("compositionId"))
    if source is None:
        return None
    return {"composition_id": source, "version_id": _uuid(origin.get("versionId")), "label": origin.get("label")}


async def _versions(session: AsyncSession, composition_id: uuid.UUID) -> list[CompositionVersion]:
    return list((await session.scalars(
        select(CompositionVersion).options(load_only(
            CompositionVersion.id, CompositionVersion.label, CompositionVersion.created_at,
            CompositionVersion.forked_from, CompositionVersion.ordinal,
        )).where(CompositionVersion.composition_id == composition_id)
        .order_by(CompositionVersion.ordinal.desc())
    )).all())


async def _lane(session: AsyncSession, composition: Composition, role: str) -> Lane:
    organization = await session.get(Organization, composition.organization_id)
    return Lane(
        role=role, available=True, composition_id=composition.id,
        organization={"id": organization.id, "slug": organization.slug, "name": organization.name},
        slug=composition.slug, name=composition.name,
        versions=[
            GraphVersion(version.id, version.label, version.created_at, _edge(version))
            for version in await _versions(session, composition.id)
        ],
    )


async def _reads(session: AsyncSession, composition: Composition, user: User | None) -> bool:
    if composition.visibility == PUBLIC:
        return True
    return user is not None and await effective_role(session, composition.organization_id, user) is not None


def _unavailable(source_id: uuid.UUID, versions: list[CompositionVersion]) -> Lane:
    """A source the caller does not read: only what its forks already say about it (SPHERE's
    ``_unavailableSourceLane``)."""
    origins = [
        version.forked_from for version in versions
        if version.forked_from and _uuid(version.forked_from.get("compositionId")) == source_id
    ]
    first = origins[0]
    organization = first.get("organization") or {}
    labels = list(dict.fromkeys(str(origin.get("label")) for origin in origins if origin.get("label")))
    return Lane(
        role="source", available=False, composition_id=source_id,
        organization={
            "id": _uuid(organization.get("id")), "slug": organization.get("name"),
            "name": organization.get("displayName") or organization.get("name"),
        },
        slug=first.get("slug"), name=first.get("name"),
        versions=[GraphVersion(None, label, None, None) for label in labels],
    )


async def graph(
    session: AsyncSession, composition: Composition, user: User | None, *, member: bool,
) -> tuple[list[Lane], bool]:
    """The lanes of ``composition``'s graph for a caller who reads it (``member`` when they hold a role in its
    organization), and whether more source lanes exist than were drawn."""
    current = await _lane(session, composition, "current")
    stored = await _versions(session, composition.id)
    source_ids = list(dict.fromkeys(
        source for source in (
            _uuid((version.forked_from or {}).get("compositionId")) for version in stored
        ) if source is not None and source != composition.id
    ))
    lanes = [current]
    for source_id in source_ids[:GRAPH_MAX_LANES]:
        source = await session.get(Composition, source_id)
        if source is not None and await _reads(session, source, user):
            lanes.append(await _lane(session, source, "source"))
        elif member:
            lanes.append(_unavailable(source_id, stored))
    if not member:
        readable = {lane.composition_id for lane in lanes}
        lanes[0] = Lane(**{**current.__dict__, "versions": [
            version if version.forked_from is None or version.forked_from["composition_id"] in readable
            else GraphVersion(version.id, version.label, version.created_at, None)
            for version in current.versions
        ]})
    return lanes, len(source_ids) > GRAPH_MAX_LANES

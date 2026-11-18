"""Value origins of a revision (``problem_value_origins``): where each value a SPHERE import wrote came from.

Rows are written with their revision, in its transaction, and never change. They give the facts their value sources
(``value_sources``) and the compositions module the upstream plan each candidate was chosen from
(``candidate_provenance``, which derive writes into a binding's ``from``).

A candidate's **provenance** comes from its rows that read a pricing (``priced``, ``guarantee``, ``limit``,
``feature``); all of them name one snapshot, plan and add-ons. A candidate whose values were all set by hand has no
provenance.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import PricingSnapshot, ProblemValueOrigin
from ...plans.application import SphereEndpoint, installed_pricing_source

#: Rows that read a pricing (as opposed to ``manual``).
PRICED_KINDS = frozenset({"priced", "guarantee", "limit", "feature"})


@dataclass(frozen=True)
class Provenance:
    """The upstream plan a candidate was generated from: what derive writes as the binding entry's ``from``."""

    sphere: str | None
    registry: str | None
    version: str
    version_label: str | None
    plan: str | None
    addons: tuple[str, ...]
    pricing_id: str
    snapshot_id: uuid.UUID | None
    permanent_url: str | None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "sphere": self.sphere,
            "version": self.version,
            "versionLabel": self.version_label,
            "plan": self.plan,
            "pricingId": self.pricing_id,
            "snapshot": str(self.snapshot_id) if self.snapshot_id else None,
            "permanentUrl": self.permanent_url,
        }
        if self.registry:
            out["registry"] = self.registry
        if self.addons:
            out["addons"] = list(self.addons)
        return out


def _uuid(value: Any) -> uuid.UUID | None:
    if value is None or isinstance(value, uuid.UUID):
        return value
    return uuid.UUID(str(value))


def rows_from(revision_id: uuid.UUID, origins: Iterable[Mapping[str, Any]]) -> list[ProblemValueOrigin]:
    """The rows of a generated revision, from the generator's origins (``Generated.origins``)."""
    return [
        ProblemValueOrigin(
            revision_id=revision_id,
            candidate_key=origin["candidateKey"],
            target_kind=origin["targetKind"],
            target=origin["target"],
            source_kind=origin["sourceKind"],
            value=origin["value"],
            snapshot_id=_uuid(origin.get("snapshot")),
            registry=origin.get("registry"),
            pricing_id=origin.get("pricingId"),
            version_id=origin.get("versionId"),
            plan=origin.get("plan"),
            add_ons=list(origin.get("addOns") or []),
            sphere_ref=origin.get("sphereRef"),
            detail=dict(origin.get("detail") or {}),
            carried_from_revision_id=_uuid(origin.get("carriedFrom")),
        )
        for origin in origins
    ]


async def origins_for(session: AsyncSession, revision_id: uuid.UUID) -> list[ProblemValueOrigin]:
    return list((await session.scalars(
        select(ProblemValueOrigin)
        .where(ProblemValueOrigin.revision_id == revision_id)
        .order_by(ProblemValueOrigin.candidate_key, ProblemValueOrigin.target_kind, ProblemValueOrigin.target)
    )).all())


def origins_digest(rows: Iterable[ProblemValueOrigin]) -> str | None:
    """A digest of what the rows say (``None`` without rows): two revisions with the same package but other
    origins have other facts."""
    items = sorted(
        [
            row.candidate_key, row.target_kind, row.target, row.source_kind, row.value,
            str(row.snapshot_id) if row.snapshot_id else None, row.version_id, row.plan, list(row.add_ons or []),
            str(row.carried_from_revision_id) if row.carried_from_revision_id else None,
        ]
        for row in rows
    )
    if not items:
        return None
    canonical = json.dumps(items, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return "sha256-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _permanent_url(registry: str | None, pricing_id: str | None, version_id: str | None) -> str | None:
    source = installed_pricing_source()
    if source is None or not pricing_id:
        return None
    try:
        return source.permanent_url(SphereEndpoint(registry), pricing_id, version_id)
    except Exception:  # noqa: BLE001 - a link that cannot be built is left out, never an error
        return None


async def _snapshots(session: AsyncSession, rows: Iterable[ProblemValueOrigin]) -> dict[uuid.UUID, PricingSnapshot]:
    wanted = {row.snapshot_id for row in rows if row.snapshot_id is not None}
    if not wanted:
        return {}
    found = (await session.scalars(select(PricingSnapshot).where(PricingSnapshot.id.in_(wanted)))).all()
    return {row.id: row for row in found}


def _pricing(row: ProblemValueOrigin, snapshot: PricingSnapshot | None) -> dict[str, Any] | None:
    if row.pricing_id is None:
        return None
    return {
        "sphere": row.sphere_ref,
        "registry": row.registry,
        "pricingId": row.pricing_id,
        "versionId": row.version_id,
        "versionLabel": snapshot.version_label if snapshot is not None else None,
        "plan": row.plan,
        "addOns": list(row.add_ons or []),
        "permanentUrl": _permanent_url(row.registry, row.pricing_id, row.version_id),
    }


def provenance_of(rows: Iterable[ProblemValueOrigin], snapshots: Mapping[uuid.UUID, PricingSnapshot]) -> dict[str, Provenance]:
    """Each candidate's provenance, from its rows that read a pricing."""
    out: dict[str, Provenance] = {}
    for row in rows:
        if row.source_kind not in PRICED_KINDS or row.pricing_id is None or row.version_id is None:
            continue
        if row.candidate_key in out:
            continue
        snapshot = snapshots.get(row.snapshot_id) if row.snapshot_id else None
        out[row.candidate_key] = Provenance(
            sphere=row.sphere_ref,
            registry=row.registry,
            version=row.version_id,
            version_label=snapshot.version_label if snapshot is not None else None,
            plan=row.plan,
            addons=tuple(row.add_ons or ()),
            pricing_id=row.pricing_id,
            snapshot_id=row.snapshot_id,
            permanent_url=_permanent_url(row.registry, row.pricing_id, row.version_id),
        )
    return out


async def candidate_provenance(session: AsyncSession, revision_id: uuid.UUID) -> dict[str, Provenance]:
    """``{candidate key: Provenance}`` of a revision (empty for a revision no SPHERE import wrote)."""
    rows = await origins_for(session, revision_id)
    return provenance_of(rows, await _snapshots(session, rows))


@dataclass(frozen=True)
class ValueSources:
    """What the facts of a revision add to its package's locations: a source per value, a provenance per
    candidate, and the digest of the rows (``None`` for a revision without origins)."""

    sources: dict[tuple[str, str, str], dict[str, Any]]
    provenance: dict[str, dict[str, Any]]
    digest: str | None


async def value_sources(session: AsyncSession, revision_id: uuid.UUID) -> ValueSources:
    rows = await origins_for(session, revision_id)
    snapshots = await _snapshots(session, rows)
    sources = {
        (row.candidate_key, row.target_kind, row.target): {
            "kind": row.source_kind,
            "pricing": _pricing(row, snapshots.get(row.snapshot_id) if row.snapshot_id else None),
            "detail": dict(row.detail or {}),
            "carried": row.carried_from_revision_id is not None,
        }
        for row in rows
    }
    provenance = {key: value.as_dict() for key, value in provenance_of(rows, snapshots).items()}
    return ValueSources(sources, provenance, origins_digest(rows))

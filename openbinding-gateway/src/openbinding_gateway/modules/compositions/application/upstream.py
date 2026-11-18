"""A composition version's upstream pricings, from stored data only, and the snapshotting of hand-written ``from``.

``upstream`` answers what the renderer draws for a version: per binding entry, the pricing, version name, plan and
permanent link of its upstream plan with the snapshot to draw it from; per global value, the kinds of source its
bound candidates' values have (plan §2.4: it counts kinds, it computes nothing); and the offering version the
version's current evaluation read. It never calls SPHERE: a candidate's snapshot comes from the linked revision's
value origins, else from a stored snapshot of the ``from`` version (in the organization's scope or public). A reader
who is not a member (a public composition's visitor) sees public snapshots only.

``resolve_provenance`` snapshots the versions hand-written ``from`` entries pin, so that the upstream view and F6
have something to compare against: an entry with a stored snapshot, or whose version is not a SPHERE id, makes no
call; at most ``network_limit`` entries are resolved over the network (``resolve_family`` keeping the family whose
manifest lists the version, then ``snapshot_version``); a failure leaves the entry ``not_snapshotted``. It is
idempotent and runs in the seal pre-phase and, later, in F6's poller.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterable
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ....composition import text
from ....composition.document import Document, Provenance
from ....db.models import Composition, CompositionEvaluation, CompositionVersion, Organization, PricingSnapshot
from ...plans.application import (
    PricingError,
    SphereEndpoint,
    credential_for,
    get_pricing_source,
    is_sphere_id,
    normalised,
    pricing2yaml,
    resolve_family,
    snapshot_version,
)
from ...problems.application import PRICED_KINDS, origins_for
from .slots import language_slot
from .versions import current_of, installed_basis

PUBLIC = "public"
NETWORK_LIMIT = 8


def _scopes(organization_id: uuid.UUID, *, member: bool) -> list[str]:
    return [PUBLIC, str(organization_id)] if member else [PUBLIC]


def _visible(snapshot: PricingSnapshot, organization_id: uuid.UUID, *, member: bool) -> bool:
    if snapshot.scope_key == PUBLIC:
        return True
    if not member:
        return False
    return snapshot.scope_key.startswith("registry:") or snapshot.scope_key == str(organization_id)


async def _stored_for(
    session: AsyncSession, organization_id: uuid.UUID, version_id: str, registry: str | None, *, member: bool,
) -> PricingSnapshot | None:
    scopes = _scopes(organization_id, member=member)
    query = select(PricingSnapshot).where(
        PricingSnapshot.version_id == version_id,
        PricingSnapshot.registry.is_(None) if registry is None else PricingSnapshot.registry == registry,
    )
    if member:
        query = query.where(or_(PricingSnapshot.scope_key.in_(scopes), PricingSnapshot.scope_key.like("registry:%")))
    else:
        query = query.where(PricingSnapshot.scope_key == PUBLIC)
    return await session.scalar(query.order_by(PricingSnapshot.fetched_at.desc()).limit(1))


def _from_view(source: Provenance | None) -> dict[str, Any] | None:
    if source is None:
        return None
    out: dict[str, Any] = {"sphere": source.sphere, "version": source.version, "plan": source.plan}
    if source.registry:
        out["registry"] = source.registry
    if source.addons:
        out["addons"] = list(source.addons)
    return out


def snapshot_view(snapshot: PricingSnapshot) -> dict[str, Any]:
    permanent = None
    if snapshot.pricing_id:
        try:
            permanent = get_pricing_source().permanent_url(SphereEndpoint(snapshot.registry), snapshot.pricing_id,
                                                           snapshot.version_id)
        except Exception:  # noqa: BLE001 - no installed source, no link
            permanent = None
    return {
        "id": str(snapshot.id),
        "title": snapshot.title,
        "owner": snapshot.owner,
        "slug": snapshot.slug,
        "pricingId": snapshot.pricing_id,
        "versionId": snapshot.version_id,
        "versionName": snapshot.version_label,
        "createdAt": snapshot.version_created_at,
        "registry": snapshot.registry,
        "url": snapshot.url,
        "permanentUrl": permanent,
    }


async def _plan_of(snapshot: PricingSnapshot, plan: str | None) -> dict[str, Any] | None:
    if plan is None:
        return None
    try:
        parsed = await normalised(snapshot)
    except PricingError:
        return None
    found = parsed.normalised.plans.get(plan) if parsed.normalised is not None else None
    if found is None:
        return None
    return {"name": found.name, "price": pricing2yaml.price_json(found.price), "unit": found.unit,
            "private": found.private}


async def upstream(
    session: AsyncSession, organization: Organization, version: CompositionVersion, document: Document, *, member: bool,
) -> dict[str, Any]:
    """The upstream view of ``version`` (``document``, its stored content) for a member or a public reader."""
    evaluations = list((await session.scalars(
        select(CompositionEvaluation).where(CompositionEvaluation.version_id == version.id)
        .order_by(CompositionEvaluation.created_at, CompositionEvaluation.id)
    )).all())
    current = current_of(evaluations, installed_basis())
    bound: dict[str, str] = {}
    if current is not None and current.binding:
        bound = {task: f"{ref['resource']}/{ref['id']}" for task, ref in current.binding.items()}
    rows = await origins_for(session, version.revision_id) if version.revision_id is not None else []
    by_candidate: dict[str, list[Any]] = {}
    for row in rows:
        by_candidate.setdefault(row.candidate_key, []).append(row)
    registries = set(get_pricing_source().registries())

    entries = []
    for task, entry in document.binding:
        if entry.local or entry.candidate is None:
            continue
        key = bound.get(task)
        candidate_rows = by_candidate.get(key or "", [])
        priced = next((r for r in candidate_rows if r.source_kind in PRICED_KINDS and r.snapshot_id), None)
        item: dict[str, Any] = {"task": task, "candidate": entry.candidate, "from": _from_view(entry.source),
                                "status": "not_snapshotted", "snapshot": None, "plan": None}
        if entry.source is not None and entry.source.registry and entry.source.registry not in registries:
            item["status"] = "registry_unknown"
            entries.append(item)
            continue
        snapshot = None
        plan_name = entry.source.plan if entry.source is not None else None
        if priced is not None:
            snapshot = await session.get(PricingSnapshot, priced.snapshot_id)
            plan_name = plan_name or priced.plan
        if snapshot is None and entry.source is not None and entry.source.version and is_sphere_id(entry.source.version):
            snapshot = await _stored_for(session, organization.id, entry.source.version, entry.source.registry,
                                         member=member)
        if snapshot is not None and _visible(snapshot, organization.id, member=member):
            item.update(status="snapshotted", snapshot=snapshot_view(snapshot), plan=await _plan_of(snapshot, plan_name))
        entries.append(item)

    kinds: dict[str, set[str]] = {}
    features = {name for name, _ in document.values}
    for row in rows:
        if row.target_kind == "feature" and row.candidate_key in bound.values():
            kinds.setdefault(row.target, set()).add(row.source_kind)
            features.add(row.target)
    if rows:
        # A bound candidate's value without an origin row is written in the package by hand.
        for key in set(bound.values()):
            written = {row.target for row in by_candidate.get(key, []) if row.target_kind == "feature"}
            for feature in features - written:
                kinds.setdefault(feature, set()).add("manual")
    values = {
        feature: {"sources": sorted(found), "manualOnly": not (found & PRICED_KINDS)}
        for feature, found in sorted(kinds.items())
    }

    offering = None
    if version.offering is not None:
        offering = {"source": dict(version.offering), "status": None, "versionName": None, "createdAt": None,
                    "snapshot": None}
        if current is not None and current.offering_status is not None:
            offering["status"] = current.offering_status
            if current.offering_snapshot_id is not None:
                snapshot = await session.get(PricingSnapshot, current.offering_snapshot_id)
                if snapshot is not None and _visible(snapshot, organization.id, member=member):
                    offering.update(versionName=snapshot.version_label, createdAt=snapshot.version_created_at,
                                    snapshot=snapshot_view(snapshot))
    return {"version": version.label, "entries": entries, "values": values, "offering": offering}


async def resolve_provenance(
    session: AsyncSession,
    organization_id: uuid.UUID,
    entries: Iterable[Provenance],
    *,
    actor_id: uuid.UUID | None = None,
    network_limit: int = NETWORK_LIMIT,
) -> dict[str, uuid.UUID]:
    """Snapshot the versions ``entries`` pin (see the module docstring): ``{versionId: snapshot id}`` of those that
    have a snapshot now."""
    found: dict[str, uuid.UUID] = {}
    budget = network_limit
    registries = set(get_pricing_source().registries())
    credential = None
    for entry in entries:
        version, registry = entry.version, entry.registry
        if not version or not entry.sphere or "/" not in entry.sphere or version in found:
            continue
        stored = await _stored_for(session, organization_id, version, registry, member=True)
        if stored is not None:
            found[version] = stored.id
            continue
        if not is_sphere_id(version) or (registry is not None and registry not in registries) or budget <= 0:
            continue
        budget -= 1
        owner, _, slug = entry.sphere.partition("/")
        where = SphereEndpoint(registry)
        try:
            if registry is None and credential is None:
                credential = await credential_for(session, organization_id)
            pricing_id = await resolve_family(session, where, owner, slug, credential if registry is None else None,
                                              version_id=version)
            taken = await snapshot_version(session, organization_id, where, pricing_id, version,
                                           credential if registry is None else None, actor_id=actor_id)
        except PricingError:
            continue
        found[version] = taken.snapshot.id
    if session.in_transaction():
        await session.commit()
    return found


async def latest_version(session: AsyncSession, composition: Composition) -> CompositionVersion | None:
    return await session.scalar(
        select(CompositionVersion).where(CompositionVersion.composition_id == composition.id)
        .order_by(CompositionVersion.ordinal.desc()).limit(1)
    )


async def stored_document(version: CompositionVersion) -> Document:
    """The version's document, read from its stored bytes in a language slot."""
    async with language_slot():
        return await asyncio.to_thread(text.read_stored, version.content)


def provenance_entries(document: Document | None) -> list[Provenance]:
    """The ``from`` entries of a document's binding."""
    if document is None:
        return []
    return [entry.source for _, entry in document.binding if entry.source is not None]


__all__ = [
    "NETWORK_LIMIT",
    "latest_version",
    "provenance_entries",
    "resolve_provenance",
    "snapshot_view",
    "stored_document",
    "upstream",
]

"""What sealed composition versions watch upstream (F6): pricing watches and their references.

``register_version`` runs inside ``seal_into`` for a **new** version only (a deduplicated seal registers nothing), in
the caller's transaction, under the composition lock, after the version and its evaluation are inserted. It reads only
stored data (the seal pre-phase, ``offering.before_seal`` -> ``resolve_provenance``, already snapshotted what it
could), so it makes no network read inside the lock, and inserts one ``pricing_watch_refs`` row per version x watch x
subject x pinned version:

1. **binding entries with ``from``**: the family comes from the stored snapshot of the pinned version (its
   ``pricing_id`` and ``scope_key``: public, a registry or the organization); without one the entry gets an
   **unresolved** ref (``watch_id`` NULL) and a due ``pricing_ref_attempts`` row, which the watcher works off later;
2. **bound candidates without ``from``** in a linked version: the linked revision's value origins for that candidate
   (``via = 'origins'``);
3. **the offering**: ``{sphere, registry?}`` through the evaluation's offering snapshot, or ``{url}`` (an
   organization-scoped ``url`` watch, keyed by the canonical URL's SHA-256 as its snapshots are).

Entries of one version that pin the same family at the same version are grouped in one ref (their tasks and
selections together). ``watch_for`` inserts a watch if absent by ``watch_key`` (``ON CONFLICT DO NOTHING``), so two
compositions pinning one public family share one watch and two racing seals create one. A new watch is due at once.

**Live versions** (``live_versions``): the latest version of each composition plus every version adopted in one of
its environments; only they are classified.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import Select, select, union
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from ....jobs import clock
from ....db.models import (
    Composition,
    CompositionEnvironment,
    CompositionEvaluation,
    CompositionVersion,
    PricingRefAttempt,
    PricingSnapshot,
    PricingWatch,
    PricingWatchRef,
)
from ...plans.application import canonical_url, is_sphere_id, url_source_key
from ...problems.application import PRICED_KINDS, origins_for
from .upstream import _stored_for

PUBLIC = "public"


# -- Watches ---------------------------------------------------------------------------------------------------------


def watch_key(kind: str, registry: str | None, pricing_id: str | None, url_key: str | None, scope_key: str) -> str:
    if kind == "url":
        return f"url|{url_key}|{scope_key}"
    prefix = f"registry:{registry}" if kind == "registry" else "sphere"
    return f"{prefix}|{pricing_id}|{scope_key}"


def _insert(session: AsyncSession, values: dict[str, Any], index: list[str], table: Any):
    dialect = session.bind.dialect.name if session.bind is not None else "sqlite"
    builder = postgresql.insert if dialect == "postgresql" else sqlite.insert
    return builder(table).values(**values).on_conflict_do_nothing(index_elements=index)


async def watch_for(
    session: AsyncSession,
    kind: str,
    registry: str | None,
    pricing_id: str | None,
    scope_key: str,
    organization_id: uuid.UUID | None,
    *,
    url: str | None = None,
) -> PricingWatch:
    """The watch of this source and scope, inserted when absent (due now)."""
    url_key = None
    if kind == "url":
        assert url is not None
        url = canonical_url(url)
        url_key = url_source_key(url).removeprefix("url:")
    key = watch_key(kind, registry, pricing_id, url_key, scope_key)
    await session.execute(_insert(session, {
        "id": uuid.uuid4(), "source_kind": kind, "registry": registry, "pricing_id": pricing_id, "url": url,
        "url_key": url_key, "scope_key": scope_key, "organization_id": organization_id, "watch_key": key,
        "status": "pending", "version_order": [], "equivalent": [], "not_found_count": 0, "failures": 0,
        "gone_epoch": 0, "next_poll_at": clock.now(session), "created_at": clock.now(session),
    }, ["watch_key"], PricingWatch.__table__))
    found = await session.scalar(select(PricingWatch).where(PricingWatch.watch_key == key))
    assert found is not None
    return found


def _scope_organization(scope_key: str) -> uuid.UUID | None:
    if scope_key == PUBLIC or scope_key.startswith("registry:"):
        return None
    return uuid.UUID(scope_key)


def _kind_of(snapshot: PricingSnapshot) -> str:
    return "registry" if snapshot.registry else ("url" if snapshot.source_kind == "url" else "sphere")


def snapshot_watch_key(snapshot: PricingSnapshot) -> str:
    """The ``watch_key`` of the watch ``snapshot`` belongs to, without inserting it."""
    kind = _kind_of(snapshot)
    url_key = url_source_key(canonical_url(snapshot.url or "")).removeprefix("url:") if kind == "url" else None
    return watch_key(kind, snapshot.registry, snapshot.pricing_id, url_key, snapshot.scope_key)


async def watch_of_snapshot(session: AsyncSession, snapshot: PricingSnapshot) -> PricingWatch:
    kind = _kind_of(snapshot)
    return await watch_for(
        session, kind, snapshot.registry, snapshot.pricing_id, snapshot.scope_key,
        _scope_organization(snapshot.scope_key), url=snapshot.url if kind == "url" else None,
    )


# -- References ------------------------------------------------------------------------------------------------------


@dataclass
class _Group:
    watch_id: uuid.UUID | None
    subject: str
    via: str
    sphere_ref: str | None
    pinned: str | None
    pinned_snapshot_id: uuid.UUID | None
    tasks: list[str] = field(default_factory=list)
    selection: dict[str, Any] = field(default_factory=dict)

    @property
    def ref_key(self) -> str:
        head = str(self.watch_id) if self.watch_id is not None else f"unresolved:{self.sphere_ref}"
        return f"{head}|{self.subject}|{self.pinned or '-'}"[:200]


def _sphere_ref(sphere: str | None, registry: str | None) -> str | None:
    if sphere is None:
        return None
    return f"{registry}:{sphere}" if registry else sphere


def _billing_of(origins: Iterable[Any]) -> tuple[str | None, int | None]:
    for row in origins:
        if row.source_kind == "priced" and isinstance(row.detail, dict):
            seats = row.detail.get("seats")
            return row.detail.get("billing"), int(seats) if isinstance(seats, (int, float)) else None
    return None, None


async def register_version(
    session: AsyncSession,
    composition: Composition,
    version: CompositionVersion,
    effective: Any,
    evaluation: CompositionEvaluation | None,
) -> list[PricingWatchRef]:
    """Insert the refs of a newly sealed ``version`` (``effective``: its document); see the module docstring."""
    organization_id = composition.organization_id
    groups: dict[tuple[Any, ...], _Group] = {}
    attempts: set[tuple[str, str | None]] = set()
    bound: dict[str, str] = {}
    if evaluation is not None and evaluation.binding:
        bound = {task: f"{ref['resource']}/{ref['id']}" for task, ref in evaluation.binding.items()}
    origins = await origins_for(session, version.revision_id) if version.revision_id is not None else []
    by_candidate: dict[str, list[Any]] = {}
    for row in origins:
        by_candidate.setdefault(row.candidate_key, []).append(row)

    for task, entry in getattr(effective, "binding", ()):
        if entry.local or entry.candidate is None:
            continue
        rows = by_candidate.get(bound.get(task, ""), [])
        billing, seats = _billing_of(rows)
        source = entry.source
        if source is not None and source.sphere and source.version:
            selection = {"plan": source.plan, "addOns": list(source.addons), "billing": billing, "seats": seats,
                         "candidate": entry.candidate}
            snapshot = None
            if is_sphere_id(source.version):
                snapshot = await _stored_for(session, organization_id, source.version, source.registry, member=True)
            if snapshot is not None and snapshot.pricing_id:
                watch = await watch_of_snapshot(session, snapshot)
                group = groups.setdefault(
                    (watch.id, "binding", source.version),
                    _Group(watch.id, "binding", "from", _sphere_ref(source.sphere, source.registry), source.version,
                           snapshot.id),
                )
            else:
                sphere_ref = _sphere_ref(source.sphere, source.registry)
                pinned = source.version if is_sphere_id(source.version) else None
                group = groups.setdefault(
                    (None, "binding", sphere_ref, pinned),
                    _Group(None, "binding", "from", sphere_ref, pinned, None),
                )
                if pinned is not None:
                    attempts.add((sphere_ref or "", pinned))
            group.tasks.append(task)
            group.selection[task] = selection
            continue
        # A bound candidate without ``from``: what its linked revision's origins read.
        priced = next((r for r in rows if r.source_kind in PRICED_KINDS and r.pricing_id and r.snapshot_id), None)
        if priced is None:
            continue
        snapshot = await session.get(PricingSnapshot, priced.snapshot_id)
        if snapshot is None:
            continue
        watch = await watch_of_snapshot(session, snapshot)
        group = groups.setdefault(
            (watch.id, "binding", priced.version_id),
            _Group(watch.id, "binding", "origins", priced.sphere_ref, priced.version_id, snapshot.id),
        )
        group.tasks.append(task)
        group.selection[task] = {"plan": priced.plan, "addOns": list(priced.add_ons or []), "billing": billing,
                                 "seats": seats, "candidate": entry.candidate}

    offering = version.offering or None
    if offering:
        snapshot = None
        if evaluation is not None and evaluation.offering_snapshot_id is not None:
            snapshot = await session.get(PricingSnapshot, evaluation.offering_snapshot_id)
        watch = None
        if offering.get("url"):
            watch = await watch_for(session, "url", None, None, str(organization_id), organization_id,
                                    url=offering["url"])
        elif snapshot is not None and snapshot.pricing_id:
            watch = await watch_of_snapshot(session, snapshot)
        if watch is not None:
            groups[(watch.id, "offering")] = _Group(
                watch.id, "offering", "offering", offering.get("url") or _sphere_ref(offering.get("sphere"),
                                                                                    offering.get("registry")),
                None, snapshot.id if snapshot is not None else None,
            )

    refs = []
    for group in groups.values():
        row = PricingWatchRef(
            organization_id=organization_id, composition_id=composition.id, version_id=version.id,
            watch_id=group.watch_id, subject=group.subject, via=group.via, sphere_ref=group.sphere_ref,
            tasks=sorted(group.tasks), pinned_version_id=group.pinned, pinned_snapshot_id=group.pinned_snapshot_id,
            selection=group.selection, ref_key=group.ref_key,
        )
        session.add(row)
        refs.append(row)
    for sphere_ref, pinned in sorted(attempts):
        await ensure_attempt(session, organization_id, sphere_ref, pinned)
    await session.flush()
    return refs


def attempt_key(organization_id: uuid.UUID, sphere_ref: str, pinned: str | None) -> str:
    return f"{organization_id}|{sphere_ref}|{pinned or '-'}"[:340]


async def ensure_attempt(session: AsyncSession, organization_id: uuid.UUID, sphere_ref: str, pinned: str | None) -> None:
    """A due attempt to resolve an unresolved family, unless one is scheduled already."""
    await session.execute(_insert(session, {
        "id": uuid.uuid4(), "organization_id": organization_id, "sphere_ref": sphere_ref, "pinned_version_id": pinned,
        "attempt_key": attempt_key(organization_id, sphere_ref, pinned), "failures": 0,
        "next_attempt_at": clock.now(session), "created_at": clock.now(session),
    }, ["attempt_key"], PricingRefAttempt.__table__))


# -- Live versions and the work of a cycle ---------------------------------------------------------------------------


def live_versions() -> Select:
    """The ids of every live version: each composition's latest, and every adopted one."""
    newer = aliased(CompositionVersion)
    latest = select(CompositionVersion.id.label("version_id")).where(
        ~select(newer.id).where(
            newer.composition_id == CompositionVersion.composition_id, newer.ordinal > CompositionVersion.ordinal,
        ).exists()
    )
    adopted = select(CompositionEnvironment.adopted_version_id.label("version_id")).where(
        CompositionEnvironment.adopted_version_id.is_not(None)
    )
    return union(latest, adopted)


def live_ref_exists(watch_id: Any) -> Any:
    """``EXISTS`` a ref of ``watch_id`` on a live version (a watch without one is not polled)."""
    return select(PricingWatchRef.id).where(
        PricingWatchRef.watch_id == watch_id, PricingWatchRef.version_id.in_(live_versions())
    ).exists()


async def unresolved_refs(session: AsyncSession, organization_id: uuid.UUID, sphere_ref: str,
                          pinned: str | None) -> list[PricingWatchRef]:
    """The unresolved refs of an organization naming ``sphere_ref`` at ``pinned`` that no resolved sibling covers."""
    resolved = aliased(PricingWatchRef)
    query = select(PricingWatchRef).where(
        PricingWatchRef.organization_id == organization_id,
        PricingWatchRef.watch_id.is_(None),
        PricingWatchRef.sphere_ref == sphere_ref,
        PricingWatchRef.pinned_version_id.is_(None) if pinned is None else PricingWatchRef.pinned_version_id == pinned,
        ~select(resolved.id).where(
            resolved.version_id == PricingWatchRef.version_id, resolved.watch_id.is_not(None),
            resolved.sphere_ref == PricingWatchRef.sphere_ref,
        ).exists(),
    )
    return list((await session.scalars(query.order_by(PricingWatchRef.created_at))).all())


async def due_ref_attempts(session: AsyncSession, limit: int) -> list[PricingRefAttempt]:
    """At most ``limit`` attempts due now (database clock), one family per organization."""
    rows = (await session.scalars(
        select(PricingRefAttempt).where(PricingRefAttempt.next_attempt_at <= clock.now(session))
        .order_by(PricingRefAttempt.next_attempt_at, PricingRefAttempt.id).limit(max(limit * 8, limit))
    )).all()
    chosen: list[PricingRefAttempt] = []
    organizations: set[uuid.UUID] = set()
    for row in rows:
        if row.organization_id in organizations:
            continue
        organizations.add(row.organization_id)
        chosen.append(row)
        if len(chosen) >= limit:
            break
    return chosen


def url_key_of(url: str) -> str:
    return hashlib.sha256(canonical_url(url).encode("utf-8")).hexdigest()


__all__ = [
    "attempt_key",
    "due_ref_attempts",
    "ensure_attempt",
    "live_ref_exists",
    "live_versions",
    "register_version",
    "snapshot_watch_key",
    "unresolved_refs",
    "url_key_of",
    "watch_for",
    "watch_key",
    "watch_of_snapshot",
]

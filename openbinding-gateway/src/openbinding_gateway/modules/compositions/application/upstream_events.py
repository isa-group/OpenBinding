"""Upstream events (F6): recording classified changes for live versions, and their resolution by a person's seal.

**Recording** (``record``, the classify step of a watcher cycle). For one watch whose target is known (its latest
version, the latest URL copy's ``sha256:<hex>``, or ``gone:<epoch>`` once confirmed gone), every reference on a
**live** version is a candidate:

* a binding ref is skipped when it pins the target, an ``equivalent`` pair, or a version at least as new as the
  target by SPHERE's order; a pinned version no longer listed by a readable manifest is ``version_withdrawn``;
* an offering ref is classified once per **composition** (on its latest version as reference), against the newest
  of the composition's last offering event and the reference version's evaluation; an equal functional hash is
  nothing (a rename);
* an existing event for the key is nothing.

The read phase gathers the classifier's inputs (snapshots through ``normalised``, the linked revision's origins, the
pinned recipe, the compiled feature rules, the current values, the margins' inputs); ``upstream_classify`` decides;
the write phase takes ``FOR SHARE`` on the composition row (it conflicts with a seal's ``FOR NO KEY UPDATE``, so the
born-resolved check and a seal's ``resolve_on_seal`` never miss each other), checks whether a later version of the
composition already pins the new version or a newer one (the event is then **born resolved**), and inserts with
``ON CONFLICT DO NOTHING ... RETURNING id`` (the partial unique indexes are the idempotency across replicas). A
classifier failure is logged once and the watch waits an hour (``classify_after``).

**Resolution** (``resolve_on_seal``): inside ``seal_into``, for a new version only, every open or reviewed binding event
of the composition is resolved when the sealed version pins the event's new version or a newer one in a ``from`` of
the watched family (rule a), or is linked to a revision whose value origins read the family at that version or newer,
whatever it bound (rule b). Offering events never resolve.

The watcher writes nothing a person must write (invariant W): no run, revision, version, evaluation, adoption,
environment or proposal; badges are computed when read.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import exists, func, select, update
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import (
    BindingCaseRevision,
    Composition,
    CompositionAdoption,
    CompositionEnvironment,
    CompositionEvaluation,
    CompositionUpstreamEvent,
    CompositionVersion,
    PricingSnapshot,
    PricingWatch,
    PricingWatchRef,
    ProblemCompilation,
    ProblemValueOrigin,
)
from ....jobs import clock
from ...plans.application import PricingError, Selection, normalised
from ...problems.application import origins_for, recipe_of_revision
from ..domain.upstream import GONE, at_least_as_new
from . import upstream_classify as uc
from .versions import current_of, installed_basis
from .watches import live_versions

logger = logging.getLogger(__name__)
#: How long a watch whose classification failed waits before it is classified again.
CLASSIFY_RETRY_S = 3600


# -- Targets ---------------------------------------------------------------------------------------------------------


async def target_of(session: AsyncSession, watch: PricingWatch) -> str | None:
    """What the watch's refs are compared with now: ``gone:<epoch>``, the latest versionId, or ``sha256:<hex>``."""
    if watch.status == "gone":
        return f"{GONE}:{watch.gone_epoch}"
    if watch.source_kind == "url":
        if watch.latest_snapshot_id is None:
            return None
        snapshot = await session.get(PricingSnapshot, watch.latest_snapshot_id)
        return f"sha256:{snapshot.sha256}" if snapshot is not None else None
    return watch.latest_version_id


def _ref_of_snapshot(snapshot: PricingSnapshot | None) -> str | None:
    if snapshot is None:
        return None
    return snapshot.version_id or f"sha256:{snapshot.sha256}"


# -- The resolution rule (shared by born-resolved recording and resolve_on_seal) --------------------------------------


async def pins_of(session: AsyncSession, version: CompositionVersion, watch: PricingWatch) -> set[str]:
    """Every version of ``watch``'s family that ``version`` pins: in a ``from`` (its refs; rule a) or through its
    linked revision's value origins, bound or not (rule b)."""
    pins = set((await session.scalars(
        select(PricingWatchRef.pinned_version_id).where(
            PricingWatchRef.version_id == version.id, PricingWatchRef.watch_id == watch.id,
            PricingWatchRef.pinned_version_id.is_not(None),
        )
    )).all())
    if version.revision_id is not None and watch.pricing_id is not None:
        query = select(ProblemValueOrigin.version_id).where(
            ProblemValueOrigin.revision_id == version.revision_id,
            ProblemValueOrigin.pricing_id == watch.pricing_id,
            ProblemValueOrigin.version_id.is_not(None),
        )
        query = query.where(ProblemValueOrigin.registry.is_(None) if watch.registry is None
                            else ProblemValueOrigin.registry == watch.registry)
        pins |= set((await session.scalars(query)).all())
    return {pin for pin in pins if pin}


def resolves(pins: Iterable[str], new_ref: str, order: list[str]) -> bool:
    if new_ref.startswith(f"{GONE}:"):
        return False
    return any(at_least_as_new(pin, new_ref, order) for pin in pins)


async def _resolver(session: AsyncSession, composition_id: uuid.UUID, after_ordinal: int, watch: PricingWatch,
                    new_ref: str) -> CompositionVersion | None:
    """The newest later version of the composition that already pins ``new_ref`` or newer (born resolved)."""
    later = (await session.scalars(
        select(CompositionVersion).where(CompositionVersion.composition_id == composition_id,
                                         CompositionVersion.ordinal > after_ordinal)
        .order_by(CompositionVersion.ordinal.desc())
    )).all()
    for version in later:
        if resolves(await pins_of(session, version, watch), new_ref, list(watch.version_order or [])):
            return version
    return None


async def _adopted_where(session: AsyncSession, version_id: uuid.UUID) -> set[uuid.UUID]:
    return set((await session.scalars(
        select(CompositionEnvironment.id).where(CompositionEnvironment.adopted_version_id == version_id)
    )).all())


# -- Inputs ----------------------------------------------------------------------------------------------------------


async def _side(snapshot: PricingSnapshot | None, *, version_id: str | None = None, label: str | None = None,
                url: str | None = None) -> uc.Side:
    if snapshot is None:
        return uc.Side(version_id, label, None, None, url)
    pricing = refusal = None
    try:
        parsed = await normalised(snapshot)
        pricing = parsed.normalised
        refusal = parsed.refusal.code if parsed.refusal is not None else (None if pricing else "pricing_invalid")
    except PricingError as exc:
        refusal = getattr(exc, "code", "pricing_invalid")
    return uc.Side(snapshot.version_id or version_id, snapshot.version_label or label, snapshot.version_created_at,
                   str(snapshot.id), url, pricing, refusal, snapshot.content_hash)


def _permanent(watch: PricingWatch, version_id: str | None) -> str | None:
    if watch.pricing_id is None:
        return watch.url
    try:
        from ...plans.application import SphereEndpoint, get_pricing_source

        return get_pricing_source().permanent_url(SphereEndpoint(watch.registry), watch.pricing_id, version_id)
    except Exception:  # noqa: BLE001 - no installed source, no link
        return None


def _facts(watch: PricingWatch, sphere_ref: str | None, title: str | None, **flags: bool) -> uc.Facts:
    return uc.Facts({"sphere": sphere_ref if watch.source_kind != "url" else None, "registry": watch.registry,
                     "pricingId": watch.pricing_id, "url": watch.url, "title": title}, **flags)


async def _current(session: AsyncSession, version: CompositionVersion) -> CompositionEvaluation | None:
    evaluations = list((await session.scalars(
        select(CompositionEvaluation).where(CompositionEvaluation.version_id == version.id)
        .order_by(CompositionEvaluation.created_at, CompositionEvaluation.id)
    )).all())
    return current_of(evaluations, installed_basis())


async def _rules(session: AsyncSession, version: CompositionVersion) -> dict[str, uc.FeatureRule]:
    if version.linked_compilation_id is None:
        return {}
    compilation = await session.get(ProblemCompilation, version.linked_compilation_id)
    return uc.feature_rules(compilation.ir if compilation is not None else None)


async def _entries(session: AsyncSession, version: CompositionVersion, ref: PricingWatchRef, watch: PricingWatch,
                   evaluation: CompositionEvaluation | None) -> list[uc.EntryInput]:
    bound: dict[str, str] = {}
    if evaluation is not None and evaluation.binding:
        bound = {task: f"{item['resource']}/{item['id']}" for task, item in evaluation.binding.items()}
    origins = await origins_for(session, version.revision_id) if version.revision_id is not None else []
    recipe = None
    if version.revision_id is not None:
        revision = await session.get(BindingCaseRevision, version.revision_id)
        recipe = recipe_of_revision(revision) if revision is not None else None
    entries = []
    for task in ref.tasks or []:
        item = (ref.selection or {}).get(task) or {}
        selection = Selection.of(item.get("plan") or "", item.get("addOns") or [], item.get("billing"),
                                 item.get("seats"))
        key = bound.get(task)
        rows = tuple(
            uc.Origin(row.target, row.target_kind, row.source_kind, row.value, dict(row.detail or {}))
            for row in origins if key is not None and row.candidate_key == key and row.pricing_id == watch.pricing_id
        )
        entry_recipe = None
        if recipe is not None and rows:
            recipe_task = next((t for t in recipe.tasks if t.task == task), None)
            source = None
            if recipe_task is not None:
                source = next((s for s in recipe_task.sources
                               if s.sphere is not None and s.sphere.pricing == watch.pricing_id), None)
            if recipe_task is not None and source is not None:
                entry_recipe = uc.RecipeEntry(recipe, recipe_task, source, None)
        entries.append(uc.EntryInput(task, item.get("candidate") or (key or "").split("/")[-1], selection,
                                     rows if entry_recipe is not None else (), entry_recipe))
    return entries


# -- Recording -------------------------------------------------------------------------------------------------------


@dataclass
class Recorded:
    """What one ``record`` call wrote: event ids by composition, for the notifications."""

    classified: int = 0
    inserted: list[uuid.UUID] = field(default_factory=list)
    notified: int = 0


def _insert(session: AsyncSession, values: dict[str, Any], subject: str):
    dialect = session.bind.dialect.name if session.bind is not None else "sqlite"
    builder = postgresql.insert if dialect == "postgresql" else sqlite.insert
    index = (["version_id", "watch_id", "old_ref", "new_ref"] if subject == "binding"
             else ["composition_id", "watch_id", "new_ref"])
    from sqlalchemy import text

    return (builder(CompositionUpstreamEvent).values(**values)
            .on_conflict_do_nothing(index_elements=index, index_where=text(f"subject = '{subject}'"))
            .returning(CompositionUpstreamEvent.id))


async def _event_exists(session: AsyncSession, **key: Any) -> bool:
    conditions = [getattr(CompositionUpstreamEvent, name) == value for name, value in key.items()]
    return bool(await session.scalar(select(exists().where(*conditions))))


async def lacking(session: AsyncSession, watch: PricingWatch, target: str) -> list[PricingWatchRef]:
    """The refs of ``watch`` on live versions that may still need an event against ``target`` (the catch-up set):
    binding refs whose pinned version differs from the target with no event yet, and offering refs (filtered per
    composition in Python). Equivalent pairs and pinned versions at least as new as the target are dropped in
    Python before any classifier call."""
    live = live_versions()
    binding = select(PricingWatchRef).where(
        PricingWatchRef.watch_id == watch.id, PricingWatchRef.version_id.in_(live),
        PricingWatchRef.subject == "binding",
        func.coalesce(PricingWatchRef.pinned_version_id, "-") != target,
        ~exists().where(
            CompositionUpstreamEvent.version_id == PricingWatchRef.version_id,
            CompositionUpstreamEvent.watch_id == watch.id,
            CompositionUpstreamEvent.old_ref == func.coalesce(PricingWatchRef.pinned_version_id, "-"),
            CompositionUpstreamEvent.new_ref == target,
        ),
    )
    offering = select(PricingWatchRef).where(
        PricingWatchRef.watch_id == watch.id, PricingWatchRef.version_id.in_(live),
        PricingWatchRef.subject == "offering",
        ~exists().where(
            CompositionUpstreamEvent.composition_id == PricingWatchRef.composition_id,
            CompositionUpstreamEvent.watch_id == watch.id,
            CompositionUpstreamEvent.subject == "offering",
            CompositionUpstreamEvent.new_ref == target,
        ),
    )
    rows = list((await session.scalars(binding.order_by(PricingWatchRef.created_at, PricingWatchRef.id))).all())
    rows += list((await session.scalars(offering.order_by(PricingWatchRef.created_at, PricingWatchRef.id))).all())
    order = list(watch.version_order or [])
    equivalent = {tuple(pair) for pair in (watch.equivalent or [])}
    kept = []
    for ref in rows:
        if ref.subject == "binding":
            pinned = ref.pinned_version_id
            if (pinned, target) in equivalent:
                continue
            if not target.startswith(f"{GONE}:") and pinned is not None and at_least_as_new(pinned, target, order):
                continue
        kept.append(ref)
    return kept


async def record(session: AsyncSession, watch: PricingWatch, *, budget: list[int]) -> Recorded:
    """Classify and record the events of ``watch`` (see the module docstring); ``budget[0]`` counts classifier calls
    left in the cycle. Each event commits in a short transaction of its own."""
    done = Recorded()
    target = await target_of(session, watch)
    if target is None:
        return done
    refs = await lacking(session, watch, target)
    watch_id = watch.id
    offering_seen: set[uuid.UUID] = set()
    for ref in refs:
        version_id = ref.version_id
        if budget[0] <= 0:
            break
        if ref.subject == "offering":
            if ref.composition_id in offering_seen:
                continue
            offering_seen.add(ref.composition_id)
        try:
            inserted = await (_record_offering(session, watch, ref, target, budget) if ref.subject == "offering"
                              else _record_binding(session, watch, ref, target, budget))
        except Exception:  # noqa: BLE001 - one classification never stops the cycle
            await session.rollback()
            logger.warning("upstream_classify_failed watch=%s version=%s", watch_id, version_id, exc_info=True)
            await session.execute(update(PricingWatch).where(PricingWatch.id == watch_id).values(
                classify_after=clock.after(session, CLASSIFY_RETRY_S), last_error="classify_failed",
            ).execution_options(synchronize_session=False))
            await session.commit()
            break
        if inserted is not None:
            done.classified += 1
            if inserted:
                event_id, told = inserted
                done.inserted.append(event_id)
                done.notified += told
    return done


async def _record_binding(session: AsyncSession, watch: PricingWatch, ref: PricingWatchRef, target: str,
                          budget: list[int]) -> tuple[uuid.UUID, int] | None | bool:
    version = await session.get(CompositionVersion, ref.version_id)
    if version is None:
        return None
    gone = target.startswith(f"{GONE}:")
    order = list(watch.version_order or [])
    withdrawn = not gone and bool(order) and ref.pinned_version_id is not None and ref.pinned_version_id not in order
    old_snapshot = await session.get(PricingSnapshot, ref.pinned_snapshot_id) if ref.pinned_snapshot_id else None
    new_snapshot = None
    if not gone and watch.latest_snapshot_id is not None:
        new_snapshot = await session.get(PricingSnapshot, watch.latest_snapshot_id)
    if not gone and not withdrawn and new_snapshot is None:
        return None  # the new version is not snapshotted yet
    evaluation = await _current(session, version)
    old = await _side(old_snapshot, version_id=ref.pinned_version_id, url=_permanent(watch, ref.pinned_version_id))
    new = None if gone else await _side(new_snapshot, version_id=watch.latest_version_id,
                                        url=_permanent(watch, watch.latest_version_id))
    title = (new_snapshot or old_snapshot).title if (new_snapshot or old_snapshot) is not None else None
    facts = _facts(watch, ref.sphere_ref, title, gone=gone, withdrawn=withdrawn)
    entries = await _entries(session, version, ref, watch, evaluation)
    context = uc.BindingContext(version.values_status.value, dict(evaluation.values or {}) if evaluation else {},
                                await _rules(session, version))
    budget[0] -= 1
    found = uc.classify_binding(old, new, facts, entries, context)
    await session.commit()
    return await _write(session, watch, version, ref, "binding", found, old_ref=ref.pinned_version_id or "-",
                        new_ref=target, old_snapshot=old_snapshot, new_snapshot=new_snapshot)


async def _record_offering(session: AsyncSession, watch: PricingWatch, ref: PricingWatchRef, target: str,
                           budget: list[int]) -> tuple[uuid.UUID, int] | None | bool:
    composition_id = ref.composition_id
    reference = await session.scalar(
        select(CompositionVersion).where(CompositionVersion.composition_id == composition_id)
        .order_by(CompositionVersion.ordinal.desc()).limit(1)
    )
    if reference is None:
        return None
    gone = target.startswith(f"{GONE}:")
    evaluation = await _current(session, reference)
    # The baseline: the newest of the composition's last offering event and the reference version's evaluation.
    last_event = await session.scalar(
        select(CompositionUpstreamEvent).where(
            CompositionUpstreamEvent.composition_id == composition_id, CompositionUpstreamEvent.watch_id == watch.id,
            CompositionUpstreamEvent.subject == "offering", CompositionUpstreamEvent.new_snapshot_id.is_not(None),
        ).order_by(CompositionUpstreamEvent.detected_at.desc()).limit(1)
    )
    candidates = []
    if last_event is not None:
        candidates.append(await session.get(PricingSnapshot, last_event.new_snapshot_id))
    if evaluation is not None and evaluation.offering_snapshot_id is not None:
        candidates.append(await session.get(PricingSnapshot, evaluation.offering_snapshot_id))
    candidates = [c for c in candidates if c is not None]
    baseline = max(candidates, key=lambda s: s.fetched_at) if candidates else None
    new_snapshot = await session.get(PricingSnapshot, watch.latest_snapshot_id) if (
        not gone and watch.latest_snapshot_id) else None
    if not gone and (new_snapshot is None or baseline is None):
        return None
    if not gone and (baseline.id == new_snapshot.id or baseline.content_hash == new_snapshot.content_hash):
        return None
    if await _event_exists(session, composition_id=composition_id, watch_id=watch.id, subject="offering",
                           new_ref=target):
        return None
    old = await _side(baseline, url=_permanent(watch, baseline.version_id if baseline else None))
    new = None if gone else await _side(new_snapshot, url=_permanent(watch, new_snapshot.version_id))
    margins = []
    environments = (await session.execute(
        select(CompositionEnvironment, CompositionAdoption).join(
            CompositionAdoption, (CompositionAdoption.environment_id == CompositionEnvironment.id)
            & (CompositionAdoption.ordinal == CompositionEnvironment.adoption_ordinal)
        ).where(CompositionEnvironment.composition_id == composition_id,
                CompositionEnvironment.adopted_version_id.is_not(None))
        .order_by(CompositionEnvironment.slug)
    )).all()
    for environment, adoption in environments:
        adopted_evaluation = await session.get(CompositionEvaluation, adoption.evaluation_id)
        adopted_version = await session.get(CompositionVersion, adoption.version_id)
        if adopted_evaluation is None or adopted_version is None:
            continue
        margins.append(uc.MarginInput(
            dict(adopted_evaluation.values or {}), adopted_version.values_status.value,
            adopted_evaluation.outcome.value, environment.expected_users, environment.slug, adoption.ordinal,
            str(adopted_evaluation.id), adopted_version.label,
        ))
    latest = None
    if evaluation is not None:
        latest = uc.MarginInput(dict(evaluation.values or {}), reference.values_status.value,
                                evaluation.outcome.value, None, version=reference.label)
    title = (new_snapshot or baseline).title if (new_snapshot or baseline) else None
    facts = _facts(watch, ref.sphere_ref, title, gone=gone)
    budget[0] -= 1
    found = uc.classify_offering(old, new, facts, margins, latest)
    await session.commit()
    if found is None:
        return None
    return await _write(session, watch, reference, ref, "offering", found, old_ref=_ref_of_snapshot(baseline) or "-",
                        new_ref=target, old_snapshot=baseline, new_snapshot=new_snapshot)


async def _write(session: AsyncSession, watch: PricingWatch, version: CompositionVersion, ref: PricingWatchRef,
                 subject: str, found: uc.Classification, *, old_ref: str, new_ref: str,
                 old_snapshot: PricingSnapshot | None, new_snapshot: PricingSnapshot | None) -> tuple[uuid.UUID, int] | bool:
    """Insert the event in a short transaction under the composition's ``FOR SHARE`` lock; ``False`` when another
    writer recorded it first."""
    composition = await session.scalar(
        select(Composition).where(Composition.id == version.composition_id).with_for_update(read=True)
    )
    if composition is None:
        await session.rollback()
        return False
    state = "open"
    stamps: dict[str, Any] = {}
    notify = found.notify
    if subject == "binding":
        resolver = await _resolver(session, version.composition_id, version.ordinal, watch, new_ref)
        if resolver is not None:
            state = "resolved"
            stamps = {"resolved_by_version_id": resolver.id, "resolved_by_id": resolver.created_by_id,
                      "resolved_at": clock.now(session)}
            # Told only when the affected version is adopted somewhere the resolving one is not.
            notify = notify and bool(await _adopted_where(session, version.id) - await _adopted_where(session, resolver.id))
    diff = dict(found.diff)
    values = {
        "id": uuid.uuid4(), "organization_id": composition.organization_id, "composition_id": composition.id,
        "version_id": version.id, "watch_id": watch.id, "subject": subject, "tasks": list(ref.tasks or []),
        "category": found.category.value, "reasons": list(found.reasons), "notify": notify,
        "old_ref": old_ref[:80], "new_ref": new_ref[:80],
        "old_version_id": old_snapshot.version_id if old_snapshot is not None else (
            old_ref if len(old_ref) == 24 else None),
        "new_version_id": new_snapshot.version_id if new_snapshot is not None else None,
        "old_label": ((old_snapshot.version_label if old_snapshot else None) or (diff.get("old") or {}).get("label")),
        "new_label": ((new_snapshot.version_label if new_snapshot else None) or (diff.get("new") or {}).get("label")),
        "old_snapshot_id": old_snapshot.id if old_snapshot is not None else None,
        "new_snapshot_id": new_snapshot.id if new_snapshot is not None else None,
        "diff": diff, "classifier": uc.CLASSIFIER_VERSION, "state": state, "note": "",
        "detected_at": clock.now(session), **stamps,
    }
    inserted = (await session.execute(_insert(session, values, subject))).scalar_one_or_none()
    told = 0
    if inserted is not None:
        logger.info("upstream_event_created id=%s category=%s composition=%s", inserted, found.category.value,
                    composition.id)
        told = await notify_inserted(session, [inserted])
    await session.commit()
    return (inserted, told) if inserted is not None else False


async def notify_inserted(session: AsyncSession, event_ids: list[uuid.UUID]) -> int:
    """Tell the members who can act about newly inserted events (A13); in the events' transaction."""
    return 0


# -- Resolution on seal (A11) ----------------------------------------------------------------------------------------


async def resolve_on_seal(session: AsyncSession, composition: Composition, version: CompositionVersion,
                          actor: Any) -> list[uuid.UUID]:
    """Resolve the composition's open and reviewed binding events that ``version`` pins (rules a and b)."""
    events = (await session.scalars(
        select(CompositionUpstreamEvent).where(
            CompositionUpstreamEvent.composition_id == composition.id,
            CompositionUpstreamEvent.state.in_(("open", "reviewed")),
            CompositionUpstreamEvent.subject == "binding",
        ).order_by(CompositionUpstreamEvent.detected_at, CompositionUpstreamEvent.id)
    )).all()
    if not events:
        return []
    watches_by_id: dict[uuid.UUID, PricingWatch] = {}
    pins_by_watch: dict[uuid.UUID, set[str]] = {}
    resolved = []
    for event in events:
        watch = watches_by_id.get(event.watch_id) or await session.get(PricingWatch, event.watch_id)
        if watch is None:
            continue
        watches_by_id[watch.id] = watch
        if watch.id not in pins_by_watch:
            pins_by_watch[watch.id] = await pins_of(session, version, watch)
        if resolves(pins_by_watch[watch.id], event.new_ref, list(watch.version_order or [])):
            changed = await session.execute(
                update(CompositionUpstreamEvent).where(
                    CompositionUpstreamEvent.id == event.id,
                    CompositionUpstreamEvent.state.in_(("open", "reviewed")),
                ).values(state="resolved", resolved_by_version_id=version.id, resolved_by_id=actor.id,
                         resolved_at=clock.now(session))
                .returning(CompositionUpstreamEvent.id).execution_options(synchronize_session=False)
            )
            if changed.first() is not None:
                resolved.append(event.id)
    return resolved


__all__ = [
    "Recorded",
    "lacking",
    "notify_inserted",
    "pins_of",
    "record",
    "resolve_on_seal",
    "resolves",
    "target_of",
]

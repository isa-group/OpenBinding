"""The upstream watcher (F6, plan §6): polls watched pricings in one gateway replica at a time.

**Where it runs.** ``run_upstream_watcher`` is a second task of the gateway lifespan, beside the job reconciler
(the worker has no pricing source and no scheduler). Every replica starts it; each cycle takes
``pg_try_advisory_xact_lock(UPSTREAM_WATCH_LOCK_KEY)`` with the reconciler's helper and a replica without the lock
skips the cycle. It reads through the process's one pricing source, sharing its cache and windows. The loop sleeps
``clamp(interval / 10, 5 s, 30 s)`` between cycles.

**One cycle** (``run_cycle``; ``tools/poll_upstream.py --once`` calls the same function):

0. housekeeping (F6-B closes interrupted proposals here);
1. claim due watches that a live version references, ``FOR UPDATE SKIP LOCKED``, pushing ``next_poll_at`` a lease
   ahead (a crashed leader's claim expires); ``force`` ignores ``next_poll_at``, never ``retry_after_until``;
2. an organization-scoped watch reads with the organization's key; a missing key, or one rejected during the read
   (the adapter would answer anonymously), is ``credential_missing``: our configuration, not an upstream change;
3. read the manifest with ``If-None-Match`` and ``revalidate=True`` (a ``url`` watch: ``snapshot_url``);
4. write each outcome in a short transaction: ``NotModified`` refreshes ``observed_at``; a manifest stores the ETag,
   the whole version order and the latest version, then snapshots a new latest in a fresh session (passing the
   manifest already read), then points ``latest_snapshot_id`` at it; a 429 closes the watch's **bucket** (all public
   watches, one registry's, or one organization's) until ``Retry-After`` in the database; a failure backs off
   exponentially; a 404 from a request actually sent counts towards ``gone``, confirmed only by a second one at least
   an interval later by the database clock (``not_found_since``; ``gone_epoch`` + 1 in the same conditional UPDATE);
5. at most ``UPSTREAM_READS_PER_CYCLE`` requests are sent; the rest of the claim is handed back due;
6. classify (``upstream_events.record``, A10);
6b. resolve due unresolved references (``pricing_ref_attempts``), at most ``UPSTREAM_RESOLVE_PER_CYCLE``, one family
   per organization, with their own exponential back-off.

Every SPHERE request runs only when both ``SPHERE_ENABLED`` and ``UPSTREAM_WATCH_ENABLED`` are on. The watcher creates
no run, problem revision, composition version, evaluation, adoption, environment or proposal (invariant W): it
writes snapshots (as a system read), watch state, refs it resolves late, the attempts schedule, events and
notifications. It imports nothing that could seal, derive, adopt or run (``tests/compositions/test_upstream_watcher``).
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import and_, case, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ....composition.document import Provenance
from ....core.settings import Settings, get_settings
from ....db import base as db_base
from ....db.models import PricingRefAttempt, PricingSnapshot, PricingWatch, PricingWatchRef
from ....jobs import clock
from ....jobs.reconciler import acquire_cycle_lock
from ...plans.application import (
    Credential,
    Manifest,
    NotModified,
    PricingError,
    PricingInvalid,
    PricingNotFound,
    PricingSource,
    PricingSourceBusy,
    PricingSourceUnavailable,
    SphereEndpoint,
    credential_for,
    get_pricing_source,
    snapshot_url,
    snapshot_version,
)
from . import upstream_events, watches
from .upstream import resolve_provenance

logger = logging.getLogger(__name__)

#: The advisory lock of one watcher cycle (the reconciler's is ``0x0B1D_5EC0_0001``).
UPSTREAM_WATCH_LOCK_KEY = 0x0B1D_5EC0_0002
#: How long a claimed watch is held before another replica may claim it again.
LEASE_S = 120
#: The shortest bucket back-off after a 429.
MIN_BUSY_S = 5
#: Reads one watch may need (a manifest, a version's YAML, a family read).
READS_PER_WATCH = 3
#: Reads one attempt to resolve a reference may need.
READS_PER_ATTEMPT = 3


def tick_of(interval_s: float) -> float:
    return min(30.0, max(5.0, interval_s / 10))


def phase_of(watch_id: uuid.UUID, interval_s: int) -> int:
    """The watch's stagger phase in the interval: SPACE's pattern, from the last six hex digits of its id."""
    return int(watch_id.hex[-6:], 16) % max(1, int(interval_s))


def next_slot(now: datetime, interval_s: int, phase: int) -> datetime:
    """The first whole second strictly after ``now`` that is ``phase`` modulo ``interval_s`` (epoch seconds)."""
    interval_s = max(1, int(interval_s))
    seconds = now.timestamp()
    slot = math.floor(seconds) - (math.floor(seconds) % interval_s) + phase
    while slot <= seconds:
        slot += interval_s
    return datetime.fromtimestamp(slot, tz=timezone.utc)


@dataclass
class CycleReport:
    claimed: int = 0
    not_modified: int = 0
    new_versions: int = 0
    busy: int = 0
    unavailable: int = 0
    gone: int = 0
    credential_rejected: int = 0
    reads: int = 0
    classified: int = 0
    events: int = 0
    notified: int = 0
    ref_attempts: int = 0
    refs_resolved: int = 0
    closed_proposals: int = 0
    ms: int = 0
    skipped: str | None = None
    watches: list[dict[str, Any]] = field(default_factory=list)

    @property
    def working(self) -> bool:
        return bool(self.claimed or self.classified or self.ref_attempts or self.closed_proposals)

    def line(self) -> str:
        parts = [f"{name}={getattr(self, name)}" for name in (
            "claimed", "not_modified", "new_versions", "busy", "unavailable", "gone", "credential_rejected", "reads",
            "classified", "events", "notified", "ref_attempts", "refs_resolved", "closed_proposals", "ms",
        )]
        return "upstream_watch_cycle " + " ".join(parts)

    def as_json(self) -> dict[str, Any]:
        return asdict(self)


class _Counting:
    """The pricing source, counting every read sent through it (the cycle's budget)."""

    def __init__(self, source: PricingSource) -> None:
        self._source = source
        self.sent = 0

    def __getattr__(self, name: str) -> Any:
        target = getattr(self._source, name)
        if name in {"manifest", "version_yaml", "family", "url_yaml", "search", "organization"}:
            async def counted(*args: Any, **kwargs: Any) -> Any:
                self.sent += 1
                return await target(*args, **kwargs)

            return counted
        return target


def _bucket(watch: PricingWatch) -> str:
    if watch.source_kind == "registry":
        return f"registry:{watch.registry}"
    if watch.organization_id is not None:
        return f"org:{watch.organization_id}"
    return "public"


def _bucket_condition(watch: PricingWatch) -> Any:
    if watch.source_kind == "registry":
        return and_(PricingWatch.source_kind == "registry", PricingWatch.registry == watch.registry)
    if watch.organization_id is not None:
        return PricingWatch.organization_id == watch.organization_id
    return and_(PricingWatch.scope_key == "public", PricingWatch.source_kind == "sphere")


# -- Claim -----------------------------------------------------------------------------------------------------------


async def claim_due(session: AsyncSession, batch: int, *, force: bool = False) -> list[uuid.UUID]:
    """Claim at most ``batch`` due watches with a live reference, pushing them a lease ahead; committed."""
    now = clock.now(session)
    query = select(PricingWatch.id).where(
        or_(PricingWatch.retry_after_until.is_(None), PricingWatch.retry_after_until <= now),
        watches.live_ref_exists(PricingWatch.id),
    )
    if not force:
        query = query.where(PricingWatch.next_poll_at <= now)
    query = query.order_by(PricingWatch.next_poll_at, PricingWatch.id).limit(batch)
    if clock.uses_db_clock(session):
        query = query.with_for_update(skip_locked=True, of=PricingWatch)
    ids = list((await session.scalars(query)).all())
    if ids:
        await session.execute(
            update(PricingWatch).where(PricingWatch.id.in_(ids))
            .values(next_poll_at=clock.after(session, LEASE_S)).execution_options(synchronize_session=False)
        )
    await session.commit()
    return ids


async def _give_back(factory: Callable[[], AsyncSession], ids: list[uuid.UUID]) -> None:
    if not ids:
        return
    async with factory() as session:
        await session.execute(update(PricingWatch).where(PricingWatch.id.in_(ids))
                              .values(next_poll_at=clock.now(session)).execution_options(synchronize_session=False))
        await session.commit()


# -- Outcomes --------------------------------------------------------------------------------------------------------


async def _write(factory, watch_id: uuid.UUID, **values: Any) -> None:
    async with factory() as session:
        await session.execute(update(PricingWatch).where(PricingWatch.id == watch_id).values(**values)
                              .execution_options(synchronize_session=False))
        await session.commit()


async def _observed(factory, watch: PricingWatch, interval: int, **values: Any) -> None:
    async with factory() as session:
        now = clock.now(session)
        moment = await clock.read_now(session)
        await session.execute(update(PricingWatch).where(PricingWatch.id == watch.id).values(
            status="active", observed_at=now, polled_at=now, failures=0, not_found_count=0, not_found_since=None,
            next_poll_at=next_slot(moment, interval, phase_of(watch.id, interval)), **values,
        ).execution_options(synchronize_session=False))
        await session.commit()


async def _failed(factory, watch: PricingWatch, settings: Settings, reason: str) -> None:
    interval = settings.upstream_poll_interval_s
    failures = watch.failures + 1
    delay = min(interval * 2 ** min(failures, 4), settings.upstream_failure_backoff_max_s)
    async with factory() as session:
        await session.execute(update(PricingWatch).where(PricingWatch.id == watch.id).values(
            failures=PricingWatch.failures + 1, status="unavailable", last_error=reason[:80],
            polled_at=clock.now(session), next_poll_at=clock.after(session, delay),
        ).execution_options(synchronize_session=False))
        await session.commit()


async def _busy(factory, watch: PricingWatch, retry_after: int) -> None:
    """A 429: this watch and every watch of its bucket wait until ``Retry-After`` (persisted, bucket-wide)."""
    hold = max(int(retry_after), MIN_BUSY_S)
    async with factory() as session:
        until = clock.after(session, hold)
        await session.execute(update(PricingWatch).where(_bucket_condition(watch)).values(
            retry_after_until=case(
                (and_(PricingWatch.retry_after_until.is_not(None), PricingWatch.retry_after_until > until),
                 PricingWatch.retry_after_until),
                else_=until,
            ),
            last_error="sphere_busy",
        ).execution_options(synchronize_session=False))
        await session.execute(update(PricingWatch).where(PricingWatch.id == watch.id).values(
            polled_at=clock.now(session), next_poll_at=until,
        ).execution_options(synchronize_session=False))
        await session.commit()


async def _not_found(factory, watch: PricingWatch, settings: Settings) -> bool:
    """A 404 from a request actually sent: ``not_found``, or ``gone`` when confirmed (one conditional UPDATE, by the
    database clock). Whether this read confirmed the disappearance."""
    interval = settings.upstream_poll_interval_s
    async with factory() as session:
        now = clock.now(session)
        since = func.coalesce(PricingWatch.not_found_since, now)
        confirmed = and_(
            PricingWatch.status != "gone",
            PricingWatch.not_found_count + 1 >= settings.upstream_not_found_confirmations,
            since <= clock.before(session, interval),
        )
        moment = await clock.read_now(session)
        row = (await session.execute(update(PricingWatch).where(PricingWatch.id == watch.id).values(
            not_found_count=PricingWatch.not_found_count + 1,
            not_found_since=since,
            status=case((confirmed, "gone"), (PricingWatch.status == "gone", "gone"), else_="not_found"),
            gone_epoch=case((confirmed, PricingWatch.gone_epoch + 1), else_=PricingWatch.gone_epoch),
            last_error="not_found",
            polled_at=now,
            next_poll_at=next_slot(moment, interval, phase_of(watch.id, interval)),
        ).returning(PricingWatch.status, PricingWatch.gone_epoch).execution_options(synchronize_session=False))).first()
        await session.commit()
    return row is not None and row.status == "gone" and row.gone_epoch > watch.gone_epoch


async def _rewritten(factory, watch: PricingWatch, manifest: Manifest) -> bool:
    """Whether a pinned version this watch's refs name changed its ``contentHash`` (same id), on a snapshot whose
    stored hash was verified against its bytes; unverified snapshots (the Q3 divergence) never say so."""
    async with factory() as session:
        rows = (await session.execute(
            select(PricingSnapshot.version_id, PricingSnapshot.content_hash)
            .join(PricingWatchRef, PricingWatchRef.pinned_snapshot_id == PricingSnapshot.id)
            .where(PricingWatchRef.watch_id == watch.id, PricingSnapshot.content_hash_verified.is_(True))
            .distinct()
        )).all()
    for version_id, stored in rows:
        entry = manifest.version(version_id) if version_id else None
        if entry is not None and entry.content_hash and entry.content_hash != stored:
            logger.warning("upstream_content_rewritten watch=%s version=%s", watch.id, version_id)
            return True
    return False


# -- Polling one watch -----------------------------------------------------------------------------------------------


async def _credential(factory, watch: PricingWatch) -> tuple[Credential | None, list[bool], bool]:
    """``(credential, rejected flag, missing)`` for an organization-scoped watch; anonymous otherwise."""
    if watch.organization_id is None or watch.source_kind != "sphere":
        return None, [], False
    async with factory() as session:
        found = await credential_for(session, watch.organization_id)
        await session.commit()
    if found is None:
        return None, [], True
    rejected: list[bool] = []
    original = found.on_rejected

    async def on_rejected() -> None:
        rejected.append(True)
        if original is not None:
            await original()

    return Credential(found.organization_id, found.api_key, on_rejected), rejected, False


async def poll_watch(
    factory, source: _Counting, watch: PricingWatch, settings: Settings, report: CycleReport,
) -> None:
    interval = settings.upstream_poll_interval_s
    if watch.source_kind == "url":
        await _poll_url(factory, source, watch, settings, report)
        return
    if watch.source_kind == "registry" and watch.registry not in set(source.registries()):
        await _write(factory, watch.id, status="registry_unknown", last_error="registry_unknown")
        await _observed_schedule(factory, watch, interval)
        return
    credential, rejected, missing = await _credential(factory, watch)
    if missing:
        await _write(factory, watch.id, status="credential_missing", last_error="credential_missing")
        await _observed_schedule(factory, watch, interval)
        return
    where = SphereEndpoint(watch.registry)
    assert watch.pricing_id is not None
    try:
        answer = await source.manifest(where, watch.pricing_id, credential, if_none_match=watch.manifest_etag,
                                       revalidate=True)
    except PricingSourceBusy as exc:
        report.busy += 1
        await _busy(factory, watch, exc.retry_after)
        raise _Closed(_bucket(watch)) from exc
    except PricingNotFound:
        if rejected:
            report.credential_rejected += 1
            await _write(factory, watch.id, status="credential_missing", last_error="credential_rejected")
            await _observed_schedule(factory, watch, interval)
            return
        if await _not_found(factory, watch, settings):
            report.gone += 1
        return
    except PricingSourceUnavailable as exc:
        report.unavailable += 1
        await _failed(factory, watch, settings, f"sphere_{exc.reason}")
        return
    except PricingError as exc:
        report.unavailable += 1
        await _failed(factory, watch, settings, type(exc).__name__.lower())
        return
    if rejected:
        report.credential_rejected += 1
        await _write(factory, watch.id, status="credential_missing", last_error="credential_rejected")
        await _observed_schedule(factory, watch, interval)
        return
    if isinstance(answer, NotModified):
        report.not_modified += 1
        await _observed(factory, watch, interval, last_error=None)
        return
    await _manifest(factory, source, watch, answer, credential, settings, report)


class _Closed(Exception):
    """The watch's bucket answered 429: the cycle stops reading that bucket."""

    def __init__(self, bucket: str) -> None:
        super().__init__(bucket)
        self.bucket = bucket


async def _observed_schedule(factory, watch: PricingWatch, interval: int) -> None:
    async with factory() as session:
        moment = await clock.read_now(session)
        await session.execute(update(PricingWatch).where(PricingWatch.id == watch.id).values(
            polled_at=clock.now(session), next_poll_at=next_slot(moment, interval, phase_of(watch.id, interval)),
        ).execution_options(synchronize_session=False))
        await session.commit()


async def _manifest(
    factory, source: _Counting, watch: PricingWatch, manifest: Manifest, credential: Credential | None,
    settings: Settings, report: CycleReport,
) -> None:
    order = [entry.version_id for entry in manifest.newest_first()]
    rewritten = await _rewritten(factory, watch, manifest)
    previous = watch.latest_version_id
    # 1. The manifest's facts, committed before any snapshot read (snapshot_version manages its own transactions).
    await _observed(
        factory, watch, settings.upstream_poll_interval_s, manifest_etag=(manifest.etag or "")[:200] or None,
        version_order=order, latest_version_id=manifest.latest_version_id,
        last_error="content_rewritten" if rewritten else None,
    )
    latest = manifest.latest_version_id
    if latest == previous and watch.latest_snapshot_id is not None:
        return  # the same latest: a rename of the family, or nothing at all
    if previous is not None and latest != previous:
        report.new_versions += 1
    # 2. Snapshot the latest in a fresh session, with the manifest already read (no second manifest request).
    organization_id = watch.organization_id
    try:
        async with factory() as session:
            taken = await snapshot_version(
                session, organization_id, SphereEndpoint(watch.registry), watch.pricing_id or "", latest, credential,
                actor_id=None, source=source, manifest=manifest,
            )
            snapshot_id = taken.snapshot.id
    except PricingSourceBusy as exc:
        report.busy += 1
        await _busy(factory, watch, exc.retry_after)
        raise _Closed(_bucket(watch)) from exc
    except (PricingSourceUnavailable, PricingNotFound) as exc:
        report.unavailable += 1
        await _failed(factory, watch, settings, f"snapshot_{getattr(exc, 'reason', 'not_found')}")
        return
    except PricingInvalid:
        # The snapshot is not stored: the classifier says ``pricing_unreadable`` from the manifest's facts.
        await _write(factory, watch.id, last_error="invalid")
        return
    # 3. The watch points at it.
    await _write(factory, watch.id, latest_snapshot_id=snapshot_id)


async def _poll_url(factory, source: _Counting, watch: PricingWatch, settings: Settings, report: CycleReport) -> None:
    interval = settings.upstream_poll_interval_s
    assert watch.organization_id is not None and watch.url is not None
    try:
        async with factory() as session:
            taken = await snapshot_url(session, watch.organization_id, watch.url, actor_id=None, source=source)
            snapshot_id, change, etag, modified = (taken.snapshot.id, taken.change, taken.snapshot.etag,
                                                   taken.snapshot.last_modified)
    except PricingSourceBusy as exc:
        report.busy += 1
        await _busy(factory, watch, exc.retry_after)
        raise _Closed(_bucket(watch)) from exc
    except PricingNotFound:
        if await _not_found(factory, watch, settings):
            report.gone += 1
        return
    except PricingInvalid:
        report.unavailable += 1
        await _failed(factory, watch, settings, "invalid")
        return
    except PricingError as exc:
        report.unavailable += 1
        await _failed(factory, watch, settings, f"url_{getattr(exc, 'reason', 'unavailable')}")
        return
    if change in ("reused", "same") and watch.latest_snapshot_id == snapshot_id:
        report.not_modified += 1
    elif watch.latest_snapshot_id is not None and watch.latest_snapshot_id != snapshot_id:
        report.new_versions += 1
    await _observed(factory, watch, interval, latest_snapshot_id=snapshot_id, manifest_etag=etag,
                    last_modified=modified, last_error=None)


# -- Unresolved references (step 6b) ---------------------------------------------------------------------------------


def _split_ref(sphere_ref: str) -> tuple[str | None, str]:
    head, sep, rest = sphere_ref.partition(":")
    if sep and "/" not in head:
        return head, rest
    return None, sphere_ref


async def resolve_attempts(factory, settings: Settings, report: CycleReport, budget: list[int]) -> None:
    async with factory() as session:
        due = await watches.due_ref_attempts(session, settings.upstream_resolve_per_cycle)
        due = [(row.id, row.organization_id, row.sphere_ref, row.pinned_version_id, row.failures) for row in due]
        await session.commit()
    for attempt_id, organization_id, sphere_ref, pinned, failures in due:
        if budget[0] < READS_PER_ATTEMPT:
            break
        budget[0] -= READS_PER_ATTEMPT
        report.ref_attempts += 1
        registry, sphere = _split_ref(sphere_ref)
        found: dict[str, uuid.UUID] = {}
        async with factory() as session:
            try:
                found = await resolve_provenance(
                    session, organization_id, [Provenance(sphere, pinned, None, registry)], actor_id=None,
                    network_limit=1,
                )
            except Exception:  # noqa: BLE001 - resolve_provenance already swallows what SPHERE answers
                logger.warning("upstream_ref_attempt_failed attempt=%s", attempt_id, exc_info=True)
            snapshot = await session.get(PricingSnapshot, found[pinned]) if pinned in found else None
            if snapshot is not None and snapshot.pricing_id:
                watch = await watches.watch_of_snapshot(session, snapshot)
                for ref in await watches.unresolved_refs(session, organization_id, sphere_ref, pinned):
                    resolved = PricingWatchRef(
                        organization_id=ref.organization_id, composition_id=ref.composition_id,
                        version_id=ref.version_id, watch_id=watch.id, subject=ref.subject, via=ref.via,
                        sphere_ref=ref.sphere_ref, tasks=list(ref.tasks), pinned_version_id=ref.pinned_version_id,
                        pinned_snapshot_id=snapshot.id, selection=dict(ref.selection),
                        ref_key=f"{watch.id}|{ref.subject}|{ref.pinned_version_id or '-'}"[:200],
                    )
                    session.add(resolved)
                    report.refs_resolved += 1
                await session.execute(delete(PricingRefAttempt).where(PricingRefAttempt.id == attempt_id))
                await session.commit()
                continue
            delay = min(settings.upstream_poll_interval_s * 2 ** (failures + 1), settings.upstream_resolve_backoff_max_s)
            await session.execute(update(PricingRefAttempt).where(PricingRefAttempt.id == attempt_id).values(
                failures=PricingRefAttempt.failures + 1, last_error="not_found",
                next_attempt_at=clock.after(session, delay),
            ).execution_options(synchronize_session=False))
            await session.commit()


# -- The cycle -------------------------------------------------------------------------------------------------------


async def housekeeping(factory, report: CycleReport) -> None:
    """Closing executions a person started that were interrupted (F6-B's proposals); nothing before them."""
    return None


def polling_enabled(settings: Settings) -> bool:
    return bool(settings.upstream_watch_enabled and settings.sphere_enabled)


async def classify(factory, settings: Settings, report: CycleReport, polled: list[uuid.UUID]) -> None:
    """Step 6: record classified events for the watches read this cycle, then the catch-up set (every watch with a
    live ref, oldest observation first, so none starves); ``UPSTREAM_CLASSIFY_PER_CYCLE`` counts classifier calls."""
    budget = [settings.upstream_classify_per_cycle]
    async with factory() as session:
        now = clock.now(session)
        others = list((await session.scalars(
            select(PricingWatch.id).where(
                watches.live_ref_exists(PricingWatch.id),
                or_(PricingWatch.classify_after.is_(None), PricingWatch.classify_after <= now),
                or_(PricingWatch.latest_version_id.is_not(None), PricingWatch.latest_snapshot_id.is_not(None),
                    PricingWatch.status == "gone"),
            ).order_by(PricingWatch.observed_at.asc().nulls_first(), PricingWatch.id)
        )).all())
        await session.commit()
    order = list(dict.fromkeys([*polled, *others]))
    for watch_id in order:
        if budget[0] <= 0:
            break
        async with factory() as session:
            watch = await session.get(PricingWatch, watch_id)
            if watch is None:
                continue
            if watch.classify_after is not None and watch_id in polled:
                moment = await clock.read_now(session)
                after = watch.classify_after if watch.classify_after.tzinfo else watch.classify_after.replace(
                    tzinfo=timezone.utc)
                current = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
                if after > current:
                    continue
            done = await upstream_events.record(session, watch, budget=budget)
            report.classified += done.classified
            report.events += len(done.inserted)
            report.notified += done.notified


async def run_cycle(
    factory: Callable[[], AsyncSession], source: PricingSource | None = None, *, force: bool = False,
    settings: Settings | None = None,
) -> CycleReport:
    """One watcher cycle (see the module docstring); the report is logged when the cycle did any work."""
    started = time.monotonic()
    settings = settings or get_settings()
    report = CycleReport()
    await housekeeping(factory, report)
    if not polling_enabled(settings):
        report.skipped = "disabled"
        logger.debug("upstream_watch_skipped reason=disabled")
        report.ms = int((time.monotonic() - started) * 1000)
        return report
    counting = _Counting(source or get_pricing_source())
    async with factory() as session:
        claimed = await claim_due(session, settings.upstream_poll_batch, force=force)
    report.claimed = len(claimed)
    closed: set[str] = set()
    polled: list[uuid.UUID] = []
    remaining = list(claimed)
    while remaining:
        watch_id = remaining.pop(0)
        if settings.upstream_reads_per_cycle - counting.sent < READS_PER_WATCH:
            await _give_back(factory, [watch_id, *remaining])
            break
        async with factory() as session:
            watch = await session.get(PricingWatch, watch_id)
            await session.commit()
        if watch is None:
            continue
        if _bucket(watch) in closed:
            await _give_back(factory, [watch_id])
            continue
        try:
            await poll_watch(factory, counting, watch, settings, report)
            polled.append(watch_id)
        except _Closed as stop:
            closed.add(stop.bucket)
        except Exception:  # noqa: BLE001 - one watch never stops the cycle
            logger.exception("upstream_watch_failed watch=%s", watch_id)
    await classify(factory, settings, report, polled)
    budget = [max(0, settings.upstream_reads_per_cycle - counting.sent)]
    await resolve_attempts(factory, settings, report, budget)
    report.reads = counting.sent + report.ref_attempts * READS_PER_ATTEMPT
    report.ms = int((time.monotonic() - started) * 1000)
    if report.working:
        logger.info(report.line())
    return report


async def status(session: AsyncSession, settings: Settings | None = None) -> dict[str, Any]:
    """The ``upstreamWatch`` block of ``/v1/admin/queues``, from the tables (any replica answers it)."""
    from ....db.models import CompositionUpstreamEvent

    settings = settings or get_settings()
    now = await clock.read_now(session)
    live = watches.live_ref_exists(PricingWatch.id)
    rows = (await session.execute(select(PricingWatch.status, live.label("live"), func.count())
                                  .group_by(PricingWatch.status, live))).all()
    counts = {name: 0 for name in ("pending", "active", "unavailable", "not_found", "gone", "credential_missing",
                                   "registry_unknown", "idle")}
    for state, has_live, count in rows:
        counts["idle" if not has_live else state] = counts.get("idle" if not has_live else state, 0) + int(count)
    due_filter = and_(live, PricingWatch.next_poll_at <= clock.now(session),
                      or_(PricingWatch.retry_after_until.is_(None), PricingWatch.retry_after_until <= clock.now(session)))
    due = int(await session.scalar(select(func.count()).select_from(PricingWatch).where(due_filter)) or 0)
    oldest = await session.scalar(select(func.min(PricingWatch.next_poll_at)).where(due_filter))
    observed = await session.scalar(select(func.max(PricingWatch.observed_at)))
    day = (await session.execute(
        select(CompositionUpstreamEvent.category, func.count()).where(
            CompositionUpstreamEvent.detected_at >= clock.before(session, 86400)
        ).group_by(CompositionUpstreamEvent.category)
    )).all()
    unresolved = int(await session.scalar(select(func.count()).select_from(PricingRefAttempt)) or 0)

    def aware(value: datetime | None) -> datetime | None:
        if value is None:
            return None
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

    oldest_at = aware(oldest)
    current = aware(now)
    return {
        "enabled": polling_enabled(settings),
        "intervalSeconds": settings.upstream_poll_interval_s,
        "watches": {
            "pending": counts["pending"], "active": counts["active"], "unavailable": counts["unavailable"],
            "notFound": counts["not_found"], "gone": counts["gone"], "credentialMissing": counts["credential_missing"],
            "registryUnknown": counts["registry_unknown"], "idle": counts["idle"],
        },
        "due": due,
        "oldestDueSeconds": max(0, int((current - oldest_at).total_seconds())) if oldest_at and current else None,
        "lastObservedAt": aware(observed).isoformat() if observed else None,
        "eventsLastDay": {category: int(count) for category, count in day},
        "unresolvedRefs": unresolved,
        "executingProposals": 0,
    }


async def run_upstream_watcher(settings: Settings | None = None) -> None:
    """Run cycles until cancelled (the gateway lifespan); errors are logged and the loop continues."""
    settings = settings or get_settings()
    tick = tick_of(settings.upstream_poll_interval_s)
    if not polling_enabled(settings):
        # Said once at start, where an operator reads it: housekeeping still runs, nothing upstream is read.
        logger.info("upstream_watch_skipped reason=disabled sphere_enabled=%s upstream_watch_enabled=%s",
                    settings.sphere_enabled, settings.upstream_watch_enabled)
    while True:
        try:
            await asyncio.sleep(tick)
            if not db_base.is_configured():
                continue
            factory = db_base.session_factory()
            async with factory() as lock_session:
                if not await acquire_cycle_lock(lock_session, UPSTREAM_WATCH_LOCK_KEY):
                    logger.debug("upstream_watch_skipped reason=lock")
                    continue
                await run_cycle(factory, settings=settings)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("The upstream watcher cycle failed; continuing")


__all__ = [
    "LEASE_S",
    "UPSTREAM_WATCH_LOCK_KEY",
    "CycleReport",
    "claim_due",
    "next_slot",
    "phase_of",
    "poll_watch",
    "run_cycle",
    "run_upstream_watcher",
    "tick_of",
]

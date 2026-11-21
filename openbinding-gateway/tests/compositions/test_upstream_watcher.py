"""The upstream watcher's cycle (F6 A9), on SQLite with a frozen clock and the recorded SPHERE.

``jobs.clock.utcnow`` is the watcher's clock on SQLite and the adapter has its own (``SphereHttpSource(clock=)``); both
are moved by hand, nothing sleeps. Network is forbidden: every read is the recorded SPHERE's or scripted.
"""

from __future__ import annotations

import ast
import json
from datetime import timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from _b1_helpers import gate  # noqa: F401
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import PricingRefAttempt, PricingSnapshot, PricingWatch, PricingWatchRef
from openbinding_gateway.modules.compositions.application import upstream_watcher as uw
from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource

from ._tomatometer import BREVO, BREVO_2026_10, DROPBOX, RESEND, TOMATOMETER, seeded
from ._watching import START, cycle, settings as _settings

pytestmark = pytest.mark.asyncio
BREVO_MANIFEST = f"/api/v1/public/pricings/{BREVO}"


async def _cycle(db_session, source, *, force: bool = True, **update) -> uw.CycleReport:
    return await cycle(db_session, source, force=force, **update)


async def _watch(db_session, pricing_id: str) -> PricingWatch:
    return await db_session.scalar(select(PricingWatch).where(PricingWatch.pricing_id == pricing_id)
                                   .execution_options(populate_existing=True))


async def _get(db_session, model, row_id):
    return await db_session.get(model, row_id, populate_existing=True)


async def _first(db_session, source, api_client, registration, gate, *, production: bool = True):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=production)
    await _cycle(db_session, source)  # the first cycle: 200s that set each watch's ETag
    return found


async def test_the_first_cycle_sets_each_watch_and_a_304_changes_nothing(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate)  # production adopts 1.0.0 (Brevo)
    snapshots = await db_session.scalar(select(func.count()).select_from(PricingSnapshot))
    first = await _cycle(db_session, source)
    assert first.claimed == 4 and first.new_versions == 0
    brevo = await _watch(db_session, BREVO)
    assert brevo.status == "active" and brevo.manifest_etag and brevo.latest_version_id == BREVO_2026_10
    assert brevo.version_order == [BREVO_2026_10] and brevo.latest_snapshot_id is not None
    assert await db_session.scalar(select(func.count()).select_from(PricingSnapshot)) == snapshots
    observed = brevo.observed_at
    clocks.advance(30)
    sent = len(sphere.sent(BREVO_MANIFEST))
    second = await _cycle(db_session, source)
    brevo = await _watch(db_session, BREVO)
    assert second.not_modified == 4 and brevo.status == "active" and brevo.observed_at > observed
    assert len(sphere.sent(BREVO_MANIFEST)) == sent + 1
    assert sphere.sent(BREVO_MANIFEST)[-1].headers["if-none-match"] == brevo.manifest_etag
    assert await db_session.scalar(select(func.count()).select_from(PricingSnapshot)) == snapshots
    assert found is not None


async def test_a_published_version_is_snapshotted_with_one_manifest_and_one_yaml_read(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _first(db_session, source, api_client, registration, gate)
    entry = sphere.publish("brevo-professional-up")
    clocks.advance(30)
    before = len(sphere.requests)
    report = await _cycle(db_session, source)
    brevo_requests = [r for r in sphere.requests[before:] if r.url.path.startswith(BREVO_MANIFEST)]
    assert [r.url.path for r in brevo_requests] == [BREVO_MANIFEST, f"{BREVO_MANIFEST}/versions/{entry['versionId']}/yaml"]
    assert report.new_versions == 1
    brevo = await _watch(db_session, BREVO)
    assert brevo.latest_version_id == entry["versionId"]
    assert brevo.version_order == [entry["versionId"], BREVO_2026_10]
    snapshot = await _get(db_session, PricingSnapshot, brevo.latest_snapshot_id)
    assert (snapshot.version_id, snapshot.scope_key, snapshot.fetched_by_id) == (entry["versionId"], "public", None)


async def test_a_family_rename_updates_the_etag_only(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _first(db_session, source, api_client, registration, gate)
    brevo = await _watch(db_session, BREVO)
    etag, snapshot_id = brevo.manifest_etag, brevo.latest_snapshot_id
    snapshots = await db_session.scalar(select(func.count()).select_from(PricingSnapshot))
    sphere.publish("brevo-renamed-family")
    clocks.advance(30)
    report = await _cycle(db_session, source)
    brevo = await _watch(db_session, BREVO)
    assert brevo.manifest_etag != etag and brevo.latest_snapshot_id == snapshot_id and report.new_versions == 0
    assert await db_session.scalar(select(func.count()).select_from(PricingSnapshot)) == snapshots


async def test_the_whole_version_order_is_kept(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _first(db_session, source, api_client, registration, gate)
    manifest = sphere.manifest(BREVO)
    extra = [{"versionId": f"6fa{i:021x}", "version": f"old-{i}", "createdAt": f"2001-01-01T00:00:{i % 60:02d}.000Z",
              "contentHash": "0" * 64} for i in range(300)]
    manifest["versions"] = list(manifest["versions"]) + extra
    sphere.serve_manifest(BREVO, manifest)
    clocks.advance(30)
    await _cycle(db_session, source)
    brevo = await _watch(db_session, BREVO)
    assert len(brevo.version_order) == 301 and brevo.version_order[0] == BREVO_2026_10


async def test_a_429_closes_the_whole_public_bucket(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _first(db_session, source, api_client, registration, gate)
    clocks.advance(30)
    sphere.rate_limited(40, anonymous=True, times=1)
    before = len(sphere.requests)
    report = await _cycle(db_session, source)
    assert report.busy == 1 and len(sphere.requests) == before + 1  # nothing more this cycle
    for pricing_id in (BREVO, DROPBOX, RESEND, TOMATOMETER):
        watch = await _watch(db_session, pricing_id)
        assert watch.retry_after_until is not None
        assert watch.retry_after_until.replace(tzinfo=timezone.utc) >= clocks.now + timedelta(seconds=39)
    # ``force`` ignores next_poll_at, never the back-off.
    again = await _cycle(db_session, source)
    assert again.claimed == 0


async def test_unavailable_backs_off_exponentially_to_the_cap(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _first(db_session, source, api_client, registration, gate)
    sphere.unavailable(BREVO_MANIFEST, status=500)
    delays = []
    for _ in range(6):
        clocks.advance(4000)
        await _cycle(db_session, source, upstream_failure_backoff_max_s=300)
        brevo = await _watch(db_session, BREVO)
        delays.append(int((brevo.next_poll_at.replace(tzinfo=timezone.utc) - clocks.now).total_seconds()))
    assert brevo.status == "unavailable" and brevo.failures == 6
    assert delays[:3] == [40, 80, 160] and delays[3:] == [300, 300, 300]


async def test_two_404s_one_interval_apart_make_gone(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _first(db_session, source, api_client, registration, gate)
    sphere.not_found(BREVO_MANIFEST)
    clocks.advance(30)
    await _cycle(db_session, source)
    brevo = await _watch(db_session, BREVO)
    assert (brevo.status, brevo.not_found_count, brevo.gone_epoch) == ("not_found", 1, 0)
    assert brevo.not_found_since is not None
    # A forced cycle 5 s later (below the interval and the adapter's 60 s negative cache) sends a request, but
    # cannot confirm the disappearance.
    clocks.advance(5)
    sent = len(sphere.sent(BREVO_MANIFEST))
    await _cycle(db_session, source)
    brevo = await _watch(db_session, BREVO)
    assert len(sphere.sent(BREVO_MANIFEST)) == sent + 1 and brevo.status == "not_found" and brevo.not_found_count == 2
    # A fresh adapter (the CLI's) changes nothing either.
    fresh = SphereHttpSource(get_settings().model_copy(update={"sphere_enabled": True}), transport=sphere.transport(),
                             clock=clocks)
    await _cycle(db_session, fresh)
    assert (await _watch(db_session, BREVO)).status == "not_found"
    # One interval after the first 404: gone, epoch 1.
    clocks.advance(20)
    report = await _cycle(db_session, source)
    brevo = await _watch(db_session, BREVO)
    assert (brevo.status, brevo.gone_epoch, report.gone) == ("gone", 1, 1)


async def test_a_rewritten_version_is_logged_only_on_a_verified_snapshot(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _first(db_session, source, api_client, registration, gate)
    manifest = sphere.manifest(BREVO)
    manifest["versions"][0]["contentHash"] = "f" * 64
    sphere.serve_manifest(BREVO, manifest)
    clocks.advance(30)
    await _cycle(db_session, source)
    assert (await _watch(db_session, BREVO)).last_error == "content_rewritten"


async def test_an_unverified_snapshot_never_says_rewritten(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    """The Q3 divergence: the manifest's hash never matched the bytes, so a changed hash proves nothing."""
    manifest = sphere.manifest(DROPBOX)
    for entry in manifest["versions"]:
        entry["contentHash"] = "0" * 64
    sphere.serve_manifest(DROPBOX, manifest)
    await _first(db_session, source, api_client, registration, gate)
    dropbox = await _watch(db_session, DROPBOX)
    pinned = await db_session.scalar(select(PricingSnapshot).join(
        PricingWatchRef, PricingWatchRef.pinned_snapshot_id == PricingSnapshot.id).where(
        PricingWatchRef.watch_id == dropbox.id))
    assert pinned.content_hash_verified is False
    for entry in manifest["versions"]:
        entry["contentHash"] = "e" * 64
    sphere.serve_manifest(DROPBOX, manifest)
    clocks.advance(30)
    await _cycle(db_session, source)
    assert (await _watch(db_session, DROPBOX)).last_error is None


async def test_the_budget_hands_the_rest_back_due(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _first(db_session, source, api_client, registration, gate)
    clocks.advance(30)
    report = await _cycle(db_session, source, upstream_reads_per_cycle=4)
    assert report.not_modified == 2 and report.reads == 2  # a third watch needs three reads in reserve
    due = await db_session.scalar(select(func.count()).select_from(PricingWatch).where(
        PricingWatch.next_poll_at <= clocks.now.replace(tzinfo=None)))
    assert due == 2


def test_next_slot_spreads_watches_and_is_stable() -> None:
    import uuid

    ids = [uuid.UUID(int=i * 7919 + 17) for i in range(100)]
    phases = [uw.phase_of(watch_id, 300) for watch_id in ids]
    slots = [uw.next_slot(START, 300, phase) for phase in phases]
    assert all(START < slot <= START + timedelta(seconds=300) for slot in slots)
    assert len({slot for slot in slots}) > 80
    assert [uw.next_slot(START, 300, phase) for phase in phases] == slots
    assert uw.next_slot(slots[0], 300, phases[0]) == slots[0] + timedelta(seconds=300)
    assert uw.tick_of(300) == 30 and uw.tick_of(20) == 5


async def test_a_watch_without_live_refs_is_not_polled(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _first(db_session, source, api_client, registration, gate)
    orphan = PricingWatch(source_kind="sphere", pricing_id="6ade364540e55445692b0eda", scope_key="public",
                          watch_key="sphere|6ade364540e55445692b0eda|public")
    db_session.add(orphan)
    await db_session.flush()
    orphan_id = orphan.id
    clocks.advance(30)
    report = await _cycle(db_session, source)
    assert report.claimed == 4 and (await _get(db_session, PricingWatch, orphan_id)).status == "pending"


async def test_an_unknown_registry_sends_nothing(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=False)
    watch = PricingWatch(source_kind="registry", registry="gone", pricing_id=BREVO, scope_key="registry:gone",
                         watch_key=f"registry:gone|{BREVO}|registry:gone")
    db_session.add(watch)
    await db_session.flush()
    db_session.add(PricingWatchRef(organization_id=found.organization.id, composition_id=found.composition.id,
                                   version_id=found.v110.id, watch_id=watch.id, subject="binding", via="from",
                                   pinned_version_id=BREVO_2026_10, selection={}, ref_key="registry-ref"))
    watch_id = watch.id
    before = len(sphere.requests)
    await _cycle(db_session, source)
    assert (await _get(db_session, PricingWatch, watch_id)).status == "registry_unknown"
    assert not [r for r in sphere.requests[before:] if "registry" in str(r.url)]


async def test_an_expired_lease_is_claimed_again(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _first(db_session, source, api_client, registration, gate)
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    clocks.advance(30)
    await db_session.commit()
    async with factory() as session:
        claimed = await uw.claim_due(session, 50)
    assert len(claimed) == 4
    async with factory() as session:
        assert await uw.claim_due(session, 50) == []  # the lease holds
    clocks.advance(uw.LEASE_S + 1)
    async with factory() as session:
        assert sorted(await uw.claim_due(session, 50)) == sorted(claimed)


async def test_unresolved_refs_are_attempted_on_their_own_schedule(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=False)
    base = f"/v1/organizations/{found.org}/compositions"
    await api_client.post(base, headers=found.headers, json={"slug": "desk", "name": "Desk"})
    document = (
        'syntaxVersion: "1.0"\ncomposition: desk\nversion: 1.0.0\nkind: application\nworkflow:\n  seq: [archive]\n'
        "binding:\n  archive: {candidate: storage.nowhere.basic, from: {sphere: nobody/nothing, "
        "version: 6b00000000000000000000ff, plan: BASIC}}\nvalues:\n  cost: {value: 1, unit: EUR/month}\n"
    )
    sealed = await api_client.post(f"{base}/desk/versions", content=document.encode(),
                                   headers={**found.headers, "content-type": "application/yaml"})
    assert sealed.status_code == 201, sealed.text
    attempt = await db_session.scalar(select(PricingRefAttempt))
    assert attempt is not None and attempt.failures == 0
    await _cycle(db_session, source, upstream_watch_enabled=False)
    assert (await db_session.scalar(select(PricingRefAttempt))).failures == 0  # nothing with the watcher off
    report = await _cycle(db_session, source)
    attempt = await db_session.scalar(select(PricingRefAttempt))
    assert report.ref_attempts == 1 and attempt.failures == 1 and attempt.last_error == "not_found"
    report = await _cycle(db_session, source)
    assert report.ref_attempts == 0  # not again before next_attempt_at
    clocks.advance(41)
    report = await _cycle(db_session, source)
    assert report.ref_attempts == 1 and (await db_session.scalar(select(PricingRefAttempt))).failures == 2


async def test_an_unresolved_ref_is_resolved_once_the_family_is_readable(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=False)
    db_session.add(PricingWatchRef(organization_id=found.organization.id, composition_id=found.composition.id,
                                   version_id=found.v110.id, watch_id=None, subject="binding", via="from",
                                   sphere_ref="danruilop1/mailgun", pinned_version_id="6ade36454b2b5b01c587db3d",
                                   tasks=["extra"], selection={"extra": {"plan": "FOUNDATION"}},
                                   ref_key="unresolved:danruilop1/mailgun|binding|6ade36454b2b5b01c587db3d"))
    from openbinding_gateway.modules.compositions.application import watches

    await watches.ensure_attempt(db_session, found.organization.id, "danruilop1/mailgun", "6ade36454b2b5b01c587db3d")
    report = await _cycle(db_session, source)
    assert report.refs_resolved == 1
    assert await db_session.scalar(select(PricingRefAttempt)) is None
    resolved = await db_session.scalar(select(PricingWatchRef).where(PricingWatchRef.sphere_ref == "danruilop1/mailgun",
                                                                     PricingWatchRef.watch_id.is_not(None)))
    assert resolved is not None and resolved.tasks == ["extra"] and resolved.pinned_snapshot_id is not None


async def test_with_sphere_off_the_cycle_is_skipped(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await seeded(api_client, registration, db_session, gate, production=False)
    before = len(sphere.requests)
    report = await _cycle(db_session, source, sphere_enabled=False)
    assert report.skipped == "disabled" and len(sphere.requests) == before


def test_the_watcher_cannot_seal_adopt_propose_or_run() -> None:
    forbidden = {"seal", "derive", "adoption", "proposals", "execution", "fork", "templates"}
    for name in ("upstream_watcher", "upstream_classify"):
        path = Path(uw.__file__).with_name(f"{name}.py")
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom):
                module = node.module or ""
                names = {alias.name for alias in node.names}
                assert not ({module.split(".")[-1]} | names) & forbidden, (name, module, names)
                assert "modules.execution" not in module and "execution" not in module.split(".")


async def test_the_admin_queue_names_the_watches(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _first(db_session, source, api_client, registration, gate)
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    async with factory() as session:
        found = await uw.status(session, _settings())
    assert found["enabled"] is True and found["intervalSeconds"] == 20
    assert found["watches"]["active"] == 4 and found["eventsLastDay"] == {}
    assert json.dumps(found)
    await db_session.execute(update(PricingWatch).values(status="active"))

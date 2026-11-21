"""Recording classified upstream events for live versions (F6 A10), and what a cycle never touches (invariants W, F).

The template-seeded TomatoMeter: 1.0.0 (Brevo PROFESSIONAL) adopted in ``production``, 1.1.0 (Resend) the latest.
"""

from __future__ import annotations

import hashlib
import logging

import pytest
import yaml
from sqlalchemy import func, select

from _b1_helpers import gate  # noqa: F401
from openbinding_gateway.db.models import (
    BindingCaseRevision,
    CompositionAdoption,
    CompositionEnvironment,
    CompositionEvaluation,
    CompositionUpstreamEvent,
    CompositionVersion,
    Job,
    PricingWatch,
)
from openbinding_gateway.modules.compositions.application import upstream_events

from ._tomatometer import BREVO, BREVO_2026_10, TOMATOMETER, seeded
from ._watching import cycle, watch_of

pytestmark = pytest.mark.asyncio
YAML = {"content-type": "application/yaml"}
BREVO_MANIFEST = f"/api/v1/public/pricings/{BREVO}"


async def _events(db_session, **where) -> list[CompositionUpstreamEvent]:
    query = select(CompositionUpstreamEvent).execution_options(populate_existing=True)
    for name, value in where.items():
        query = query.where(getattr(CompositionUpstreamEvent, name) == value)
    return list((await db_session.scalars(query.order_by(CompositionUpstreamEvent.detected_at,
                                                        CompositionUpstreamEvent.id))).all())


async def _ready(api_client, registration, db_session, gate, source, *, production: bool = True):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=production)
    await cycle(db_session, source)
    return found


async def test_a_price_raise_records_one_event_on_the_adopted_version(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _ready(api_client, registration, db_session, gate, source)
    entry = sphere.publish("brevo-professional-up")
    clocks.advance(30)
    report = await cycle(db_session, source)
    events = await _events(db_session, subject="binding")
    assert len(events) == 1 and report.events == 1
    event = events[0]
    assert (event.version_id, event.category, event.state, event.notify) == (found.ids["v100"], "values_changed", "open",
                                                                             True)
    assert (event.old_ref, event.new_ref, event.old_label, event.new_label) == (
        BREVO_2026_10, entry["versionId"], "2026-10", "2026-11")
    assert event.tasks == ["dailySummary"] and event.old_snapshot_id and event.new_snapshot_id
    assert event.diff["global"][0]["delta"] == "50.000000" and event.diff["global"][0]["feature"] == "subscription"
    price = event.diff["entries"][0]["comparison"]["price"]
    assert (price["before"]["subtotal"], price["after"]["subtotal"]) == ("499.000000", "549.000000")
    assert "domain_may_change" in event.diff["notes"]
    # Nothing on 1.1.0 (Resend); a second cycle and a forced one add nothing.
    assert await cycle(db_session, source) and len(await _events(db_session)) == 1
    clocks.advance(30)
    await cycle(db_session, source, force=True)
    assert len(await _events(db_session)) == 1


async def test_a_retired_plan_after_a_raise_is_a_second_event(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _ready(api_client, registration, db_session, gate, source)
    sphere.publish("brevo-professional-up")
    clocks.advance(30)
    await cycle(db_session, source)
    retired = sphere.publish("brevo-professional-retired")
    clocks.advance(30)
    await cycle(db_session, source)
    events = await _events(db_session, subject="binding")
    assert [(e.new_ref, e.category) for e in events] == [
        ("6fff00000000000000000001", "values_changed"), (retired["versionId"], "binding_invalid")]
    assert events[1].reasons[0]["code"] == "plan_removed" and events[1].version_id == found.ids["v100"]


async def test_a_confirmed_disappearance_is_source_unavailable_numbered_by_epoch(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _ready(api_client, registration, db_session, gate, source)
    sphere.not_found(BREVO_MANIFEST, times=2)
    clocks.advance(30)
    await cycle(db_session, source)
    assert await _events(db_session) == []  # one 404 is not an event
    clocks.advance(25)
    await cycle(db_session, source)
    (event,) = await _events(db_session)
    assert (event.category, event.new_ref, event.new_snapshot_id) == ("binding_invalid", "gone:1", None)
    assert event.reasons == [{"code": "source_unavailable", "detail": "family_not_found"}]
    # Back, then gone again: a new event, gone:2.
    clocks.advance(25)
    await cycle(db_session, source)
    assert (await watch_of(db_session, BREVO)).status == "active"
    sphere.not_found(BREVO_MANIFEST, times=2)
    clocks.advance(25)
    await cycle(db_session, source)
    clocks.advance(25)
    await cycle(db_session, source)
    assert [e.new_ref for e in await _events(db_session)] == ["gone:1", "gone:2"]


async def test_a_manifest_without_the_pinned_version_is_version_withdrawn(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _ready(api_client, registration, db_session, gate, source)
    entry = sphere.publish("brevo-professional-up")
    manifest = sphere.manifest(BREVO)
    manifest["versions"] = [v for v in manifest["versions"] if v["versionId"] != BREVO_2026_10]
    sphere.serve_manifest(BREVO, manifest)
    clocks.advance(30)
    await cycle(db_session, source)
    (event,) = await _events(db_session)
    assert event.reasons == [{"code": "source_unavailable", "detail": "version_withdrawn"}]
    assert event.new_ref == entry["versionId"]


async def test_a_family_of_300_versions_pinned_at_its_oldest_is_not_withdrawn(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _ready(api_client, registration, db_session, gate, source)
    sphere.publish("brevo-professional-up")
    manifest = sphere.manifest(BREVO)
    manifest["versions"] = manifest["versions"][:1] + [
        {"versionId": f"6fa{i:021x}", "version": f"between-{i}", "createdAt": f"2026-10-{(i % 20) + 26:02d}T00:00:00.000Z"
         if (i % 20) + 26 <= 31 else "2026-11-01T00:00:00.000Z", "contentHash": "0" * 64} for i in range(298)
    ] + manifest["versions"][1:]
    sphere.serve_manifest(BREVO, manifest)
    clocks.advance(30)
    await cycle(db_session, source)
    (event,) = await _events(db_session)
    assert event.category in ("values_changed", "no_impact")
    assert all(r.get("detail") != "version_withdrawn" for r in event.reasons)


async def test_an_offering_version_is_one_event_on_the_composition_with_margins(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _ready(api_client, registration, db_session, gate, source)
    sphere.publish("tomatometer-1.2.0")
    clocks.advance(30)
    await cycle(db_session, source)
    (event,) = await _events(db_session, subject="offering")
    assert (event.category, event.version_id, event.notify, event.state) == ("offering_changed", found.ids["v110"], True,
                                                                             "open")
    environment = event.diff["margins"]["environments"][0]
    assert environment["environment"] == "production" and environment["users"] == 1000
    moved = {(b["plan"], tuple(b["addOns"])) for b, a in zip(environment["before"]["rows"], environment["after"]["rows"],
                                                              strict=True) if b["margin"] != a["margin"]}
    assert moved == {("basic", ()), ("basic", ("extraTimers",))}
    assert event.diff["margins"]["latest"]["version"] == "1.1.0"
    # A later version does not duplicate it (one offering event per composition, watch and version).
    base = f"/v1/organizations/{found.org}/compositions/tomatometer"
    document = yaml.safe_load((await api_client.get(f"{base}/versions/1.1.0/content", headers=found.headers)).text)
    document["version"] = "1.3.0"
    sealed = await api_client.post(f"{base}/versions", content=yaml.safe_dump(document, sort_keys=False).encode(),
                                   headers={**found.headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    clocks.advance(30)
    await cycle(db_session, source)
    assert len(await _events(db_session, subject="offering")) == 1


async def test_an_offering_change_is_judged_on_the_versions_that_offer_it(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate)
    # The latest, 1.2.0, offers nothing; production keeps 1.0.0, which offers TomatoMeter.
    base = f"/v1/organizations/{found.org}/compositions/tomatometer"
    document = yaml.safe_load((await api_client.get(f"{base}/versions/1.1.0/content", headers=found.headers)).text)
    document["version"] = "1.2.0"
    document.pop("offering")
    sealed = await api_client.post(f"{base}/versions", content=yaml.safe_dump(document, sort_keys=False).encode(),
                                   headers={**found.headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    await cycle(db_session, source)
    sphere.publish("tomatometer-1.2.0")
    clocks.advance(30)
    await cycle(db_session, source)
    (event,) = await _events(db_session, subject="offering")
    assert event.version_id == found.ids["v100"] and event.category == "offering_changed"
    assert [e["environment"] for e in event.diff["margins"]["environments"]] == ["production"]
    assert event.diff["margins"]["latest"]["version"] == "1.0.0"


async def test_an_offering_version_with_no_effective_change_is_not_told(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _ready(api_client, registration, db_session, gate, source)
    recorded = (sphere.root / TOMATOMETER / "6921867e7004563bd918e7e8.yml").read_text()
    data = recorded.replace('version: "1.0.0"', 'version: "1.0.1"').replace(
        "description: Basic plan", "description: The basic plan").encode()
    import hashlib

    version_id = "6fff0000000000000000b001"
    manifest = sphere.manifest(TOMATOMETER)
    manifest["versions"] = [{"versionId": version_id, "version": "1.0.1", "createdAt": "2026-11-20T00:00:00.000Z",
                             "contentHash": "0" * 64}] + manifest["versions"]
    manifest["latestVersionId"] = version_id
    sphere.serve_manifest(TOMATOMETER, manifest)
    sphere.serve(f"/api/v1/public/pricings/{TOMATOMETER}/versions/{version_id}/yaml", data,
                 {"content-type": "application/yaml", "etag": '"' + hashlib.sha256(data).hexdigest() + '"'})
    clocks.advance(30)
    await cycle(db_session, source)
    (event,) = await _events(db_session, subject="offering")
    assert event.category == "offering_changed" and event.notify is False


async def test_a_superseded_unadopted_version_gets_nothing_until_it_is_adopted(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _ready(api_client, registration, db_session, gate, source, production=False)
    sphere.publish("brevo-professional-up")
    clocks.advance(30)
    await cycle(db_session, source)
    assert await _events(db_session, subject="binding") == []  # 1.0.0 is neither latest nor adopted


async def test_an_event_is_born_resolved_when_a_later_version_already_pins_the_new_one(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _ready(api_client, registration, db_session, gate, source)
    entry = sphere.publish("brevo-professional-up")
    sphere.source._cache.clear()  # the gateway's own reads see the new version (its manifest cache is per process)
    base = f"/v1/organizations/{found.org}/compositions/tomatometer"
    document = yaml.safe_load((await api_client.get(f"{base}/versions/1.0.0/content", headers=found.headers)).text)
    document["version"] = "1.2.0"
    # Declared (no problem): its ``from`` may pin the new version (a linked one must match its problem's origins).
    document.pop("problem")
    document.pop("evidence", None)
    document["binding"]["dailySummary"]["from"]["version"] = entry["versionId"]
    sealed = await api_client.post(f"{base}/versions", content=yaml.safe_dump(document, sort_keys=False).encode(),
                                   headers={**found.headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    clocks.advance(30)
    await cycle(db_session, source)
    events = await _events(db_session, subject="binding", version_id=found.ids["v100"])
    assert len(events) == 1
    resolver = await db_session.scalar(select(CompositionVersion).where(
        CompositionVersion.composition_id == found.ids["composition"], CompositionVersion.label == "1.2.0"))
    event = events[0]
    # 1.0.0 is adopted in production where 1.2.0 is not: told.
    assert (event.state, event.resolved_by_version_id, event.notify) == ("resolved", resolver.id, True)


async def test_a_classifier_failure_writes_nothing_and_waits(api_client, registration, db_session, gate, sphere, source, clocks, monkeypatch, caplog):  # noqa: F811
    await _ready(api_client, registration, db_session, gate, source)
    sphere.publish("brevo-professional-up")

    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(upstream_events.uc, "classify_binding", broken)
    clocks.advance(30)
    with caplog.at_level(logging.WARNING):
        await cycle(db_session, source)
    assert await _events(db_session, subject="binding") == []
    assert "upstream_classify_failed" in caplog.text
    watch = await watch_of(db_session, BREVO)
    assert watch.classify_after is not None and watch.last_error == "classify_failed"


async def test_catch_up_drops_refs_at_least_as_new_without_a_classifier_call(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    await _ready(api_client, registration, db_session, gate, source)
    watch = await watch_of(db_session, BREVO)
    assert await upstream_events.lacking(db_session, watch, BREVO_2026_10) == []
    calls = []
    original = upstream_events.uc.classify_binding

    def counted(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    upstream_events.uc.classify_binding = counted
    try:
        await cycle(db_session, source)
        await cycle(db_session, source)
    finally:
        upstream_events.uc.classify_binding = original
    assert calls == []


async def test_a_cycle_that_writes_events_changes_nothing_a_person_writes(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    """Invariants W and F: runs, revisions, versions, evaluations and adoptions are untouched, and so are every
    environment row (its ETag) and the feed (the adopted version's digest)."""
    found = await _ready(api_client, registration, db_session, gate, source)

    async def state():
        counts = {}
        for model in (Job, BindingCaseRevision, CompositionVersion, CompositionEvaluation, CompositionAdoption):
            counts[model.__tablename__] = await db_session.scalar(select(func.count()).select_from(model))
        environments = (await db_session.execute(select(
            CompositionEnvironment.id, CompositionEnvironment.updated_at, CompositionEnvironment.adopted_version_id,
            CompositionEnvironment.adoption_ordinal))).all()
        contents = (await db_session.execute(select(CompositionVersion.id, CompositionVersion.content_digest))).all()
        return counts, sorted(environments), sorted(contents)

    before = await state()
    feed = await api_client.get(f"/v1/organizations/{found.org}/compositions/tomatometer/environments/production/composition",
                                headers=found.headers)
    sphere.publish("brevo-professional-up")
    sphere.publish("tomatometer-1.2.0")
    clocks.advance(30)
    report = await cycle(db_session, source)
    assert report.events == 2
    assert await state() == before
    again = await api_client.get(f"/v1/organizations/{found.org}/compositions/tomatometer/environments/production/composition",
                                 headers=found.headers)
    assert (feed.status_code, again.status_code) == (200, 200)
    assert again.headers["etag"] == feed.headers["etag"] and again.content == feed.content
    assert (await db_session.scalar(select(func.count()).select_from(PricingWatch))) == 4


SHOP = """\
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow:
  seq: [notify]
binding:
  notify: {candidate: email.local.smtp}
values:
  cost: {value: 30, unit: USD/month}
offering: {url: "https://pricings.example.org/shop/pricing.yml"}
"""


async def test_a_url_offering_is_watched_through_its_snapshots(api_client, registration, db_session, gate, sphere, source, clocks, monkeypatch):  # noqa: F811
    """F4-A's known limit closed: a URL offering's same bytes and a ``saasName``-only change are nothing; other content
    is one ``offering_changed`` event with the environment's margins; the feed never moves."""
    from openbinding_gateway.core import revision as etags
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db.models import Composition, OrganizationRole
    from openbinding_gateway.modules.compositions.application import adoption
    from sphere_recorded import SFX

    monkeypatch.setattr(get_settings(), "offering_url_min_interval_s", 1e-6)
    mailgun = (SFX / "6ade364540e55445692b0eda" / "6ade36454b2b5b01c587db3d.yml").read_bytes()
    sphere.add_host("pricings.example.org", "93.184.216.34")
    sphere.serve("/shop/pricing.yml", mailgun, {"content-type": "application/yaml", "etag": '"v1"'})
    found = await seeded(api_client, registration, db_session, gate, production=False)
    base = f"/v1/organizations/{found.org}/compositions"
    assert (await api_client.post(base, headers=found.headers, json={"slug": "shop", "name": "Shop"})).status_code == 201
    sealed = await api_client.post(f"{base}/shop/versions", content=SHOP.encode(), headers={**found.headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    shop = await db_session.scalar(select(Composition).where(Composition.slug == "shop"))
    environment = CompositionEnvironment(organization_id=shop.organization_id, composition_id=shop.id,
                                         slug="production", name="Production", created_by_id=found.ids["user"],
                                         adopt_role="MEMBER", expected_users=100)
    db_session.add(environment)
    await db_session.commit()
    organization, user = found.organization, found.user
    await adoption.adopt(db_session, organization=organization, composition=shop, environment=environment,
                         role=OrganizationRole.OWNER, version_ref="1.0.0", actor=user,
                         if_match=etags.etag_for(environment))
    await db_session.commit()
    shop_id = shop.id
    feed = await api_client.get(f"{base}/shop/environments/production/composition", headers=found.headers)
    clocks.advance(86400)  # the events' clock past the evaluation's (which is not frozen)

    await cycle(db_session, source)
    assert await _events(db_session, composition_id=shop_id) == []
    renamed = mailgun.replace(b"saasName: Mailgun", b"saasName: Mailgun Renamed", 1)
    sphere.serve("/shop/pricing.yml", renamed, {"content-type": "application/yaml", "etag": '"v2"'})
    await cycle(db_session, source)
    assert await _events(db_session, composition_id=shop_id) == []
    scale = (SFX / "derived" / "mailgun-scale.yml").read_bytes()
    sphere.serve("/shop/pricing.yml", scale, {"content-type": "application/yaml", "etag": '"v3"'})
    await cycle(db_session, source)
    (event,) = await _events(db_session, composition_id=shop_id)
    assert event.category == "offering_changed" and event.new_ref.startswith("sha256:")
    assert event.diff["margins"]["environments"][0]["environment"] == "production"
    again = await api_client.get(f"{base}/shop/environments/production/composition", headers=found.headers)
    assert again.headers["etag"] == feed.headers["etag"]
    # Back to the earlier content, then forward again: each move is an event against what was observed last,
    # although the URL serves the snapshots it served before.
    sphere.serve("/shop/pricing.yml", renamed, {"content-type": "application/yaml", "etag": '"v4"'})
    clocks.advance(30)
    await cycle(db_session, source)
    sphere.serve("/shop/pricing.yml", scale, {"content-type": "application/yaml", "etag": '"v5"'})
    clocks.advance(30)
    await cycle(db_session, source)
    first, back, forward = await _events(db_session, composition_id=shop_id)
    assert back.old_ref == first.new_ref and back.new_ref == f"sha256:{hashlib.sha256(renamed).hexdigest()}"
    assert (forward.old_ref, forward.new_ref) == (back.new_ref, f"{first.new_ref}~1")
    assert forward.new_snapshot_id == first.new_snapshot_id and forward.notify is True
    await cycle(db_session, source)
    assert len(await _events(db_session, composition_id=shop_id)) == 3

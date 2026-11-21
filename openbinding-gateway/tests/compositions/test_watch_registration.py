"""What a sealed version watches (F6 A8): ``seal_into`` registers its watch references, from stored data only."""

from __future__ import annotations

import uuid

import pytest
import yaml
from sqlalchemy import func, select

from _b1_helpers import gate  # noqa: F401
from _problem_helpers import make_org
from openbinding_gateway.db.models import (
    Composition,
    CompositionVersion,
    PricingRefAttempt,
    PricingSnapshot,
    PricingWatch,
    PricingWatchRef,
)

from ._tomatometer import BREVO, BREVO_2026_10, DROPBOX, RESEND, TOMATOMETER, seeded

pytestmark = pytest.mark.asyncio
YAML = {"content-type": "application/yaml"}


async def _refs(db_session, version_id) -> list[PricingWatchRef]:
    return list((await db_session.scalars(
        select(PricingWatchRef).where(PricingWatchRef.version_id == version_id).order_by(PricingWatchRef.via,
                                                                                          PricingWatchRef.sphere_ref)
    )).all())


async def _watch(db_session, watch_id) -> PricingWatch:
    return await db_session.get(PricingWatch, watch_id)


async def test_the_template_seeded_tomatometer_registers_what_it_reads(api_client, registration, db_session, gate):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=False)
    refs = await _refs(db_session, found.v100.id)
    by_pricing = {(await _watch(db_session, r.watch_id)).pricing_id: r for r in refs}
    assert set(by_pricing) == {BREVO, DROPBOX, TOMATOMETER}  # nothing for ZenQuotes (hand-made)
    brevo = by_pricing[BREVO]
    assert (brevo.via, brevo.subject, brevo.pinned_version_id, brevo.tasks) == ("from", "binding", BREVO_2026_10,
                                                                                 ["dailySummary"])
    assert brevo.selection["dailySummary"] | {} == {
        "plan": "PROFESSIONAL", "addOns": [], "billing": "monthly", "seats": 1, "candidate": "email.brevo.professional",
    }
    assert brevo.pinned_snapshot_id is not None
    dropbox = by_pricing[DROPBOX]
    assert (dropbox.via, dropbox.selection["export"]["plan"]) == ("from", "PLUS")
    offering = by_pricing[TOMATOMETER]
    assert (offering.subject, offering.via, offering.selection, offering.pinned_version_id) == (
        "offering", "offering", {}, None)
    assert offering.sphere_ref == "sphere/tomatometer"
    # 1.1.0 reads Resend instead of Brevo (derive wrote its ``from`` from the origins).
    later = {(await _watch(db_session, r.watch_id)).pricing_id: r for r in await _refs(db_session, found.v110.id)}
    assert set(later) == {RESEND, DROPBOX, TOMATOMETER}
    assert later[RESEND].via == "from"
    watches = (await db_session.scalars(select(PricingWatch))).all()
    assert {w.pricing_id for w in watches} == {BREVO, DROPBOX, TOMATOMETER, RESEND}
    assert all(w.scope_key == "public" and w.status == "pending" for w in watches)


async def test_a_deduplicated_seal_registers_nothing(api_client, registration, db_session, gate):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=False)
    before = await db_session.scalar(select(func.count()).select_from(PricingWatchRef))
    content = (await api_client.get(f"/v1/organizations/{found.org}/compositions/tomatometer/versions/1.0.0/content",
                                    headers=found.headers)).text
    again = await api_client.post(f"/v1/organizations/{found.org}/compositions/tomatometer/versions",
                                  content=content.encode(), headers={**found.headers, **YAML})
    assert again.status_code in (200, 201), again.text
    assert await db_session.scalar(select(func.count()).select_from(PricingWatchRef)) == before


async def test_a_linked_version_without_from_registers_through_its_origins(api_client, registration, db_session, gate):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=False)
    base = f"/v1/organizations/{found.org}/compositions/tomatometer"
    document = yaml.safe_load((await api_client.get(f"{base}/versions/1.0.0/content", headers=found.headers)).text)
    document["version"] = "1.2.0"
    del document["binding"]["dailySummary"]["from"]
    sealed = await api_client.post(f"{base}/versions", content=yaml.safe_dump(document, sort_keys=False).encode(),
                                   headers={**found.headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    version = await db_session.scalar(select(CompositionVersion).where(
        CompositionVersion.composition_id == found.composition.id, CompositionVersion.label == "1.2.0"))
    refs = {r.via: r for r in await _refs(db_session, version.id) if r.subject == "binding" and "dailySummary" in r.tasks}
    origin = refs["origins"]
    assert (await _watch(db_session, origin.watch_id)).pricing_id == BREVO
    assert origin.pinned_version_id == BREVO_2026_10 and origin.selection["dailySummary"]["plan"] == "PROFESSIONAL"


DECLARED = """\
syntaxVersion: "1.0"
composition: desk
version: {version}
kind: application
workflow:
  seq: [notify, archive]
binding:
  notify: {{candidate: email.brevo.starter, from: {{sphere: danruilop1/brevo, version: 6ade2d444b2b5b01c587d80d, plan: STARTER}}}}
  archive: {{candidate: storage.nowhere.basic, from: {{sphere: nobody/nothing, version: 6b00000000000000000000ff, plan: BASIC}}}}
values:
  cost: {{value: 42.5, unit: EUR/month}}
offering: {{url: "https://pricings.example.org/desk/pricing.yml"}}
"""


async def _declared(api_client, headers, org, slug: str, version: str):
    created = await api_client.post(f"/v1/organizations/{org}/compositions", headers=headers,
                                    json={"slug": slug, "name": slug.title()})
    assert created.status_code == 201, created.text
    sealed = await api_client.post(f"/v1/organizations/{org}/compositions/{slug}/versions",
                                   content=DECLARED.format(version=version).replace("composition: desk",
                                                                                     f"composition: {slug}").encode(),
                                   headers={**headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    return uuid.UUID(sealed.json()["id"]) if "id" in sealed.json() else None


async def test_declared_versions_register_from_unresolved_refs_and_a_url_offering(api_client, registration, db_session, gate, sphere):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=False)
    sphere.add_host("pricings.example.org", "93.184.216.34")
    sphere.serve("/desk/pricing.yml", b"saasName: Desk\n", {"content-type": "application/yaml"})
    await _declared(api_client, found.headers, found.org, "desk", "1.0.0")
    composition = await db_session.scalar(select(Composition).where(Composition.slug == "desk"))
    version = await db_session.scalar(select(CompositionVersion).where(CompositionVersion.composition_id == composition.id))
    refs = await _refs(db_session, version.id)
    brevo = [r for r in refs if r.watch_id is not None and r.subject == "binding"]
    assert [(await _watch(db_session, r.watch_id)).pricing_id for r in brevo] == [BREVO]
    assert brevo[0].selection["notify"]["plan"] == "STARTER"
    unresolved = [r for r in refs if r.watch_id is None]
    assert [(r.sphere_ref, r.pinned_version_id) for r in unresolved] == [("nobody/nothing", "6b00000000000000000000ff")]
    attempts = (await db_session.scalars(select(PricingRefAttempt))).all()
    assert [(a.sphere_ref, a.pinned_version_id, a.organization_id) for a in attempts] == [
        ("nobody/nothing", "6b00000000000000000000ff", found.organization.id)]
    offering = [r for r in refs if r.subject == "offering"]
    url_watch = await _watch(db_session, offering[0].watch_id)
    assert (url_watch.source_kind, url_watch.scope_key, url_watch.organization_id) == (
        "url", str(found.organization.id), found.organization.id)
    assert url_watch.url == "https://pricings.example.org/desk/pricing.yml" and len(url_watch.url_key) == 64
    # A second composition naming the same families shares the public watch and adds no attempt.
    await _declared(api_client, found.headers, found.org, "desk-two", "1.0.0")
    assert len((await db_session.scalars(select(PricingRefAttempt))).all()) == 1
    brevo_watches = (await db_session.scalars(select(PricingWatch).where(PricingWatch.pricing_id == BREVO))).all()
    assert len(brevo_watches) == 1


async def test_a_fork_registers_for_the_new_composition_only(api_client, registration, db_session, gate):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate, production=False)
    target = await make_org(api_client, found.headers)
    before = await db_session.scalar(select(func.count()).select_from(PricingWatchRef).where(
        PricingWatchRef.composition_id == found.composition.id))
    forked = await api_client.post(f"/v1/organizations/{found.org}/compositions/tomatometer/fork",
                                   headers=found.headers, json={"version": "1.1.0", "targetOrganization": target, "dropProblem": True})
    assert forked.status_code == 201, forked.text
    assert await db_session.scalar(select(func.count()).select_from(PricingWatchRef).where(
        PricingWatchRef.composition_id == found.composition.id)) == before
    copy = await db_session.scalar(select(Composition).where(Composition.id != found.composition.id,
                                                              Composition.slug == "tomatometer"))
    refs = (await db_session.scalars(select(PricingWatchRef).where(PricingWatchRef.composition_id == copy.id))).all()
    assert refs and all(r.organization_id == copy.organization_id for r in refs)


async def test_snapshots_are_only_read(api_client, registration, db_session, gate, sphere):  # noqa: F811
    """Registration makes no network read: the seal pre-phase already snapshotted what it could."""
    found = await seeded(api_client, registration, db_session, gate, production=False)
    sent = len(sphere.requests)
    snapshots = await db_session.scalar(select(func.count()).select_from(PricingSnapshot))
    from openbinding_gateway.modules.compositions.application import watches

    refs = await watches.register_version(db_session, found.composition, found.v110, None, None)
    assert refs == [] or all(r.subject == "offering" for r in refs)
    await db_session.rollback()
    assert len(sphere.requests) == sent
    assert await db_session.scalar(select(func.count()).select_from(PricingSnapshot)) == snapshots

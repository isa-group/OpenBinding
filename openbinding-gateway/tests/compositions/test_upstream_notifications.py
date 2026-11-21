"""Telling the members who can act about upstream events (F6 A13; invariant N)."""

from __future__ import annotations

import pytest
from sqlalchemy import select, update

from _b1_helpers import gate, make_account, put_member  # noqa: F401
from openbinding_gateway.db.models import Notification, User

from ._tomatometer import seeded
from ._watching import cycle

pytestmark = pytest.mark.asyncio


async def _people(api_client, registration, db_session, gate, found):  # noqa: F811
    """A MEMBER, a VIEWER, a VIEWER who operates production, a member who turned the kind off, a deactivated
    MEMBER and an outsider, besides the owner."""
    people = {}
    for name, role in (("member", "MEMBER"), ("viewer", "VIEWER"), ("operator", "VIEWER"), ("quiet", "MEMBER"),
                       ("inactive", "MEMBER"), ("outsider", None)):
        account, _ = await make_account(api_client, registration, db_session, gate)
        if role is not None:
            assert (await put_member(api_client, found.headers, found.org, account["id"], role)).status_code in (200, 201)
        people[name] = account["id"]
    import uuid

    from openbinding_gateway.db.models import CompositionEnvironment

    await db_session.execute(update(CompositionEnvironment).where(CompositionEnvironment.slug == "production")
                             .values(operator_id=uuid.UUID(people["operator"])))
    await db_session.execute(update(User).where(User.id == uuid.UUID(people["quiet"])).values(
        preferences={"kinds": {"UpstreamEvent": {"inbox": False}}}))
    await db_session.execute(update(User).where(User.id == uuid.UUID(people["inactive"])).values(is_active=False))
    await db_session.commit()
    return people


async def _told(db_session) -> dict[str, list[Notification]]:
    rows = (await db_session.scalars(select(Notification).where(Notification.kind == "UpstreamEvent")
                                     .execution_options(populate_existing=True))).all()
    out: dict[str, list[Notification]] = {}
    for row in rows:
        out.setdefault(str(row.user_id), []).append(row)
    return out


async def test_a_price_raise_tells_the_members_who_can_act_once(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate)
    people = await _people(api_client, registration, db_session, gate, found)
    await cycle(db_session, source)
    sphere.publish("brevo-professional-up")
    clocks.advance(30)
    report = await cycle(db_session, source)
    told = await _told(db_session)
    owner = str(found.ids["user"])
    assert set(told) == {owner, people["member"], people["operator"]}
    assert report.notified == 3 and all(len(rows) == 1 for rows in told.values())
    row = told[people["member"]][0]
    assert row.subject == "brevo 2026-11: TomatoMeter values changed"
    payload = row.payload
    assert (payload["organization"], payload["composition"], payload["category"], payload["newVersion"]) == (
        found.org, "tomatometer", "values_changed", "2026-11")
    assert payload["versions"] == ["1.0.0"] and payload["environments"] == ["production"]
    assert payload["resolvedBy"] is None and payload["event"] == payload["events"][0]
    # A re-run cycle tells nobody again.
    clocks.advance(30)
    await cycle(db_session, source)
    assert sum(len(rows) for rows in (await _told(db_session)).values()) == 3


async def test_an_ancestor_admin_is_told(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    import uuid

    from openbinding_gateway.db.models import Organization, OrganizationMembership, OrganizationRole

    found = await seeded(api_client, registration, db_session, gate)
    account, _ = await make_account(api_client, registration, db_session, gate)
    parent = Organization(slug=f"p-{uuid.uuid4().hex[:6]}", name="Parent", created_by_id=uuid.UUID(account["id"]))
    db_session.add(parent)
    await db_session.flush()
    db_session.add(OrganizationMembership(organization_id=parent.id, user_id=uuid.UUID(account["id"]),
                                          role=OrganizationRole.ADMIN))
    await db_session.execute(update(Organization).where(Organization.id == found.ids["organization"])
                             .values(parent_id=parent.id))
    await db_session.commit()
    await cycle(db_session, source)
    sphere.publish("brevo-professional-up")
    clocks.advance(30)
    await cycle(db_session, source)
    assert account["id"] in await _told(db_session)


async def test_no_impact_and_quiet_offering_versions_tell_nobody(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate)
    await cycle(db_session, source)
    from openbinding_gateway.db.models import CompositionUpstreamEvent

    # Brevo 2026-11 that only changes another plan: no impact on PROFESSIONAL.
    entry = sphere.scenario("brevo-professional-up")
    data = (sphere.root / "6ade2d4440e55445692b07f1" / "6ade2d444b2b5b01c587d80d.yml").read_text().replace(
        "version: 2026-10", "version: '2026-11-starter'").replace("    '5000': 9\n", "    '5000': 10\n", 1).encode()
    import hashlib

    manifest = sphere.manifest(entry["pricingId"])
    manifest["versions"] = [{"versionId": "6fff0000000000000000c001", "version": "2026-11-starter",
                             "createdAt": "2026-11-15T00:00:00.000Z", "contentHash": "0" * 64}] + manifest["versions"]
    manifest["latestVersionId"] = "6fff0000000000000000c001"
    sphere.serve_manifest(entry["pricingId"], manifest)
    sphere.serve(f"/api/v1/public/pricings/{entry['pricingId']}/versions/6fff0000000000000000c001/yaml", data,
                 {"content-type": "application/yaml", "etag": '"' + hashlib.sha256(data).hexdigest() + '"'})
    clocks.advance(30)
    await cycle(db_session, source)
    (event,) = (await db_session.scalars(select(CompositionUpstreamEvent))).all()
    assert (event.category, event.notify) == ("no_impact", False)
    assert await _told(db_session) == {}
    assert found is not None


async def test_a_born_resolved_event_on_an_adopted_version_is_told_with_its_resolution(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    import yaml

    found = await seeded(api_client, registration, db_session, gate)
    await cycle(db_session, source)
    sphere.publish("brevo-professional-up")
    sphere.source._cache.clear()
    base = f"/v1/organizations/{found.org}/compositions/tomatometer"
    document = yaml.safe_load((await api_client.get(f"{base}/versions/1.0.0/content", headers=found.headers)).text)
    document["version"] = "1.2.0"
    document.pop("problem")
    document.pop("evidence", None)
    document["binding"]["dailySummary"]["from"]["version"] = "6fff00000000000000000001"
    sealed = await api_client.post(f"{base}/versions", content=yaml.safe_dump(document, sort_keys=False).encode(),
                                   headers={**found.headers, "content-type": "application/yaml"})
    assert sealed.status_code == 201, sealed.text
    clocks.advance(30)
    await cycle(db_session, source)
    (row,) = (await _told(db_session))[str(found.ids["user"])]
    assert row.payload["resolvedBy"] == {"version": "1.2.0"}
    assert "already resolved in 1.2.0, not adopted in production" in row.body


async def test_two_affected_versions_give_one_notification_naming_both(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    import yaml

    from openbinding_gateway.db.models import CompositionUpstreamEvent

    found = await seeded(api_client, registration, db_session, gate)
    base = f"/v1/organizations/{found.org}/compositions/tomatometer"
    document = yaml.safe_load((await api_client.get(f"{base}/versions/1.0.0/content", headers=found.headers)).text)
    document["version"] = "1.2.0"  # the latest, still on Brevo 2026-10, while production keeps 1.0.0
    document.pop("problem")
    document.pop("evidence", None)
    sealed = await api_client.post(f"{base}/versions", content=yaml.safe_dump(document, sort_keys=False).encode(),
                                   headers={**found.headers, "content-type": "application/yaml"})
    assert sealed.status_code == 201, sealed.text
    await cycle(db_session, source)
    sphere.publish("brevo-professional-up")
    clocks.advance(30)
    report = await cycle(db_session, source)
    events = (await db_session.scalars(select(CompositionUpstreamEvent).where(CompositionUpstreamEvent.notify.is_(True))
                                       .execution_options(populate_existing=True))).all()
    assert len(events) == 2
    (row,) = (await _told(db_session))[str(found.ids["user"])]
    assert report.notified == 1
    assert sorted(row.payload["versions"]) == ["1.0.0", "1.2.0"]
    assert sorted(row.payload["events"]) == sorted(str(event.id) for event in events)
    assert row.payload["event"] in row.payload["events"] and row.payload["environments"] == ["production"]


async def test_the_stream_delivers_the_row_once_committed(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate)
    await cycle(db_session, source)
    sphere.publish("brevo-professional-up")
    clocks.advance(30)
    await cycle(db_session, source)
    listed = await api_client.get("/v1/notifications", headers=found.headers)
    assert listed.status_code == 200
    kinds = [item["kind"] for item in listed.json()["notifications"]] if isinstance(listed.json(), dict) else [
        item["kind"] for item in listed.json()]
    assert "UpstreamEvent" in kinds

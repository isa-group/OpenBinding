"""Checking an environment now: a read-only report of the composition in effect against its sources (F4 A7).

Over the recorded SPHERE set: a TomatoMeter version derived from ``tomatometer-email@2`` (Mailgun FOUNDATION, the
offering ``sphere/tomatometer``) is adopted and checked; every source is ``current``. ``newer`` comes only from a
scripted manifest; a source that cannot be read is ``unavailable`` and the answer is still 200. Nothing is written:
every table keeps its row count, and the feed its ETag.
"""

from __future__ import annotations

import json

import httpx
import pytest
import yaml
from sqlalchemy import func, select

from _b1_helpers import gate  # noqa: F401
from compositions._sphere import BINDING, YAML, compositions, generated_problem
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.base import Base
from openbinding_gateway.db.models import PricingSnapshot
from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
from openbinding_gateway.modules.plans.application import set_pricing_source

pytestmark = pytest.mark.asyncio

DROPBOX = {"sphere": "atenea/dropbox", "version": "687e4b68102baa50f3a5c7b7", "plan": "PLUS"}
MAILGUN_PRICING = "6ade364540e55445692b0eda"


async def counts(db) -> dict[str, int]:
    found = {}
    for table in Base.metadata.sorted_tables:
        found[table.name] = int(await db.scalar(select(func.count()).select_from(table)) or 0)
    return found


async def adopted(api_client, headers, base, label="1.0.0"):
    environments = f"{base}/environments"
    created = await api_client.post(environments, headers=headers, json={"slug": "production", "name": "P"})
    assert created.status_code == 201, created.text
    done = await api_client.post(
        f"{environments}/production/adopt", headers={**headers, "If-Match": created.headers["ETag"]},
        json={"version": label},
    )
    assert done.status_code == 200, done.text
    return f"{environments}/production"


async def derived(api_client, headers, base, **extra):
    made = await api_client.post(
        f"{base}/derive", headers=headers,
        json={"revision": "tomatometer-email@2", "binding": BINDING, "version": "1.0.0",
              "offering": {"sphere": "sphere/tomatometer"}, **extra},
    )
    assert made.status_code == 201, made.text
    return made.json()


async def test_every_source_of_the_recorded_version_is_current(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    await derived(api_client, headers, base)
    environment = await adopted(api_client, headers, base)
    key = await api_client.post(f"{environment}/keys", headers=headers, json={})
    feed_key = {"X-API-Key": key.json()["secret"]}
    before_feed = await api_client.get(f"{environment}/composition", headers=feed_key)
    before = await counts(db_session)
    before_environment = await api_client.get(environment, headers=headers)

    checked = await api_client.post(f"{environment}/check", headers=headers)

    assert checked.status_code == 200, checked.text
    body = checked.json()
    assert body["version"]["label"] == "1.0.0"
    assert body["binding"]["status"] == "valid" and body["binding"]["toolchain"]
    (email,) = [row for row in body["upstream"] if row["task"] == "dailySummary"]
    assert email["sphere"] == "danruilop1/mailgun" and email["plan"] == "FOUNDATION"
    assert email["status"] == "current"
    assert email["pinned"]["versionId"] == email["latest"]["versionId"]
    assert body["offering"]["status"] == "current"
    assert body["offering"]["pinned"]["versionName"] == body["offering"]["latest"]["versionName"] == "1.0.0"
    assert body["offering"]["source"] == {"sphere": "sphere/tomatometer"}
    # Nothing written; the environment, its ETag and the feed unchanged.
    assert await counts(db_session) == before
    after_environment = await api_client.get(environment, headers=headers)
    assert after_environment.headers["ETag"] == before_environment.headers["ETag"]
    after_feed = await api_client.get(f"{environment}/composition", headers=feed_key)
    assert after_feed.headers["ETag"] == before_feed.headers["ETag"] and after_feed.content == before_feed.content


async def test_a_scripted_newer_manifest_is_newer(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    await derived(api_client, headers, base)
    environment = await adopted(api_client, headers, base)
    recorded = sphere.routes[f"/api/v1/public/pricings/{MAILGUN_PRICING}"]
    manifest = json.loads((sphere.root / recorded["file"]).read_text())
    pinned = manifest["latestVersionId"]
    newer = {"versionId": "7" * 24, "version": "2027-01", "createdAt": "2027-01-15T00:00:00.000Z",
             "contentHash": "0" * 64}
    scripted = {**manifest, "latestVersionId": newer["versionId"], "versions": [newer, *manifest["versions"]]}

    def answer(request):
        return httpx.Response(200, headers={"content-type": "application/json"}, json=scripted)

    sphere._script(sphere._for(f"/api/v1/public/pricings/{MAILGUN_PRICING}"), answer)
    # A fresh port, so the manifest the derive read is not served from the process cache.
    set_pricing_source(SphereHttpSource(get_settings().model_copy(update={"sphere_enabled": True}),
                                        transport=sphere.transport()))

    body = (await api_client.post(f"{environment}/check", headers=headers)).json()

    (email,) = [row for row in body["upstream"] if row["task"] == "dailySummary"]
    assert email["status"] == "newer"
    assert email["pinned"]["versionId"] == pinned
    assert email["latest"] == {"versionId": "7" * 24, "name": "2027-01", "createdAt": "2027-01-15T00:00:00.000Z"}


async def test_an_unreadable_source_is_unavailable_and_never_a_5xx(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    await derived(api_client, headers, base)
    environment = await adopted(api_client, headers, base)
    sphere.rate_limited(9)
    set_pricing_source(SphereHttpSource(get_settings().model_copy(update={"sphere_enabled": True}),
                                        transport=sphere.transport()))

    checked = await api_client.post(f"{environment}/check", headers=headers)

    assert checked.status_code == 200, checked.text
    body = checked.json()
    assert {row["status"] for row in body["upstream"] if row["task"] == "dailySummary"} == {"unavailable"}
    assert body["offering"]["status"] == "unavailable"


async def test_latest_is_the_manifests_never_the_highest_label(api_client, registration, db_session, gate, sphere):  # noqa: F811
    """Dropbox 2021 is the recorded latestVersionId although a 2024 version exists: the pin is current."""
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    draft = await api_client.post(
        f"{base}/derive", headers=headers,
        json={"revision": "tomatometer-email@2", "binding": BINDING, "version": "1.0.0", "seal": False},
    )
    assert draft.status_code == 200, draft.text
    document = yaml.safe_load(draft.json()["content"])
    document["binding"]["export"]["from"] = DROPBOX
    sealed = await api_client.post(
        f"{base}/versions", content=yaml.safe_dump(document, sort_keys=False).encode(), headers={**headers, **YAML},
    )
    assert sealed.status_code == 201, sealed.text
    environment = await adopted(api_client, headers, base)
    first = (await api_client.post(f"{environment}/check", headers=headers)).json()
    (unsnapshotted,) = [row for row in first["upstream"] if row["task"] == "export"]
    assert unsnapshotted["status"] == "not_snapshotted" and unsnapshotted["pinned"] is None
    # The snapshot the upstream view would resolve (F6's poller takes it); check itself never takes one.
    db_session.add(PricingSnapshot(
        source_key="sphere:6ab0a323697330667ccce9c1:687e4b68102baa50f3a5c7b7", scope_key="public", sha256="a" * 64,
        size_bytes=1, content_hash="b" * 64, content_hash_verified=True, source_kind="sphere",
        pricing_id="6ab0a323697330667ccce9c1", version_id="687e4b68102baa50f3a5c7b7", version_label="2021",
        version_created_at="2025-07-08T00:00:00.000Z", owner="atenea", slug="dropbox", title="Dropbox", valid=True,
    ))
    await db_session.commit()

    body = (await api_client.post(f"{environment}/check", headers=headers)).json()

    (export,) = [row for row in body["upstream"] if row["task"] == "export"]
    assert export["sphere"] == "atenea/dropbox"
    assert export["status"] == "current", export
    assert export["pinned"]["versionId"] == export["latest"]["versionId"] == "687e4b68102baa50f3a5c7b7"
    assert export["latest"]["name"] == "2021"
    # A task without a from gives no row.
    assert {row["task"] for row in body["upstream"]} == {"dailySummary", "export"}


async def test_who_may_check(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    await derived(api_client, headers, base)
    environments = f"{base}/environments"
    created = await api_client.post(environments, headers=headers, json={"slug": "staging", "name": "S"})
    assert created.status_code == 201

    nothing = await api_client.post(f"{environments}/staging/check", headers=headers)
    assert nothing.status_code == 409 and nothing.json()["detail"]["code"] == "nothing_adopted"
    assert (await api_client.post(f"{environments}/staging/check")).status_code == 401

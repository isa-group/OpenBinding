"""``GET /v1/plans/pricing``: OpenBinding's own published pricing, read through the pricing source."""

from __future__ import annotations

import hashlib

import pytest
from sqlalchemy import select

from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import PricingSnapshot
from sphere_recorded import RecordedSphere, sfx_bytes

OPENBINDING = "6ab0a323697330667ccce891"
VERSION_ID = "6ada6dbd4b2b5b01c587d17f"
URL = "/v1/plans/pricing"


@pytest.fixture(autouse=True)
def sphere_on(monkeypatch):
    monkeypatch.setattr(get_settings(), "sphere_enabled", True)
    monkeypatch.setattr(get_settings(), "space_pricing_version", "0.2.0")


def _yaml_requests(sphere: RecordedSphere) -> list:
    return [r for r in sphere.requests if r.url.path.endswith("/yaml")]


async def test_the_published_version_is_served_verified(api_client, db_session, sphere: RecordedSphere) -> None:
    answer = await api_client.get(URL)
    assert answer.status_code == 200, answer.text
    body = answer.json()
    raw = sfx_bytes(f"{OPENBINDING}/{VERSION_ID}.yml")
    assert (body["pricingId"], body["version"], body["versionId"]) == (OPENBINDING, "0.2.0", VERSION_ID)
    assert body["name"] == "OpenBinding" and body["permanentUrl"] == f"https://sphere.score.us.es/p/{OPENBINDING}"
    assert body["yaml"].encode() == raw
    assert body["document"]["version"] == "0.2.0" and set(body["document"]["plans"]) == {"FREE", "RESEARCH", "LAB"}
    # .inf is null in the document.
    assert body["document"]["plans"]["LAB"]["usageLimits"]["maxRepositoryStorage"]["value"] is None
    assert answer.headers["ETag"] == '"' + hashlib.sha256(raw).hexdigest() + '"'
    assert answer.headers["Cache-Control"] == "public, max-age=300"
    row = await db_session.scalar(select(PricingSnapshot))
    assert row.content_hash_verified and row.content_hash.startswith("3db4ad99") and row.scope_key == "public"
    assert "contentHash" not in answer.text and "sha256" not in answer.text


async def test_the_snapshot_is_reused_and_304_answers_a_current_copy(api_client, db_session, sphere) -> None:
    first = await api_client.get(URL)
    second = await api_client.get(URL)
    assert second.status_code == 200 and len(_yaml_requests(sphere)) == 1
    cached = await api_client.get(URL, headers={"If-None-Match": first.headers["ETag"]})
    assert cached.status_code == 304 and cached.headers["ETag"] == first.headers["ETag"]


async def test_a_label_the_manifest_lacks_is_unavailable(api_client, db_session, sphere, monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "space_pricing_version", "9.9.9")
    answer = await api_client.get(URL)
    assert answer.status_code == 503 and answer.json()["detail"]["code"] == "pricing_unavailable"


async def test_sphere_down_serves_a_stored_snapshot(api_client, db_session, sphere: RecordedSphere, monkeypatch) -> None:
    assert (await api_client.get(URL)).status_code == 200
    down = RecordedSphere()
    down.unavailable()
    from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
    from openbinding_gateway.modules.plans.application import set_pricing_source

    set_pricing_source(SphereHttpSource(get_settings().model_copy(update={"sphere_enabled": True}), transport=down.transport()))
    monkeypatch.setattr("openbinding_gateway.core.outbound._getaddrinfo", lambda host, port: down.getaddrinfo(host, port))
    stale = await api_client.get(URL)
    assert stale.status_code == 200 and stale.json()["version"] == "0.2.0"


async def test_with_sphere_down_and_nothing_stored_it_is_unavailable(api_client, db_session, sphere) -> None:
    sphere.unavailable()
    answer = await api_client.get(URL)
    assert answer.status_code == 503
    assert "pricing_unavailable" in answer.text


async def test_with_sphere_disabled_it_is_unavailable(api_client, db_session, sphere, monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "sphere_enabled", False)
    answer = await api_client.get(URL)
    assert answer.status_code == 503 and "pricing_unavailable" in answer.text
    assert sphere.requests == []

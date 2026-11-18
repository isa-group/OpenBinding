"""SPHERE discovery and pricing snapshots through the gateway (``/v1/organizations/{org}/sphere``, ``/pricing-snapshots``)."""

from __future__ import annotations

import hashlib
import json
import uuid

from cryptography.fernet import Fernet
from sqlalchemy import select

from _b1_helpers import gate, make_account  # noqa: F401
from _problem_helpers import make_org
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.models import Organization, OrganizationMembership, OrganizationRole
from openbinding_gateway.modules.plans.adapters import routes as plans_routes
from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
from openbinding_gateway.modules.plans.application import set_pricing_source
from openbinding_gateway.modules.plans.domain.pricing2yaml import normalise_text, summary
from sphere_recorded import SFX, RecordedSphere, sfx_bytes, sfx_json

from ._pricings import DROPBOX, DROPBOX_2023, SET_B, TOMATOMETER, latest

MAILGUN = SET_B["mailgun"]
MAILGUN_VERSION = "6ade36454b2b5b01c587db3d"
DANRUILOP1 = "6ade2ce94b2b5b01c587d7c6"
KEY = "sk-" + "ab" * 32
PRIVATE_FAMILY = "6b00000000000000000000f1"
PRIVATE_VERSION = "6b00000000000000000000f2"


async def _member(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    slug = await make_org(api_client, headers)
    return headers, slug


def _sphere(slug: str) -> str:
    return f"/v1/organizations/{slug}/sphere/pricings"


async def test_search_by_name_with_whole_result_facets(api_client, registration, db_session, gate, sphere) -> None:  # noqa: F811
    headers, slug = await _member(api_client, registration, db_session, gate)
    answer = await api_client.get(_sphere(slug), params={"q": "Mailgun"}, headers=headers)
    assert answer.status_code == 200, answer.text
    body = answer.json()
    recorded = sfx_json("search/name-Mailgun.json")
    assert body["total"] == recorded["total"] and body["connected"] is False and body["registries"] == []
    assert body["facets"] == {"minPrice": recorded["minPrice"], "maxPrice": recorded["maxPrice"],
                              "configurationSpaceSize": recorded["configurationSpaceSize"]}
    row = next(r for r in body["pricings"] if r["pricingId"] == MAILGUN)
    assert row["owner"]["name"] == "danruilop1" and row["latestVersion"]["id"] == MAILGUN_VERSION
    assert row["analytics"]["plans"] == 5 and "contentHash" not in answer.text


async def test_search_by_collection_and_min_price(api_client, registration, db_session, gate, sphere) -> None:  # noqa: F811
    headers, slug = await _member(api_client, registration, db_session, gate)
    by_collection = await api_client.get(_sphere(slug), params={"collection": "email-apis-pricing-intelligence"}, headers=headers)
    assert by_collection.status_code == 200 and by_collection.json()["total"] == 8
    priced = await api_client.get(_sphere(slug), params={"q": "Mailgun", "minPrice": 10}, headers=headers)
    assert priced.status_code == 200
    sent = sphere.requests[-1].url.params
    assert sent["min-minPrice"] == "10" and "max-minPrice" not in sent and "max-maxPrice" not in sent
    too_many = await api_client.get(_sphere(slug), params={"q": "Mailgun", "limit": 25}, headers=headers)
    assert too_many.status_code == 422


async def test_search_in_a_registry(api_client, registration, db_session, gate, sphere: RecordedSphere) -> None:  # noqa: F811
    sphere.add_host("registry.internal", "10.0.0.7")
    registries = Settings(sphere_registries={"lab": {"url": "https://registry.internal", "api_key": "operator-key"}})
    set_pricing_source(SphereHttpSource(
        get_settings().model_copy(update={"sphere_enabled": True, "sphere_registries": registries.sphere_registries}),
        transport=sphere.transport(),
    ))
    headers, slug = await _member(api_client, registration, db_session, gate)
    answer = await api_client.get(_sphere(slug), params={"q": "Mailgun", "registry": "lab"}, headers=headers)
    assert answer.status_code == 200 and answer.json()["registries"] == ["lab"]
    assert sphere.requests[-1].headers["host"] == "registry.internal" and sphere.requests[-1].headers["x-api-key"] == "operator-key"
    unknown = await api_client.get(_sphere(slug), params={"q": "Mailgun", "registry": "nope"}, headers=headers)
    assert unknown.status_code == 422


async def test_a_private_family_appears_only_with_the_connection(
    api_client, registration, db_session, gate, sphere: RecordedSphere, monkeypatch  # noqa: F811
) -> None:
    monkeypatch.setattr(get_settings(), "secrets_fernet_keys", Fernet.generate_key().decode())
    sphere.serve("/api/v1/users/me", sfx_bytes("users-me.json"), {"content-type": "application/json"})
    listing = sfx_json(f"org-pricings/{DANRUILOP1}.0.json")
    extra = dict(listing["pricings"][0], pricingId=PRIVATE_FAMILY, id=PRIVATE_VERSION, _id=PRIVATE_VERSION,
                 slug="internal", name="Internal", private=True)
    listing["pricings"].append(extra)
    sphere.keyed(KEY, f"/api/v1/pricings/{DANRUILOP1}?limit=24&offset=0", json.dumps(listing).encode())
    headers, slug = await _member(api_client, registration, db_session, gate)
    params = {"q": "Mailgun", "organization": DANRUILOP1}
    before = await api_client.get(_sphere(slug), params=params, headers=headers)
    assert PRIVATE_FAMILY not in before.text and before.json()["connected"] is False
    put = await api_client.put(f"/v1/organizations/{slug}/connections/sphere", json={"apiKey": KEY}, headers=headers)
    assert put.status_code == 200, put.text
    after = await api_client.get(_sphere(slug), params=params, headers=headers)
    assert after.json()["connected"] is True
    row = next(r for r in after.json()["pricings"] if r["pricingId"] == PRIVATE_FAMILY)
    assert row["private"] is True


async def test_the_manifest_view_orders_by_date_and_hides_hashes(api_client, registration, db_session, gate, sphere) -> None:  # noqa: F811
    headers, slug = await _member(api_client, registration, db_session, gate)
    answer = await api_client.get(f"{_sphere(slug)}/{DROPBOX}", headers=headers)
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert [v["label"] for v in body["versions"]] == ["2021", "2023", "2024"]
    assert body["latestVersionId"] == body["versions"][0]["versionId"]
    assert body["permanentUrl"] == f"https://sphere.score.us.es/p/{DROPBOX}"
    assert "contentHash" not in answer.text and "sha256" not in answer.text


async def test_the_version_view_snapshots_once_and_summarises(api_client, registration, db_session, gate, sphere) -> None:  # noqa: F811
    headers, slug = await _member(api_client, registration, db_session, gate)
    url = f"{_sphere(slug)}/{MAILGUN}/versions/{MAILGUN_VERSION}"
    first = await api_client.get(url, headers=headers)
    assert first.status_code == 200, first.text
    sent = len(sphere.requests)
    second = await api_client.get(url, headers=headers)
    assert second.status_code == 200 and len(sphere.requests) == sent
    body = first.json()
    snapshot = body["snapshot"]
    assert (snapshot["owner"], snapshot["slug"], snapshot["versionLabel"]) == ("danruilop1", "mailgun", "2026-10")
    assert snapshot["source"] == "sphere" and snapshot["yamlHref"].endswith(f"/pricing-snapshots/{snapshot['id']}/yaml")
    expected = summary(normalise_text(sfx_bytes(f"{MAILGUN}/{MAILGUN_VERSION}.yml")))
    assert body["summary"] == json.loads(json.dumps(expected))
    assert {a["id"] for a in body["summary"]["meteredAddOns"]} >= {"extraEmailsFoundation"}
    assert "sha256" not in first.text and "contentHash" not in first.text


async def test_a_2x_version_is_refused_with_its_label(api_client, registration, db_session, gate, sphere) -> None:  # noqa: F811
    headers, slug = await _member(api_client, registration, db_session, gate)
    answer = await api_client.get(f"{_sphere(slug)}/{DROPBOX}/versions/{DROPBOX_2023}", headers=headers)
    assert answer.status_code == 422 and answer.json()["code"] == "sphere_syntax_unsupported"
    assert "2.1" in answer.text


async def test_every_unreadable_pricing_is_the_same_404(api_client, registration, db_session, gate, sphere) -> None:  # noqa: F811
    headers, slug = await _member(api_client, registration, db_session, gate)
    sphere.not_found("/api/v1/public/pricings/" + "0" * 24)
    sphere.private(MAILGUN, PRIVATE_VERSION, b"saasName: P\n", credential=KEY)
    bodies = []
    for path in (
        f"{_sphere(slug)}/6ab0a323697330667ccce8cdX",
        f"{_sphere(slug)}/{'0' * 24}",
        f"{_sphere(slug)}/{MAILGUN}/versions/{PRIVATE_VERSION}",
        f"{_sphere(slug)}/{MAILGUN}/versions/not-an-id",
    ):
        answer = await api_client.get(path, headers=headers)
        assert answer.status_code == 404, (path, answer.text)
        bodies.append(answer.json())
    assert all(body == bodies[0] for body in bodies)
    assert not [r for r in sphere.requests if "users" in r.url.path or "not-an-id" in r.url.path]


async def test_sphere_busy_is_a_503_with_retry_after(api_client, registration, db_session, gate, sphere) -> None:  # noqa: F811
    headers, slug = await _member(api_client, registration, db_session, gate)
    sphere.rate_limited(9, anonymous=True)
    answer = await api_client.get(_sphere(slug), params={"q": "Mailgun"}, headers=headers)
    assert answer.status_code == 503 and answer.headers["Retry-After"] == "9"
    assert answer.json()["detail"]["code"] == "sphere_busy"


async def test_a_viewer_cannot_search_or_read_versions(api_client, registration, db_session, gate, sphere) -> None:  # noqa: F811
    _, slug = await _member(api_client, registration, db_session, gate)
    account, headers = await make_account(api_client, registration, db_session, gate)
    organization = await db_session.scalar(select(Organization).where(Organization.slug == slug))
    db_session.add(OrganizationMembership(organization_id=organization.id, user_id=uuid.UUID(account["id"]),
                                          role=OrganizationRole.VIEWER))
    await db_session.commit()
    for path in (_sphere(slug) + "?q=Mailgun", f"{_sphere(slug)}/{TOMATOMETER}/versions/{latest(TOMATOMETER)}"):
        assert (await api_client.get(path, headers=headers)).status_code == 403
    assert sphere.requests == []


async def _snapshot(api_client, headers, slug, pricing_id=MAILGUN, version_id=MAILGUN_VERSION) -> dict:
    answer = await api_client.get(f"{_sphere(slug)}/{pricing_id}/versions/{version_id}", headers=headers)
    assert answer.status_code == 200, answer.text
    return answer.json()["snapshot"]


async def test_snapshot_metadata_and_yaml_for_members_visitors_and_others(
    api_client, registration, db_session, gate, sphere: RecordedSphere, monkeypatch  # noqa: F811
) -> None:
    headers, slug = await _member(api_client, registration, db_session, gate)
    other_headers, other_slug = await _member(api_client, registration, db_session, gate)
    public = await _snapshot(api_client, headers, slug)
    base = f"/v1/organizations/{slug}/pricing-snapshots/{public['id']}"
    meta = await api_client.get(base, headers=headers)
    assert meta.status_code == 200 and meta.json()["id"] == public["id"]
    raw = await api_client.get(f"{base}/yaml", headers=headers)
    assert raw.status_code == 200 and raw.content == sfx_bytes(f"{MAILGUN}/{MAILGUN_VERSION}.yml")
    assert raw.headers["content-type"].startswith("application/yaml")
    assert raw.headers["ETag"] == '"' + hashlib.sha256(raw.content).hexdigest() + '"'
    assert "immutable" in raw.headers["cache-control"] and raw.headers["x-content-type-options"] == "nosniff"
    assert raw.headers["content-disposition"].startswith("attachment")
    again = await api_client.get(f"{base}/yaml", headers={**headers, "If-None-Match": raw.headers["ETag"]})
    assert again.status_code == 304
    # A visitor reads a public snapshot of an organization that publishes a composition; not of one that does not.
    assert (await api_client.get(base)).status_code == 404
    monkeypatch.setattr(plans_routes, "_publishes", _always)
    assert (await api_client.get(base)).status_code == 200
    # A private one is its organization's only.
    monkeypatch.setattr(get_settings(), "secrets_fernet_keys", Fernet.generate_key().decode())
    sphere.serve("/api/v1/users/me", sfx_bytes("users-me.json"), {"content-type": "application/json"})
    sphere.private(MAILGUN, PRIVATE_VERSION, (SFX / "derived" / "mailgun-scale.yml").read_bytes(), credential=KEY)
    await api_client.put(f"/v1/organizations/{slug}/connections/sphere", json={"apiKey": KEY}, headers=headers)
    private = await _snapshot(api_client, headers, slug, MAILGUN, PRIVATE_VERSION)
    own = f"/v1/organizations/{slug}/pricing-snapshots/{private['id']}"
    assert (await api_client.get(own, headers=headers)).status_code == 200
    elsewhere = f"/v1/organizations/{other_slug}/pricing-snapshots/{private['id']}"
    assert (await api_client.get(elsewhere, headers=other_headers)).status_code == 404
    assert (await api_client.get(own)).status_code == 404
    assert (await api_client.get(f"{own}/yaml", headers=other_headers)).status_code == 404


async def _always(*_args) -> bool:
    return True

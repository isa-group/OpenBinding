"""``owner/name`` -> family (``plans.application.resolve_family``) over the recorded SPHERE."""

from __future__ import annotations

import uuid

import pytest

from openbinding_gateway.db.models import Organization, User
from openbinding_gateway.modules.plans.application import (
    DEFAULT_ENDPOINT,
    Credential,
    FamilyAmbiguous,
    PricingNotFound,
    resolve_family,
    snapshot_version,
)
from openbinding_gateway.modules.plans.application import discovery
from sphere_recorded import RecordedSphere

from ._pricings import DROPBOX, DROPBOX_2021, SET_B, TOMATOMETER

ATENEA = "6a69bffdcc66dffbac53dfd4"


@pytest.fixture(autouse=True)
def fresh_cache():
    discovery.clear_resolution_cache()
    yield
    discovery.clear_resolution_cache()


async def _org(db) -> Organization:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.org", password_hash="x", plan_cache="free")
    db.add(user)
    await db.flush()
    organization = Organization(slug=f"o-{suffix}", name="O", created_by_id=user.id)
    db.add(organization)
    await db.commit()
    return organization


async def test_a_personal_organization(db_session, sphere: RecordedSphere) -> None:
    assert await resolve_family(db_session, DEFAULT_ENDPOINT, "sphere", "tomatometer") == TOMATOMETER
    # Discovery found the organization (personal ones are not in /orgs/public), then its listing the family.
    assert sphere.sent("/api/v1/orgs/public") and sphere.sent("/api/v1/pricings/6a2d90d2e7661f8a65098f97")


async def test_a_multi_word_slug_whose_display_name_differs(db_session, sphere: RecordedSphere) -> None:
    assert await resolve_family(db_session, DEFAULT_ENDPOINT, "danruilop1", "twilio-sendgrid-email-api") == SET_B["sendgrid"]
    names = [r.url.params.get("name") for r in sphere.sent("/api/v1/pricings") if r.url.path == "/api/v1/pricings"]
    assert names == ["twilio-sendgrid-email-api", "twilio sendgrid email api"]


async def test_a_slug_no_discovery_term_finds_needs_a_known_organization(db_session, sphere: RecordedSphere) -> None:
    with pytest.raises(PricingNotFound):
        await resolve_family(db_session, DEFAULT_ENDPOINT, "danruilop1", "sendgridrapidapi")
    organization = await _org(db_session)
    await snapshot_version(db_session, organization.id, DEFAULT_ENDPOINT, SET_B["mailgun"], "6ade36454b2b5b01c587db3d")
    assert await resolve_family(db_session, DEFAULT_ENDPOINT, "danruilop1", "sendgridrapidapi") == "6ade2ef740e55445692b094f"


async def test_two_families_with_one_name_are_ambiguous(db_session, sphere: RecordedSphere) -> None:
    with pytest.raises(FamilyAmbiguous) as caught:
        await resolve_family(db_session, DEFAULT_ENDPOINT, "sphere", "resend")
    assert sorted(caught.value.candidates) == ["6ab0a323697330667ccce8e9", "6ab0a323697330667cccea11"]
    # The version a hand-written ``from`` names picks the family whose manifest lists it.
    picked = await resolve_family(db_session, DEFAULT_ENDPOINT, "sphere", "resend", version_id="69639298641bc8e6c0f764d1")
    assert picked == "6ab0a323697330667ccce8e9"


async def test_an_unknown_owner(db_session, sphere: RecordedSphere) -> None:
    with pytest.raises(PricingNotFound):
        await resolve_family(db_session, DEFAULT_ENDPOINT, "nobody", "resend")


async def test_the_page_limit(db_session, sphere: RecordedSphere, monkeypatch) -> None:
    organization = await _org(db_session)
    await snapshot_version(db_session, organization.id, DEFAULT_ENDPOINT, DROPBOX, DROPBOX_2021)
    monkeypatch.setattr(discovery, "FAMILY_PAGES", 2)
    before = len(sphere.requests)
    with pytest.raises(PricingNotFound):
        await resolve_family(db_session, DEFAULT_ENDPOINT, "atenea", "no-such-slug")
    listings = [r for r in sphere.requests[before:] if r.url.path == f"/api/v1/pricings/{ATENEA}"]
    assert [r.url.params["offset"] for r in listings] == ["0", "24"]


async def test_a_stored_snapshot_answers_with_no_request(db_session, sphere: RecordedSphere) -> None:
    organization = await _org(db_session)
    await snapshot_version(db_session, organization.id, DEFAULT_ENDPOINT, SET_B["mailgun"], "6ade36454b2b5b01c587db3d")
    before = len(sphere.requests)
    assert await resolve_family(db_session, DEFAULT_ENDPOINT, "danruilop1", "mailgun") == SET_B["mailgun"]
    assert len(sphere.requests) == before


async def test_an_anonymous_resolution_is_cached_and_a_keyed_one_is_not(db_session, sphere: RecordedSphere) -> None:
    await resolve_family(db_session, DEFAULT_ENDPOINT, "sphere", "tomatometer")
    before = len(sphere.requests)
    await resolve_family(db_session, DEFAULT_ENDPOINT, "sphere", "tomatometer")
    assert len(sphere.requests) == before
    key = Credential("org-a", "sk-" + "a" * 64)
    await resolve_family(db_session, DEFAULT_ENDPOINT, "sphere", "tomatometer", key)
    await resolve_family(db_session, DEFAULT_ENDPOINT, "sphere", "tomatometer", key)
    keyed = [r for r in sphere.requests[before:] if r.headers.get("x-api-key") == key.api_key]
    assert len(keyed) == 2

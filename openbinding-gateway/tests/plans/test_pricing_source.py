"""The ``PricingSource`` port over the recorded SPHERE (``SphereHttpSource``, ``UrlSource``)."""

from __future__ import annotations

import json
import logging

import pytest
from pydantic import ValidationError

from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
from openbinding_gateway.modules.plans.adapters.url import UrlSource
from openbinding_gateway.modules.plans.application import (
    DEFAULT_ENDPOINT,
    Credential,
    CredentialRejected,
    NotModified,
    PricingNotFound,
    PricingSourceBusy,
    PricingSourceUnavailable,
    SearchQuery,
    SphereEndpoint,
    read_version,
)
from sphere_recorded import SFX, RecordedSphere, sfx_bytes

from ._pricings import DROPBOX, DROPBOX_2021, SET_B, TOMATOMETER, latest

TOMATO_MANIFEST = f"/api/v1/public/pricings/{TOMATOMETER}"
MAILGUN = SET_B["mailgun"]
DANRUILOP1 = "6ade2ce94b2b5b01c587d7c6"
PRIVATE_VERSION = "6b0000000000000000000001"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _settings(**update) -> Settings:
    return get_settings().model_copy(update={"sphere_enabled": True, **update})


def _source(sphere: RecordedSphere, clock: Clock | None = None, **update) -> SphereHttpSource:
    return SphereHttpSource(_settings(**update), transport=sphere.transport(), clock=clock or Clock())


def _key(organization: str = "org-a", api_key: str = "sk-" + "a" * 64, on_rejected=None) -> Credential:
    return Credential(organization, api_key, on_rejected)


# --- reads ----------------------------------------------------------------------------------------------------------


async def test_manifest_discovery_version_family_and_organization(sphere: RecordedSphere) -> None:
    source = _source(sphere)
    manifest = await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert manifest.name == "TomatoMeter" and manifest.etag
    assert [v.label for v in manifest.newest_first()] == ["1.0.0"]
    page = await source.search(DEFAULT_ENDPOINT, SearchQuery(name="Mailgun"), None)
    assert MAILGUN in {row.pricing_id for row in page.rows} and page.total >= 3
    assert set(page.facets) == {"minPrice", "maxPrice", "configurationSpaceSize"}
    listing = await source.organization_pricings(DEFAULT_ENDPOINT, DANRUILOP1, None)
    assert {row.slug for row in listing.rows} >= {"mailgun", "sendgridrapidapi", "twilio-sendgrid-email-api"}
    fetched = await source.version_yaml(DEFAULT_ENDPOINT, TOMATOMETER, manifest.latest_version_id, None)
    assert fetched.body == sfx_bytes(f"{TOMATOMETER}/{manifest.latest_version_id}.yml")
    identity = await source.family(DEFAULT_ENDPOINT, MAILGUN)
    assert (identity.owner, identity.slug, identity.organization_id) == ("danruilop1", "mailgun", DANRUILOP1)
    assert source.permanent_url(DEFAULT_ENDPOINT, MAILGUN, "6ade36454b2b5b01c587db3d") == (
        f"https://sphere.score.us.es/p/{MAILGUN}?version=6ade36454b2b5b01c587db3d"
    )


async def test_whoami_keeps_the_scopes_and_drops_the_personal_fields(sphere: RecordedSphere) -> None:
    sphere.serve("/api/v1/users/me", sfx_bytes("users-me.json"), {"content-type": "application/json"})
    user = await _source(sphere).whoami(DEFAULT_ENDPOINT, _key())
    assert user.username == "fixture-user" and user.scopes == ((DANRUILOP1, "MANAGEMENT"),)
    assert "email" not in repr(user) and "example.invalid" not in repr(user)
    assert sphere.requests[-1].headers["x-api-key"] == "sk-" + "a" * 64


async def test_whoami_with_a_refused_key(sphere: RecordedSphere) -> None:
    sphere.unauthorized()
    with pytest.raises(CredentialRejected):
        await _source(sphere).whoami(DEFAULT_ENDPOINT, _key())


# --- revalidation and integrity --------------------------------------------------------------------------------------


async def test_an_anonymous_manifest_is_cached_then_revalidated_with_its_etag(sphere: RecordedSphere) -> None:
    clock = Clock()
    source = _source(sphere, clock)
    first = await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert len(sphere.sent(TOMATO_MANIFEST)) == 1
    clock.now += 301
    again = await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    sent = sphere.sent(TOMATO_MANIFEST)
    assert len(sent) == 2 and sent[1].headers["if-none-match"] == first.etag
    assert again == first
    # The 304 extended the entry.
    clock.now += 200
    await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert len(sphere.sent(TOMATO_MANIFEST)) == 2
    assert isinstance(await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None, if_none_match=first.etag), NotModified)


async def test_bytes_that_do_not_match_the_etag_fail(sphere: RecordedSphere) -> None:
    sphere.wrong_etag(f"{TOMATO_MANIFEST}/versions/")
    with pytest.raises(PricingSourceUnavailable) as caught:
        await _source(sphere).version_yaml(DEFAULT_ENDPOINT, TOMATOMETER, latest(TOMATOMETER), None)
    assert caught.value.reason == "integrity"


async def test_a_content_hash_mismatch_is_read_but_unverified(sphere: RecordedSphere, caplog) -> None:
    manifest = json.loads((SFX / TOMATOMETER / "manifest.json").read_text())
    manifest["versions"][0]["contentHash"] = "f" * 64
    sphere.serve(TOMATO_MANIFEST, json.dumps(manifest).encode(), {"content-type": "application/json"})
    with caplog.at_level(logging.WARNING):
        read = await read_version(_source(sphere), DEFAULT_ENDPOINT, TOMATOMETER, latest(TOMATOMETER), None)
    assert read.content_hash_verified is False and read.parsed.normalised is not None
    assert "pricing_content_hash_unverified" in caplog.text


async def test_the_recorded_version_verifies(sphere: RecordedSphere) -> None:
    read = await read_version(_source(sphere), DEFAULT_ENDPOINT, MAILGUN, latest(MAILGUN), None)
    assert read.content_hash_verified and read.entry.label == "2026-10"


async def test_an_encoded_answer_is_refused(sphere: RecordedSphere) -> None:
    sphere.encoded(TOMATO_MANIFEST)
    with pytest.raises(PricingSourceUnavailable) as caught:
        await _source(sphere).manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert caught.value.reason == "encoding"


# --- caching by credential -------------------------------------------------------------------------------------------


async def test_a_keyed_answer_is_never_cached_or_shown_to_another_caller(sphere: RecordedSphere) -> None:
    a = _key("org-a", "sk-" + "a" * 64)
    b = _key("org-b", "sk-" + "b" * 64)
    sphere.private(MAILGUN, PRIVATE_VERSION, sfx_bytes(f"{MAILGUN}/{latest(MAILGUN)}.yml"), credential=a.api_key)
    source = _source(sphere)
    keyed = await source.manifest(DEFAULT_ENDPOINT, MAILGUN, a)
    assert keyed.version(PRIVATE_VERSION) is not None and keyed.version(PRIVATE_VERSION).private
    for credential in (b, None):
        other = await source.manifest(DEFAULT_ENDPOINT, MAILGUN, credential)
        assert other.version(PRIVATE_VERSION) is None
    page = await source.search(DEFAULT_ENDPOINT, SearchQuery(name="Mailgun"), b)
    assert PRIVATE_VERSION not in {row.version_id for row in page.rows}
    # Each keyed call went to SPHERE: nothing keyed was served from the cache.
    await source.manifest(DEFAULT_ENDPOINT, MAILGUN, a)
    keyed_calls = [r for r in sphere.sent(f"/api/v1/public/pricings/{MAILGUN}") if r.headers.get("x-api-key") == a.api_key]
    assert len(keyed_calls) == 2
    with pytest.raises(PricingNotFound):
        await source.version_yaml(DEFAULT_ENDPOINT, MAILGUN, PRIVATE_VERSION, b)
    assert (await source.version_yaml(DEFAULT_ENDPOINT, MAILGUN, PRIVATE_VERSION, a)).body


# --- ids, queries, not found -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("bad", ["../../users/me?x=", "6ab0a323697330667ccce8c", "6AB0A323697330667CCCE8CD", "a" * 25, ""])
async def test_a_non_sphere_id_makes_no_request(sphere: RecordedSphere, bad: str) -> None:
    source = _source(sphere)
    with pytest.raises(PricingNotFound):
        await source.manifest(DEFAULT_ENDPOINT, bad, None)
    with pytest.raises(PricingNotFound):
        await source.version_yaml(DEFAULT_ENDPOINT, TOMATOMETER, bad, None)
    with pytest.raises(PricingNotFound):
        await source.family(DEFAULT_ENDPOINT, bad)
    with pytest.raises(PricingNotFound):
        await source.organization_pricings(DEFAULT_ENDPOINT, bad, None)
    assert sphere.requests == []


@pytest.mark.parametrize(
    "query",
    [SearchQuery(name="Mailgun", min_price=10), SearchQuery(sort_by="minPrice", sort="asc"), SearchQuery(name="Mailgun")],
)
async def test_discovery_never_sends_max_min_price(sphere: RecordedSphere, query: SearchQuery) -> None:
    await _source(sphere).search(DEFAULT_ENDPOINT, query, None)
    sent = sphere.requests[-1].url.params
    assert "max-minPrice" not in sent and "max-maxPrice" not in sent
    assert sent["limit"] == "24"
    if query.min_price is not None:
        assert sent["min-minPrice"] == "10"


async def test_unknown_and_private_without_a_key_are_not_found(sphere: RecordedSphere) -> None:
    source = _source(sphere)
    sphere.not_found("/api/v1/public/pricings/" + "0" * 24)
    with pytest.raises(PricingNotFound):
        await source.manifest(DEFAULT_ENDPOINT, "0" * 24, None)
    with pytest.raises(PricingNotFound):
        await read_version(source, DEFAULT_ENDPOINT, TOMATOMETER, "1" * 24, None)
    sphere.private(MAILGUN, PRIVATE_VERSION, b"x: 1\n", credential="sk-" + "a" * 64)
    with pytest.raises(PricingNotFound):
        await read_version(source, DEFAULT_ENDPOINT, MAILGUN, PRIVATE_VERSION, None)


async def test_a_rejected_key_is_reported_and_the_read_retried_anonymously(sphere: RecordedSphere) -> None:
    told = []

    async def rejected() -> None:
        told.append("invalid")

    sphere.unauthorized()
    manifest = await _source(sphere).manifest(DEFAULT_ENDPOINT, TOMATOMETER, _key(on_rejected=rejected))
    assert manifest.name == "TomatoMeter" and told == ["invalid"]
    assert "x-api-key" in sphere.requests[0].headers and "x-api-key" not in sphere.requests[1].headers


# --- back-off --------------------------------------------------------------------------------------------------------


async def test_a_429_closes_only_that_bucket_until_retry_after(sphere: RecordedSphere) -> None:
    clock = Clock()
    source = _source(sphere, clock)
    a, b = _key("org-a", "sk-" + "a" * 64), _key("org-b", "sk-" + "b" * 64)
    sphere.rate_limited(7, credential=a.api_key, times=1)
    with pytest.raises(PricingSourceBusy) as caught:
        await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, a)
    assert caught.value.retry_after == 7
    sent = len(sphere.requests)
    with pytest.raises(PricingSourceBusy):
        await source.manifest(DEFAULT_ENDPOINT, MAILGUN, a)
    assert len(sphere.requests) == sent  # failed fast, nothing sent
    assert (await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, b)).name == "TomatoMeter"
    assert (await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)).name == "TomatoMeter"
    clock.now += 8
    assert (await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, a)).name == "TomatoMeter"


async def test_the_rate_limit_reserve_closes_the_bucket_until_reset(sphere: RecordedSphere) -> None:
    clock = Clock()
    source = _source(sphere, clock)
    sphere.rate_limit_headers(limit=300, remaining=30, reset=9)
    await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    with pytest.raises(PricingSourceBusy):
        await source.manifest(DEFAULT_ENDPOINT, MAILGUN, None)
    assert (await source.manifest(DEFAULT_ENDPOINT, MAILGUN, _key())).name == "Mailgun"
    clock.now += 10
    sphere.ratelimit = None
    assert (await source.manifest(DEFAULT_ENDPOINT, MAILGUN, None)).name == "Mailgun"


async def test_a_503_is_negatively_cached_for_its_path_only(sphere: RecordedSphere) -> None:
    clock = Clock()
    source = _source(sphere, clock)
    sphere.unavailable(TOMATO_MANIFEST, times=1)
    with pytest.raises(PricingSourceUnavailable):
        await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    sent = len(sphere.requests)
    with pytest.raises(PricingSourceUnavailable):
        await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert len(sphere.requests) == sent
    assert (await source.manifest(DEFAULT_ENDPOINT, MAILGUN, None)).name == "Mailgun"
    clock.now += 61
    assert (await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)).name == "TomatoMeter"


async def test_a_connect_timeout_backs_the_host_off(sphere: RecordedSphere) -> None:
    clock = Clock()
    source = _source(sphere, clock)
    sphere.connect_error(times=1)
    with pytest.raises(PricingSourceUnavailable) as caught:
        await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert caught.value.reason == "timeout"
    assert source.state() == "backing-off"
    with pytest.raises(PricingSourceUnavailable):
        await source.manifest(DEFAULT_ENDPOINT, MAILGUN, None)
    assert len(sphere.requests) == 1
    clock.now += 6
    assert (await source.manifest(DEFAULT_ENDPOINT, MAILGUN, None)).name == "Mailgun"
    assert source.state() == "configured"


async def test_a_slow_answer_is_unavailable(sphere: RecordedSphere) -> None:
    sphere.slow(TOMATO_MANIFEST, seconds=5)
    with pytest.raises(PricingSourceUnavailable) as caught:
        await _source(sphere, sphere_timeout_s=0.2).manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert caught.value.reason == "timeout"


async def test_an_oversize_body_is_refused_while_streaming(sphere: RecordedSphere) -> None:
    sphere.oversize(f"{TOMATO_MANIFEST}/versions/", 4096)
    with pytest.raises(PricingSourceUnavailable) as caught:
        await _source(sphere, sphere_max_bytes=1024).version_yaml(DEFAULT_ENDPOINT, TOMATOMETER, latest(TOMATOMETER), None)
    assert caught.value.reason == "too_large"


async def test_sphere_redirects_are_refused(sphere: RecordedSphere) -> None:
    sphere.redirect(TOMATO_MANIFEST, "https://sphere.score.us.es/elsewhere")
    with pytest.raises(PricingSourceUnavailable) as caught:
        await _source(sphere).manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert caught.value.reason == "redirect"


# --- registries, keys and URLs ---------------------------------------------------------------------------------------


def _with_registry(sphere: RecordedSphere, **update) -> SphereHttpSource:
    sphere.add_host("registry.internal", "10.0.0.7")
    registries = {"lab": {"url": "https://registry.internal", "api_key": "operator-key"}}
    settings = _settings(sphere_registries=Settings(sphere_registries=registries).sphere_registries, **update)
    return SphereHttpSource(settings, transport=sphere.transport())


async def test_a_registry_alias_reads_its_url_with_its_operator_key_on_a_private_address(sphere: RecordedSphere) -> None:
    source = _with_registry(sphere)
    manifest = await source.manifest(SphereEndpoint("lab"), TOMATOMETER, _key())
    assert manifest.name == "TomatoMeter"
    request = sphere.requests[-1]
    assert request.url.host == "10.0.0.7" and request.headers["host"] == "registry.internal"
    # The operator key, never the organization's.
    assert request.headers["x-api-key"] == "operator-key"
    assert source.permanent_url(SphereEndpoint("lab"), TOMATOMETER) == f"https://registry.internal/p/{TOMATOMETER}"
    assert source.registries() == ("lab",)


async def test_a_url_on_that_private_address_is_refused(sphere: RecordedSphere) -> None:
    source = _with_registry(sphere)
    with pytest.raises(PricingSourceUnavailable) as caught:
        await source.url_yaml("https://registry.internal/pricing.yml")
    assert caught.value.reason == "address"
    assert sphere.requests == []


async def test_an_unknown_alias_raises(sphere: RecordedSphere) -> None:
    with pytest.raises(PricingSourceUnavailable) as caught:
        await _source(sphere).manifest(SphereEndpoint("nowhere"), TOMATOMETER, None)
    assert caught.value.reason == "registry_unknown"


async def test_the_default_sphere_sends_no_key_without_a_credential(sphere: RecordedSphere) -> None:
    source = _source(sphere)
    await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    await source.search(DEFAULT_ENDPOINT, SearchQuery(name="Mailgun"), None)
    assert not any("x-api-key" in r.headers or "authorization" in r.headers for r in sphere.requests)


async def test_a_credential_never_reaches_a_url(sphere: RecordedSphere) -> None:
    sphere.add_host("pricings.example", "93.184.216.34")
    body = sfx_bytes(f"{DROPBOX}/{DROPBOX_2021}.yml")
    sphere.serve("/dropbox.yml", body, {"content-type": "application/yaml", "etag": '"v1"', "last-modified": "Wed, 18 Nov 2026 10:00:00 GMT"})
    source = _source(sphere)
    fetched = await source.url_yaml("https://pricings.example/dropbox.yml")
    assert fetched.body == body and fetched.etag == '"v1"'
    assert not any("x-api-key" in r.headers for r in sphere.requests)
    again = await source.url_yaml("https://pricings.example/dropbox.yml", if_none_match='"v1"',
                                  if_modified_since="Wed, 18 Nov 2026 10:00:00 GMT")
    assert isinstance(again, NotModified)
    assert sphere.requests[-1].headers["if-modified-since"] == "Wed, 18 Nov 2026 10:00:00 GMT"


async def test_url_redirects_are_followed_revalidated_and_bounded(sphere: RecordedSphere) -> None:
    sphere.add_host("pricings.example", "93.184.216.34")
    sphere.add_host("cdn.example", "93.184.216.35")
    sphere.serve("/final.yml", b"saasName: x\n", {"content-type": "application/yaml"})
    sphere.redirect("/start.yml", "https://cdn.example/final.yml")
    source = UrlSource(_settings(), transport=sphere.transport())
    fetched = await source.url_yaml("https://pricings.example/start.yml")
    assert fetched.url == "https://cdn.example/final.yml" and sphere.requests[-1].url.host == "93.184.216.35"
    sphere.redirect("/http.yml", "http://cdn.example/final.yml")
    with pytest.raises(PricingSourceUnavailable) as caught:
        await source.url_yaml("https://pricings.example/http.yml")
    assert caught.value.reason == "redirect"
    with pytest.raises(PricingSourceUnavailable):
        await UrlSource(_settings(offering_url_max_redirects=0), transport=sphere.transport()).url_yaml(
            "https://pricings.example/start.yml"
        )


async def test_with_sphere_disabled_registries_and_urls_still_read(sphere: RecordedSphere) -> None:
    source = _with_registry(sphere, sphere_enabled=False)
    with pytest.raises(PricingSourceUnavailable) as caught:
        await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert caught.value.reason == "disabled"
    assert source.state() == "disabled"
    assert (await source.manifest(SphereEndpoint("lab"), TOMATOMETER, None)).name == "TomatoMeter"
    sphere.add_host("pricings.example", "93.184.216.34")
    sphere.serve("/p.yml", b"a: 1\n", {"content-type": "application/yaml"})
    assert (await source.url_yaml("https://pricings.example/p.yml")).body == b"a: 1\n"


@pytest.mark.parametrize("url", ["http://sphere.score.us.es", "ftp://sphere.score.us.es", "sphere.score.us.es"])
def test_sphere_url_must_be_https(url: str) -> None:
    with pytest.raises(ValidationError):
        Settings(sphere_url=url)
    assert Settings(sphere_url="").sphere_url == "https://sphere.score.us.es"

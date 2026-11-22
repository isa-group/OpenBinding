"""``SphereHttpSource.manifest(..., revalidate=True)``: the upstream watcher's read always reaches SPHERE."""

from __future__ import annotations

import pytest

from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
from openbinding_gateway.modules.plans.application import (
    DEFAULT_ENDPOINT,
    Credential,
    NotModified,
    PricingNotFound,
    PricingSourceBusy,
)
from sphere_recorded import RecordedSphere

from ._pricings import SET_B, TOMATOMETER

TOMATO_MANIFEST = f"/api/v1/public/pricings/{TOMATOMETER}"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _settings(**update) -> Settings:
    return get_settings().model_copy(update={"sphere_enabled": True, **update})


def _source(sphere: RecordedSphere, clock: Clock | None = None) -> SphereHttpSource:
    return SphereHttpSource(_settings(), transport=sphere.transport(), clock=clock or Clock())


async def test_a_fresh_entry_is_revalidated_with_one_conditional_request(sphere: RecordedSphere) -> None:
    source = _source(sphere)
    first = await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert len(sphere.sent(TOMATO_MANIFEST)) == 1
    answer = await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None, if_none_match=first.etag, revalidate=True)
    sent = sphere.sent(TOMATO_MANIFEST)
    assert isinstance(answer, NotModified) and answer.etag == first.etag
    assert len(sent) == 2 and sent[1].headers["if-none-match"] == first.etag


async def test_without_revalidate_a_fresh_entry_sends_nothing(sphere: RecordedSphere) -> None:
    source = _source(sphere)
    first = await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    answer = await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None, if_none_match=first.etag)
    assert isinstance(answer, NotModified)
    assert len(sphere.sent(TOMATO_MANIFEST)) == 1


async def test_a_new_etag_returns_the_new_manifest(sphere: RecordedSphere) -> None:
    source = _source(sphere)
    first = await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    answer = await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None, if_none_match='"stale"', revalidate=True)
    assert not isinstance(answer, NotModified)
    assert answer.etag == first.etag and answer.latest_version_id == first.latest_version_id
    assert sphere.sent(TOMATO_MANIFEST)[-1].headers["if-none-match"] == '"stale"'


async def test_a_closed_bucket_is_busy_without_a_request_even_when_revalidating(sphere: RecordedSphere) -> None:
    clock = Clock()
    source = _source(sphere, clock)
    sphere.rate_limited(30, anonymous=True, times=1)
    with pytest.raises(PricingSourceBusy):
        await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None, revalidate=True)
    sent = len(sphere.requests)
    with pytest.raises(PricingSourceBusy):
        await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None, revalidate=True)
    assert len(sphere.requests) == sent


async def test_a_recent_404_is_answered_from_the_negative_cache_unless_revalidating(sphere: RecordedSphere) -> None:
    clock = Clock()
    source = _source(sphere, clock)
    sphere.not_found(TOMATO_MANIFEST)
    with pytest.raises(PricingNotFound):
        await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert len(sphere.sent(TOMATO_MANIFEST)) == 1
    clock.now += 20  # below NEGATIVE_TTL_S
    with pytest.raises(PricingNotFound):
        await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert len(sphere.sent(TOMATO_MANIFEST)) == 1
    with pytest.raises(PricingNotFound):
        await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None, revalidate=True)
    assert len(sphere.sent(TOMATO_MANIFEST)) == 2


async def test_a_rejected_key_is_told_once_and_the_manifest_read_anonymously(sphere: RecordedSphere) -> None:
    told: list[str] = []

    async def rejected() -> None:
        told.append("invalid")

    sphere.unauthorized()
    credential = Credential("org-a", "sk-" + "a" * 64, rejected)
    manifest = await _source(sphere).manifest(DEFAULT_ENDPOINT, SET_B["mailgun"], credential, revalidate=True)
    assert manifest.name == "Mailgun" and told == ["invalid"]
    assert "x-api-key" in sphere.requests[0].headers and "x-api-key" not in sphere.requests[1].headers


# -- SPHERE_REQUIRE_HTTPS (F6-C): plain http to a local SPHERE outside production -------------------------------------

LAB = "http://sphere-lab:8080"


def _lab_source(sphere: RecordedSphere, **update) -> SphereHttpSource:
    settings = _settings(sphere_url=LAB, sphere_require_https=False, **update)
    return SphereHttpSource(settings, transport=sphere.transport(), clock=Clock())


async def test_with_the_switch_a_plain_http_sphere_on_a_private_address_is_read(sphere: RecordedSphere) -> None:
    sphere.add_host("sphere-lab", "172.18.0.5")
    source = _lab_source(sphere)
    manifest = await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert manifest.name == "TomatoMeter"
    request = sphere.requests[-1]
    assert request.url.scheme == "http" and request.url.host == "172.18.0.5" and request.headers["host"] == "sphere-lab:8080"
    # A version's integrity check (ETag = SHA-256 of the bytes) still applies.
    fetched = await source.version_yaml(DEFAULT_ENDPOINT, TOMATOMETER, manifest.latest_version_id, None)
    assert fetched.body


async def test_with_the_switch_plain_http_to_a_global_address_is_refused_before_any_request(sphere: RecordedSphere) -> None:
    from openbinding_gateway.modules.plans.application import PricingSourceUnavailable

    sphere.add_host("sphere-lab", "193.147.175.105")
    source = _lab_source(sphere)
    with pytest.raises(PricingSourceUnavailable) as caught:
        await source.manifest(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert caught.value.__cause__.code == "outbound_address"
    assert sphere.requests == []


async def test_without_the_switch_the_default_sphere_stays_https_and_global(sphere: RecordedSphere) -> None:
    source = _source(sphere)
    assert source._policy(source._target(DEFAULT_ENDPOINT)).https_only is True
    assert source._policy(source._target(DEFAULT_ENDPOINT)).allow_internal is False
    relaxed = _lab_source(sphere)
    policy = relaxed._policy(relaxed._target(DEFAULT_ENDPOINT))
    assert (policy.https_only, policy.allow_internal) == (False, True)


async def test_a_registry_and_a_url_stay_https_with_the_switch(sphere: RecordedSphere) -> None:
    from openbinding_gateway.modules.plans.application import PricingSourceUnavailable, SphereEndpoint

    sphere.add_host("registry.internal", "10.0.0.7")
    registries = Settings(sphere_registries={"lab": {"url": "https://registry.internal"}}).sphere_registries
    source = _lab_source(sphere, sphere_registries=registries)
    assert source._policy(source._target(SphereEndpoint("lab"))).https_only is True
    with pytest.raises(ValueError, match="https only"):
        Settings(sphere_registries={"lab": {"url": "http://registry.internal"}})
    # A Pricing2Yaml URL (an offering) is user input: never http, never a private address.
    sphere.add_host("pricings.lab", "10.0.0.8")
    sphere.serve("/p.yml", b"a: 1\n", {"content-type": "application/yaml"})
    with pytest.raises(PricingSourceUnavailable) as caught:
        await source.url_yaml("http://pricings.lab/p.yml")
    assert caught.value.reason == "scheme"
    assert not sphere.sent("/p.yml")


async def test_links_are_built_on_the_public_sphere_url(sphere: RecordedSphere) -> None:
    source = _lab_source(sphere, sphere_public_url="https://sphere.score.us.es")
    assert source.permanent_url(DEFAULT_ENDPOINT, TOMATOMETER, "6921867e7004563bd918e7e8") == (
        f"https://sphere.score.us.es/p/{TOMATOMETER}?version=6921867e7004563bd918e7e8"
    )
    assert _lab_source(sphere).permanent_url(DEFAULT_ENDPOINT, TOMATOMETER) == f"{LAB}/p/{TOMATOMETER}"
    assert _source(sphere).permanent_url(DEFAULT_ENDPOINT, TOMATOMETER) == f"https://sphere.score.us.es/p/{TOMATOMETER}"

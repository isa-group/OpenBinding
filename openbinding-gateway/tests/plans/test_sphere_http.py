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

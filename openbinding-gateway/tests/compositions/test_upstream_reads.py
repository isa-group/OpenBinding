"""``ManifestReads``: the bounded, typed manifest reads shared by "Check now" and the upstream watcher."""

from __future__ import annotations

from openbinding_gateway.modules.compositions.application.upstream_reads import ManifestReads, ReadFailure
from openbinding_gateway.modules.plans.application import DEFAULT_ENDPOINT, Manifest, NotModified
from sphere_recorded import RecordedSphere

from plans._pricings import DROPBOX, SET_B, TOMATOMETER


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


async def test_reads_are_shared_per_pricing_and_bounded_by_count(sphere: RecordedSphere) -> None:
    reads = ManifestReads(max_reads=2, deadline_s=10)
    first = await reads.read(DEFAULT_ENDPOINT, TOMATOMETER, None)
    again = await reads.read(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert isinstance(first, Manifest) and again is first
    assert isinstance(await reads.read(DEFAULT_ENDPOINT, DROPBOX, None), Manifest)
    assert reads.left == 0
    assert await reads.read(DEFAULT_ENDPOINT, SET_B["brevo"], None) == ReadFailure("unavailable", "budget")
    assert len(sphere.sent("/api/v1/public/pricings/")) == 2


async def test_the_deadline_stops_further_reads(sphere: RecordedSphere) -> None:
    clock = Clock()
    reads = ManifestReads(max_reads=8, deadline_s=10, clock=clock)
    clock.now = 11
    assert await reads.read(DEFAULT_ENDPOINT, TOMATOMETER, None) == ReadFailure("unavailable", "deadline")
    assert sphere.sent("/api/v1/public/pricings/") == []


async def test_failures_are_typed(sphere: RecordedSphere) -> None:
    sphere.rate_limited(12, path=f"/api/v1/public/pricings/{TOMATOMETER}", times=1)
    sphere.not_found(f"/api/v1/public/pricings/{DROPBOX}")
    sphere.unavailable(f"/api/v1/public/pricings/{SET_B['brevo']}", status=500)
    reads = ManifestReads(max_reads=8, deadline_s=10)
    assert await reads.read(DEFAULT_ENDPOINT, DROPBOX, None) == ReadFailure("not_found")
    assert await reads.read(DEFAULT_ENDPOINT, SET_B["brevo"], None) == ReadFailure("unavailable", "unavailable")
    assert await reads.read(DEFAULT_ENDPOINT, "not-an-id", None) == ReadFailure("not_found", "not_a_sphere_id")
    # The 429 closes the anonymous bucket: it is the last read here.
    assert await reads.read(DEFAULT_ENDPOINT, TOMATOMETER, None) == ReadFailure("busy", "sphere_busy", 12)


async def test_revalidate_is_passed_through(sphere: RecordedSphere) -> None:
    path = f"/api/v1/public/pricings/{TOMATOMETER}"
    first = await ManifestReads(max_reads=1, deadline_s=10).read(DEFAULT_ENDPOINT, TOMATOMETER, None)
    assert isinstance(first, Manifest)
    cached = await ManifestReads(max_reads=1, deadline_s=10).read(
        DEFAULT_ENDPOINT, TOMATOMETER, None, if_none_match=first.etag
    )
    assert isinstance(cached, NotModified) and len(sphere.sent(path)) == 1
    fresh = await ManifestReads(max_reads=1, deadline_s=10, revalidate=True).read(
        DEFAULT_ENDPOINT, TOMATOMETER, None, if_none_match=first.etag
    )
    assert isinstance(fresh, NotModified) and len(sphere.sent(path)) == 2

"""The recorded SPHERE set (``fixtures/sphere``) is coherent, and ``RecordedSphere`` serves it offline."""

from __future__ import annotations

import hashlib
import json

import httpx
import pytest

from sphere_recorded import SFX, SPHERE_HOST, RecordedSphere, UnrecordedRequest

ROUTES = json.loads((SFX / "routes.json").read_text())


def test_every_route_points_at_existing_files() -> None:
    for key, entry in ROUTES.items():
        assert (SFX / entry["file"]).is_file(), key
        assert (SFX / entry["headers"]).is_file(), key


def test_every_manifest_lists_recorded_versions_and_every_yaml_matches_its_etag() -> None:
    yamls = 0
    for manifest_path in SFX.glob("*/manifest.json"):
        manifest = json.loads(manifest_path.read_text())
        ids = {entry["versionId"] for entry in manifest["versions"]}
        assert manifest["latestVersionId"] in ids
        for path in manifest_path.parent.glob("*.yml"):
            assert path.stem in ids, path
            headers = json.loads(path.with_suffix(".headers.json").read_text())
            assert headers["etag"] == '"' + hashlib.sha256(path.read_bytes()).hexdigest() + '"'
            yamls += 1
    assert yamls >= 25


def test_discovery_rows_reference_recorded_families_or_say_so() -> None:
    recorded = {path.parent.name for path in SFX.glob("*/manifest.json")}
    search = json.loads((SFX / "search" / "name-Mailgun.json").read_text())
    assert {"total", "pricings", "minPrice", "maxPrice", "configurationSpaceSize"} <= set(search)
    rows = {row["pricingId"] for row in search["pricings"]}
    assert "6ade364540e55445692b0eda" in rows and "6ae077ac40e55445692c01ce" in rows
    assert rows & recorded


def _get(transport: httpx.MockTransport, path: str, headers: dict | None = None) -> httpx.Response:
    async def run() -> httpx.Response:
        async with httpx.AsyncClient(transport=transport) as client:
            return await client.get(f"https://{SPHERE_HOST}{path}", headers=headers or {})

    import asyncio

    return asyncio.run(run())


def test_it_serves_200_and_304() -> None:
    sphere = RecordedSphere()
    path = "/api/v1/public/pricings/6ab0a323697330667ccce8cd"
    first = _get(sphere.transport(), path)
    assert first.status_code == 200 and first.json()["name"] == "TomatoMeter"
    second = _get(sphere.transport(), path, {"if-none-match": first.headers["etag"]})
    assert second.status_code == 304
    assert len(sphere.requests) == 2


def test_unknown_urls_raise() -> None:
    sphere = RecordedSphere()
    with pytest.raises(UnrecordedRequest):
        _get(sphere.transport(), "/api/v1/users/me")


def test_scripts_answer_before_the_recordings() -> None:
    sphere = RecordedSphere()
    path = "/api/v1/public/pricings/6ab0a323697330667ccce8cd"
    sphere.rate_limited(7, credential="sk-a", times=1)
    assert _get(sphere.transport(), path, {"x-api-key": "sk-a"}).status_code == 429
    assert _get(sphere.transport(), path, {"x-api-key": "sk-a"}).status_code == 200
    sphere.unavailable(path)
    assert _get(sphere.transport(), path).status_code == 503
    other = RecordedSphere()
    other.unauthorized()
    assert _get(other.transport(), path, {"x-api-key": "sk-x"}).status_code == 401
    assert _get(other.transport(), path).status_code == 200

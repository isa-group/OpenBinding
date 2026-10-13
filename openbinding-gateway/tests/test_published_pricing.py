"""The published pricing is read from SPHERE, read only, and never stored here.

A mocked SPHERE serves one public version; the tests check what the public page
and the renderer get, that only GET requests ever leave the gateway, and that a
published version whose bytes change is refused instead of served.
"""

from __future__ import annotations

import functools
import hashlib

import httpx
import pytest

from openbinding_gateway import pricing_catalog as catalog_module
from openbinding_gateway.core.public_errors import PUBLISHED_PRICING_UNAVAILABLE
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.main import app
from openbinding_gateway.pricing_catalog import PricingCatalogError, published_pricing
from openbinding_gateway.routes import pricing as pricing_routes
from openbinding_gateway.sphere_client import SphereClient, SphereError

BASE = "https://sphere.test"
ORG = "org-1"
VERSION = "0.1.0"
DOCUMENT = (
    b"syntaxVersion: '3.1'\nsaasName: openbinding\nversion: 0.1.0\ncreatedAt: '2026-10-12T00:00:00Z'\n"
    b"features:\n  solve:\n    valueType: BOOLEAN\n    defaultValue: true\n"
    b"usageLimits:\n  apiKeys:\n    valueType: NUMERIC\n    defaultValue: .inf\n"
    b"plans:\n  BASIC:\n    price: 0.0\n"
)


class Sphere:
    """A scripted SPHERE that records every request it receives."""

    def __init__(self, *, body: bytes = DOCUMENT, private: bool = False, organizations=None):
        self.body = body
        self.private = private
        self.organizations = organizations
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == f"/api/v1/orgs/{ORG}":
            return httpx.Response(200, json={"id": ORG, "name": "openbinding", "displayName": "OpenBinding"})
        if path == "/api/v1/users/me/orgs":
            return httpx.Response(200, json=self.organizations if self.organizations is not None else [])
        if path == f"/api/v1/pricings/{ORG}/openbinding":
            return httpx.Response(200, json={
                "slug": "openbinding",
                "versions": [{
                    "version": VERSION,
                    "private": self.private,
                    "yaml": f"/static/pricings/openbinding/{VERSION}.yaml",
                }],
            })
        if path == f"/static/pricings/openbinding/{VERSION}.yaml":
            return httpx.Response(200, content=self.body)
        return httpx.Response(404, json={"error": "not found"})

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)


def configured(**overrides) -> Settings:
    values = dict(
        _env_file=None,
        sphere_enabled=True,
        sphere_url=BASE,
        sphere_api_key="read-key",
        sphere_organization_id=ORG,
        space_pricing_version=VERSION,
    )
    values.update(overrides)
    return Settings(**values)


@pytest.fixture(autouse=True)
def fresh_cache():
    catalog_module.clear_cache()
    yield
    catalog_module.clear_cache()


@pytest.fixture
def sphere(monkeypatch):
    """SPHERE mocked into the routes, with SPHERE enabled for the app."""
    server = Sphere()
    settings = configured()
    monkeypatch.setattr(
        pricing_routes, "published_pricing", functools.partial(published_pricing, transport=server.transport)
    )
    app.dependency_overrides[get_settings] = lambda: settings
    yield server
    app.dependency_overrides.pop(get_settings, None)


async def test_the_catalog_is_the_published_document_as_json(api_client, sphere):
    response = await api_client.get("/v1/pricing/catalog")

    assert response.status_code == 200
    body = response.json()
    assert body["version"] == VERSION
    assert body["createdAt"] == "2026-10-12T00:00:00Z"
    assert body["plans"]["BASIC"]["price"] == 0.0
    # YAML infinity is legal JSON as null, never an invented ceiling.
    assert body["usageLimits"]["apiKeys"]["defaultValue"] is None


async def test_current_names_the_version_digest_and_public_url(api_client, sphere):
    response = await api_client.get("/v1/pricing/current")

    assert response.status_code == 200
    assert response.json() == {
        "version": VERSION,
        "digest": f"sha256-{hashlib.sha256(DOCUMENT).hexdigest()}",
        "url": f"{BASE}/static/pricings/openbinding/{VERSION}.yaml",
    }


async def test_the_deprecated_yaml_proxy_serves_the_exact_bytes(api_client, sphere):
    response = await api_client.get("/v1/pricing")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/yaml")
    assert response.content == DOCUMENT
    assert response.headers["etag"] == f'"sha256-{hashlib.sha256(DOCUMENT).hexdigest()}"'


async def test_only_get_requests_ever_reach_sphere(api_client, sphere):
    for path in ("/v1/pricing/catalog", "/v1/pricing/current", "/v1/pricing"):
        assert (await api_client.get(path)).status_code == 200

    assert sphere.requests
    assert {request.method for request in sphere.requests} == {"GET"}


async def test_the_version_shown_comes_from_configuration(api_client, sphere):
    app.dependency_overrides[get_settings] = lambda: configured(space_pricing_version="9.9.9")

    response = await api_client.get("/v1/pricing/current")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "pricing_unavailable"


async def test_without_sphere_the_endpoints_answer_503_pricing_unavailable(api_client):
    # The suite runs with SPHERE disabled; nothing is read from disk or the database instead.
    for path in ("/v1/pricing/catalog", "/v1/pricing/current", "/v1/pricing"):
        response = await api_client.get(path)
        assert response.status_code == 503, path
        assert response.json()["detail"]["code"] == "pricing_unavailable", path


async def test_without_a_configured_version_the_endpoints_answer_503(api_client, sphere, caplog):
    app.dependency_overrides[get_settings] = lambda: configured(space_pricing_version=None)

    response = await api_client.get("/v1/pricing/catalog")

    assert response.status_code == 503
    assert response.json()["detail"]["error"] == PUBLISHED_PRICING_UNAVAILABLE.detail
    assert "SPACE_PRICING_VERSION" not in response.text
    # The reason stays in the internal log.
    assert "SPACE_PRICING_VERSION" in caplog.text


async def test_a_private_version_is_never_shown(api_client, sphere, caplog):
    sphere.private = True

    response = await api_client.get("/v1/pricing/catalog")

    assert response.status_code == 503
    assert response.json()["detail"]["error"] == PUBLISHED_PRICING_UNAVAILABLE.detail
    assert "public" not in response.json()["detail"]["error"]
    assert "public" in caplog.text


async def test_a_published_version_whose_bytes_change_is_refused(sphere):
    settings = configured()
    first = await published_pricing(settings, transport=sphere.transport)
    catalog_module._CACHE.clear()  # the cached read expired
    sphere.body = DOCUMENT.replace(b"BASIC", b"CHEAP")

    with pytest.raises(PricingCatalogError, match="immutable digest"):
        await published_pricing(settings, transport=sphere.transport)

    sphere.body = DOCUMENT
    again = await published_pricing(settings, transport=sphere.transport)
    assert again.digest == first.digest


async def test_a_document_that_declares_another_version_is_refused(sphere):
    sphere.body = DOCUMENT.replace(b"version: 0.1.0", b"version: 0.2.0")

    with pytest.raises(PricingCatalogError, match="different pricing version"):
        await published_pricing(configured(), transport=sphere.transport)


async def test_a_verified_read_is_reused_until_it_expires(sphere):
    settings = configured()
    await published_pricing(settings, transport=sphere.transport)
    count = len(sphere.requests)

    await published_pricing(settings, transport=sphere.transport)

    assert len(sphere.requests) == count


# -- The client itself ------------------------------------------------------------


def test_the_sphere_client_has_no_write_operations():
    for name in ("upload", "delete_private_version", "create_organization"):
        assert not hasattr(SphereClient, name), name


async def test_a_missing_organization_is_an_error_not_a_creation():
    server = Sphere(organizations=[])
    client = SphereClient(configured(sphere_organization_id=None), transport=server.transport)
    try:
        with pytest.raises(SphereError, match="no OpenBinding organization"):
            await client.organization_id()
    finally:
        await client.aclose()

    assert {request.method for request in server.requests} == {"GET"}


async def test_the_organization_is_found_by_name_when_not_configured():
    server = Sphere(organizations=[{"id": ORG, "name": "openbinding", "displayName": "OpenBinding"}])
    client = SphereClient(configured(sphere_organization_id=None), transport=server.transport)
    try:
        assert await client.organization_id() == ORG
        versions = await client.list_versions()
    finally:
        await client.aclose()

    assert [item.version for item in versions] == [VERSION]
    assert {request.method for request in server.requests} == {"GET"}

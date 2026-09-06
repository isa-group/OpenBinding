"""SPHERE/SPACE pricing lifecycle boundaries and local metadata invariants."""

from __future__ import annotations

import uuid
import json

import httpx
import pytest
from sqlalchemy import inspect, select

from _repo import REPO_ROOT
from openbinding_gateway.core.settings import Settings
from openbinding_gateway.db.models import (
    PricingRelease,
    PricingSpaceState,
    PricingSphereState,
    User,
    UserRole,
)
from openbinding_gateway.routes import pricing as pricing_routes
from openbinding_gateway.space_client import PricingUnavailable
from openbinding_gateway.space_client.deployments import SpaceDeploymentClient
from openbinding_gateway.sphere_client import SphereClient, SphereError
from openbinding_gateway.sphere_client import SpherePricingVersion


def sphere_settings(**overrides) -> Settings:
    return Settings(
        _env_file=None,
        sphere_enabled=True,
        sphere_url="https://sphere.example",
        sphere_api_key="sphere-secret",
        **overrides,
    )


def _version(*, private: bool | str = False, url: str = "/static/pricings/openbinding/0.1.0.yaml"):
    return {
        "version": "0.1.0",
        "private": private,
        "yaml": url,
        "organizationId": "org-1",
        "slug": "openbinding",
    }


async def test_sphere_uses_one_api_key_organization_and_slug() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        assert request.headers["x-api-key"] == "sphere-secret"
        if request.url.path == "/api/v1/users/me/orgs":
            return httpx.Response(200, json=[{"id": "org-1", "displayName": "OpenBinding"}])
        if request.url.path == "/api/v1/pricings/org-1/openbinding":
            assert request.url.params["includePrivate"] == "true"
            return httpx.Response(200, json={"slug": "openbinding", "versions": [_version(private="false")]})
        if request.url.path == "/static/pricings/openbinding/0.1.0.yaml":
            return httpx.Response(200, content=b"version: 0.1.0\n")
        raise AssertionError(request.url)

    client = SphereClient(sphere_settings(), transport=httpx.MockTransport(handler))
    try:
        versions = await client.list_versions()
        content = await client.content("0.1.0")
    finally:
        await client.aclose()

    assert [(item.version, item.private, item.organization_id) for item in versions] == [
        ("0.1.0", False, "org-1")
    ]
    assert content == b"version: 0.1.0\n"
    assert all(request.url.host == "sphere.example" for request in seen)


async def test_sphere_rejects_cross_origin_pricing_urls() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/users/me/orgs":
            return httpx.Response(200, json=[{"id": "org-1", "displayName": "OpenBinding"}])
        return httpx.Response(
            200,
            json={
                "slug": "openbinding",
                "versions": [_version(url="https://attacker.example/static/pricings/stolen.yaml")],
            },
        )

    client = SphereClient(sphere_settings(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(SphereError, match="another origin"):
            await client.list_versions()
    finally:
        await client.aclose()


async def test_sphere_uploads_visibility_and_never_overwrites_a_version() -> None:
    posts: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/users/me/orgs":
            return httpx.Response(200, json=[{"id": "org-1", "displayName": "OpenBinding"}])
        if request.method == "GET":
            return httpx.Response(404)
        posts.append(request)
        return httpx.Response(
            201,
            json=_version(
                private=True,
                url="/static/pricings/openbinding/0.1.0-draft.1.yaml",
            )
            | {"version": "0.1.0-draft.1"},
        )

    client = SphereClient(sphere_settings(), transport=httpx.MockTransport(handler))
    try:
        uploaded = await client.upload(
            b"version: 0.1.0-draft.1\n", "0.1.0-draft.1", private=True
        )
    finally:
        await client.aclose()

    assert uploaded.private is True
    assert [request.url.path for request in posts] == ["/api/v1/pricings/org-1"]
    assert b'name="private"' in posts[0].content
    assert b"true" in posts[0].content


async def test_sphere_never_deletes_a_public_release() -> None:
    methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        if request.url.path == "/api/v1/users/me/orgs":
            return httpx.Response(200, json=[{"id": "org-1", "displayName": "OpenBinding"}])
        return httpx.Response(200, json={"slug": "openbinding", "versions": [_version()]})

    client = SphereClient(sphere_settings(), transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(SphereError, match="Public SPHERE releases"):
            await client.delete_private_version("0.1.0")
    finally:
        await client.aclose()
    assert "DELETE" not in methods


async def test_space_destructive_operations_require_the_separate_key() -> None:
    settings = Settings(
        _env_file=None,
        space_enabled=True,
        space_url="https://space.example",
        space_api_key="normal-key",
    )
    client = SpaceDeploymentClient(settings, transport=httpx.MockTransport(lambda _: httpx.Response(204)))
    with pytest.raises(PricingUnavailable, match="SPACE_DESTRUCTIVE_API_KEY"):
        await client.delete_archived("0.1.0-draft.1")


async def test_space_deletes_only_an_exact_archived_version_with_the_destructive_key() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(204)

    settings = Settings(
        _env_file=None,
        space_enabled=True,
        space_url="https://space.example",
        space_api_key="normal-key",
        space_destructive_api_key="destructive-key",
    )
    client = SpaceDeploymentClient(settings, transport=httpx.MockTransport(handler))
    await client.delete_archived("0.1.0-draft.1")

    assert seen[0].method == "DELETE"
    assert seen[0].headers["x-api-key"] == "destructive-key"
    assert seen[0].url.path == "/api/v1/services/openbinding/pricings/0.1.0-draft.1"


async def test_space_counts_contracts_pinned_to_an_exact_pricing_version() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, headers={"X-Total-Count": "3"}, json=[{"id": "one"}])

    client = SpaceDeploymentClient(
        Settings(
            _env_file=None,
            space_enabled=True,
            space_url="https://space.example",
            space_api_key="normal-key",
        ),
        transport=httpx.MockTransport(handler),
    )

    assert await client.contract_count("0.1.0") == 3
    assert seen[0].url.path == "/api/v1/contracts"
    assert seen[0].url.params["limit"] == "1"
    assert json.loads(seen[0].content) == {
        "filters": {"services": {"openbinding": ["0.1.0"]}}
    }


def test_canonical_pricing_is_valid_and_has_the_agreed_product_shape() -> None:
    content = (REPO_ROOT / "space/pricing/openbinding.yml").read_bytes()
    _, result = pricing_routes.validate_pricing(content, "0.1.0")

    assert result.valid, result.errors
    assert result.plans == ["ADVANCED", "BASIC", "PRO", "RESEARCH"]
    assert result.add_ons == [
        "COLLABORATION_PACK",
        "COMPUTE_PACK",
        "CONCURRENCY_PACK",
        "FEDERATION_PACK",
        "REPRODUCIBILITY_ARCHIVE",
        "STORAGE_PACK",
    ]


def test_pricing_metadata_table_cannot_store_yaml_or_private_urls() -> None:
    columns = {column.name for column in inspect(PricingRelease).columns}
    assert not columns & {"yaml", "content", "private_url", "draft_url"}
    assert {"version", "digest", "public_url", "is_live"} <= columns


async def test_public_proxy_fetches_the_live_release_from_sphere(
    api_client, db_session, registration, monkeypatch
) -> None:
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    user = await db_session.scalar(select(User).where(User.id == uuid.UUID(created.json()["id"])))
    content = (REPO_ROOT / "space/pricing/openbinding.yml").read_bytes()
    _, validation = pricing_routes.validate_pricing(content, "0.1.0")
    release = PricingRelease(
        version="0.1.0",
        digest=validation.digest,
        sphere_organization_id="org-1",
        sphere_state=PricingSphereState.PUBLIC_RELEASE,
        space_state=PricingSpaceState.ACTIVE,
        is_live=True,
        public_url="https://sphere.example/static/pricings/openbinding/0.1.0.yaml",
        created_by_id=user.id,
    )
    db_session.add(release)
    await db_session.flush()

    class FakeSphere:
        async def content(self, version: str) -> bytes:
            assert version == "0.1.0"
            return content

        async def aclose(self) -> None:
            return None

    async def fake_sphere(_settings):
        return FakeSphere()

    monkeypatch.setattr(pricing_routes, "_sphere", fake_sphere)
    current = await api_client.get("/v1/pricing/current")
    proxied = await api_client.get("/v1/pricing")

    assert current.json() == {
        "version": "0.1.0",
        "digest": validation.digest,
        "url": release.public_url,
    }
    assert proxied.content == content
    assert proxied.headers["etag"] == f'"{validation.digest}"'
    assert proxied.headers["cache-control"] == "public, max-age=300"


def test_pricing_validator_rejects_secret_shaped_fields() -> None:
    _, result = pricing_routes.validate_pricing(
        b"""
syntaxVersion: '3.1'
saasName: openbinding
version: 0.1.0-draft.1
plans: {BASIC: {price: 0}}
features: {solve: {defaultValue: true}}
usageLimits: {tasksLimit: {defaultValue: 1}}
metadata: {apiToken: should-not-be-here}
"""
    )
    assert result.valid is False
    assert any("secret-shaped" in error for error in result.errors)


async def test_http_pricing_lifecycle_keeps_drafts_private_and_public_releases_immutable(
    api_client, db_session, registration, monkeypatch
) -> None:
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    user = await db_session.scalar(select(User).where(User.id == uuid.UUID(created.json()["id"])))
    user.role = UserRole.ADMIN
    await db_session.flush()
    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    class FakeSphere:
        def __init__(self) -> None:
            self.documents: dict[str, bytes] = {}
            self.visibility: dict[str, bool] = {}
            self.deleted: list[str] = []

        async def upload(self, content: bytes, version: str, *, private: bool):
            assert version not in self.documents
            self.documents[version] = content
            self.visibility[version] = private
            return SpherePricingVersion(
                version=version,
                private=private,
                yaml_url=f"https://sphere.example/static/pricings/openbinding/{version}.yaml",
                organization_id="org-1",
            )

        async def content(self, version: str) -> bytes:
            return self.documents[version]

        async def exact_version(self, version: str) -> SpherePricingVersion:
            return SpherePricingVersion(
                version=version,
                private=self.visibility[version],
                yaml_url=f"https://sphere.example/static/pricings/openbinding/{version}.yaml",
                organization_id="org-1",
            )

        async def delete_private_version(self, version: str) -> None:
            assert self.visibility[version] is True
            self.deleted.append(version)
            del self.documents[version]
            del self.visibility[version]

        async def aclose(self) -> None:
            return None

    class FakeSpace:
        def __init__(self) -> None:
            self.deployed: list[str] = []
            self.availability: list[tuple[str, str]] = []
            self.deleted: list[str] = []

        async def deploy(self, url: str) -> None:
            self.deployed.append(url)

        async def set_availability(self, version: str, state: str, _fallback=None) -> None:
            self.availability.append((version, state))

        async def contract_count(self, _version: str) -> int:
            return 0

        async def delete_archived(self, version: str) -> None:
            self.deleted.append(version)

    sphere = FakeSphere()
    space = FakeSpace()

    async def fake_sphere(_settings):
        return sphere

    async def fake_space(_settings):
        return space

    monkeypatch.setattr(pricing_routes, "_sphere", fake_sphere)
    monkeypatch.setattr(pricing_routes, "_space", fake_space)

    document = pricing_routes.yaml.safe_load(
        (REPO_ROOT / "space/pricing/openbinding.yml").read_bytes()
    )

    def body(version: str) -> dict:
        document["version"] = version
        return {"yaml": pricing_routes.yaml.safe_dump(document, sort_keys=False)}

    draft = await api_client.post(
        "/v1/admin/pricing/drafts", headers=headers, json=body("0.1.0-draft.1")
    )
    assert draft.status_code == 201, draft.text
    assert draft.json()["release"]["sphere_state"] == "PRIVATE_DRAFT"
    assert draft.json()["release"]["public_url"] is None
    assert (await api_client.get("/v1/pricing/current")).status_code == 404

    preview = await api_client.get(
        "/v1/admin/pricing/versions/0.1.0-draft.1/preview", headers=headers
    )
    assert preview.status_code == 200
    assert preview.headers["cache-control"] == "no-store"
    assert "sphere.example" not in preview.text
    refused_live = await api_client.post(
        "/v1/admin/pricing/versions/0.1.0-draft.1/activate", headers=headers
    )
    assert refused_live.status_code == 409
    assert refused_live.json()["detail"]["code"] == "draft_cannot_be_live"

    wrong_first = await api_client.post(
        "/v1/admin/pricing/publish",
        headers=headers,
        json={
            "draft_version": "0.1.0-draft.1",
            "version": "0.2.0",
            "changelog": "Wrong first release",
        },
    )
    assert wrong_first.status_code == 409
    assert wrong_first.json()["detail"]["code"] == "first_release_version"

    published = await api_client.post(
        "/v1/admin/pricing/publish",
        headers=headers,
        json={
            "draft_version": "0.1.0-draft.1",
            "version": "0.1.0",
            "changelog": "Initial platform release",
        },
    )
    assert published.status_code == 201, published.text
    assert published.json()["release"]["sphere_state"] == "PUBLIC_RELEASE"
    assert sphere.visibility["0.1.0"] is False

    activated = await api_client.post(
        "/v1/admin/pricing/versions/0.1.0/activate", headers=headers
    )
    assert activated.status_code == 200, activated.text
    current = await api_client.get("/v1/pricing/current")
    assert current.status_code == 200
    assert current.json()["version"] == "0.1.0"

    public_delete = await api_client.request(
        "DELETE",
        "/v1/admin/pricing/drafts/0.1.0",
        headers=headers,
        json={"confirmation": "0.1.0"},
    )
    assert public_delete.status_code == 409
    assert public_delete.json()["detail"]["code"] == "immutable_public_release"
    assert "0.1.0" not in sphere.deleted

    second = await api_client.post(
        "/v1/admin/pricing/drafts", headers=headers, json=body("0.2.0-draft.1")
    )
    assert second.status_code == 201
    assert (await api_client.post(
        "/v1/admin/pricing/versions/0.2.0-draft.1/deploy", headers=headers
    )).status_code == 200
    deployed_delete = await api_client.request(
        "DELETE",
        "/v1/admin/pricing/drafts/0.2.0-draft.1",
        headers=headers,
        json={"confirmation": "0.2.0-draft.1"},
    )
    assert deployed_delete.status_code == 409
    assert deployed_delete.json()["detail"]["code"] == "deployed_draft"
    archived = await api_client.post(
        "/v1/admin/pricing/versions/0.2.0-draft.1/archive", headers=headers, json={}
    )
    assert archived.status_code == 200, archived.text
    deleted = await api_client.request(
        "DELETE",
        "/v1/admin/pricing/drafts/0.2.0-draft.1",
        headers=headers,
        json={"confirmation": "0.2.0-draft.1"},
    )
    assert deleted.status_code == 204, deleted.text
    assert space.deleted == ["0.2.0-draft.1"]
    assert sphere.deleted == ["0.2.0-draft.1"]

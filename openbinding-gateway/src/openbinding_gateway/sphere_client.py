"""Narrow server-side client for OpenBinding's single SPHERE pricing.

SPHERE remains the owner of every Pricing2Yaml body.  The gateway only moves
exact immutable versions under the fixed ``OpenBinding/openbinding`` identity
and never exposes a private YAML URL to a browser.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urljoin, urlsplit

import httpx

from .core.settings import Settings


class SphereError(RuntimeError):
    """SPHERE rejected a scoped operation or returned an unsafe response."""


@dataclass(frozen=True)
class SpherePricingVersion:
    version: str
    private: bool
    yaml_url: str
    organization_id: str
    slug: str = "openbinding"


class SphereClient:
    """Only the SPHERE calls needed by the pricing control room."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        if not settings.sphere_api_key:
            raise SphereError("SPHERE_API_KEY is not configured.")
        self.settings = settings
        self._base = settings.sphere_url.rstrip("/")
        self._api = f"{self._base}/api/v1"
        self._client = httpx.AsyncClient(
            headers={"x-api-key": settings.sphere_api_key},
            timeout=settings.sphere_timeout_s,
            follow_redirects=False,
            transport=transport,
        )
        self._organization_id: str | None = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            response = await self._client.request(method, f"{self._api}{path}", **kwargs)
        except httpx.HTTPError as exc:
            raise SphereError(f"SPHERE is unavailable: {exc}") from exc
        if response.status_code >= 400:
            message = ""
            try:
                body = response.json()
                message = str(body.get("error") or body.get("message") or "")
            except (ValueError, AttributeError):
                pass
            raise SphereError(
                f"SPHERE returned {response.status_code}"
                + (f": {message[:300]}" if message else ".")
            )
        return response

    @staticmethod
    def _items(value: Any) -> list[dict[str, Any]]:
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
        if not isinstance(value, dict):
            return []
        for key in ("items", "organizations", "data"):
            nested = value.get(key)
            if isinstance(nested, list):
                return [item for item in nested if isinstance(item, dict)]
        return [value]

    @classmethod
    def _flatten_organizations(cls, values: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        pending = list(values)
        while pending:
            item = pending.pop()
            result.append(item)
            for key in ("subOrganizations", "children"):
                children = item.get(key)
                if isinstance(children, list):
                    pending.extend(child for child in children if isinstance(child, dict))
        return result

    @staticmethod
    def _org_id(value: dict[str, Any]) -> str | None:
        identifier = value.get("id") or value.get("_id") or value.get("organizationId")
        return str(identifier) if identifier else None

    @staticmethod
    def _is_openbinding_org(value: dict[str, Any]) -> bool:
        return value.get("displayName") == "OpenBinding" or str(value.get("name", "")).casefold() == "openbinding"

    async def organization_id(self) -> str:
        """Resolve or create the one root organization and pin its id."""

        if self._organization_id:
            return self._organization_id
        configured = self.settings.sphere_organization_id
        if configured:
            response = await self._request("GET", f"/orgs/{quote(configured, safe='')}")
            organization = response.json()
            if not isinstance(organization, dict) or not self._is_openbinding_org(organization):
                raise SphereError("SPHERE_ORGANIZATION_ID does not identify OpenBinding.")
            actual = self._org_id(organization)
            if actual != configured:
                raise SphereError("SPHERE returned a different organization id.")
            self._organization_id = configured
            return configured

        response = await self._request("GET", "/users/me/orgs")
        organizations = self._flatten_organizations(self._items(response.json()))
        matches = [item for item in organizations if self._is_openbinding_org(item)]
        if len(matches) > 1:
            raise SphereError("More than one SPHERE organization is named OpenBinding.")
        if matches:
            identifier = self._org_id(matches[0])
            if not identifier:
                raise SphereError("SPHERE omitted the OpenBinding organization id.")
        else:
            created = await self._request(
                "POST",
                "/orgs",
                json={
                    "name": "openbinding",
                    "displayName": "OpenBinding",
                    "description": "Canonical pricing source for the OpenBinding platform.",
                    "isPersonal": False,
                },
            )
            value = created.json()
            if not isinstance(value, dict) or not self._is_openbinding_org(value):
                raise SphereError("SPHERE created an unexpected organization.")
            identifier = self._org_id(value)
            if not identifier:
                raise SphereError("SPHERE omitted the created organization id.")
        self._organization_id = identifier
        return identifier

    def _trusted_yaml_url(self, value: str) -> str:
        url = urljoin(f"{self._base}/", value)
        expected = urlsplit(self._base)
        actual = urlsplit(url)
        if (actual.scheme, actual.netloc) != (expected.scheme, expected.netloc):
            raise SphereError("SPHERE returned a pricing URL on another origin.")
        if not actual.path.startswith("/static/pricings/"):
            raise SphereError("SPHERE returned an unexpected pricing URL.")
        return url

    def _version(self, raw: dict[str, Any], organization_id: str) -> SpherePricingVersion:
        nested_org = raw.get("organization")
        returned_org = raw.get("_organizationId") or raw.get("organizationId")
        if isinstance(nested_org, dict):
            returned_org = returned_org or self._org_id(nested_org)
        if returned_org is not None and str(returned_org) != organization_id:
            raise SphereError("SPHERE returned a pricing outside the OpenBinding organization.")
        slug = str(raw.get("slug") or self.settings.sphere_pricing_slug)
        if slug != self.settings.sphere_pricing_slug:
            raise SphereError("SPHERE returned a pricing outside the openbinding slug.")
        version = raw.get("version")
        yaml_url = raw.get("yaml") or raw.get("url")
        if not isinstance(version, str) or not version or not isinstance(yaml_url, str):
            raise SphereError("SPHERE returned malformed pricing metadata.")
        private_value = raw.get("private", raw.get("isPrivate", False))
        if isinstance(private_value, str):
            is_private = private_value.casefold() == "true"
        else:
            is_private = bool(private_value)
        return SpherePricingVersion(
            version=version,
            private=is_private,
            yaml_url=self._trusted_yaml_url(yaml_url),
            organization_id=organization_id,
            slug=slug,
        )

    async def list_versions(self) -> list[SpherePricingVersion]:
        organization_id = await self.organization_id()
        path = (
            f"/pricings/{quote(organization_id, safe='')}/"
            f"{quote(self.settings.sphere_pricing_slug, safe='')}?includePrivate=true"
        )
        try:
            response = await self._request("GET", path)
        except SphereError as exc:
            if "returned 404" in str(exc):
                return []
            raise
        body = response.json()
        if not isinstance(body, dict):
            raise SphereError("SPHERE returned malformed pricing history.")
        slug = str(body.get("slug") or self.settings.sphere_pricing_slug)
        if slug != self.settings.sphere_pricing_slug:
            raise SphereError("SPHERE returned an unexpected pricing slug.")
        raw_versions = body.get("versions")
        if not isinstance(raw_versions, list):
            raw_versions = [body] if body.get("version") else []
        return [self._version(value, organization_id) for value in raw_versions if isinstance(value, dict)]

    async def exact_version(self, version: str) -> SpherePricingVersion:
        matches = [item for item in await self.list_versions() if item.version == version]
        if len(matches) != 1:
            raise SphereError(f"SPHERE has no unique openbinding version {version!r}.")
        return matches[0]

    async def upload(self, yaml_body: bytes, version: str, *, private: bool) -> SpherePricingVersion:
        organization_id = await self.organization_id()
        existing = await self.list_versions()
        if any(item.version == version for item in existing):
            raise SphereError(f"SPHERE version {version!r} already exists and is immutable.")
        files = {"yaml": (f"{version}.yaml", yaml_body, "application/yaml")}
        data = {
            "private": "true" if private else "false",
            "saasName": "openbinding",
            "name": "openbinding",
            "version": version,
        }
        if existing:
            path = (
                f"/pricings/{quote(organization_id, safe='')}/openbinding/"
                f"{quote(version, safe='')}"
            )
        else:
            path = f"/pricings/{quote(organization_id, safe='')}"
        response = await self._request("POST", path, data=data, files=files)
        value = response.json()
        if not isinstance(value, dict):
            raise SphereError("SPHERE returned malformed upload metadata.")
        uploaded = self._version(value, organization_id)
        if uploaded.version != version or uploaded.private is not private:
            raise SphereError("SPHERE did not preserve the requested version visibility.")
        return uploaded

    async def content(self, version: str) -> bytes:
        metadata = await self.exact_version(version)
        try:
            response = await self._client.get(metadata.yaml_url)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise SphereError(f"SPHERE could not return version {version!r}.") from exc
        if len(response.content) > 2 * 1024 * 1024:
            raise SphereError("SPHERE pricing content exceeds 2 MB.")
        return response.content

    async def delete_private_version(self, version: str) -> None:
        metadata = await self.exact_version(version)
        if not metadata.private:
            raise SphereError("Public SPHERE releases are immutable and cannot be deleted.")
        organization_id = await self.organization_id()
        path = (
            f"/pricings/{quote(organization_id, safe='')}/openbinding/"
            f"{quote(version, safe='')}"
        )
        await self._request("DELETE", path)

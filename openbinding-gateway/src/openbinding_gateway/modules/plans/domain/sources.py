"""What a pricing source answers, as values, and the parsing of SPHERE's real answers.

The shapes are SPHERE's public API at ``73779a8a`` (recorded in ``tests/fixtures/sphere``): the manifest
(``/public/pricings/{pricingId}``), discovery (``/pricings``, ``/pricings/{organizationId}``), the permalink
(``/permalinks/pricing/{pricingId}``), an organization (``/orgs/{organizationId}``), the public organizations
(``/orgs/public``) and ``/users/me``. Every id that will be written into a URL is checked here first:
SPHERE ids are 24 lower-case hexadecimal characters (``SPHERE_ID``), and anything else is refused before a
request is built.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlsplit

#: A SPHERE ObjectId: pricing families, versions and organizations.
SPHERE_ID = re.compile(r"^[0-9a-f]{24}$")
#: The most rows one discovery page asks for.
MAX_PAGE = 24


def is_sphere_id(value: object) -> bool:
    return isinstance(value, str) and SPHERE_ID.fullmatch(value) is not None


class SourceShapeError(ValueError):
    """An answer that is not shaped as SPHERE documents it."""


@dataclass(frozen=True)
class SphereEndpoint:
    """Which SPHERE: the default one (``SPHERE_URL``) or an operator registry (``SPHERE_REGISTRIES`` alias)."""

    registry: str | None = None

    @property
    def key(self) -> str:
        return f"registry:{self.registry}" if self.registry else "default"


DEFAULT_ENDPOINT = SphereEndpoint()


@dataclass(frozen=True)
class Credential:
    """An organization's SPHERE key, decrypted for one call. Never logged: ``repr`` shows only the organization."""

    organization_id: str
    api_key: str = field(repr=False)
    #: Awaited when SPHERE answers 401 to this key (the connection is then marked invalid).
    on_rejected: Any = field(default=None, repr=False, compare=False)

    @property
    def bucket(self) -> str:
        return f"org:{self.organization_id}"


@dataclass(frozen=True)
class ManifestVersion:
    version_id: str
    label: str
    created_at: str
    content_hash: str
    private: bool = False


@dataclass(frozen=True)
class Manifest:
    pricing_id: str
    name: str
    permanent_url: str
    latest_version_id: str
    versions: tuple[ManifestVersion, ...]
    etag: str | None = None

    def version(self, version_id: str) -> ManifestVersion | None:
        return next((v for v in self.versions if v.version_id == version_id), None)

    def newest_first(self) -> list[ManifestVersion]:
        """By ``createdAt``, newest first (SPHERE's latest is by date, not by label)."""
        return sorted(self.versions, key=lambda v: (v.created_at, v.version_id), reverse=True)

    def by_label(self, label: str) -> ManifestVersion | None:
        return next((v for v in self.newest_first() if v.label == label), None)


@dataclass(frozen=True)
class NotModified:
    etag: str | None = None


@dataclass(frozen=True)
class SearchQuery:
    """A discovery query. Only ``min_price`` (minimum price at least this) is offered: SPHERE's ``max-minPrice``
    also filters on the dearest plan (convergence §8.5), so it is never sent."""

    name: str | None = None
    collection: str | None = None
    organizations: tuple[str, ...] = ()
    sort_by: str | None = None
    sort: str | None = None
    min_price: float | None = None
    limit: int = MAX_PAGE
    offset: int = 0

    def params(self) -> dict[str, str]:
        out: dict[str, str] = {"limit": str(max(1, min(self.limit, MAX_PAGE))), "offset": str(max(0, self.offset))}
        if self.name:
            out["name"] = self.name
        if self.collection:
            out["collection"] = self.collection
        if self.organizations:
            out["selectedOrganizations"] = ",".join(self.organizations)
        if self.sort_by:
            out["sortBy"] = self.sort_by
        if self.sort in {"asc", "desc"}:
            out["sort"] = self.sort
        if self.min_price is not None:
            out["min-minPrice"] = _number_text(self.min_price)
        return out


def _number_text(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else repr(float(value))


@dataclass(frozen=True)
class SphereOrganization:
    id: str
    name: str
    display_name: str | None = None
    is_personal: bool | None = None


@dataclass(frozen=True)
class SearchRow:
    pricing_id: str
    version_id: str
    name: str
    slug: str
    version_label: str
    created_at: str | None
    currency: str | None
    private: bool
    analytics: Mapping[str, Any]
    collection: Mapping[str, Any] | None
    organization: SphereOrganization | None


@dataclass(frozen=True)
class SearchPage:
    rows: tuple[SearchRow, ...]
    total: int
    #: SPHERE's whole-result histograms (``minPrice``, ``maxPrice``, ``configurationSpaceSize``), never computed here.
    facets: Mapping[str, Any]


@dataclass(frozen=True)
class FamilyIdentity:
    """Who owns a family and what it is called, at read time (``owner/slug`` is the label ``from.sphere`` writes)."""

    pricing_id: str
    organization_id: str
    slug: str
    owner: str | None
    collection: str | None = None


@dataclass(frozen=True)
class SphereUser:
    """What a connection keeps of ``/users/me``: no email, no name, nothing personal beyond the username."""

    id: str
    username: str
    scopes: tuple[tuple[str, str], ...] | None
    expires_at: str | None = None


@dataclass(frozen=True)
class FetchedYaml:
    body: bytes
    sha256: str
    etag: str | None
    last_modified: str | None
    url: str


def _text(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _need(mapping: object, key: str) -> Any:
    if not isinstance(mapping, Mapping) or key not in mapping:
        raise SourceShapeError(f"missing {key}")
    return mapping[key]


def parse_manifest(data: object, *, etag: str | None = None) -> Manifest:
    pricing_id = _need(data, "pricingId")
    latest = _need(data, "latestVersionId")
    if not is_sphere_id(pricing_id) or not is_sphere_id(latest):
        raise SourceShapeError("a manifest names ids that are not SPHERE ids")
    versions = []
    for entry in _need(data, "versions") or ():
        version_id = _need(entry, "versionId")
        if not is_sphere_id(version_id):
            continue
        versions.append(
            ManifestVersion(
                version_id=version_id,
                label=str(_need(entry, "version")),
                created_at=str(entry.get("createdAt") or ""),
                content_hash=str(entry.get("contentHash") or ""),
                private=entry.get("private") is True,
            )
        )
    return Manifest(
        pricing_id=pricing_id,
        name=str(_need(data, "name")),
        permanent_url=str(data.get("permanentUrl") or ""),  # type: ignore[union-attr]
        latest_version_id=latest,
        versions=tuple(versions),
        etag=etag,
    )


def parse_organization(data: object) -> SphereOrganization:
    organization_id = _need(data, "id")
    if not is_sphere_id(organization_id):
        raise SourceShapeError("an organization id is not a SPHERE id")
    return SphereOrganization(
        id=organization_id,
        name=str(_need(data, "name")),
        display_name=_text(data.get("displayName")),  # type: ignore[union-attr]
        is_personal=data.get("isPersonal") if isinstance(data.get("isPersonal"), bool) else None,  # type: ignore[union-attr]
    )


def parse_search(data: object) -> SearchPage:
    rows = []
    for item in _need(data, "pricings") or ():
        pricing_id = item.get("pricingId") if isinstance(item, Mapping) else None
        version_id = item.get("id") or item.get("_id") if isinstance(item, Mapping) else None
        if not is_sphere_id(pricing_id) or not is_sphere_id(version_id):
            continue
        organization = None
        if isinstance(item.get("organization"), Mapping) and is_sphere_id(item["organization"].get("id")):
            organization = parse_organization(item["organization"])
        collection = item.get("collection") if isinstance(item.get("collection"), Mapping) else None
        if collection is not None and not collection.get("id"):
            collection = None
        rows.append(
            SearchRow(
                pricing_id=pricing_id,
                version_id=version_id,
                name=str(item.get("name") or ""),
                slug=str(item.get("slug") or ""),
                version_label=str(item.get("version") or ""),
                created_at=_text(item.get("createdAt")),
                currency=_text(item.get("currency")),
                private=item.get("private") is True,
                analytics=dict(item.get("analytics") or {}),
                collection=dict(collection) if collection else None,
                organization=organization,
            )
        )
    facets = {key: data[key] for key in ("minPrice", "maxPrice", "configurationSpaceSize") if key in data}  # type: ignore[operator,index]
    total = data.get("total") if isinstance(data, Mapping) else None
    return SearchPage(tuple(rows), int(total) if isinstance(total, int) else len(rows), facets)


def parse_permalink(data: object) -> tuple[str, str, str | None]:
    """``(organization id, slug, collection)`` of ``{"location": "/pricings/<org>/<slug>?collection=…"}``."""
    location = _need(data, "location")
    if not isinstance(location, str):
        raise SourceShapeError("a permalink location is not a text")
    parts = urlsplit(location)
    segments = [s for s in parts.path.split("/") if s]
    if len(segments) != 3 or segments[0] != "pricings" or not is_sphere_id(segments[1]) or not segments[2]:
        raise SourceShapeError("a permalink does not point at a pricing")
    collection = parse_qs(parts.query).get("collection", [None])[0]
    return segments[1], segments[2], collection


def parse_public_organizations(data: object) -> list[SphereOrganization]:
    out = []
    for item in _need(data, "items") or ():
        try:
            out.append(parse_organization(item))
        except SourceShapeError:
            continue
    return out


def parse_user(data: object) -> SphereUser:
    """Keep the user id, the username, the key's scopes and its expiry; drop everything else of ``/users/me``."""
    user_id = _need(data, "id")
    username = _need(data, "username")
    api_key = data.get("apiKey") if isinstance(data, Mapping) else None
    scopes: tuple[tuple[str, str], ...] | None = None
    expires_at = None
    if isinstance(api_key, Mapping):
        expires_at = _text(api_key.get("expiresAt"))
        raw = api_key.get("scopes")
        if isinstance(raw, list):
            scopes = tuple(
                (entry["organizationId"], str(entry.get("scope") or ""))
                for entry in raw
                if isinstance(entry, Mapping) and is_sphere_id(entry.get("organizationId"))
            )
    return SphereUser(id=str(user_id), username=str(username), scopes=scopes, expires_at=expires_at)

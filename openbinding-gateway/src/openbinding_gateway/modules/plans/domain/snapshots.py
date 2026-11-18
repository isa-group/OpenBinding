"""Pure rules of pricing snapshots: their source and scope keys, canonical URLs and how a new read relates
to the previous one of the same source."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

from .sources import SphereEndpoint

PUBLIC_SCOPE = "public"


def sphere_source_key(where: SphereEndpoint, pricing_id: str, version_id: str) -> str:
    """``sphere:<pricingId>@<versionId>`` or ``registry:<alias>:<pricingId>@<versionId>``."""
    if where.registry:
        return f"registry:{where.registry}:{pricing_id}@{version_id}"
    return f"sphere:{pricing_id}@{version_id}"


def canonical_url(url: str) -> str:
    """The URL a ``url`` snapshot is keyed by: scheme and host lower-cased, the default port and the fragment
    dropped, an empty path written ``/``."""
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    if parts.port is not None and not (parts.scheme.lower() == "https" and parts.port == 443):
        host = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme.lower(), host, parts.path or "/", parts.query, ""))


def url_source_key(url: str) -> str:
    return "url:" + hashlib.sha256(canonical_url(url).encode("utf-8")).hexdigest()


def registry_scope(alias: str) -> str:
    return f"registry:{alias}"


def organization_scope(organization_id: object) -> str:
    return str(organization_id)


def is_shared_scope(scope_key: str) -> bool:
    """Public and registry rows are shared across organizations (and never deleted)."""
    return scope_key == PUBLIC_SCOPE or scope_key.startswith("registry:")


@dataclass(frozen=True)
class Previous:
    sha256: str
    content_hash: str


def classify_change(previous: Previous | None, sha256: str, content_hash: str) -> str:
    """``new`` (no earlier read), ``same`` (the same bytes), ``rename`` (other bytes, same functional hash, e.g.
    only ``saasName`` changed) or ``content`` (other bytes and another hash)."""
    if previous is None:
        return "new"
    if previous.sha256 == sha256:
        return "same"
    if previous.content_hash == content_hash:
        return "rename"
    return "content"

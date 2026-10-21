"""The published OpenBinding pricing, read from SPHERE and never stored here.

SPHERE owns the immutable Pricing2Yaml versions and SPACE owns plans, add-ons
and contracts; both are administered in their native consoles. The gateway
only shows the pricing page and the renderer one exact published version, the
one named by ``SPACE_PRICING_VERSION``. Nothing is read from disk and nothing
is written to the database.

Integrity: a released version is immutable, so the digest of its bytes is
pinned the first time it is read in this process and every later read has to
match it. SPHERE changing a published version is reported as an error instead
of being served.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any

import yaml

from .core.settings import Settings
from .sphere_client import SphereClient, SphereError

#: How long a verified read is reused; the same as the public ``Cache-Control``.
CACHE_TTL_S = 300.0


class PricingCatalogError(ValueError):
    """The published pricing cannot be read or no longer matches its pinned digest."""


@dataclass(frozen=True)
class PublishedPricing:
    """One exact, digest-verified public SPHERE version."""

    version: str
    digest: str
    url: str
    content: bytes
    document: dict[str, Any]

    def public_view(self) -> dict[str, Any]:
        """The Pricing2Yaml document as JSON, without a parallel projection."""
        return _json_value(self.document)


def _json_value(value: Any) -> Any:
    """Make YAML infinities legal JSON without inventing a numeric ceiling."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: _json_value(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_json_value(child) for child in value]
    return value


_PINNED_DIGESTS: dict[str, str] = {}
_CACHE: dict[str, tuple[float, PublishedPricing]] = {}


def clear_cache() -> None:
    """Forget pinned digests and cached reads (tests, and a process-wide reset)."""
    _PINNED_DIGESTS.clear()
    _CACHE.clear()


async def published_pricing(settings: Settings, *, transport=None) -> PublishedPricing:
    """Read the configured version from SPHERE (read only) and verify its digest."""
    version = settings.space_pricing_version
    if not version:
        raise PricingCatalogError("SPACE_PRICING_VERSION is not configured.")
    if not settings.sphere_enabled:
        raise PricingCatalogError("SPHERE is not enabled.")

    cached = _CACHE.get(version)
    if cached is not None and time.monotonic() - cached[0] < CACHE_TTL_S:
        return cached[1]

    try:
        client = SphereClient(settings, transport=transport)
    except SphereError as exc:
        raise PricingCatalogError(str(exc)) from exc
    try:
        metadata = await client.exact_version(version)
        if metadata.private:
            raise PricingCatalogError(f"Pricing version {version!r} is not a public SPHERE release.")
        content = await client.content(version)
    except SphereError as exc:
        raise PricingCatalogError(str(exc)) from exc
    finally:
        await client.aclose()

    digest = SphereClient.digest_of(content)
    pinned = _PINNED_DIGESTS.setdefault(version, digest)
    if pinned != digest:
        raise PricingCatalogError(
            f"SPHERE content for pricing {version!r} no longer matches its immutable digest."
        )
    try:
        document = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        raise PricingCatalogError(f"Invalid Pricing2Yaml: {exc}") from exc
    if not isinstance(document, dict) or str(document.get("version")) != version:
        raise PricingCatalogError("SPHERE returned a different pricing version.")

    value = PublishedPricing(
        version=version, digest=digest, url=metadata.yaml_url, content=content, document=document
    )
    _CACHE[version] = (time.monotonic(), value)
    return value

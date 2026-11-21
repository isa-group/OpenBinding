"""The ``PricingSource`` port: the single read contract for SPHERE, its registries and Pricing2Yaml URLs.

Every SPHERE or URL read OpenBinding makes goes through the installed source (``set_pricing_source``, done by
``main._lifespan``; the tests install one over recorded answers). Reads happen before a compile or evaluation
slot and outside any database transaction, never during compilation or evaluation, and only immutable ids
(``pricingId``, ``versionId``) and content-addressed snapshots are kept.

Errors are four classes, so that callers answer the same way whatever went wrong upstream:
``PricingNotFound`` (missing, hidden, private without access, unknown version: one 404 for everything
unreadable), ``PricingSourceBusy`` (SPHERE's rate limit or the port's own back-off, with ``retry_after``),
``PricingSourceUnavailable`` (timeout, 5xx, transport, oversize, integrity, disabled; ``reason``) and
``PricingInvalid`` (not a pricing this gateway reads).
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Protocol

from ..domain.errors import PricingError
from ..domain.sources import (
    Credential,
    FamilyIdentity,
    FetchedYaml,
    Manifest,
    ManifestVersion,
    NotModified,
    SearchPage,
    SearchQuery,
    SphereEndpoint,
    SphereOrganization,
    SphereUser,
)
from .parsing import ParsedPricing, parse

logger = logging.getLogger(__name__)


class PricingNotFound(PricingError):
    """Nothing readable there, for this caller (the routes answer one 404 for every such case)."""


class PricingSourceBusy(PricingError):
    def __init__(self, retry_after: int, message: str = "") -> None:
        super().__init__(message or f"the pricing source is busy; retry after {retry_after} s")
        self.retry_after = max(1, int(retry_after))


class PricingSourceUnavailable(PricingError):
    """``reason``: ``timeout``, ``unavailable``, ``transport``, ``too_large``, ``integrity``, ``redirect``,
    ``encoding``, ``disabled`` or ``registry_unknown``."""

    def __init__(self, reason: str, message: str = "") -> None:
        super().__init__(message or f"the pricing source is unavailable ({reason})")
        self.reason = reason


class CredentialRejected(PricingError):
    """SPHERE refused the key (401) of a ``whoami``."""


class PricingSource(Protocol):
    async def search(self, where: SphereEndpoint, query: SearchQuery, credential: Credential | None) -> SearchPage: ...

    async def organization_pricings(
        self, where: SphereEndpoint, sphere_org_id: str, credential: Credential | None, *, offset: int = 0
    ) -> SearchPage: ...

    async def manifest(
        self,
        where: SphereEndpoint,
        pricing_id: str,
        credential: Credential | None,
        *,
        if_none_match: str | None = None,
        revalidate: bool = False,
    ) -> Manifest | NotModified:
        """A family's manifest, or ``NotModified`` when ``if_none_match`` still names it.

        ``revalidate`` sends a conditional request even when a fresh cached answer or a recent negative answer
        exists; rate-limit windows and the host back-off still apply.
        """
        ...

    async def version_yaml(
        self, where: SphereEndpoint, pricing_id: str, version_id: str, credential: Credential | None
    ) -> FetchedYaml: ...

    async def family(self, where: SphereEndpoint, pricing_id: str) -> FamilyIdentity: ...

    async def organization(self, where: SphereEndpoint, organization_id: str) -> SphereOrganization: ...

    async def public_organizations(self, where: SphereEndpoint, q: str) -> list[SphereOrganization]: ...

    async def whoami(self, where: SphereEndpoint, credential: Credential) -> SphereUser: ...

    async def url_yaml(
        self, url: str, *, if_none_match: str | None = None, if_modified_since: str | None = None
    ) -> FetchedYaml | NotModified: ...

    def permanent_url(self, where: SphereEndpoint, pricing_id: str, version_id: str | None = None) -> str: ...

    def registries(self) -> tuple[str, ...]: ...

    def state(self) -> str: ...


_source: PricingSource | None = None


def set_pricing_source(source: PricingSource | None) -> None:
    """Install the process-wide source (``main._lifespan``; the tests install theirs)."""
    global _source
    _source = source


def get_pricing_source() -> PricingSource:
    """The installed source; there is no fallback, as for the SPACE gate."""
    if _source is None:
        raise RuntimeError("No pricing source is installed; the application lifespan did not run.")
    return _source


def installed_pricing_source() -> PricingSource | None:
    return _source


@contextmanager
def pricing_source_override(source: PricingSource) -> Iterator[PricingSource]:
    """Install ``source`` for the duration of a block (tests, tools)."""
    previous = _source
    set_pricing_source(source)
    try:
        yield source
    finally:
        set_pricing_source(previous)


@dataclass(frozen=True)
class VersionRead:
    """One SPHERE version read and checked: the manifest entry, the bytes, their reading, and whether the
    computed functional hash equals the manifest's ``contentHash``."""

    where: SphereEndpoint
    manifest: Manifest
    entry: ManifestVersion
    fetched: FetchedYaml
    parsed: ParsedPricing
    content_hash_verified: bool


async def read_version(
    source: PricingSource,
    where: SphereEndpoint,
    pricing_id: str,
    version_id: str,
    credential: Credential | None,
    *,
    manifest: Manifest | None = None,
) -> VersionRead:
    """The manifest entry and the bytes of one version, verified.

    The bytes must match the YAML's ``ETag`` (checked by the adapter). The functional hash is compared with
    the manifest's ``contentHash``; a mismatch does not fail the read (a port divergence must not block a
    valid pricing) but is logged and reported as ``content_hash_verified = False``.
    """
    if manifest is None:
        answer = await source.manifest(where, pricing_id, credential)
        if isinstance(answer, NotModified):  # pragma: no cover - no condition was sent
            raise PricingSourceUnavailable("unavailable")
        manifest = answer
    entry = manifest.version(version_id)
    if entry is None:
        raise PricingNotFound(f"version {version_id} is not readable in {pricing_id}")
    fetched = await source.version_yaml(where, pricing_id, version_id, credential)
    parsed = await parse(fetched.body)
    verified = parsed.content_hash == entry.content_hash
    if not verified:
        logger.warning(
            "pricing_content_hash_unverified pricing=%s version=%s endpoint=%s", pricing_id, version_id, where.key
        )
    return VersionRead(where, manifest, entry, fetched, parsed, verified)

"""Immutable pricing snapshots (``pricing_snapshots``): every upstream pricing a value or a margin points at.

- ``snapshot_version`` reads one SPHERE (or registry) version once per scope: a stored row is reused with no
  request; otherwise the version is read through the port **outside any transaction** (the session's read
  transaction is closed first), together with the family's identity (permalink and organization name, O6) and,
  for a keyed read, its own manifest, which decides the scope. The bytes are written to the content-addressed
  store, then the row is inserted; a lost insert race reads the winner.
- **Scope.** A version marked ``private`` read with an organization's key is that organization's; one read with
  a registry's operator key is ``registry:<alias>`` (signed-in users of this instance, never visitors); every
  ``url`` snapshot is the reading organization's, charged to the reader's storage; everything else is
  ``public``, shared and charged to nobody (one row per immutable ``versionId``).
- **Renames.** New bytes for a source whose latest snapshot has the same functional hash set ``renamed_from_id``
  (``rename``); other bytes and another hash for the same SPHERE version are ``content`` and logged
  (``pricing_version_content_changed``).
- ``snapshot_url`` reads a Pricing2Yaml URL conditionally on the last snapshot's ``ETag``/``Last-Modified``, never
  twice within ``OFFERING_URL_MIN_INTERVAL_S`` in one scope, and reuses identical bytes.
- ``read_snapshot`` enforces the scope; ``snapshot_bytes`` checks the digest on every read; ``normalised`` is
  memoised per process by sha256 (64 entries, 64 MiB of source).
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.settings import get_settings
from ....db.models import BindingCaseRevision, PricingSnapshot
from ...shared.application import path_for, write_file
from ..domain.errors import PricingInvalid
from ..domain.snapshots import (
    PUBLIC_SCOPE,
    Previous,
    canonical_url,
    classify_change,
    organization_scope,
    registry_scope,
    sphere_source_key,
    url_source_key,
)
from ..domain.sources import Credential, FamilyIdentity, Manifest, NotModified, SphereEndpoint, is_sphere_id
from .parsing import ParsedPricing, parse
from .pricing_source import (
    PricingNotFound,
    PricingSource,
    PricingSourceUnavailable,
    get_pricing_source,
    read_version,
)

logger = logging.getLogger(__name__)

MEMO_ENTRIES = 64
MEMO_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class Snapshotted:
    """A snapshot and how it came to be: ``reused`` (no request), ``new``, ``same``, ``rename`` or ``content``."""

    snapshot: PricingSnapshot
    change: str


# --- reading -----------------------------------------------------------------------------------------------------


def readable_scopes(
    organization_id: uuid.UUID | None, *, member: bool, signed_in: bool, registry: str | None = None
) -> list[str]:
    """The scopes a caller may read under ``organization_id``: public; ``registry:*`` when signed in; the
    organization's own when a member."""
    scopes = [PUBLIC_SCOPE]
    if member and organization_id is not None:
        scopes.append(organization_scope(organization_id))
    if signed_in and registry:
        scopes.append(registry_scope(registry))
    return scopes


def _visible(scope_key: str, organization_id: uuid.UUID | None, *, member: bool, signed_in: bool) -> bool:
    if scope_key == PUBLIC_SCOPE:
        return True
    if scope_key.startswith("registry:"):
        return signed_in
    return member and organization_id is not None and scope_key == organization_scope(organization_id)


async def read_snapshot(
    session: AsyncSession, organization_id: uuid.UUID | None, snapshot_id: uuid.UUID | str, *,
    member: bool, signed_in: bool,
) -> PricingSnapshot:
    """The snapshot, if the caller may read it under ``organization_id``; else ``PricingNotFound`` (one 404)."""
    try:
        key = snapshot_id if isinstance(snapshot_id, uuid.UUID) else uuid.UUID(str(snapshot_id))
    except ValueError as exc:
        raise PricingNotFound("no such snapshot") from exc
    row = await session.get(PricingSnapshot, key)
    if row is None or not _visible(row.scope_key, organization_id, member=member, signed_in=signed_in):
        raise PricingNotFound("no such snapshot")
    return row


def snapshot_bytes(snapshot: PricingSnapshot) -> bytes:
    """The stored bytes, checked against the snapshot's SHA-256 (``PricingSourceUnavailable`` when altered)."""
    try:
        content = Path(path_for(f"sha256-{snapshot.sha256}")).read_bytes()
    except OSError as exc:
        raise PricingSourceUnavailable("integrity", "the stored pricing is missing") from exc
    if hashlib.sha256(content).hexdigest() != snapshot.sha256:
        raise PricingSourceUnavailable("integrity", "the stored pricing does not match its digest")
    return content


class _Memo:
    def __init__(self) -> None:
        self.items: OrderedDict[str, tuple[ParsedPricing, int]] = OrderedDict()
        self.size = 0

    def get(self, key: str) -> ParsedPricing | None:
        item = self.items.get(key)
        if item is None:
            return None
        self.items.move_to_end(key)
        return item[0]

    def put(self, key: str, value: ParsedPricing, size: int) -> None:
        if key in self.items:
            return
        self.items[key] = (value, size)
        self.size += size
        while self.items and (len(self.items) > MEMO_ENTRIES or self.size > MEMO_BYTES):
            _, (_, dropped) = self.items.popitem(last=False)
            self.size -= dropped


_MEMO = _Memo()


async def normalised(snapshot: PricingSnapshot) -> ParsedPricing:
    """The snapshot's reading (document, functional hash, normalised pricing), memoised by sha256."""
    cached = _MEMO.get(snapshot.sha256)
    if cached is not None:
        return cached
    parsed = await parse(snapshot_bytes(snapshot))
    _MEMO.put(snapshot.sha256, parsed, snapshot.size_bytes)
    return parsed


async def latest_for(session: AsyncSession, source_key: str, scope_keys: list[str]) -> PricingSnapshot | None:
    """The newest snapshot of ``source_key`` in one of ``scope_keys``."""
    return await session.scalar(
        select(PricingSnapshot)
        .where(PricingSnapshot.source_key == source_key, PricingSnapshot.scope_key.in_(scope_keys))
        .order_by(PricingSnapshot.fetched_at.desc(), PricingSnapshot.id.desc())
        .limit(1)
    )


async def url_snapshot_bytes(session: AsyncSession, user_id: uuid.UUID) -> int:
    """The size of every ``url`` snapshot ``user_id`` fetched (they count against the account's storage)."""
    return int(await session.scalar(
        select(func.coalesce(func.sum(PricingSnapshot.size_bytes), 0))
        .where(PricingSnapshot.fetched_by_id == user_id, PricingSnapshot.source_kind == "url")
    ) or 0)


async def account_stored_bytes(session: AsyncSession, user_id: uuid.UUID) -> int:
    """What ``maxRepositoryStorage`` charges an account: its problem revisions and the URL snapshots it read."""
    revisions = int(await session.scalar(
        select(func.coalesce(func.sum(BindingCaseRevision.package_size), 0))
        .where(BindingCaseRevision.created_by_id == user_id)
    ) or 0)
    return revisions + await url_snapshot_bytes(session, user_id)


# --- writing -----------------------------------------------------------------------------------------------------


async def _close_read(session: AsyncSession) -> None:
    """End the session's read transaction before a network read (nothing is pending in these flows)."""
    if session.in_transaction():
        await session.commit()


async def _insert(session: AsyncSession, row: PricingSnapshot) -> PricingSnapshot:
    try:
        session.add(row)
        await session.commit()
        return row
    except IntegrityError:
        await session.rollback()
        winner = await session.scalar(
            select(PricingSnapshot).where(
                PricingSnapshot.source_key == row.source_key,
                PricingSnapshot.scope_key == row.scope_key,
                PricingSnapshot.sha256 == row.sha256,
            )
        )
        if winner is None:
            raise
        return winner


async def _known_identity(session: AsyncSession, pricing_id: str) -> FamilyIdentity | None:
    row = await session.scalar(
        select(PricingSnapshot)
        .where(PricingSnapshot.pricing_id == pricing_id, PricingSnapshot.owner.is_not(None),
               PricingSnapshot.scope_key == PUBLIC_SCOPE)
        .order_by(PricingSnapshot.fetched_at.desc())
        .limit(1)
    )
    if row is None or not row.sphere_organization_id or not row.slug:
        return None
    return FamilyIdentity(pricing_id, row.sphere_organization_id, row.slug, row.owner, row.collection_slug)


async def snapshot_version(
    session: AsyncSession,
    organization_id: uuid.UUID | None,
    where: SphereEndpoint,
    pricing_id: str,
    version_id: str,
    credential: Credential | None = None,
    *,
    actor_id: uuid.UUID | None = None,
    signed_in: bool = True,
    refresh: bool = False,
    source: PricingSource | None = None,
    manifest: Manifest | None = None,
) -> Snapshotted:
    """The snapshot of one SPHERE or registry version, read at most once per scope (see the module docstring).

    ``manifest``, when the caller already read it (the upstream watcher), is used instead of reading it again.
    """
    if not is_sphere_id(pricing_id) or not is_sphere_id(version_id):
        raise PricingNotFound("not a SPHERE pricing or version id")
    source = source or get_pricing_source()
    key = sphere_source_key(where, pricing_id, version_id)
    scopes = readable_scopes(organization_id, member=organization_id is not None, signed_in=signed_in,
                             registry=where.registry)
    stored = await latest_for(session, key, scopes)
    if stored is not None and not refresh:
        return Snapshotted(stored, "reused")
    await _close_read(session)

    read = await read_version(source, where, pricing_id, version_id, credential, manifest=manifest)
    if read.entry.private:
        if where.registry:
            scope = registry_scope(where.registry)
        elif credential is not None and organization_id is not None:
            scope = organization_scope(organization_id)
        else:  # pragma: no cover - an anonymous manifest never lists a private version
            raise PricingNotFound("a private version needs a key")
    else:
        scope = PUBLIC_SCOPE
    identity = await _known_identity(session, pricing_id)
    if identity is None:
        try:
            identity = await source.family(where, pricing_id)
        except PricingNotFound:
            identity = None
    await _close_read(session)

    body = read.fetched.body
    sha256 = read.fetched.sha256
    existing = await session.scalar(
        select(PricingSnapshot).where(
            PricingSnapshot.source_key == key, PricingSnapshot.scope_key == scope, PricingSnapshot.sha256 == sha256
        )
    )
    if existing is not None:
        return Snapshotted(existing, "same")
    previous_row = await latest_for(session, key, [scope])
    previous = Previous(previous_row.sha256, previous_row.content_hash) if previous_row else None
    # The bytes' own functional hash decides: the manifest's contentHash names the version, not these bytes.
    change = classify_change(previous, sha256, read.parsed.content_hash)
    if change == "content":
        logger.warning("pricing_version_content_changed source=%s scope=%s", key, scope)
    await _close_read(session)
    write_file(body)
    normalised_pricing = read.parsed.normalised
    row = PricingSnapshot(
        source_key=key,
        scope_key=scope,
        organization_id=organization_id if scope == organization_scope(organization_id) else None,
        sha256=sha256,
        size_bytes=len(body),
        content_hash=read.entry.content_hash or read.parsed.content_hash,
        content_hash_verified=read.content_hash_verified,
        source_kind="registry" if where.registry else "sphere",
        registry=where.registry,
        pricing_id=pricing_id,
        version_id=version_id,
        version_label=read.entry.label[:120],
        version_created_at=read.entry.created_at[:40] or None,
        sphere_organization_id=identity.organization_id if identity else None,
        owner=(identity.owner or None) if identity else None,
        slug=identity.slug if identity else None,
        title=(read.manifest.name or (normalised_pricing.title if normalised_pricing else "Pricing"))[:240],
        collection_slug=identity.collection if identity else None,
        url=None,
        etag=(read.fetched.etag or "")[:200] or None,
        last_modified=read.fetched.last_modified,
        syntax_version=_syntax(read.parsed),
        currency=normalised_pricing.currency if normalised_pricing else None,
        valid=bool(read.parsed.valid),
        renamed_from_id=previous_row.id if change == "rename" and previous_row else None,
        fetched_by_id=actor_id,
    )
    return Snapshotted(await _insert(session, row), change)


def _syntax(parsed: ParsedPricing) -> str | None:
    if parsed.normalised is not None:
        return parsed.normalised.syntax_version
    raw = parsed.document.get("syntaxVersion")
    return str(raw)[:16] if raw is not None else None


async def snapshot_url(
    session: AsyncSession,
    organization_id: uuid.UUID,
    url: str,
    *,
    actor_id: uuid.UUID | None,
    source: PricingSource | None = None,
    now: datetime | None = None,
) -> Snapshotted:
    """The organization's snapshot of a Pricing2Yaml URL (see the module docstring)."""
    source = source or get_pricing_source()
    settings = get_settings()
    canonical = canonical_url(url)
    key = url_source_key(canonical)
    scope = organization_scope(organization_id)
    latest = await latest_for(session, key, [scope])
    moment = now or datetime.now(timezone.utc)
    if latest is not None:
        fetched_at = latest.fetched_at if latest.fetched_at.tzinfo else latest.fetched_at.replace(tzinfo=timezone.utc)
        if moment - fetched_at < timedelta(seconds=float(settings.offering_url_min_interval_s)):
            return Snapshotted(latest, "reused")
    await _close_read(session)
    answer = await source.url_yaml(
        canonical,
        if_none_match=latest.etag if latest is not None else None,
        if_modified_since=latest.last_modified if latest is not None else None,
    )
    if isinstance(answer, NotModified):
        if latest is None:  # pragma: no cover - no condition was sent
            raise PricingSourceUnavailable("unavailable")
        return Snapshotted(latest, "same")
    existing = await session.scalar(
        select(PricingSnapshot).where(
            PricingSnapshot.source_key == key, PricingSnapshot.scope_key == scope,
            PricingSnapshot.sha256 == answer.sha256,
        )
    )
    if existing is not None:
        return Snapshotted(existing, "same")
    try:
        parsed = await parse(answer.body)
    except PricingInvalid:
        raise
    if actor_id is not None:
        from ....services.entitlements import entitlement_service

        async def stored() -> int:
            return await account_stored_bytes(session, actor_id)

        await entitlement_service.enforce_storage_quota(actor_id, len(answer.body), stored)
    previous = Previous(latest.sha256, latest.content_hash) if latest is not None else None
    change = classify_change(previous, answer.sha256, parsed.content_hash)
    await _close_read(session)
    write_file(answer.body)
    normalised_pricing = parsed.normalised
    row = PricingSnapshot(
        source_key=key,
        scope_key=scope,
        organization_id=organization_id,
        sha256=answer.sha256,
        size_bytes=len(answer.body),
        content_hash=parsed.content_hash,
        content_hash_verified=True,
        source_kind="url",
        title=(normalised_pricing.title if normalised_pricing else _title(parsed))[:240],
        url=canonical,
        etag=(answer.etag or "")[:200] or None,
        last_modified=answer.last_modified,
        syntax_version=_syntax(parsed),
        currency=normalised_pricing.currency if normalised_pricing else None,
        valid=bool(parsed.valid),
        renamed_from_id=latest.id if change == "rename" and latest is not None else None,
        fetched_by_id=actor_id,
    )
    return Snapshotted(await _insert(session, row), change)


def _title(parsed: ParsedPricing) -> str:
    name = parsed.document.get("saasName")
    return name if isinstance(name, str) and name else "Pricing"

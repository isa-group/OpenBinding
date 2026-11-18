"""OpenBinding's own published pricing (``GET /v1/plans/pricing``), read through the pricing source.

The family is ``SPHERE_OPENBINDING_PRICING_ID``; the version is the one labelled ``SPACE_PRICING_VERSION`` in its
manifest, so a new published version is a setting, not code. The version is snapshotted once (verified as every
SPHERE read: bytes against the ``ETag``, functional hash against ``contentHash``) and served from the snapshot:
the YAML for pricing-renderer and the parsed document as JSON (``.inf`` becomes ``null``) for the frontend's
plan model. When the manifest cannot be read but a snapshot of that label exists, the snapshot is served
(stale-if-error); with neither, the caller gets the public ``pricing_unavailable``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.settings import Settings
from ....db.models import PricingSnapshot
from ..domain.errors import PricingError
from ..domain.snapshots import PUBLIC_SCOPE
from ..domain.sources import DEFAULT_ENDPOINT
from .discovery import manifest as read_manifest
from .pricing_source import PricingSource, get_pricing_source
from .snapshots import normalised, snapshot_bytes, snapshot_version


class OwnPricingUnavailable(PricingError):
    """The published pricing cannot be served (the reason goes to the log, never to the caller)."""


@dataclass(frozen=True)
class OwnPricing:
    pricing_id: str
    name: str
    version: str
    version_id: str
    created_at: str | None
    permanent_url: str
    yaml: str
    document: dict[str, Any]
    sha256: str


def json_value(value: Any) -> Any:
    """YAML infinities as JSON ``null``, without inventing a numeric ceiling."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(key): json_value(child) for key, child in value.items()}
    if isinstance(value, list):
        return [json_value(child) for child in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


async def _stale(session: AsyncSession, pricing_id: str, label: str) -> PricingSnapshot | None:
    return await session.scalar(
        select(PricingSnapshot)
        .where(PricingSnapshot.pricing_id == pricing_id, PricingSnapshot.version_label == label,
               PricingSnapshot.scope_key == PUBLIC_SCOPE, PricingSnapshot.registry.is_(None))
        .order_by(PricingSnapshot.fetched_at.desc())
        .limit(1)
    )


async def own_pricing(session: AsyncSession, settings: Settings, *, source: PricingSource | None = None) -> OwnPricing:
    """The version of OpenBinding's pricing that ``SPACE_PRICING_VERSION`` names, from its snapshot."""
    label = settings.space_pricing_version
    pricing_id = settings.sphere_openbinding_pricing_id
    if not label:
        raise OwnPricingUnavailable("SPACE_PRICING_VERSION is not configured")
    if not settings.sphere_enabled:
        raise OwnPricingUnavailable("SPHERE is not enabled")
    source = source or get_pricing_source()
    snapshot: PricingSnapshot | None = None
    name = None
    try:
        manifest = await read_manifest(DEFAULT_ENDPOINT, pricing_id, None, source=source)
        entry = manifest.by_label(label)
        if entry is None:
            raise OwnPricingUnavailable(f"SPHERE has no version {label!r} of the published pricing")
        name = manifest.name
        snapshot = (await snapshot_version(session, None, DEFAULT_ENDPOINT, pricing_id, entry.version_id,
                                           signed_in=False, source=source)).snapshot
    except OwnPricingUnavailable:
        raise
    except PricingError as exc:
        snapshot = await _stale(session, pricing_id, label)
        if snapshot is None:
            raise OwnPricingUnavailable(f"the published pricing cannot be read: {exc}") from exc
    parsed = await normalised(snapshot)
    try:
        text = snapshot_bytes(snapshot).decode("utf-8")
    except (UnicodeDecodeError, PricingError) as exc:
        raise OwnPricingUnavailable(f"the stored pricing cannot be read: {exc}") from exc
    return OwnPricing(
        pricing_id=pricing_id,
        name=name or snapshot.title,
        version=snapshot.version_label or label,
        version_id=snapshot.version_id or "",
        created_at=snapshot.version_created_at,
        permanent_url=source.permanent_url(DEFAULT_ENDPOINT, pricing_id),
        yaml=text,
        document=json_value(dict(parsed.document)),
        sha256=snapshot.sha256,
    )

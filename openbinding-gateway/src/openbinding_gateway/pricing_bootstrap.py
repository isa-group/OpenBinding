"""Startup reconciliation of the pricing source of truth in SPHERE."""

from __future__ import annotations

from typing import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .core.settings import Settings
from .db.models import AuditEvent, PricingRelease, PricingSpaceState, PricingSphereState, User
from .pricing_catalog import PricingCatalogError
from .routes.pricing import STABLE_VERSION, validate_pricing
from .space_client.deployments import SpaceDeploymentClient
from .sphere_client import SphereClient, SphereError, SpherePricingVersion


def _stable_key(version: str) -> tuple[int, int, int]:
    match = STABLE_VERSION.fullmatch(version)
    if match is None:
        raise ValueError(f"Not a stable pricing version: {version}")
    return tuple(int(part) for part in match.groups())


def latest_public_version(versions: Iterable[SpherePricingVersion]) -> SpherePricingVersion:
    public = [
        item for item in versions
        if not item.private and STABLE_VERSION.fullmatch(item.version)
    ]
    if not public:
        raise SphereError("SPHERE has no public stable pricing release.")
    return max(public, key=lambda item: _stable_key(item.version))


async def reconcile_pricing(
    session: AsyncSession, settings: Settings, actor: User
) -> PricingRelease:
    """Make the database and SPACE point at SPHERE's latest public release."""
    sphere = SphereClient(settings)
    try:
        remote = latest_public_version(await sphere.list_versions())
        content = await sphere.content(remote.version)
    finally:
        await sphere.aclose()

    _, validation = validate_pricing(content, remote.version, settings)
    if not validation.valid or not validation.digest:
        raise PricingCatalogError(
            f"SPHERE release {remote.version!r} failed pricing validation: "
            + "; ".join(validation.errors)
        )

    release = await session.scalar(
        select(PricingRelease).where(PricingRelease.version == remote.version)
    )
    if release is None:
        release = PricingRelease(
            version=remote.version,
            digest=validation.digest,
            sphere_organization_id=remote.organization_id,
            sphere_state=PricingSphereState.PUBLIC_RELEASE,
            public_url=remote.yaml_url,
            created_by_id=actor.id,
        )
        session.add(release)
        await session.flush()
    elif release.digest != validation.digest:
        raise PricingCatalogError(
            f"SPHERE changed the immutable digest of pricing {remote.version!r}."
        )
    else:
        release.sphere_state = PricingSphereState.PUBLIC_RELEASE
        release.public_url = remote.yaml_url
        release.sphere_organization_id = remote.organization_id

    if settings.space_enabled:
        space = SpaceDeploymentClient(settings)
        if release.space_state is PricingSpaceState.NOT_DEPLOYED:
            await space.deploy(remote.yaml_url)
        elif release.space_state in {
            PricingSpaceState.ARCHIVED,
            PricingSpaceState.DRAINING,
        }:
            await space.set_availability(remote.version, "active")
        release.space_state = PricingSpaceState.ACTIVE

    previous = (
        await session.execute(
            select(PricingRelease).where(
                PricingRelease.is_live.is_(True), PricingRelease.id != release.id
            )
        )
    ).scalars().all()
    for old in previous:
        old.is_live = False
        if old.space_state is PricingSpaceState.ACTIVE:
            old.space_state = PricingSpaceState.DRAINING
    release.is_live = True
    session.add(
        AuditEvent(
            actor_id=actor.id,
            action="pricing.startup.reconciled",
            target_type="PricingRelease",
            target_id=release.id,
            detail={
                "version": release.version,
                "previous": [item.version for item in previous],
            },
        )
    )
    await session.flush()
    return release
"""Settling the contracts that could not be created when an account was made.

Registration deliberately survives SPACE being unreachable: losing a sign-up
because a pricing service was restarting is a worse failure than a delayed
contract, so the account is created either way and ``contract_pending`` records
what it still owes.

Nothing settled that debt. The flag was written on registration, read by the
profile endpoints, and never cleared - so an account created while SPACE was
down stayed unmetered for ever, and its quotas read as an empty list, which
looks like "this plan has no limits" rather than like a failure. The first
account it happened to was the seeded administrator, created before anybody had
connected SPACE at all.

This is that reconciliation, on the first authenticated request the user makes.
It is cheap for everybody else: a boolean on a row that is already loaded.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import Settings
from ..db.models import (
    AuditEvent,
    PricingRelease,
    PricingSpaceState,
    PricingSphereState,
    User,
)

logger = logging.getLogger(__name__)


async def live_pricing_version(session: AsyncSession) -> str:
    """The public release selected for new and renewing contracts."""
    version = await session.scalar(
        select(PricingRelease.version)
        .where(
            PricingRelease.is_live.is_(True),
            PricingRelease.sphere_state == PricingSphereState.PUBLIC_RELEASE,
        )
        .limit(1)
    )
    if version is not None:
        return str(version)
    from ..space_client import get_gate

    injected = getattr(get_gate(), "catalog", None)
    if injected is not None:
        return str(injected.version)
    from ..space_client import PricingUnavailable

    raise PricingUnavailable("No LIVE pricing release is registered.")


async def settle_pending_contract(user: User, session: AsyncSession) -> None:
    """Give this account the contract it was promised, if it is still owed one.

    Failures are swallowed on purpose: this runs on an ordinary request that
    has nothing to do with contracts, and SPACE still being unreachable is the
    same situation the flag was invented for. The account stays pending and the
    next request tries again.
    """
    if not getattr(user, "contract_pending", False):
        return

    from .. import space_client
    from ..space_client import PricingUnavailable

    gate = space_client.get_gate()
    if gate is None:
        return

    try:
        await gate.create_contract(
            user.id,
            user.plan_cache,
            user.email,
            await live_pricing_version(session),
        )
    except PricingUnavailable as error:
        logger.debug("Contract for %s still pending: %s", user.username, error)
        return
    except Exception as error:  # noqa: BLE001 - never fail somebody's request over this
        logger.warning("Could not settle the contract for %s: %s", user.username, error)
        return

    user.contract_pending = False
    await session.flush()
    logger.info("Settled the pending contract for %s", user.username)


async def reconcile_contract_renewal(user: User, session: AsyncSession) -> bool:
    """Novate an expired contract to LIVE before SPACE can auto-renew it.

    A version-only novation deliberately emits no notification: users are
    notified only when their plan or add-on quantities change.
    """
    if getattr(user, "contract_pending", False):
        return False
    from .. import space_client
    from ..space_client import PricingUnavailable

    try:
        changed = await space_client.get_gate().migrate_due_contract(
            user.id, await live_pricing_version(session)
        )
    except PricingUnavailable as error:
        logger.debug("Could not reconcile contract for %s: %s", user.username, error)
        return False
    except Exception as error:  # noqa: BLE001 - authentication must survive a control-plane outage
        logger.warning("Could not reconcile contract for %s: %s", user.username, error)
        return False
    if changed:
        logger.info("Migrated expired contract for %s to the LIVE pricing", user.username)
    return changed


async def sweep_contract_renewals(session: AsyncSession) -> int:
    """Reconcile every active, settled account; used by the periodic sweep."""
    users = (
        await session.execute(
            select(User).where(User.is_active.is_(True), User.contract_pending.is_(False))
        )
    ).scalars().all()
    return sum([await reconcile_contract_renewal(user, session) for user in users])


async def archive_drained_pricings(session: AsyncSession, settings: Settings) -> int:
    """Archive SPACE releases after their final pinned contract has renewed."""
    if not settings.space_enabled:
        return 0
    from ..space_client import PricingUnavailable
    from ..space_client.deployments import SpaceDeploymentClient

    client = SpaceDeploymentClient(settings)
    releases = (
        await session.execute(
            select(PricingRelease).where(
                PricingRelease.space_state == PricingSpaceState.DRAINING,
                PricingRelease.is_live.is_(False),
            )
        )
    ).scalars().all()
    archived = 0
    for release in releases:
        try:
            if await client.contract_count(release.version):
                continue
            await client.set_availability(release.version, "archived")
        except PricingUnavailable as error:
            logger.warning("Could not inspect drained pricing %s: %s", release.version, error)
            continue
        release.space_state = PricingSpaceState.ARCHIVED
        session.add(AuditEvent(
            action="pricing.space.auto_archived",
            target_type="PricingRelease",
            target_id=release.id,
            detail={"version": release.version, "reason": "no_pinned_contracts"},
        ))
        archived += 1
    return archived

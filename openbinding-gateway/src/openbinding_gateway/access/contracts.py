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

from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User

logger = logging.getLogger(__name__)


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
        await gate.create_contract(user.id, user.plan_cache.value, user.email)
    except PricingUnavailable as error:
        logger.debug("Contract for %s still pending: %s", user.username, error)
        return
    except Exception as error:  # noqa: BLE001 - never fail somebody's request over this
        logger.warning("Could not settle the contract for %s: %s", user.username, error)
        return

    user.contract_pending = False
    await session.flush()
    logger.info("Settled the pending contract for %s", user.username)

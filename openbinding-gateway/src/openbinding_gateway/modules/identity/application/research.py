"""RESEARCH by a verified institutional email, and the plan rule that applies it.

Plan §5: RESEARCH is for an account whose email SCORETech Identity verified and whose domain is in
``RESEARCH_EMAIL_DOMAINS``; otherwise an administrator grants it. The grant moves an account on the default plan
to RESEARCH with a SPACE novation (``upgrade_to_research``), at provisioning and after every claim sync, and is
never withdrawn automatically.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import TypeVar

from sqlalchemy.ext.asyncio import AsyncSession

from .... import space_client
from ....access.contracts import live_pricing_version
from ....core.settings import Settings, get_settings
from ....db.models import User
from ..domain.claims import IdentityClaims
from ..domain.rules import research_eligible
from . import sessions

logger = logging.getLogger(__name__)

T = TypeVar("T")

RESEARCH = "RESEARCH"


async def apply_plan_rule(
    user_id: uuid.UUID,
    rule: Callable[[space_client.SubscriptionSnapshot], Awaitable[T]],
    current: space_client.SubscriptionSnapshot | None = None,
) -> T:
    """Apply a plan change that follows a rule to the contract it was decided on.

    ``rule`` looks at a subscription and, when the rule applies, novates with that subscription's
    ``contract_version``. If the contract changed in between (a renewal, an administrator), the novation is
    refused with ``ContractChanged`` and the rule is applied again, once, to the contract as it is now: a rule,
    unlike a person, can decide again on its own. A second change in a row propagates as the
    ``PricingUnavailable`` it also is.
    """
    gate = space_client.get_gate()
    try:
        return await rule(current if current is not None else await gate.subscription(user_id))
    except space_client.ContractChanged:
        return await rule(await gate.subscription(user_id))


async def upgrade_to_research(user: User) -> bool:
    """Move a default-plan account to RESEARCH; whether it moved.

    An account on any other plan is left alone. Without a configured default plan there is no "default-plan
    account" to upgrade. Raises ``space_client.PricingUnavailable`` when SPACE cannot be reached.
    """
    settings = get_settings()
    default_plan = settings.space_default_plan
    if not default_plan:
        return False
    version = live_pricing_version(settings)

    async def upgrade(current: space_client.SubscriptionSnapshot) -> bool:
        if current.plan != default_plan:
            return False
        # SPACE rejects the novation if the pricing version has no RESEARCH plan.
        await space_client.get_gate().change_plan(user.id, RESEARCH, version, current.contract_version)
        return True

    changed = await apply_plan_rule(user.id, upgrade)
    if changed:
        user.plan_cache = RESEARCH
    return changed


def eligible(settings: Settings, email: str | None, verified: bool) -> bool:
    return research_eligible(email, verified, settings.research_email_domain_list)


async def grant_by_email(db: AsyncSession, settings: Settings, user: User, claims: IdentityClaims) -> None:
    """After a claim sync: RESEARCH for a default-plan account whose stored, verified email qualifies.

    Idempotent (an account already off the default plan is never touched, so one novation and one audit row);
    SPACE down leaves it for the next renewal. Never a downgrade.
    """
    if not claims.profile_from_id_token or not eligible(settings, user.email, user.email_verified):
        return
    if user.contract_pending or user.plan_cache != (settings.space_default_plan or ""):
        return
    try:
        changed = await upgrade_to_research(user)
    except space_client.PricingUnavailable as error:
        logger.info("research_grant_deferred error=%s", type(error).__name__)
        return
    if changed:
        sessions.audit(db, "account.research.granted", actor=user.id, target=user.id, detail={"basis": "email"})


def institutional_email(user: User, settings: Settings | None = None) -> bool:
    """Whether ``user``'s stored, verified email is in a RESEARCH domain (shown on profiles and admin views)."""
    return eligible(settings or get_settings(), user.email, bool(user.email_verified))

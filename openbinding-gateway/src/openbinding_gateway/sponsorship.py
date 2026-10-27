"""Billing sponsorship transfer.

Whoever pays for an organization's subtree can only be the person who agrees to
pay: an OWNER may make themselves the sponsor, and nobody can name somebody
else.  The transfer checks the new sponsor's plan and moves the whole subtree in
the request's transaction.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .collaboration import (
    descendant_ids,
    enforce_sponsor_usage,
    organization_usage,
    sponsor_organization_ids,
)
from .db.models import Organization, User


async def check_transfer(
    session: AsyncSession, organization: Organization, sponsor: User
) -> set[uuid.UUID]:
    """Lock the sponsor and verify their contract admits the whole subtree.

    The hypothetical total is the sponsor's current organizations plus this
    subtree: the same check and errors (402 ``sponsor_quota_exceeded``, 503
    ``pricing_unavailable``) the direct change always had.  Nothing is written.
    Returns the subtree that would move.
    """

    await session.execute(select(User.id).where(User.id == sponsor.id).with_for_update())
    subtree = set(await descendant_ids(session, organization.id))
    sponsored = set(await sponsor_organization_ids(session, sponsor.id))
    await enforce_sponsor_usage(session, sponsor, await organization_usage(session, subtree | sponsored))
    return subtree


async def apply_transfer(
    session: AsyncSession, organization: Organization, sponsor: User, subtree: set[uuid.UUID]
) -> uuid.UUID:
    """Move the subtree's consumption to ``sponsor``'s quota; returns the previous sponsor."""

    previous = organization.billing_sponsor_user_id
    await session.execute(
        update(Organization).where(Organization.id.in_(subtree)).values(billing_sponsor_user_id=sponsor.id)
    )
    organization.billing_sponsor_user_id = sponsor.id
    return previous


async def transfer_sponsorship(
    session: AsyncSession, organization: Organization, sponsor: User
) -> uuid.UUID:
    """Check, then move, the organization and its subtree to ``sponsor``'s quota."""

    subtree = await check_transfer(session, organization, sponsor)
    return await apply_transfer(session, organization, sponsor, subtree)

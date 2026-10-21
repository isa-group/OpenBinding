"""Billing sponsorship by explicit acceptance.

Whoever pays for an organization's subtree is chosen by the organization, but
only the chosen person can agree to pay.  Proposing somebody else therefore
creates a ``SponsorProposal``; nothing about quotas changes until that person
accepts, and acceptance re-validates everything inside one transaction.

Every state other than ``pending`` is terminal.  Expiry is evaluated lazily
whenever a proposal is read or decided, and the periodic reconciler sweeps what
nobody touched (``sweep_expired``).  Because an error response rolls the request
transaction back, a lazy expiry that must be reported as an error commits
first (``_commit_then``).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Iterable

from fastapi import status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .collaboration import (
    ancestor_ids,
    descendant_ids,
    effective_role,
    enforce_sponsor_usage,
    organization_usage,
    sponsor_organization_ids,
    ROLE_STRENGTH,
)
from .core.settings import get_settings
from .db.models import (
    AuditEvent,
    Notification,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    SponsorProposal,
    SponsorProposalStatus,
    User,
    utcnow,
)
from .models.errors import api_error
from .models.platform import SponsorProposalView

PENDING = SponsorProposalStatus.PENDING


def aware(moment: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; the stored value is UTC either way."""

    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=timezone.utc)


def is_due(proposal: SponsorProposal, now: datetime | None = None) -> bool:
    return aware(proposal.expires_at) <= (now or utcnow())


def _audit(
    session: AsyncSession,
    action: str,
    proposal: SponsorProposal,
    actor_id: uuid.UUID | None,
    **detail,
) -> None:
    session.add(
        AuditEvent(
            organization_id=proposal.organization_id,
            actor_id=actor_id,
            action=action,
            target_type="SponsorProposal",
            target_id=proposal.id,
            detail={
                "proposal_id": str(proposal.id),
                "organization_id": str(proposal.organization_id),
                "proposed_user_id": str(proposal.proposed_user_id) if proposal.proposed_user_id else None,
                "proposed_by_user_id": str(proposal.proposed_by_user_id) if proposal.proposed_by_user_id else None,
                **detail,
            },
        )
    )


async def organization_owner_ids(session: AsyncSession, organization_id: uuid.UUID) -> list[uuid.UUID]:
    """Users holding OWNER on the organization or on an ancestor."""

    ancestors = await ancestor_ids(session, organization_id)
    rows = await session.scalars(
        select(OrganizationMembership.user_id).where(
            OrganizationMembership.organization_id.in_(ancestors),
            OrganizationMembership.role == OrganizationRole.OWNER,
        )
    )
    return list(dict.fromkeys(rows))


async def _notify(
    session: AsyncSession,
    recipients: Iterable[uuid.UUID | None],
    kind: str,
    subject: str,
    body: str,
    payload: dict,
) -> None:
    for user_id in dict.fromkeys(r for r in recipients if r is not None):
        session.add(Notification(user_id=user_id, kind=kind, subject=subject, body=body, payload=payload))


async def _notify_resolution(
    session: AsyncSession,
    proposal: SponsorProposal,
    organization: Organization,
    outcome: str,
    actor_id: uuid.UUID | None,
) -> None:
    """Tell the proposer and the organization's owners how a proposal ended."""

    owners = await organization_owner_ids(session, organization.id)
    recipients = [proposal.proposed_by_user_id, *owners]
    skip = {actor_id, proposal.proposed_user_id}
    await _notify(
        session,
        [r for r in recipients if r not in skip],
        f"organization.sponsor.{outcome}",
        f"Sponsorship proposal for {organization.name} {outcome}",
        f"The proposal that the billing sponsor of {organization.name} changes was {outcome}.",
        {
            "proposal_id": str(proposal.id),
            "organization_id": str(organization.id),
            "organization_slug": organization.slug,
            "status": proposal.status.value,
        },
    )


async def _transition(
    session: AsyncSession,
    proposal: SponsorProposal,
    new_status: SponsorProposalStatus,
    decided_by: uuid.UUID | None,
    reason: str | None = None,
) -> bool:
    """Leave ``pending`` exactly once (compare-and-set), reporting whether this call did."""

    result = await session.execute(
        update(SponsorProposal)
        .where(SponsorProposal.id == proposal.id, SponsorProposal.status == PENDING)
        .values(
            status=new_status,
            decided_at=utcnow(),
            decided_by_user_id=decided_by,
            decision_reason=reason,
        )
        .execution_options(synchronize_session=False)
    )
    await session.refresh(proposal)
    return result.rowcount == 1


async def _finish(
    session: AsyncSession,
    proposal: SponsorProposal,
    organization: Organization,
    new_status: SponsorProposalStatus,
    decided_by: uuid.UUID | None,
    reason: str | None = None,
    **detail,
) -> bool:
    if not await _transition(session, proposal, new_status, decided_by, reason):
        return False
    outcome = new_status.value
    _audit(
        session,
        f"organization.sponsor.{outcome}",
        proposal,
        decided_by,
        **({"reason": reason} if reason else {}),
        **detail,
    )
    await _notify_resolution(session, proposal, organization, outcome, decided_by)
    await session.flush()
    return True


async def expire_if_due(session: AsyncSession, proposal: SponsorProposal) -> bool:
    """Expire a pending proposal whose time is up. Returns whether it did."""

    if proposal.status is not PENDING or not is_due(proposal):
        return False
    organization = await session.get(Organization, proposal.organization_id)
    return await _finish(
        session, proposal, organization, SponsorProposalStatus.EXPIRED, None, "expired"
    )


async def sweep_expired(session: AsyncSession, *, limit: int = 500) -> int:
    """Expire everything nobody touched; called by the periodic reconciler."""

    rows = (
        await session.scalars(
            select(SponsorProposal)
            .where(SponsorProposal.status == PENDING, SponsorProposal.expires_at <= utcnow())
            .order_by(SponsorProposal.expires_at)
            .limit(limit)
        )
    ).all()
    return sum([await expire_if_due(session, row) for row in rows])


async def cancel_for_user(
    session: AsyncSession,
    user_id: uuid.UUID,
    reason: str,
    actor_id: uuid.UUID | None = None,
) -> int:
    """Cancel every pending proposal that involves a user who is no longer active.

    Covers proposals addressed to the user and those the user made: a person who
    lost access cannot be asked to pay, and cannot stand behind a request.
    """

    rows = (
        await session.scalars(
            select(SponsorProposal).where(
                SponsorProposal.status == PENDING,
                (SponsorProposal.proposed_user_id == user_id)
                | (SponsorProposal.proposed_by_user_id == user_id),
            )
        )
    ).all()
    cancelled = 0
    for proposal in rows:
        organization = await session.get(Organization, proposal.organization_id)
        cancelled += await _finish(
            session, proposal, organization, SponsorProposalStatus.CANCELLED, actor_id, reason
        )
    return cancelled


async def _commit_then(session: AsyncSession, error):
    """Keep a state change made while discovering the problem, then report it."""

    await session.commit()
    return error


def _terminal_error(proposal: SponsorProposal):
    if proposal.status is SponsorProposalStatus.EXPIRED:
        return api_error(
            status.HTTP_409_CONFLICT,
            "sponsor_proposal_expired",
            "This sponsorship proposal has expired.",
            status=proposal.status.value,
        )
    return api_error(
        status.HTTP_409_CONFLICT,
        "sponsor_proposal_not_pending",
        "This sponsorship proposal has already been resolved.",
        status=proposal.status.value,
    )


async def require_pending(session: AsyncSession, proposal: SponsorProposal) -> None:
    """Refuse to act on a proposal that is not pending, expiring it first when due."""

    if proposal.status is PENDING and await expire_if_due(session, proposal):
        raise await _commit_then(session, _terminal_error(proposal))
    if proposal.status is not PENDING:
        raise _terminal_error(proposal)


async def pending_for(session: AsyncSession, organization_id: uuid.UUID) -> SponsorProposal | None:
    return (
        await session.scalars(
            select(SponsorProposal).where(
                SponsorProposal.organization_id == organization_id, SponsorProposal.status == PENDING
            )
        )
    ).first()


async def create_proposal(
    session: AsyncSession,
    organization: Organization,
    proposed: User,
    proposer: User,
    *,
    replace: bool = False,
) -> SponsorProposal:
    """Propose ``proposed`` as sponsor of ``organization``; the sponsor does not change.

    At most one proposal per organization may be pending.  A second one is
    refused with ``409 sponsor_proposal_pending`` unless its author is the same
    person who made the pending one and says so explicitly (``replace``), in
    which case the old proposal is cancelled (reason ``replaced``).
    """

    if not proposed.is_active:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_sponsor", "Sponsor must be active.")
    existing = await pending_for(session, organization.id)
    if existing is not None and await expire_if_due(session, existing):
        existing = None
    if existing is not None:
        if replace and existing.proposed_by_user_id == proposer.id:
            await _finish(
                session, existing, organization, SponsorProposalStatus.CANCELLED, proposer.id, "replaced"
            )
        else:
            raise api_error(
                status.HTTP_409_CONFLICT,
                "sponsor_proposal_pending",
                "A sponsorship proposal is already pending for this organization; "
                "cancel it, wait for the answer, or (its author only) replace it.",
                proposal_id=str(existing.id),
                expires_at=aware(existing.expires_at).isoformat(),
            )
    now = utcnow()
    proposal = SponsorProposal(
        organization_id=organization.id,
        proposed_user_id=proposed.id,
        proposed_by_user_id=proposer.id,
        status=PENDING,
        created_at=now,
        expires_at=now + timedelta(days=get_settings().sponsor_proposal_ttl_days),
    )
    try:
        async with session.begin_nested():
            session.add(proposal)
            await session.flush()
    except IntegrityError:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "sponsor_proposal_pending",
            "A sponsorship proposal is already pending for this organization.",
        ) from None
    _audit(
        session,
        "organization.sponsor.proposed",
        proposal,
        proposer.id,
        current_sponsor_user_id=str(organization.billing_sponsor_user_id),
        expires_at=aware(proposal.expires_at).isoformat(),
    )
    await _notify(
        session,
        [proposed.id],
        "organization.sponsor.proposed",
        f"{proposer.username} proposes you as billing sponsor of {organization.name}",
        (
            f"{proposer.username} proposed you as the billing sponsor of {organization.name} and "
            "its sub-organizations. Nothing changes until you accept; the consumption of all of "
            "them would then count against your plan."
        ),
        {
            "proposal_id": str(proposal.id),
            "organization_id": str(organization.id),
            "organization_slug": organization.slug,
            "proposed_by_user_id": str(proposer.id),
            "expires_at": aware(proposal.expires_at).isoformat(),
        },
    )
    await session.flush()
    return proposal


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


async def supersede_pending(
    session: AsyncSession, organization: Organization, actor: User, reason: str = "sponsor_changed"
) -> None:
    """A direct change of sponsor leaves no pending proposal behind."""

    existing = await pending_for(session, organization.id)
    if existing is not None:
        await _finish(session, existing, organization, SponsorProposalStatus.CANCELLED, actor.id, reason)


async def accept(session: AsyncSession, proposal: SponsorProposal, actor: User) -> Organization:
    """The proposed person agrees: revalidate everything and move the subtree."""

    await require_pending(session, proposal)
    organization = await session.get(Organization, proposal.organization_id)
    sponsor = await session.get(User, proposal.proposed_user_id)
    if sponsor is None or not sponsor.is_active:
        await _finish(
            session, proposal, organization, SponsorProposalStatus.CANCELLED, None, "user_deactivated"
        )
        raise await _commit_then(session, _terminal_error(proposal))
    if organization.billing_sponsor_user_id == sponsor.id:
        await _finish(
            session, proposal, organization, SponsorProposalStatus.CANCELLED, actor.id, "already_sponsor"
        )
        raise await _commit_then(session, _terminal_error(proposal))
    # Limits first, with nothing written: a refusal leaves the proposal pending so
    # the person can raise their plan and accept again.  Then claim the decision
    # (a concurrent decision leaves rowcount 0 here) and only then move the subtree.
    subtree = await check_transfer(session, organization, sponsor)
    if not await _transition(session, proposal, SponsorProposalStatus.ACCEPTED, actor.id):
        raise _terminal_error(proposal)
    previous = await apply_transfer(session, organization, sponsor, subtree)
    _audit(
        session,
        "organization.sponsor.accepted",
        proposal,
        actor.id,
        previous_sponsor_user_id=str(previous),
        new_sponsor_user_id=str(sponsor.id),
    )
    await _notify_resolution(session, proposal, organization, "accepted", actor.id)
    await session.flush()
    return organization


async def decline(session: AsyncSession, proposal: SponsorProposal, actor: User) -> None:
    await require_pending(session, proposal)
    organization = await session.get(Organization, proposal.organization_id)
    if not await _finish(session, proposal, organization, SponsorProposalStatus.DECLINED, actor.id):
        raise _terminal_error(proposal)


async def cancel(session: AsyncSession, proposal: SponsorProposal, actor: User) -> None:
    await require_pending(session, proposal)
    organization = await session.get(Organization, proposal.organization_id)
    if not await _finish(session, proposal, organization, SponsorProposalStatus.CANCELLED, actor.id):
        raise _terminal_error(proposal)


# --- who may see and do what -------------------------------------------------


async def viewer_level(session: AsyncSession, proposal: SponsorProposal, user: User) -> str | None:
    """``proposed`` / ``proposer`` / ``staff`` when the user may see the proposal, else ``None``.

    Staff are platform administrators and OWNER/ADMIN of the organization.
    """

    if user.id == proposal.proposed_user_id:
        return "proposed"
    if user.id == proposal.proposed_by_user_id:
        return "proposer"
    if user.is_admin:
        return "staff"
    role = await effective_role(session, proposal.organization_id, user)
    if role is not None and ROLE_STRENGTH[role] >= ROLE_STRENGTH[OrganizationRole.ADMIN]:
        return "staff"
    return None


async def may_cancel(session: AsyncSession, proposal: SponsorProposal, user: User) -> bool:
    """The proposer, an OWNER of the organization, or a platform administrator."""

    if user.is_admin or user.id == proposal.proposed_by_user_id:
        return True
    return await effective_role(session, proposal.organization_id, user) is OrganizationRole.OWNER


async def views(session: AsyncSession, proposals: list[SponsorProposal]) -> list[SponsorProposalView]:
    """Render proposals with organization and user labels, in three queries."""

    if not proposals:
        return []
    organizations = {
        row.id: row
        for row in await session.scalars(
            select(Organization).where(Organization.id.in_({p.organization_id for p in proposals}))
        )
    }
    user_ids = {
        value
        for p in proposals
        for value in (p.proposed_user_id, p.proposed_by_user_id, p.decided_by_user_id)
        if value is not None
    }
    names = (
        dict((await session.execute(select(User.id, User.username).where(User.id.in_(user_ids)))).all())
        if user_ids
        else {}
    )
    return [
        SponsorProposalView(
            id=p.id,
            organization_id=p.organization_id,
            organization_slug=organizations[p.organization_id].slug,
            organization_name=organizations[p.organization_id].name,
            proposed_user_id=p.proposed_user_id,
            proposed_username=names.get(p.proposed_user_id),
            proposed_by_user_id=p.proposed_by_user_id,
            proposed_by_username=names.get(p.proposed_by_user_id),
            status=p.status.value,
            created_at=p.created_at,
            expires_at=p.expires_at,
            decided_at=p.decided_at,
            decided_by_user_id=p.decided_by_user_id,
            decision_reason=p.decision_reason,
        )
        for p in proposals
    ]

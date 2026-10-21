"""Billing-sponsor proposals: who is asked, who answers, who can see and withdraw them.

Proposing a sponsor is done through ``PATCH /v1/organizations/{org}`` or the
administrator's ``POST /v1/admin/organizations/{id}/sponsor`` (both answer 202
with the proposal). The endpoints here are the proposed person's answer and
the lists. Anybody who may not see a proposal gets 404, never 403, so the
existence of other people's proposals does not leak.
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi import status as http_status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import sponsor_proposals
from ..access.dependencies import get_current_user, session_dependency
from ..collaboration import ROLE_STRENGTH, effective_role, organization_by_ref
from ..db.models import OrganizationRole, SponsorProposal, SponsorProposalStatus, User, utcnow
from ..models.errors import ErrorResponse, NOT_FOUND_RESPONSE, api_error
from ..models.platform import SponsorProposalState, SponsorProposalView

router = APIRouter(prefix="/v1/sponsor-proposals", tags=["Organizations"])
me_router = APIRouter(prefix="/v1/users/me", tags=["Organizations"])
organization_router = APIRouter(prefix="/v1/organizations", tags=["Organizations"])

DECISION_RESPONSES = {
    403: {
        "model": ErrorResponse,
        "description": "The caller may see the proposal but not take this decision (`sponsor_proposal_forbidden`).",
    },
    404: NOT_FOUND_RESPONSE,
    409: {
        "model": ErrorResponse,
        "description": (
            "The proposal is no longer pending: `sponsor_proposal_expired` (its time ran out) or "
            "`sponsor_proposal_not_pending` (already accepted, declined or cancelled; `status` says which)."
        ),
    },
}


def _not_found():
    return api_error(http_status.HTTP_404_NOT_FOUND, "not_found", "Sponsorship proposal not found.")


def _forbidden():
    return api_error(
        http_status.HTTP_403_FORBIDDEN,
        "sponsor_proposal_forbidden",
        "You may see this sponsorship proposal but not take this decision.",
    )


async def _visible(session: AsyncSession, proposal_id: uuid.UUID, user: User) -> tuple[SponsorProposal, str]:
    proposal = await session.get(SponsorProposal, proposal_id)
    level = await sponsor_proposals.viewer_level(session, proposal, user) if proposal else None
    if proposal is None or level is None:
        raise _not_found()
    return proposal, level


async def _listing(
    session: AsyncSession,
    conditions: list,
    status_filter: Optional[str],
    limit: int,
    offset: int,
) -> list[SponsorProposalView]:
    # Expire what is due first, so the list never offers an answer that would fail.
    due = (
        await session.scalars(
            select(SponsorProposal).where(
                *conditions,
                SponsorProposal.status == SponsorProposalStatus.PENDING,
                SponsorProposal.expires_at <= utcnow(),
            )
        )
    ).all()
    for proposal in due:
        await sponsor_proposals.expire_if_due(session, proposal)
    query = select(SponsorProposal).where(*conditions)
    if status_filter is not None:
        query = query.where(SponsorProposal.status == SponsorProposalStatus(status_filter))
    rows = (
        await session.scalars(
            query.order_by(SponsorProposal.created_at.desc(), SponsorProposal.id).offset(offset).limit(limit)
        )
    ).all()
    return await sponsor_proposals.views(session, list(rows))


@me_router.get(
    "/sponsor-proposals",
    response_model=list[SponsorProposalView],
    operation_id="listMySponsorProposals",
    summary="Sponsorship proposals addressed to the caller",
)
async def list_my_proposals(
    status: Optional[SponsorProposalState] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[SponsorProposalView]:
    return await _listing(
        session, [SponsorProposal.proposed_user_id == user.id], status, limit, offset
    )


@organization_router.get(
    "/{org}/sponsor-proposals",
    response_model=list[SponsorProposalView],
    operation_id="listOrganizationSponsorProposals",
    summary="Sponsorship proposals made for an organization",
    responses={403: {"model": ErrorResponse, "description": "A member without ADMIN access."}, 404: NOT_FOUND_RESPONSE},
)
async def list_organization_proposals(
    org: str,
    status: Optional[SponsorProposalState] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[SponsorProposalView]:
    """OWNER and ADMIN of the organization, and platform administrators; a non-member gets 404."""
    organization = await organization_by_ref(session, org)
    role = await effective_role(session, organization.id, user) if organization else None
    if organization is None or (role is None and not user.is_admin):
        raise _not_found()
    if not user.is_admin and ROLE_STRENGTH[role] < ROLE_STRENGTH[OrganizationRole.ADMIN]:
        raise api_error(
            http_status.HTTP_403_FORBIDDEN,
            "organization_forbidden",
            "This action requires ADMIN access to the organization.",
        )
    return await _listing(
        session, [SponsorProposal.organization_id == organization.id], status, limit, offset
    )


@router.get(
    "/{proposal_id}",
    response_model=SponsorProposalView,
    operation_id="getSponsorProposal",
    responses={404: NOT_FOUND_RESPONSE},
)
async def get_proposal(
    proposal_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> SponsorProposalView:
    proposal, _ = await _visible(session, proposal_id, user)
    await sponsor_proposals.expire_if_due(session, proposal)
    [view] = await sponsor_proposals.views(session, [proposal])
    return view


@router.post(
    "/{proposal_id}/accept",
    response_model=SponsorProposalView,
    operation_id="acceptSponsorProposal",
    summary="Accept being the billing sponsor",
    responses={
        **DECISION_RESPONSES,
        402: {
            "model": ErrorResponse,
            "description": "The caller's plan cannot take the organization's subtree (`sponsor_quota_exceeded`); the proposal stays pending.",
        },
        503: {"model": ErrorResponse, "description": "The caller's contract cannot be read (`pricing_unavailable`)."},
    },
)
async def accept_proposal(
    proposal_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> SponsorProposalView:
    """Only the proposed person can accept, and only if their plan admits the organization and its subtree."""
    proposal, level = await _visible(session, proposal_id, user)
    if level != "proposed":
        raise _forbidden()
    await sponsor_proposals.accept(session, proposal, user)
    [view] = await sponsor_proposals.views(session, [proposal])
    return view


@router.post(
    "/{proposal_id}/decline",
    response_model=SponsorProposalView,
    operation_id="declineSponsorProposal",
    summary="Decline being the billing sponsor",
    responses=DECISION_RESPONSES,
)
async def decline_proposal(
    proposal_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> SponsorProposalView:
    proposal, level = await _visible(session, proposal_id, user)
    if level != "proposed":
        raise _forbidden()
    await sponsor_proposals.decline(session, proposal, user)
    [view] = await sponsor_proposals.views(session, [proposal])
    return view


@router.post(
    "/{proposal_id}/cancel",
    response_model=SponsorProposalView,
    operation_id="cancelSponsorProposal",
    summary="Withdraw a pending sponsorship proposal",
    responses=DECISION_RESPONSES,
)
async def cancel_proposal(
    proposal_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> SponsorProposalView:
    """The proposer, an OWNER of the organization, or a platform administrator."""
    proposal, _ = await _visible(session, proposal_id, user)
    if not await sponsor_proposals.may_cancel(session, proposal, user):
        raise _forbidden()
    await sponsor_proposals.cancel(session, proposal, user)
    [view] = await sponsor_proposals.views(session, [proposal])
    return view

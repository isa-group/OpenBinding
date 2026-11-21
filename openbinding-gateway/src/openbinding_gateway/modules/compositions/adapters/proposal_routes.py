"""Proposals (F6-B): ``.../compositions/{composition}/proposals``, ``/v1/organizations/{org}/proposals/{proposal}`` and the
caller's list.

A proposal is an organization's typed steps that change nothing until its author confirms them (``proposals``). A
MEMBER proposes an adoption, or a derivation and its adoption in one step, on a composition; members of the
organization read every proposal, and only its author cancels it (or confirms it, ``.../confirm``). Every route needs a
signed-in caller (401 before any lookup). A non-member gets the composition's 404 parity on the composition's routes,
and ``Proposal not found.`` on a proposal's own routes, the body a member gets for a missing proposal or another
organization's. Making, superseding or cancelling a proposal never moves an environment's ETag or its feed.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, session_dependency
from ....access.work_limits import limit_work
from ....collaboration import effective_role, organization_by_ref
from ....db.models import Composition, CompositionEnvironment, Organization, OrganizationRole, User
from ....security.apikeys import authenticated_api_key
from ....models.errors import (
    CONFLICT_RESPONSE,
    FORBIDDEN_RESPONSE,
    NOT_FOUND_RESPONSE,
    UNAVAILABLE_RESPONSE,
    ErrorResponse,
)
from ..application import compositions, environments, proposal_executor, proposals
from .schemas import (
    CompositionOrganization,
    ProposalComposition,
    ProposalConfirm,
    ProposalCreate,
    ProposalEnvironment,
    ProposalList,
    ProposalPerson,
    ProposalPreview,
    ProposalPreviewAgainst,
    ProposalStepError,
    ProposalStepView,
    ProposalView,
    VersionName,
)

router = APIRouter(prefix="/v1/organizations/{org}/compositions/{composition}/proposals", tags=["Proposals"])
organization_router = APIRouter(prefix="/v1/organizations/{org}/proposals", tags=["Proposals"])
me_router = APIRouter(prefix="/v1/users/me/proposals", tags=["Proposals"])

NO_CACHE = "private, no-cache"
_VARY = "Authorization, X-API-Key"
UNAUTHENTICATED: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "No credential, or one that is not valid (`unauthorized`)."},
}
UNREADABLE: dict[int | str, dict[str, Any]] = {
    **UNAUTHENTICATED,
    404: {
        **NOT_FOUND_RESPONSE,
        "description": "No such organization, composition or proposal, or the caller is not a member: "
                       "`Composition not found.` for a private or missing composition, `Proposal not found.` "
                       "otherwise.",
    },
}
PROPOSAL_UNREADABLE: dict[int | str, dict[str, Any]] = {
    **UNAUTHENTICATED,
    404: {**NOT_FOUND_RESPONSE, "description": "`Proposal not found.`: no such proposal in this organization, or the "
                                               "caller is not a member."},
}
#: A seal step derives (and, at confirm, seals) as the derive route does.
EVALUATING: dict[int | str, dict[str, Any]] = {
    429: {"model": ErrorResponse, "description": "Every Composition2Yaml slot of this process is taken "
                                                "(`composition_busy`), or the caller's `evaluate` budget is spent."},
    503: {**UNAVAILABLE_RESPONSE, "description": "The toolchain does not answer (`bim_unavailable`)."},
}
Status = Literal["pending", "executing", "completed", "partial", "failed", "cancelled", "superseded", "stale"]


def headers(response: Response, row=None) -> None:
    response.headers["Cache-Control"] = NO_CACHE
    response.headers["Vary"] = _VARY
    if row is not None:
        response.headers["ETag"] = proposals.proposal_etag(row)


async def _scope(session: AsyncSession, org: str, composition: str, user: User) -> tuple[Organization, Composition,
                                                                                        OrganizationRole]:
    organization, found, reader = await compositions.readable_composition(session, org, composition, user)
    if reader.public or reader.role is None:
        raise proposals.unreadable()
    return organization, found, reader.role


async def organization_scope(session: AsyncSession, org: str, user: User) -> tuple[Organization, OrganizationRole]:
    """The organization of a proposal's own routes, for a member; everyone else gets ``Proposal not found.``."""
    organization = await organization_by_ref(session, org)
    role = None if organization is None else await effective_role(session, organization.id, user)
    if organization is None or role is None:
        raise proposals.unreadable()
    return organization, role


async def reachable(session: AsyncSession, organization: Organization, proposal: str, user: User):
    """The organization's proposal ``proposal`` for a caller whose API key (if any) reaches its composition; anything
    else is ``Proposal not found.``."""
    row = await proposals.by_id(session, organization, proposal)
    if row is None:
        raise proposals.unreadable()
    composition = None if row.composition_id is None else await session.get(Composition, row.composition_id)
    if not proposals.key_reaches(authenticated_api_key(user), organization, composition):
        raise proposals.unreadable()
    return row


async def proposal_view(session: AsyncSession, row, caller: User, *, detail: bool = False) -> ProposalView:
    """The view of ``row``; ``detail`` adds each seal step's preview and its diff (computed on read)."""
    organization = await session.get(Organization, row.organization_id)
    composition = None if row.composition_id is None else await session.get(Composition, row.composition_id)
    author = await session.get(User, row.proposed_by_id)
    steps = await proposals.steps_of(session, row)
    views = []
    for step in steps:
        preview = None
        if detail:
            found = await proposals.preview_of(session, row, step, steps)
            if found is not None:
                against = None
                if found.against is not None:
                    environment: CompositionEnvironment | None = found.environment
                    against = ProposalPreviewAgainst(
                        version=VersionName(id=found.against.id, label=found.against.label),
                        environment=None if environment is None else ProposalEnvironment(
                            id=environment.id, slug=environment.slug, name=environment.name),
                    )
                preview = ProposalPreview(document=found.document, against=against, diff=found.diff)
        error = None
        if step.error:
            error = ProposalStepError(status=int(step.error.get("status") or 0), code=str(step.error.get("code")),
                                      message=str(step.error.get("message")), detail=step.error.get("detail"))
        views.append(ProposalStepView(
            ordinal=step.ordinal, kind=step.kind, description=step.description, params=dict(step.params),
            base=dict(step.base), dependsOn=list(step.depends_on or []), deferred=proposals.deferred_of(step),
            destructive=step.destructive, status=step.status, result=step.result, error=error,
            finishedAt=step.finished_at, preview=preview,
        ))
    assert organization is not None
    return ProposalView(
        id=row.id,
        organization=CompositionOrganization(id=organization.id, slug=organization.slug, name=organization.name),
        composition=None if composition is None else ProposalComposition(
            id=composition.id, slug=composition.slug, name=composition.name),
        origin=row.origin, status=row.status, summary=row.summary, warnings=list(row.warnings or []),
        confirmationPhrase=row.confirmation_phrase, upstreamEvent=row.upstream_event_id,
        proposedBy=None if author is None else ProposalPerson(username=author.username),
        mine=row.proposed_by_id == caller.id, supersededBy=row.superseded_by_id, createdAt=row.created_at,
        confirmedAt=row.confirmed_at, completedAt=row.completed_at, steps=views,
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=ProposalView,
    operation_id="createProposal",
    summary="Propose a change to a composition",
    description=(
        "Build a proposal of typed steps (MEMBER): `adopt` (one step) or `derive_and_adopt` (derive a version from a "
        "run's solution or a revision's binding, seal it and adopt it, in one confirmation). Nothing changes until "
        "the caller confirms it. Each step stores its base revisions; a seal step stores the exact document it would "
        "seal (`GET` serves it with its diff). The caller's pending proposal on this composition is superseded."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        **UNREADABLE,
        403: {**FORBIDDEN_RESPONSE, "description": "The caller's role is weaker than MEMBER (`organization_forbidden`)."},
        409: {**CONFLICT_RESPONSE, "description": "`composition_archived`, or `proposal_conflict` (another proposal of "
                                                  "the caller's was made at the same time)."},
        422: {"description": "`proposal_invalid`: `errors` lists `{step, code, message}`."},
        **EVALUATING,
    },
)
async def create_proposal(
    org: str,
    composition: str,
    payload: ProposalCreate,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProposalView:
    organization, found, role = await _scope(session, org, composition, user)
    environments.require(role, OrganizationRole.MEMBER)
    request = payload.root
    try:
        row = await proposals.create(
            session, organization, user, proposals.web_steps(request), role=role, composition=found,
            origin="web", upstream_event=request.upstreamEvent,
        )
    except proposals.ProposalInvalid as invalid:
        raise invalid.http() from None
    headers(response, row)
    response.headers["Location"] = f"/v1/organizations/{organization.slug}/proposals/{row.id}"
    return await proposal_view(session, row, user, detail=True)


@router.get("", response_model=ProposalList, operation_id="listProposals", responses=UNREADABLE)
async def list_proposals(
    org: str,
    composition: str,
    response: Response,
    status_: Status | None = Query(default=None, alias="status"),
    limit: int = Query(default=20, ge=1, le=100),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProposalList:
    """The composition's proposals, newest first (members; previews are on a proposal's own read)."""
    organization, found, _ = await _scope(session, org, composition, user)
    rows = await proposals.list_for(session, organization, composition=found, status_=status_, limit=limit)
    headers(response)
    return ProposalList(proposals=[await proposal_view(session, row, user) for row in rows])


@organization_router.get("/{proposal}", response_model=ProposalView, operation_id="getProposal",
                         responses={200: {"headers": {"ETag": {"schema": {"type": "string"}}}}, **PROPOSAL_UNREADABLE})
async def get_proposal(
    org: str,
    proposal: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProposalView:
    """One proposal with each seal step's document and its diff against the version in effect (members)."""
    organization, _ = await organization_scope(session, org, user)
    row = await reachable(session, organization, proposal, user)
    headers(response, row)
    return await proposal_view(session, row, user, detail=True)


@organization_router.delete(
    "/{proposal}",
    response_model=ProposalView,
    operation_id="cancelProposal",
    responses={
        **PROPOSAL_UNREADABLE,
        403: {**FORBIDDEN_RESPONSE, "description": "Only its author cancels a proposal (`proposal_not_yours`)."},
        409: {**CONFLICT_RESPONSE, "description": "It is no longer pending (`proposal_not_pending`)."},
    },
)
async def cancel_proposal(
    org: str,
    proposal: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProposalView:
    """Cancel a pending proposal (its author only): it is kept, `cancelled`."""
    organization, _ = await organization_scope(session, org, user)
    row = await reachable(session, organization, proposal, user)
    cancelled = await proposals.cancel(session, row, user)
    headers(response, cancelled)
    return await proposal_view(session, cancelled, user)


@organization_router.post(
    "/{proposal}/confirm",
    response_model=ProposalView,
    operation_id="confirmProposal",
    summary="Confirm a proposal and apply it step by step",
    description=(
        "Its author only. Every step's stored base is checked first (a base that no longer holds makes the proposal "
        "`stale`: 409 `proposal_stale`, nothing changed), and the caller's permissions for each step: its role, and "
        "for a personal API key each step's own permission (`compositions:adopt` for an `adopt` step, beyond the "
        "`compositions:write` this route asks for). Then the steps run in order, each committed by itself, and the "
        "answer is the proposal as recorded: `completed`, `partial` (each step's outcome says what was applied) or "
        "`failed`. A step whose dependency did not complete is `skipped`; nothing is retried or rolled back."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        **PROPOSAL_UNREADABLE,
        403: {**FORBIDDEN_RESPONSE, "description": "`proposal_not_yours`, `organization_forbidden` (a step's role) or "
                                                   "`insufficient_api_key_permission` (a step's key permission)."},
        409: {**CONFLICT_RESPONSE, "description": "`proposal_not_pending`, or `proposal_stale` (`stale` lists "
                                                  "`{step, kind, reason, base, current}`)."},
        422: {"description": "`confirmation_required` or `confirmation_mismatch`: a destructive step needs its typed "
                             "phrase."},
        **EVALUATING,
    },
)
async def confirm_proposal(
    org: str,
    proposal: str,
    request: Request,
    response: Response,
    payload: Optional[ProposalConfirm] = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProposalView:
    """Confirm a pending proposal (its author): the steps are applied in order and reported one by one."""
    organization, role = await organization_scope(session, org, user)
    await reachable(session, organization, proposal, user)
    finished = await proposal_executor.confirm(
        session, organization, proposal, user, role=role,
        confirmation=None if payload is None else payload.confirmation,
        api_key=getattr(request.state, "api_key", None),
    )
    headers(response, finished)
    return await proposal_view(session, finished, user, detail=True)


@me_router.get("", response_model=ProposalList, operation_id="listOwnProposals", responses=UNAUTHENTICATED)
async def list_own_proposals(
    response: Response,
    status_: Status | None = Query(default="pending", alias="status"),
    limit: int = Query(default=10, ge=1, le=50),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ProposalList:
    """The caller's own proposals in every organization they hold a role in, newest first (pending by default): the
    dashboard's "Your pending proposals"."""
    organization_ids = await compositions.readable_organization_ids(session, user)
    key = authenticated_api_key(user)
    if key is not None:
        # The key's boundary: only proposals of organizations and compositions it reaches (filtered here, since the
        # route names none of them).
        reached = []
        for row in await proposals.list_for(session, None, organization_ids=organization_ids, author=user,
                                            status_=status_, limit=200):
            organization = await session.get(Organization, row.organization_id)
            composition = None if row.composition_id is None else await session.get(Composition, row.composition_id)
            if organization is not None and proposals.key_reaches(key, organization, composition):
                reached.append(row)
        rows = reached[:limit]
    else:
        rows = await proposals.list_for(session, None, organization_ids=organization_ids, author=user,
                                        status_=status_, limit=limit)
    headers(response)
    return ProposalList(proposals=[await proposal_view(session, row, user) for row in rows])


__all__ = ["me_router", "organization_router", "proposal_view", "router"]

"""Upstream events (F6): ``/v1/organizations/{org}/compositions/{composition}/upstream-events`` and the caller's list.

An upstream event records that a pricing a live version reads changed upstream, classified once (``upstream_events``).
Every route needs a signed-in caller (401 before any lookup) with a role in the organization: a non-member gets the
composition's 404 parity, and every event route of a public composition answers such a caller "Upstream event not
found." VIEWER reads; MEMBER marks an event reviewed, once, with an optional note. No route resolves an event: only a
person's seal does (``seal_into``). Reading or reviewing never moves an environment's ETag or its feed.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, session_dependency
from ....core import revision as etags
from ....db.models import Composition, Organization, OrganizationRole, User
from ....models.errors import CONFLICT_RESPONSE, FORBIDDEN_RESPONSE, NOT_FOUND_RESPONSE, ErrorResponse, api_error
from ..application import compositions, environments, upstream_events
from .schemas import (
    CompositionOrganization,
    MyUpstreamComposition,
    MyUpstreamEvent,
    MyUpstreamEventList,
    UpstreamEventCounts,
    UpstreamEventDetail,
    UpstreamEventList,
    UpstreamEventReview,
    UpstreamEventView,
    UpstreamPerson,
    UpstreamPricingRef,
    UpstreamResolution,
    UpstreamSide,
    UpstreamVersionName,
    UpstreamWatchSummary,
)

router = APIRouter(prefix="/v1/organizations/{org}/compositions/{composition}/upstream-events",
                   tags=["Upstream events"])
me_router = APIRouter(prefix="/v1/users/me/upstream-events", tags=["Upstream events"])

NO_CACHE = "private, no-cache"
_VARY = "Authorization, X-API-Key"
UNREADABLE: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "No credential, or one that is not valid (`unauthorized`)."},
    404: {
        **NOT_FOUND_RESPONSE,
        "description": "No such organization, composition or event, or the caller is not a member: "
                       "`Composition not found.` for a private or missing composition, `Upstream event not found.` "
                       "otherwise.",
    },
}


def unreadable():
    return api_error(404, "not_found", "Upstream event not found.")


def _headers(response: Response) -> None:
    response.headers["Cache-Control"] = NO_CACHE
    response.headers["Vary"] = _VARY


async def _scope(session: AsyncSession, org: str, composition: str, user: User) -> tuple[Organization, Composition,
                                                                                        OrganizationRole]:
    organization, found, reader = await compositions.readable_composition(session, org, composition, user)
    if reader.public or reader.role is None:
        raise unreadable()
    return organization, found, reader.role


def _side(diff_side: dict[str, Any] | None, snapshot_id: uuid.UUID | None, version_id: str | None,
          label: str | None) -> UpstreamSide:
    diff_side = diff_side or {}
    return UpstreamSide(versionId=version_id or diff_side.get("versionId"), label=label or diff_side.get("label"),
                        snapshotId=snapshot_id, url=diff_side.get("url"))


def event_view(row: upstream_events.EventRow, *, detail: bool = False) -> UpstreamEventView:
    event = row.event
    pricing = dict(event.diff.get("pricing") or {})
    gone = event.new_ref.startswith("gone:")
    values = dict(
        id=event.id, subject=event.subject, category=event.category, state=event.state, notify=event.notify,
        version=UpstreamVersionName(id=row.version.id, label=row.version.label), tasks=list(event.tasks or []),
        reasons=list(event.reasons or []),
        pricing=UpstreamPricingRef(sphere=pricing.get("sphere"), registry=pricing.get("registry"),
                                   pricingId=pricing.get("pricingId"), url=pricing.get("url"),
                                   title=pricing.get("title")),
        old=_side(event.diff.get("old"), event.old_snapshot_id, event.old_version_id, event.old_label),
        new=None if gone else _side(event.diff.get("new"), event.new_snapshot_id, event.new_version_id,
                                    event.new_label),
        note=event.note, reviewedBy=UpstreamPerson(username=row.reviewed_by) if row.reviewed_by else None,
        reviewedAt=event.reviewed_at,
        resolvedBy=None if row.resolved_version is None else UpstreamResolution(
            version=UpstreamVersionName(id=row.resolved_version.id, label=row.resolved_version.label),
            by=UpstreamPerson(username=row.resolved_by) if row.resolved_by else None, at=event.resolved_at,
        ),
        detectedAt=event.detected_at, environments=row.environments, supersededBy=row.superseded_by,
        newVersionWithdrawn=row.withdrawn, rebindingRecommended=event.category == "binding_invalid",
        classifier=event.classifier,
    )
    if detail:
        return UpstreamEventDetail(**values, diff=dict(event.diff))
    return UpstreamEventView(**values)


def _before(value: str | None) -> tuple[datetime, uuid.UUID] | None:
    if not value:
        return None
    try:
        moment, _, ident = value.partition(",")
        return datetime.fromisoformat(moment), uuid.UUID(ident)
    except ValueError as exc:
        raise api_error(422, "invalid_request", "`before` is `<detectedAt>,<id>` of an event.") from exc


@router.get("", response_model=UpstreamEventList, operation_id="listUpstreamEvents", responses=UNREADABLE)
async def list_upstream_events(
    org: str,
    composition: str,
    response: Response,
    state: Literal["open", "reviewed", "resolved"] | None = Query(default=None),
    version: uuid.UUID | None = Query(default=None, description="Only the events of this version (its id)."),
    category: Literal["no_impact", "values_changed", "binding_invalid", "offering_changed"] | None = Query(default=None),
    subject: Literal["binding", "offering"] | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    before: str | None = Query(default=None, description="`<detectedAt>,<id>` of the last event of the page before."),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> UpstreamEventList:
    """The composition's upstream events, newest first, with the pricings its live versions read (members only)."""
    _, found, _ = await _scope(session, org, composition, user)
    events = await upstream_events.list_events(session, found, state=state, version=version, category=category,
                                               subject=subject, limit=limit, before=_before(before))
    rows = await upstream_events.rows_of(session, events)
    watches = [
        UpstreamWatchSummary(
            pricing=UpstreamPricingRef(sphere=sphere_ref if watch.source_kind != "url" else None,
                                       registry=watch.registry, pricingId=watch.pricing_id, url=watch.url, title=None),
            latestLabel=label, observedAt=watch.observed_at, status=watch.status,
        )
        for watch, sphere_ref, label in await upstream_events.watch_summaries(session, found)
    ]
    _headers(response)
    last = events[-1] if len(events) == limit else None
    return UpstreamEventList(
        events=[event_view(row) for row in rows], watches=watches,
        counts=UpstreamEventCounts(**await upstream_events.state_counts(session, found)),
        nextBefore=f"{last.detected_at.isoformat()},{last.id}" if last is not None else None,
    )


@router.get("/{event}", response_model=UpstreamEventDetail, operation_id="getUpstreamEvent",
            responses={**etags.ETAG_RESPONSE, **UNREADABLE})
async def get_upstream_event(
    org: str,
    composition: str,
    event: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> UpstreamEventDetail:
    """One event with its stored diff (members only)."""
    _, found, _ = await _scope(session, org, composition, user)
    row = await upstream_events.event_of(session, found, event)
    if row is None:
        raise unreadable()
    (viewed,) = await upstream_events.rows_of(session, [row])
    _headers(response)
    response.headers["ETag"] = upstream_events.event_etag(row)
    return event_view(viewed, detail=True)


@router.post(
    "/{event}/review",
    response_model=UpstreamEventDetail,
    operation_id="reviewUpstreamEvent",
    responses={
        **etags.PRECONDITION_RESPONSES,
        **UNREADABLE,
        403: {**FORBIDDEN_RESPONSE, "description": "The caller's role is weaker than MEMBER (`organization_forbidden`)."},
        409: {**CONFLICT_RESPONSE, "description": "Already reviewed or resolved (`event_not_reviewable`)."},
    },
)
async def review_upstream_event(
    org: str,
    composition: str,
    event: str,
    payload: UpstreamEventReview,
    response: Response,
    if_match: str | None = etags.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> UpstreamEventDetail:
    """Mark an open event reviewed, with an optional note written once (MEMBER). An offering event ends here."""
    _, found, role = await _scope(session, org, composition, user)
    environments.require(role, OrganizationRole.MEMBER)
    row = await upstream_events.event_of(session, found, event)
    if row is None:
        raise unreadable()
    etags.check(etags.parse_if_match(if_match), upstream_events.event_etag(row))
    if row.state != "open":
        raise api_error(409, "event_not_reviewable", "This upstream event is already reviewed or resolved.")
    reviewed = await upstream_events.review(session, found, row, user, payload.note)
    (viewed,) = await upstream_events.rows_of(session, [reviewed])
    _headers(response)
    response.headers["ETag"] = upstream_events.event_etag(reviewed)
    return event_view(viewed, detail=True)


@me_router.get("", response_model=MyUpstreamEventList, operation_id="listOwnUpstreamEvents",
               responses={401: UNREADABLE[401]})
async def list_own_upstream_events(
    response: Response,
    limit: int = Query(default=10, ge=1, le=50),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> MyUpstreamEventList:
    """The open upstream events (reviewed ones too, for bindings) of the live versions of every organization the
    caller holds a role in, newest first: the dashboard's "Upstream changes"."""
    organization_ids = await compositions.readable_organization_ids(session, user)
    events = await upstream_events.mine(session, organization_ids, limit)
    rows = await upstream_events.rows_of(session, events)
    out = []
    for row in rows:
        composition = await session.get(Composition, row.event.composition_id)
        organization = await session.get(Organization, row.event.organization_id)
        out.append(MyUpstreamEvent(
            **event_view(row).model_dump(),
            organization=CompositionOrganization(id=organization.id, slug=organization.slug, name=organization.name),
            composition=MyUpstreamComposition(id=composition.id, slug=composition.slug, name=composition.name),
        ))
    _headers(response)
    return MyUpstreamEventList(events=out)


__all__ = ["event_view", "me_router", "router"]

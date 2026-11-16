"""Permanent links to a composition and following one: ``/v1/permalinks/compositions/{id}`` and
``/v1/composition-follows/{org}/{composition}``.

The permanent link is ported from SPHERE (SCORELabUS/SPHERE, MIT licence, revision 73779a8a),
``api/src/main/routes/PermanentLinkRoutes.ts`` and ``PermanentLinkService.resolve``: it resolves a composition's id
(and optionally a version, by id or label) to where the application shows it, with an ``ETag`` of the answer,
``Cache-Control: private, no-store`` and ``Vary`` on the credential, and the same 404 for a composition that does
not exist and one the caller does not read. A version the caller does not read, or that does not exist, is left
out of the answer, exactly as if the link named none.

Following sits outside ``/v1/organizations/{org}/compositions``, as SPHERE's ``/pricing-follows``: a reader who may
not write the composition still follows it. It answers 404 to whoever does not read it.
"""

from __future__ import annotations

import hashlib
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, get_reader, session_dependency
from ....access.work_limits import charge_anonymous_read
from ....collaboration import effective_role
from ....db.models import Composition, CompositionVersion, Organization, User
from ....models.errors import NOT_FOUND_RESPONSE, api_error
from ..application import compositions, follows
from .schemas import FollowState, PermanentLink

permalink_router = APIRouter(prefix="/v1/permalinks", tags=["Compositions"])
follow_router = APIRouter(prefix="/v1/composition-follows", tags=["Compositions"])

_VARY = "Authorization, X-API-Key"
_MISSING = {404: {**NOT_FOUND_RESPONSE, "description": "No such composition, or the caller does not read it."}}


def _missing():
    return api_error(status.HTTP_404_NOT_FOUND, "not_found", "Composition not found.")


@permalink_router.get(
    "/compositions/{composition_id}",
    response_model=PermanentLink,
    operation_id="resolveCompositionPermalink",
    dependencies=[Depends(charge_anonymous_read)],
    responses={**_MISSING, 304: {"description": "`If-None-Match` names the current answer."}},
)
async def resolve_composition_permalink(
    composition_id: str,
    request: Request,
    response: Response,
    version: str | None = Query(default=None, max_length=256, description="A version's id or label."),
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> PermanentLink | Response:
    """Where the application shows a composition, from its permanent id (``/p/{id}?version=``)."""
    try:
        parsed = uuid.UUID(composition_id)
    except ValueError:
        raise _missing() from None
    found = await session.get(Composition, parsed)
    organization = await session.get(Organization, found.organization_id) if found is not None else None
    if organization is None:
        raise _missing()
    if found.visibility != compositions.PUBLIC and (
        user is None or await effective_role(session, organization.id, user) is None
    ):
        raise _missing()
    location = f"/compositions/{quote(organization.slug)}/{quote(found.slug)}"
    if version:
        condition = [CompositionVersion.label == version]
        try:
            condition.append(CompositionVersion.id == uuid.UUID(version))
        except ValueError:
            pass
        named = await session.scalar(
            select(CompositionVersion.label).where(CompositionVersion.composition_id == found.id, or_(*condition))
            .order_by(CompositionVersion.ordinal).limit(1)
        )
        if named is not None:
            location += f"?version={quote(named)}"
    body = PermanentLink(location=location)
    etag = '"' + hashlib.sha256(body.model_dump_json().encode()).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": "private, no-store", "Vary": _VARY}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    response.headers.update(headers)
    return body


async def _followable(session: AsyncSession, org: str, composition: str, user: User) -> Composition:
    _, found, _ = await compositions.readable_composition(session, org, composition, user)
    return found


@follow_router.get(
    "/{org}/{composition}", response_model=FollowState, operation_id="getCompositionFollow", responses=_MISSING,
)
async def get_composition_follow(
    org: str,
    composition: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> FollowState:
    """Whether the caller follows the composition."""
    found = await _followable(session, org, composition, user)
    return FollowState(following=await follows.is_following(session, user.id, found.id))


@follow_router.put(
    "/{org}/{composition}", response_model=FollowState, operation_id="followComposition", responses=_MISSING,
)
async def follow_composition(
    org: str,
    composition: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> FollowState:
    """Follow a composition the caller reads: each version sealed later tells them (``CompositionUpdated``)."""
    found = await _followable(session, org, composition, user)
    await follows.follow(session, user.id, found.id)
    return FollowState(following=True)


@follow_router.delete(
    "/{org}/{composition}", response_model=FollowState, operation_id="unfollowComposition", responses=_MISSING,
)
async def unfollow_composition(
    org: str,
    composition: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> FollowState:
    """Stop following. A follower who no longer reads the composition stops too, and is answered 404."""
    organization = await compositions.organization_by_ref(session, org)
    held = await compositions.composition_by_ref(session, organization.id, composition) if organization else None
    try:
        found = await _followable(session, org, composition, user)
    except HTTPException:
        if held is not None:
            await follows.unfollow(session, user.id, held.id)
            await session.commit()
        raise
    await follows.unfollow(session, user.id, found.id)
    return FollowState(following=False)

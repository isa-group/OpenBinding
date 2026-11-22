"""Composition environments: ``/v1/organizations/{org}/compositions/{composition}/environments``.

An environment is where an application reads the version of a composition in effect. Every route needs a
signed-in caller (401 before any lookup) with a role in the organization; a caller without one gets the
composition's 404 parity, and every environment of a public composition answers such a caller "Environment
not found." VIEWER reads, ADMIN creates, edits and deletes (``environments``). Edits take an optional
``If-Match`` (the ``ETag`` of a read or an earlier edit).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import FeedReader, get_current_user, get_feed_reader, session_dependency
from ....access.work_limits import limit_work
from ....composition import text
from ....core import revision as etags
from ....db.models import OrganizationRole, User
from ....models.errors import CONFLICT_RESPONSE, FORBIDDEN_RESPONSE, NOT_FOUND_RESPONSE, ErrorResponse, api_error
from ..application import adoption, environments, feed, feed_keys, upstream_events
from ..application.check import check_environment
from ..domain.environments import AdoptRole
from .schemas import (
    AdoptionEvaluation,
    AdoptionOffering,
    AdoptionProposal,
    CompositionAdoptionList,
    CompositionAdoptionView,
    EnvironmentAdopt,
    EnvironmentAdoptResult,
    EnvironmentCheck,
    FeedKeyCreate,
    FeedKeyCreated,
    VersionName,
    CompositionEnvironmentCreate,
    CompositionEnvironmentList,
    CompositionEnvironmentUpdate,
    CompositionEnvironmentView,
    EnvironmentBound,
    EnvironmentEvaluation,
    EnvironmentFeed,
    EnvironmentInEffect,
    EnvironmentKeyView,
    EnvironmentOffering,
    EnvironmentOperator,
    EnvironmentPerson,
    EnvironmentUpstreamSummary,
    EnvironmentVersion,
)

router = APIRouter(
    prefix="/v1/organizations/{org}/compositions/{composition}/environments", tags=["Composition environments"],
)

#: Environment answers change on adopt and edits, and differ by caller (keys are ADMIN's).
NO_CACHE = "private, no-cache"
_VARY = "Authorization, X-API-Key"

UNREADABLE: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "No credential, or one that is not valid (`unauthorized`)."},
    404: {
        **NOT_FOUND_RESPONSE,
        "description": (
            "No such organization, composition or environment, or the caller is not a member: "
            "`Composition not found.` for a private or missing composition, `Environment not found.` otherwise."
        ),
    },
}
FORBIDDEN: dict[int | str, dict[str, Any]] = {
    403: {**FORBIDDEN_RESPONSE, "description": "The caller's role is too weak (`organization_forbidden`)."},
}


def headers(response: Response, row=None) -> None:
    response.headers["Cache-Control"] = NO_CACHE
    response.headers["Vary"] = _VARY
    if row is not None:
        etags.set_etag(response, row)


def person(found: environments.Person | None) -> EnvironmentPerson | None:
    return None if found is None else EnvironmentPerson(username=found.username, displayName=found.display_name)


def _binding(content: str) -> dict[str, EnvironmentBound]:
    reading = text.read(content)
    if reading.document is None:
        return {}
    return {
        task: EnvironmentBound(candidate=entry.candidate)
        for task, entry in reading.document.binding
        if entry.candidate is not None
    }


def in_effect_view(found: environments.InEffect | None) -> EnvironmentInEffect | None:
    if found is None:
        return None
    evaluation = found.evaluation
    offering = None
    if evaluation is not None and evaluation.offering_status is not None:
        snapshot = found.offering
        offering = EnvironmentOffering(
            status=evaluation.offering_status,
            versionName=snapshot.version_label if snapshot is not None else None,
            createdAt=snapshot.version_created_at if snapshot is not None else None,
        )
    return EnvironmentInEffect(
        adoption=found.adoption.ordinal,
        version=EnvironmentVersion(id=found.version.id, label=found.version.label, ordinal=found.version.ordinal),
        adoptedAt=found.adoption.created_at,
        adoptedBy=person(found.actor),
        note=found.adoption.note,
        evaluation=None if evaluation is None else EnvironmentEvaluation(
            id=evaluation.id, basisKey=evaluation.basis_key, valuesStatus=found.version.values_status.value,
            outcome=evaluation.outcome.value,
        ),
        offering=offering,
        binding=_binding(found.version.content),
    )


def view(detail: environments.Detail, upstream: dict | None = None) -> CompositionEnvironmentView:
    row = detail.environment
    in_effect = in_effect_view(detail.in_effect)
    operator = detail.operator
    return CompositionEnvironmentView(
        id=row.id,
        slug=row.slug,
        name=row.name,
        description=row.description,
        operator=None if operator is None else EnvironmentOperator(
            username=operator.username, displayName=operator.display_name, member=operator.member,
        ),
        adoptRole=row.adopt_role,
        expectedUsers=row.expected_users,
        inEffect=in_effect,
        feed=EnvironmentFeed(
            path=environments.feed_path(detail.organization, detail.composition, row),
            etag=f'"{detail.in_effect.adoption.content_digest}"' if detail.in_effect is not None else None,
        ),
        keys=None if detail.keys is None else [
            EnvironmentKeyView(
                id=item.key.id, hint=f"{item.key.prefix}…", label=item.key.label, createdAt=item.key.created_at,
                createdBy=item.created_by.username if item.created_by else None,
                creatorIsMember=bool(item.created_by and item.created_by.member),
                lastUsedAt=item.key.last_used_at, revokedAt=item.key.revoked_at,
            )
            for item in detail.keys
        ],
        keyCount=detail.key_count,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
        upstream=None if upstream is None else EnvironmentUpstreamSummary(**upstream),
    )


async def viewed(session: AsyncSession, organization, composition, row, role) -> CompositionEnvironmentView:
    (detail,) = await environments.details(session, organization, composition, [row], role)
    counts = await upstream_events.counts_for_environments(session, [row])
    return view(detail, counts[row.id])


@router.get(
    "",
    response_model=CompositionEnvironmentList,
    operation_id="listCompositionEnvironments",
    responses=UNREADABLE,
)
async def list_composition_environments(
    org: str,
    composition: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionEnvironmentList:
    """The composition's environments, by slug (members only)."""
    organization, found, role = await environments.operating_composition(session, org, composition, user)
    rows = await environments.list_environments(session, found)
    headers(response)
    counts = await upstream_events.counts_for_environments(session, rows)
    return CompositionEnvironmentList(
        environments=[view(detail, counts[detail.environment.id])
                      for detail in await environments.details(session, organization, found, rows, role)],
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=CompositionEnvironmentView,
    operation_id="createCompositionEnvironment",
    responses={
        201: {"headers": {"ETag": etags.ETAG_HEADER}},
        **UNREADABLE,
        **FORBIDDEN,
        409: {
            **CONFLICT_RESPONSE,
            "description": "The slug is in use in this composition (`slug_conflict`), or the composition has as "
                           "many environments as it may (`environment_limit`).",
        },
        422: {"description": "The operator is not a member (`operator_not_member`)."},
    },
)
async def create_composition_environment(
    org: str,
    composition: str,
    payload: CompositionEnvironmentCreate,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionEnvironmentView:
    """Create an environment with nothing adopted yet (ADMIN)."""
    organization, found, role = await environments.operating_composition(session, org, composition, user)
    environments.require(role, OrganizationRole.ADMIN)
    created = await environments.create_environment(
        session, organization, found, user, slug=payload.slug, name=payload.name, description=payload.description,
        operator=payload.operator, adopt_role=AdoptRole(payload.adoptRole), expected_users=payload.expectedUsers,
    )
    headers(response, created)
    return await viewed(session, organization, found, created, role)


@router.get(
    "/{environment}",
    response_model=CompositionEnvironmentView,
    operation_id="getCompositionEnvironment",
    responses={**etags.ETAG_RESPONSE, **UNREADABLE},
)
async def get_composition_environment(
    org: str,
    composition: str,
    environment: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionEnvironmentView:
    """One environment, by slug or id (members only)."""
    organization, found, row, role = await environments.readable_environment(
        session, org, composition, environment, user,
    )
    headers(response, row)
    return await viewed(session, organization, found, row, role)


@router.patch(
    "/{environment}",
    response_model=CompositionEnvironmentView,
    operation_id="updateCompositionEnvironment",
    responses={
        **etags.EDIT_RESPONSES,
        **UNREADABLE,
        **FORBIDDEN,
        422: {"description": "The operator is not a member (`operator_not_member`)."},
    },
)
async def update_composition_environment(
    org: str,
    composition: str,
    environment: str,
    payload: CompositionEnvironmentUpdate,
    response: Response,
    if_match: str | None = etags.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionEnvironmentView:
    """Rename or describe an environment, or change its operator, who may adopt or its expected users (ADMIN)."""
    organization, found, row, role = await environments.readable_environment(
        session, org, composition, environment, user,
    )
    environments.require(role, OrganizationRole.ADMIN)
    changes = payload.model_dump(exclude_unset=True)
    for required in ("name", "description", "adoptRole"):
        if required in changes and changes[required] is None:
            raise api_error(422, "invalid_request", f"`{required}` cannot be null.")
    await etags.guard(session, row, if_match)
    updated = await environments.update_environment(session, organization, found, row, user, changes)
    headers(response, updated)
    return await viewed(session, organization, found, updated, role)


@router.delete(
    "/{environment}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteCompositionEnvironment",
    responses={**etags.PRECONDITION_RESPONSES, **UNREADABLE, **FORBIDDEN},
)
async def delete_composition_environment(
    org: str,
    composition: str,
    environment: str,
    if_match: str | None = etags.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Delete an environment with its feed keys and its adoption history (ADMIN); its feed stops answering."""
    _, found, row, role = await environments.readable_environment(session, org, composition, environment, user)
    environments.require(role, OrganizationRole.ADMIN)
    # The composition before the environment's row (the guard updates it), the order an organization delete takes.
    await environments.lock_composition(session, found)
    await etags.guard(session, row, if_match)
    await environments.delete_environment(session, found, row, user)


# -- Adoption --------------------------------------------------------------------------------------------


def adoption_view(row: adoption.HistoryRow) -> CompositionAdoptionView:
    evaluation = row.evaluation
    snapshot = row.offering
    return CompositionAdoptionView(
        ordinal=row.adoption.ordinal,
        version=VersionName(id=row.version.id, label=row.version.label),
        previousVersion=None if row.previous is None else VersionName(id=row.previous.id, label=row.previous.label),
        adoptedAt=row.adoption.created_at,
        adoptedBy=None if row.actor is None else EnvironmentPerson(
            username=row.actor.username, displayName=row.actor.username,
        ),
        note=row.adoption.note,
        evaluation=None if evaluation is None else AdoptionEvaluation(
            id=evaluation.id, basisKey=evaluation.basis_key, valuesStatus=row.version.values_status.value,
        ),
        offering=None if snapshot is None else AdoptionOffering(
            versionName=snapshot.version_label, createdAt=snapshot.version_created_at,
        ),
        feedEtag=f'"{row.adoption.content_digest}"',
        source=row.adoption.source,
        proposal=None if row.proposal is None else AdoptionProposal(id=row.proposal.id, summary=row.proposal.summary),
    )


@router.post(
    "/{environment}/adopt",
    response_model=EnvironmentAdoptResult,
    operation_id="adoptCompositionVersion",
    summary="Adopt a sealed version in an environment",
    description=(
        "Makes the version the one the environment's feed serves. `If-Match` with the environment's `ETag` is "
        "required. The caller's role must reach the environment's `adoptRole`; a personal API key also needs "
        "`compositions:adopt`."
    ),
    responses={
        200: {"headers": {"ETag": etags.ETAG_HEADER}},
        **etags.PRECONDITION_RESPONSES,
        **etags.PRECONDITION_REQUIRED_RESPONSE,
        **UNREADABLE,
        **FORBIDDEN,
        409: {
            **CONFLICT_RESPONSE,
            "description": (
                "`already_in_effect`, `composition_archived`, `evaluation_stale` (re-evaluate the version first), "
                "`binding_invalid` or `evaluation_semantics_changed` (derive it again)."
            ),
        },
    },
)
async def adopt_composition_version(
    org: str,
    composition: str,
    environment: str,
    payload: EnvironmentAdopt,
    response: Response,
    if_match: str | None = etags.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> EnvironmentAdoptResult:
    """Adopt a version in an environment: what its application reads changes on its next poll."""
    organization, found, row, role = await environments.readable_environment(
        session, org, composition, environment, user,
    )
    adopted = await adoption.adopt(
        session, organization=organization, composition=found, environment=row, role=role,
        version_ref=payload.version, actor=user, if_match=if_match, note=payload.note, source="direct",
        proposal_id=None,
    )
    headers(response, adopted.environment)
    (history,) = await adoption.adoptions(session, adopted.environment, limit=1)
    return EnvironmentAdoptResult(
        environment=await viewed(session, organization, found, adopted.environment, role),
        adoption=adoption_view(history),
    )


@router.get(
    "/{environment}/adoptions",
    response_model=CompositionAdoptionList,
    operation_id="listCompositionAdoptions",
    responses=UNREADABLE,
)
async def list_composition_adoptions(
    org: str,
    composition: str,
    environment: str,
    response: Response,
    limit: int = Query(default=20, ge=1, le=100),
    before: int | None = Query(default=None, ge=1, description="Only adoptions numbered below this one."),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CompositionAdoptionList:
    """An environment's adoption history, newest first (members only)."""
    _, _, row, _ = await environments.readable_environment(session, org, composition, environment, user)
    rows = await adoption.adoptions(session, row, limit=limit, before=before)
    headers(response)
    last = rows[-1].adoption.ordinal if rows else None
    return CompositionAdoptionList(
        adoptions=[adoption_view(item) for item in rows],
        nextBefore=last if last is not None and last > 1 and len(rows) == limit else None,
    )


# -- Feed keys -------------------------------------------------------------------------------------------


@router.post(
    "/{environment}/keys",
    status_code=status.HTTP_201_CREATED,
    response_model=FeedKeyCreated,
    operation_id="createEnvironmentFeedKey",
    summary="Mint a feed key of an environment",
    description=(
        "The key reads this environment's feed and nothing else. Its secret is in this answer only. An environment "
        "holds at most two live keys, so a key is rotated by minting the second and revoking the first. ADMIN; a "
        "personal API key also needs `keys:write`."
    ),
    responses={
        **UNREADABLE,
        **FORBIDDEN,
        409: {**CONFLICT_RESPONSE, "description": "Two live keys already (`feed_key_limit`): revoke one first."},
    },
)
async def create_environment_feed_key(
    org: str,
    composition: str,
    environment: str,
    payload: FeedKeyCreate,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> FeedKeyCreated:
    """Mint a feed key; the secret is shown once."""
    organization, found, row, role = await environments.readable_environment(
        session, org, composition, environment, user,
    )
    environments.require(role, OrganizationRole.ADMIN)
    key, secret = await feed_keys.mint_key(session, found, row, user, payload.label)
    response.headers["Cache-Control"] = "no-store"
    return FeedKeyCreated(
        key=EnvironmentKeyView(
            id=key.id, hint=f"{key.prefix}…", label=key.label, createdAt=key.created_at, createdBy=user.username,
            creatorIsMember=True, lastUsedAt=None, revokedAt=None,
        ),
        secret=secret,
    )


@router.delete(
    "/{environment}/keys/{key}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="revokeEnvironmentFeedKey",
    responses=({**UNREADABLE, **FORBIDDEN}),
)
async def revoke_environment_feed_key(
    org: str,
    composition: str,
    environment: str,
    key: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Revoke a feed key (ADMIN): it stops authenticating on the next request, for good."""
    _, found, row, role = await environments.readable_environment(session, org, composition, environment, user)
    environments.require(role, OrganizationRole.ADMIN)
    await feed_keys.revoke_key(session, found, row, key, user)


# -- The feed --------------------------------------------------------------------------------------------

_FEED_HEADERS = {
    "ETag": {"description": "The adopted version's content digest, quoted: it changes only on adopt.", "schema": {"type": "string"}},
    "Cache-Control": {"description": "`private, no-cache`.", "schema": {"type": "string"}},
    "Vary": {"description": "`Authorization, X-API-Key`.", "schema": {"type": "string"}},
    "OpenBinding-Adoption": {"description": "The adoption's number in the environment (informative).", "schema": {"type": "string"}},
    "OpenBinding-Composition-Version": {"description": "The adopted version's label (informative).", "schema": {"type": "string"}},
}


@router.get(
    "/{environment}/composition",
    response_class=Response,
    operation_id="getEnvironmentFeed",
    summary="Read the composition in effect in an environment",
    description=(
        "The adopted version's Composition2Yaml bytes, unchanged. Read with the environment's feed key (`obe_…`, as "
        "`X-API-Key` or a Bearer token) or a member's credential with `compositions:read`. The `ETag` is the "
        "version's content digest and moves only on adopt: send it as `If-None-Match` and a 304 says nothing "
        "changed. Consumers read `binding.<task>.candidate`, keep their last good state on any other answer, "
        "honour `Retry-After`, and poll about every 30 seconds."
    ),
    responses={
        200: {
            "description": "The composition in effect.",
            "headers": _FEED_HEADERS,
            "content": {"application/yaml": {"schema": {"type": "string"}}},
        },
        304: {"description": "The caller's copy (`If-None-Match`) is the composition in effect.", "headers": _FEED_HEADERS},
        401: {"model": ErrorResponse, "description": "No credential, or one that is not valid (`unauthorized`)."},
        403: {
            "model": ErrorResponse,
            "description": "A member's personal key lacks `compositions:read` or its boundary excludes this feed.",
        },
        404: {
            "model": ErrorResponse,
            "description": (
                "`not_found` (no such environment for this credential, or the composition's parity for a member) or "
                "`nothing_adopted` (nothing is adopted yet)."
            ),
        },
        429: {
            "model": ErrorResponse,
            "description": "Too many reads with this credential (`feed_rate_limited`); `Retry-After` says when.",
            "headers": {"Retry-After": {"description": "Seconds to wait.", "schema": {"type": "integer"}}},
        },
    },
)
async def get_environment_feed(
    org: str,
    composition: str,
    environment: str,
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
    reader: FeedReader = Depends(get_feed_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    return await feed.feed_response(
        session, reader, org=org, composition=composition, environment=environment, if_none_match=if_none_match,
    )


# -- Check now -------------------------------------------------------------------------------------------


@router.post(
    "/{environment}/check",
    response_model=EnvironmentCheck,
    operation_id="checkCompositionEnvironment",
    summary="Check the composition in effect against its sources now",
    description=(
        "Assesses the version in effect on the installed toolchain and compares the upstream pricings and the "
        "offering it pins with what their sources publish now. Writes nothing: no snapshot, row, event or "
        "notification, and the feed is unchanged. A source that cannot be read now is `unavailable`. MEMBER; "
        "counted as a `read`."
    ),
    dependencies=[Depends(limit_work)],
    responses={
        **UNREADABLE,
        **FORBIDDEN,
        409: {**CONFLICT_RESPONSE, "description": "Nothing is adopted in this environment yet (`nothing_adopted`)."},
    },
)
async def check_composition_environment(
    org: str,
    composition: str,
    environment: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> EnvironmentCheck:
    """Check an environment now: what it runs against what its sources publish."""
    organization, found, row, role = await environments.readable_environment(
        session, org, composition, environment, user,
    )
    environments.require(role, OrganizationRole.MEMBER)
    report = await check_environment(session, organization, found, row, user)
    headers(response)
    return EnvironmentCheck.model_validate(report)

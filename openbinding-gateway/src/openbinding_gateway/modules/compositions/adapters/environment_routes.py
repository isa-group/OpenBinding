"""Composition environments: ``/v1/organizations/{org}/compositions/{composition}/environments``.

An environment is where an application reads the version of a composition in effect. Every route needs a
signed-in caller (401 before any lookup) with a role in the organization; a caller without one gets the
composition's 404 parity, and every environment of a public composition answers such a caller "Environment
not found." VIEWER reads, ADMIN creates, edits and deletes (``environments``). Edits take an optional
``If-Match`` (the ``ETag`` of a read or an earlier edit).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, session_dependency
from ....composition import text
from ....core import revision as etags
from ....db.models import OrganizationRole, User
from ....models.errors import CONFLICT_RESPONSE, FORBIDDEN_RESPONSE, NOT_FOUND_RESPONSE, ErrorResponse, api_error
from ..application import environments
from ..domain.environments import AdoptRole
from .schemas import (
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


def view(detail: environments.Detail) -> CompositionEnvironmentView:
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
    )


async def viewed(session: AsyncSession, organization, composition, row, role) -> CompositionEnvironmentView:
    (detail,) = await environments.details(session, organization, composition, [row], role)
    return view(detail)


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
    return CompositionEnvironmentList(
        environments=[view(detail) for detail in await environments.details(session, organization, found, rows, role)],
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
        422: {"model": ErrorResponse, "description": "The operator is not a member (`operator_not_member`)."},
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
        422: {"model": ErrorResponse, "description": "The operator is not a member (`operator_not_member`)."},
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
    await etags.guard(session, row, if_match)
    await environments.delete_environment(session, found, row, user)

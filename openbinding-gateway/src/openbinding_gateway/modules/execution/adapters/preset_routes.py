"""The run presets of an organization: ``/v1/organizations/{org}/presets``.

A preset names the settings a run starts from (engine, registration, mode, options, optimization);
``createRun {revision, preset}`` expands it. Presets follow the runs of their module: every member reads
them, and below MEMBER (or for an API key that cannot run engines) the options are redacted, as a run's
are; MEMBER and above create, edit and delete them (``403 insufficient_role`` below). A non-member learns
nothing: every route answers 404. Edits take an optional ``If-Match`` (the ``ETag`` of a read or an earlier
edit). Errors use the platform JSON envelope.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, session_dependency
from ....collaboration import effective_role, organization_by_ref
from ....core import revision as etags
from ....db.models import Organization, RunPreset, User
from ....models.errors import CONFLICT_RESPONSE, FORBIDDEN_RESPONSE, NOT_FOUND_RESPONSE, api_error
from ....models.platform import SLUG
from ....security.redaction import must_redact_jobs, redact_options
from ....security.roles import require_work_role
from ..application import presets
from ..domain.presets import MAX_OPTIONS_BYTES, SETTINGS_FIELDS

router = APIRouter(prefix="/v1/organizations/{org}/presets", tags=["Runs"])

_REFERENCE = {"$ref": "#/components/schemas/ImmutableResourceRef"}
_ENGINE_SCHEMA = {
    "description": "A built-in engine name, or an immutable reference `{namespace, name, version, digest}`.",
    "oneOf": [{"type": "string", "minLength": 1}, _REFERENCE],
}
_REGISTRATION_SCHEMA = {
    "description": "The deployment to run on, an immutable reference; null for the engine's installed one.",
    "anyOf": [_REFERENCE, {"type": "null"}],
}
_MODE_SCHEMA = {
    "description": "The engine mode; null for the engine's default.",
    "anyOf": [{"type": "string", "minLength": 1, "maxLength": 64}, {"type": "null"}],
}
_OPTIONS_SCHEMA = {
    "description": f"The engine options, as a run request's (at most {MAX_OPTIONS_BYTES} bytes as JSON).",
    "type": "object",
}
_OPTIMIZATION_SCHEMA = {
    "description": (
        "`{type: SINGLE|MULTI|MANY, scalarization, weights?: [{criteria, value}]}`, resolved against the problem's "
        "criteria when a run uses the preset."
    ),
    "anyOf": [{"type": "object"}, {"type": "null"}],
}

_UNREADABLE: dict[int | str, dict[str, Any]] = {
    404: {**NOT_FOUND_RESPONSE, "description": "No such organization or preset, or the caller is not a member."},
}
_WEAK_ROLE: dict[int | str, dict[str, Any]] = {
    403: {**FORBIDDEN_RESPONSE, "description": "Below MEMBER (`insufficient_role`)."},
}


# -- Documents -------------------------------------------------------------------------------------------


class RunPresetCreate(BaseModel):
    """A new run preset: its name and the settings a run started from it runs with."""

    model_config = ConfigDict(extra="forbid")

    slug: str = Field(pattern=SLUG, description="Unique within the organization: 1 to 64 lowercase letters, digits and hyphens.")
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    engine: Any = Field(json_schema_extra=_ENGINE_SCHEMA)
    registration: Any = Field(default=None, json_schema_extra=_REGISTRATION_SCHEMA)
    mode: Any = Field(default=None, json_schema_extra=_MODE_SCHEMA)
    options: Any = Field(default_factory=dict, json_schema_extra=_OPTIONS_SCHEMA)
    optimization: Any = Field(default=None, json_schema_extra=_OPTIMIZATION_SCHEMA)


class RunPresetUpdate(BaseModel):
    """The fields to change; absent fields stay. `registration`, `mode` and `optimization` are cleared with null."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=2000)
    engine: Any = Field(default=None, json_schema_extra=_ENGINE_SCHEMA)
    registration: Any = Field(default=None, json_schema_extra=_REGISTRATION_SCHEMA)
    mode: Any = Field(default=None, json_schema_extra=_MODE_SCHEMA)
    options: Any = Field(default=None, json_schema_extra=_OPTIONS_SCHEMA)
    optimization: Any = Field(default=None, json_schema_extra=_OPTIMIZATION_SCHEMA)


class RunPresetView(BaseModel):
    """A run preset of an organization. Below MEMBER the options are redacted, as a run's are."""

    id: uuid.UUID
    organization_id: uuid.UUID
    slug: str
    name: str
    description: str
    engine: Any = Field(json_schema_extra=_ENGINE_SCHEMA)
    registration: Optional[dict[str, Any]] = None
    mode: Optional[str] = None
    options: dict[str, Any]
    optimization: Optional[dict[str, Any]] = None
    created_by_id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class RunPresetList(BaseModel):
    """One page of an organization's run presets, by name, and how many match in all."""

    presets: list[RunPresetView]
    total: int
    limit: int
    offset: int


# -- Access ----------------------------------------------------------------------------------------------


async def _organization(session: AsyncSession, org: str, user: User) -> Organization:
    """The organization of the address, for a member of it; 404 for everyone else (as the runs routes)."""
    organization = await organization_by_ref(session, org)
    if organization is None or await effective_role(session, organization.id, user) is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    return organization


async def _writable(session: AsyncSession, org: str, user: User) -> Organization:
    organization = await _organization(session, org, user)
    await require_work_role(session, user, [organization.id])
    return organization


def _view(preset: RunPreset, *, redact: bool) -> RunPresetView:
    options = dict(preset.options or {})
    return RunPresetView(
        id=preset.id, organization_id=preset.organization_id, slug=preset.slug, name=preset.name,
        description=preset.description, engine=preset.engine, registration=preset.registration, mode=preset.mode,
        options=redact_options(options) if redact else options, optimization=preset.optimization,
        created_by_id=preset.created_by_id, created_at=preset.created_at, updated_at=preset.updated_at,
    )


# -- Routes ----------------------------------------------------------------------------------------------


@router.get("", response_model=RunPresetList, operation_id="listRunPresets", responses=_UNREADABLE)
async def list_run_presets(
    org: str,
    q: str | None = Query(default=None, max_length=160, description="Text in the name or the slug."),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> RunPresetList:
    """The organization's run presets, by name."""
    organization = await _organization(session, org, user)
    page = await presets.list_presets(session, organization.id, q=q, limit=limit, offset=offset)
    redact = await must_redact_jobs(session, organization.id, user)
    return RunPresetList(
        presets=[_view(row, redact=redact) for row in page.presets], total=page.total, limit=limit, offset=offset,
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=RunPresetView,
    operation_id="createRunPreset",
    responses={
        201: {"headers": {"ETag": etags.ETAG_HEADER}},
        **_WEAK_ROLE,
        **_UNREADABLE,
        409: {**CONFLICT_RESPONSE, "description": "The slug is in use in this organization (`slug_conflict`)."},
        422: {"description": "A setting of the wrong shape (`invalid_request_fields`), located by its `pointer`."},
    },
)
async def create_run_preset(
    org: str,
    payload: RunPresetCreate,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> RunPresetView:
    """Name a set of run settings that runs of the organization can start from (MEMBER).

    Only their shape is checked here; the engine, the mode's options and the optimization are checked
    against the problem when a run uses the preset.
    """
    organization = await _writable(session, org, user)
    settings = presets.checked_settings(payload.model_dump(include=set(SETTINGS_FIELDS)))
    created = await presets.create_preset(
        session, organization, user, slug=payload.slug, name=payload.name, description=payload.description,
        settings=settings,
    )
    etags.set_etag(response, created)
    return _view(created, redact=False)


@router.get(
    "/{preset}",
    response_model=RunPresetView,
    operation_id="getRunPreset",
    responses={**etags.ETAG_RESPONSE, **_UNREADABLE},
)
async def get_run_preset(
    org: str,
    preset: str,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> RunPresetView:
    """One run preset, by slug or id."""
    organization = await _organization(session, org, user)
    found = await presets.required_preset(session, organization, preset)
    etags.set_etag(response, found)
    return _view(found, redact=await must_redact_jobs(session, organization.id, user))


@router.patch(
    "/{preset}",
    response_model=RunPresetView,
    operation_id="updateRunPreset",
    responses={**etags.EDIT_RESPONSES, **_WEAK_ROLE, **_UNREADABLE},
)
async def update_run_preset(
    org: str,
    preset: str,
    payload: RunPresetUpdate,
    response: Response,
    if_match: str | None = etags.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> RunPresetView:
    """Rename, describe or change the settings of a run preset (MEMBER); runs already started keep theirs."""
    organization = await _writable(session, org, user)
    found = await presets.required_preset(session, organization, preset)
    await etags.guard(session, found, if_match)
    changes = {key: getattr(payload, key) for key in payload.model_fields_set}
    updated = await presets.update_preset(session, found, user, changes)
    etags.set_etag(response, updated)
    return _view(updated, redact=False)


@router.delete(
    "/{preset}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteRunPreset",
    responses={**_WEAK_ROLE, **_UNREADABLE},
)
async def delete_run_preset(
    org: str,
    preset: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Delete a run preset (MEMBER); runs started from it keep the settings they copied."""
    organization = await _writable(session, org, user)
    found = await presets.required_preset(session, organization, preset)
    await presets.delete_preset(session, found, user)

"""The run presets of an organization: create, look up, list, edit and delete them, and expand one into a run.

A preset is a named set of run settings (engine, registration, mode, options, optimization) that
``createRun {revision, preset}`` starts from. The run copies the settings it expands and records the
preset it came from (``{id, slug}``), so editing or deleting a preset never changes a run, and nothing
refers to a preset once a run has started. A preset never enters a composition document.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Mapping

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.like import LIKE_ESCAPE, like_contains
from ....db.models import Organization, RunPreset, User
from ....models.errors import api_error
from ...shared.application import audit
from ..domain.presets import SETTINGS_FIELDS, PresetRef, PresetSettings, PresetShapeError
from ..domain.run_request import RunRequest

#: The audit target type of a run preset.
TARGET = "RunPreset"


class PresetNotFound(LookupError):
    """A run request names a preset its organization does not have."""


@dataclass(frozen=True)
class Page:
    """One page of an organization's presets, and how many match in all."""

    presets: list[RunPreset]
    total: int


def settings_of(preset: RunPreset) -> PresetSettings:
    """What a run started from ``preset`` runs with."""
    return PresetSettings(
        engine=preset.engine, registration=preset.registration, mode=preset.mode,
        options=dict(preset.options or {}), optimization=preset.optimization,
    )


def shape_refusal(error: PresetShapeError) -> HTTPException:
    """422 ``invalid_request_fields`` for a setting of the wrong shape, located by its pointer."""
    return api_error(
        422, "invalid_request_fields", error.message,
        diagnostics=[{"code": "invalid_request_fields", "message": error.message, "pointer": error.pointer}],
    )


def checked_settings(fields: Mapping[str, Any]) -> PresetSettings:
    """``PresetSettings.from_fields``, or its refusal as 422 ``invalid_request_fields``."""
    try:
        return PresetSettings.from_fields(fields)
    except PresetShapeError as error:
        raise shape_refusal(error) from error


# -- Lookup ----------------------------------------------------------------------------------------------


async def preset_by_ref(session: AsyncSession, organization_id: uuid.UUID, ref: str) -> RunPreset | None:
    """The organization's preset named by ``ref``: its slug, else its id."""
    found = await session.scalar(
        select(RunPreset).where(RunPreset.organization_id == organization_id, RunPreset.slug == ref)
    )
    if found is not None:
        return found
    try:
        parsed = uuid.UUID(ref)
    except ValueError:
        return None
    return await session.scalar(
        select(RunPreset).where(RunPreset.organization_id == organization_id, RunPreset.id == parsed)
    )


async def required_preset(session: AsyncSession, organization: Organization, ref: str) -> RunPreset:
    """``preset_by_ref``, or 404 ``not_found``."""
    found = await preset_by_ref(session, organization.id, ref)
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Run preset not found.")
    return found


async def expand(session: AsyncSession, request: RunRequest) -> RunRequest:
    """``request`` with the settings of the preset it names copied in; unchanged when it names none.

    The preset is looked up in the request's organization (the run's). ``PresetNotFound`` when it has none
    by that slug or id.
    """
    if request.preset_ref is None:
        return request
    preset = await preset_by_ref(session, request.organization_id, request.preset_ref)
    if preset is None:
        raise PresetNotFound(request.preset_ref)
    return request.with_preset(PresetRef(preset.id, preset.slug), settings_of(preset))


async def list_presets(
    session: AsyncSession, organization_id: uuid.UUID, *, q: str | None = None, limit: int = 50, offset: int = 0,
) -> Page:
    """The organization's presets by name, filtered by a text in the name or the slug."""
    query = select(RunPreset).where(RunPreset.organization_id == organization_id)
    if q:
        pattern = like_contains(q)
        query = query.where(or_(
            RunPreset.name.ilike(pattern, escape=LIKE_ESCAPE),
            RunPreset.slug.ilike(pattern, escape=LIKE_ESCAPE),
        ))
    total = int(await session.scalar(select(func.count()).select_from(query.subquery())) or 0)
    rows = (await session.scalars(query.order_by(RunPreset.name, RunPreset.slug).offset(offset).limit(limit))).all()
    return Page(list(rows), total)


# -- Writing ---------------------------------------------------------------------------------------------


def _slug_conflict() -> HTTPException:
    return api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That preset slug is in use in this organization.")


async def create_preset(
    session: AsyncSession,
    organization: Organization,
    actor: User,
    *,
    slug: str,
    name: str,
    description: str,
    settings: PresetSettings,
) -> RunPreset:
    """Insert a preset of ``organization`` and audit it; 409 ``slug_conflict`` when the slug is taken."""
    taken = await session.scalar(select(RunPreset.id).where(
        RunPreset.organization_id == organization.id, RunPreset.slug == slug,
    ).limit(1))
    if taken is not None:
        raise _slug_conflict()
    preset = RunPreset(
        organization_id=organization.id, slug=slug, name=name, description=description,
        created_by_id=actor.id, **settings.as_fields(),
    )
    try:
        async with session.begin_nested():
            session.add(preset)
            await session.flush()
    except IntegrityError as exc:
        # A concurrent create took the slug between the check and the insert.
        raise _slug_conflict() from exc
    await session.refresh(preset, ["created_at", "updated_at"])
    audit(session, actor, "run_preset.created", TARGET, preset.id, organization.id, slug=slug)
    return preset


async def update_preset(
    session: AsyncSession, preset: RunPreset, actor: User, changes: Mapping[str, Any],
) -> RunPreset:
    """Apply ``changes`` (``name``, ``description`` and the settings) to ``preset``.

    The settings that result are checked as a whole (422 ``invalid_request_fields``) before anything is
    written. The caller has already checked ``If-Match``.
    """
    merged = {**settings_of(preset).as_fields(), **{key: changes[key] for key in SETTINGS_FIELDS if key in changes}}
    settings = checked_settings(merged)
    changed: dict[str, Any] = {}
    for key in ("name", "description"):
        if key in changes and changes[key] is not None and changes[key] != getattr(preset, key):
            setattr(preset, key, changes[key])
            changed[key] = changes[key] if key == "name" else True
    for key, value in settings.as_fields().items():
        if value != getattr(preset, key):
            setattr(preset, key, value)
            changed[key] = True
    await session.flush()
    await session.refresh(preset, ["updated_at"])
    if changed:
        audit(session, actor, "run_preset.updated", TARGET, preset.id, preset.organization_id, **changed)
    return preset


async def delete_preset(session: AsyncSession, preset: RunPreset, actor: User) -> None:
    """Delete ``preset``; the runs started from it keep the settings they copied."""
    audit(session, actor, "run_preset.deleted", TARGET, preset.id, preset.organization_id, slug=preset.slug)
    await session.delete(preset)
    await session.flush()

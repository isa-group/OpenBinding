"""Compositions of an organization: create, look up, list, edit and delete them.

A composition is the entity its versions will belong to (slug unique within the organization, name,
description, ``kind``, ``archived``). An empty one, with no version yet, is a valid state: the editor's
starting point and a derivation's target.

Who may read it follows SPHERE's private read rule: a composition the caller cannot read answers exactly as
a missing one does, 404 and never 403, so that a non-member learns nothing of the organization or of what it
holds. A member whose role is too weak for a write gets 403, since that member can read it
(``organization_for``).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ....collaboration import ROLE_STRENGTH, effective_role, organization_by_ref
from ....core.like import LIKE_ESCAPE, like_contains
from ....db.models import Composition, CompositionKind, Organization, OrganizationRole, User
from ....models.errors import api_error
from ....services.entitlements import entitlement_service
from ...plans.application import entitlement_map as ids
from ...shared.application import audit

#: The audit target type of a composition.
TARGET = "Composition"


@dataclass(frozen=True)
class Page:
    """One page of an organization's compositions, and how many match in all."""

    compositions: list[Composition]
    total: int


# -- Access ----------------------------------------------------------------------------------------------


def _not_found() -> HTTPException:
    return api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")


async def organization_for(session: AsyncSession, org: str, user: User, minimum: OrganizationRole) -> Organization:
    """The organization named by ``org``, for a caller who needs ``minimum`` there.

    404 ``not_found`` when there is no such organization **or the caller cannot read it** (no role in it or
    above it): an unreadable composition answers as a missing one. 403 ``organization_forbidden`` when the
    caller reads it but ``minimum`` is a stronger role than the caller's.
    """
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise _not_found()
    role = await effective_role(session, organization.id, user)
    if role is None:
        raise _not_found()
    if ROLE_STRENGTH[role] < ROLE_STRENGTH[minimum]:
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "organization_forbidden",
            f"This action requires {minimum.value} access to the organization.",
        )
    return organization


async def composition_by_ref(session: AsyncSession, organization_id: uuid.UUID, ref: str) -> Composition | None:
    """The organization's composition named by ``ref``: its slug, else its id."""
    found = await session.scalar(
        select(Composition).where(Composition.organization_id == organization_id, Composition.slug == ref)
    )
    if found is not None:
        return found
    try:
        parsed = uuid.UUID(ref)
    except ValueError:
        return None
    return await session.scalar(
        select(Composition).where(Composition.organization_id == organization_id, Composition.id == parsed)
    )


async def required_composition(session: AsyncSession, organization: Organization, ref: str) -> Composition:
    """``composition_by_ref``, or 404 ``not_found``."""
    found = await composition_by_ref(session, organization.id, ref)
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Composition not found.")
    return found


# -- Listing ---------------------------------------------------------------------------------------------


async def list_compositions(
    session: AsyncSession,
    organization_id: uuid.UUID,
    *,
    kind: CompositionKind | None = None,
    q: str | None = None,
    archived: bool | None = None,
    limit: int = 50,
    offset: int = 0,
) -> Page:
    """The organization's compositions by name, filtered by kind, by a text in name or slug, and by archived."""
    query = select(Composition).where(Composition.organization_id == organization_id)
    if kind is not None:
        query = query.where(Composition.kind == kind)
    if archived is not None:
        query = query.where(Composition.archived.is_(archived))
    if q:
        pattern = like_contains(q)
        query = query.where(or_(
            Composition.name.ilike(pattern, escape=LIKE_ESCAPE),
            Composition.slug.ilike(pattern, escape=LIKE_ESCAPE),
        ))
    total = int(await session.scalar(select(func.count()).select_from(query.subquery())) or 0)
    rows = (await session.scalars(
        query.order_by(Composition.name, Composition.slug).offset(offset).limit(limit)
    )).all()
    return Page(list(rows), total)


# -- Writing ---------------------------------------------------------------------------------------------


def _slug_conflict() -> HTTPException:
    return api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That composition slug is in use in this organization.")


async def create_composition(
    session: AsyncSession,
    organization: Organization,
    actor: User,
    *,
    slug: str,
    name: str,
    description: str = "",
    kind: CompositionKind = CompositionKind.APPLICATION,
) -> Composition:
    """A new, empty composition of ``organization``.

    Needs the ``repository`` feature of the actor's plan (403 ``feature_not_entitled``): pricing 0.2.0 has no
    composition feature or limit of its own. 409 ``slug_conflict`` when the slug is taken.
    """
    caps = await entitlement_service.caps_or_503(actor.id)
    entitlement_service.require_feature(caps, ids.REPOSITORY)
    taken = await session.scalar(select(Composition.id).where(
        Composition.organization_id == organization.id, Composition.slug == slug,
    ).limit(1))
    if taken is not None:
        raise _slug_conflict()
    composition = Composition(
        organization_id=organization.id, slug=slug, name=name, description=description, kind=kind,
        created_by_id=actor.id,
    )
    try:
        async with session.begin_nested():
            session.add(composition)
            await session.flush()
    except IntegrityError as exc:
        # A concurrent create took the slug between the check and the insert.
        raise _slug_conflict() from exc
    await session.refresh(composition, ["created_at", "updated_at"])
    audit(session, actor, "composition.created", TARGET, composition.id, organization.id, slug=slug, kind=kind.value)
    return composition


async def update_composition(
    session: AsyncSession,
    composition: Composition,
    actor: User,
    *,
    name: str | None = None,
    description: str | None = None,
    archived: bool | None = None,
) -> Composition:
    """Change the given fields of ``composition``; the caller has already checked its ``If-Match``."""
    changed = {}
    if name is not None:
        composition.name = name
        changed["name"] = name
    if description is not None:
        composition.description = description
        changed["description"] = True
    if archived is not None:
        composition.archived = archived
        changed["archived"] = archived
    await session.flush()
    await session.refresh(composition, ["updated_at"])
    if changed:
        audit(session, actor, "composition.updated", TARGET, composition.id, composition.organization_id, **changed)
    return composition


async def delete_composition(session: AsyncSession, composition: Composition, actor: User) -> None:
    """Delete ``composition``."""
    audit(session, actor, "composition.deleted", TARGET, composition.id, composition.organization_id,
          slug=composition.slug)
    await session.delete(composition)
    await session.flush()

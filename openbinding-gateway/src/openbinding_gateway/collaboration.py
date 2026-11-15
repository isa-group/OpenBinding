"""Portable hierarchy/RBAC helpers shared by collaborative routes."""

from __future__ import annotations

import uuid
from typing import Iterable

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db.models import (
    Organization,
    OrganizationMembership,
    OrganizationRole,
    User,
)
from .models.errors import api_error

ROLE_STRENGTH = {
    OrganizationRole.VIEWER: 1,
    OrganizationRole.MEMBER: 2,
    OrganizationRole.ADMIN: 3,
    OrganizationRole.OWNER: 4,
}


async def organization_by_ref(session: AsyncSession, reference: str | uuid.UUID) -> Organization | None:
    if isinstance(reference, uuid.UUID):
        return await session.get(Organization, reference)
    try:
        parsed = uuid.UUID(str(reference))
    except ValueError:
        parsed = None
    query = select(Organization).where(
        Organization.id == parsed if parsed is not None else Organization.slug == str(reference)
    )
    return (await session.execute(query)).scalars().first()


async def ancestor_ids(session: AsyncSession, organization_id: uuid.UUID) -> list[uuid.UUID]:
    """The organization and each ancestor, implemented as one recursive query."""

    ancestors = (
        select(Organization.id.label("id"), Organization.parent_id.label("parent_id"))
        .where(Organization.id == organization_id)
        .cte(name="organization_ancestors", recursive=True)
    )
    ancestors = ancestors.union_all(
        select(Organization.id, Organization.parent_id).join(
            ancestors, Organization.id == ancestors.c.parent_id
        )
    )
    rows = await session.execute(select(ancestors.c.id))
    return list(rows.scalars().all())


async def descendant_ids(session: AsyncSession, organization_id: uuid.UUID) -> list[uuid.UUID]:
    descendants = (
        select(Organization.id.label("id"), Organization.parent_id.label("parent_id"))
        .where(Organization.id == organization_id)
        .cte(name="organization_descendants", recursive=True)
    )
    descendants = descendants.union_all(
        select(Organization.id, Organization.parent_id).join(
            descendants, Organization.parent_id == descendants.c.id
        )
    )
    rows = await session.execute(select(descendants.c.id))
    return list(rows.scalars().all())


async def effective_role(
    session: AsyncSession, organization_id: uuid.UUID, user: User
) -> OrganizationRole | None:
    ancestors = await ancestor_ids(session, organization_id)
    if not ancestors:
        return None
    roles = (
        await session.execute(
            select(OrganizationMembership.role).where(
                OrganizationMembership.organization_id.in_(ancestors),
                OrganizationMembership.user_id == user.id,
            )
        )
    ).scalars().all()
    return max(roles, key=ROLE_STRENGTH.get) if roles else None


async def require_role(
    session: AsyncSession,
    organization: Organization,
    user: User,
    minimum: OrganizationRole,
) -> OrganizationRole:
    role = await effective_role(session, organization.id, user)
    if role is None or ROLE_STRENGTH[role] < ROLE_STRENGTH[minimum]:
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "organization_forbidden",
            f"This action requires {minimum.value} access to the organization.",
        )
    return role


async def assert_acyclic_move(
    session: AsyncSession, organization_id: uuid.UUID, new_parent_id: uuid.UUID | None
) -> None:
    if new_parent_id is None:
        return
    if organization_id == new_parent_id:
        raise api_error(status.HTTP_409_CONFLICT, "organization_cycle", "An organization cannot parent itself.")
    descendants = await descendant_ids(session, organization_id)
    if new_parent_id in descendants:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "organization_cycle",
            "An organization cannot be moved below one of its descendants.",
        )


def strongest(roles: Iterable[OrganizationRole]) -> OrganizationRole | None:
    values = list(roles)
    return max(values, key=ROLE_STRENGTH.get) if values else None

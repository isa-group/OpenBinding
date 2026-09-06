"""Portable hierarchy/RBAC helpers shared by collaborative routes."""

from __future__ import annotations

import uuid
from typing import Iterable

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .db.models import (
    Artifact,
    Collection,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    Project,
    Study,
    User,
)
from .models.errors import api_error
from .space_client import PricingUnavailable, get_gate

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
    if user.is_admin:
        return OrganizationRole.OWNER
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


async def project_by_ref(
    session: AsyncSession, organization_id: uuid.UUID, reference: str | uuid.UUID
) -> Project | None:
    try:
        parsed = reference if isinstance(reference, uuid.UUID) else uuid.UUID(str(reference))
    except ValueError:
        parsed = None
    return (
        await session.execute(
            select(Project).where(
                Project.organization_id == organization_id,
                Project.id == parsed if parsed is not None else Project.slug == str(reference),
            )
        )
    ).scalars().first()


async def require_project(
    session: AsyncSession,
    organization: Organization,
    reference: str | uuid.UUID,
    user: User,
    minimum: OrganizationRole,
) -> Project:
    await require_role(session, organization, user, minimum)
    project = await project_by_ref(session, organization.id, reference)
    if project is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Project not found.")
    return project


async def organization_usage(
    session: AsyncSession, organization_ids: Iterable[uuid.UUID]
) -> dict[str, int]:
    """Structural usage for an exact set of sponsored organizations."""

    ids = tuple(set(organization_ids))
    if not ids:
        return {
            "organizations": 0,
            "members": 0,
            "projects": 0,
            "privateProjects": 0,
            "collections": 0,
            "studies": 0,
            "storageBytes": 0,
        }
    organizations = len(ids)
    members = int(
        await session.scalar(
            select(func.count(func.distinct(OrganizationMembership.user_id))).where(
                OrganizationMembership.organization_id.in_(ids)
            )
        )
        or 0
    )
    projects = int(
        await session.scalar(select(func.count(Project.id)).where(Project.organization_id.in_(ids)))
        or 0
    )
    private_projects = int(
        await session.scalar(
            select(func.count(Project.id)).where(
                Project.organization_id.in_(ids), Project.visibility == "private"
            )
        )
        or 0
    )
    project_ids = select(Project.id).where(Project.organization_id.in_(ids))
    collections = int(
        await session.scalar(select(func.count(Collection.id)).where(Collection.project_id.in_(project_ids)))
        or 0
    )
    studies = int(
        await session.scalar(select(func.count(Study.id)).where(Study.project_id.in_(project_ids)))
        or 0
    )
    storage_bytes = int(
        await session.scalar(
            select(func.coalesce(func.sum(Artifact.size_bytes), 0)).where(
                Artifact.organization_id.in_(ids)
            )
        )
        or 0
    )
    return {
        "organizations": organizations,
        "members": members,
        "projects": projects,
        "privateProjects": private_projects,
        "collections": collections,
        "studies": studies,
        "storageBytes": storage_bytes,
    }


async def sponsor_organization_ids(
    session: AsyncSession, sponsor_user_id: uuid.UUID
) -> list[uuid.UUID]:
    return list(
        (
            await session.execute(
                select(Organization.id).where(
                    Organization.billing_sponsor_user_id == sponsor_user_id
                )
            )
        ).scalars()
    )


async def sponsor_usage(session: AsyncSession, sponsor_user_id: uuid.UUID) -> dict[str, int]:
    return await organization_usage(
        session, await sponsor_organization_ids(session, sponsor_user_id)
    )


async def sponsor_has_member(
    session: AsyncSession, sponsor_user_id: uuid.UUID, user_id: uuid.UUID
) -> bool:
    return bool(
        await session.scalar(
            select(func.count(OrganizationMembership.id))
            .join(Organization, Organization.id == OrganizationMembership.organization_id)
            .where(
                Organization.billing_sponsor_user_id == sponsor_user_id,
                OrganizationMembership.user_id == user_id,
            )
        )
    )


async def enforce_sponsor_usage(
    session: AsyncSession, sponsor: User, usage: dict[str, int]
) -> None:
    """Validate a complete hypothetical sponsor total in one contract read."""

    try:
        caps = await get_gate().caps(sponsor.id)
    except PricingUnavailable as exc:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)
        ) from exc
    for dimension, used in usage.items():
        allowance = caps.limit(dimension)
        if allowance is None:
            continue
        limit = int(allowance)
        if used > limit:
            raise api_error(
                status.HTTP_402_PAYMENT_REQUIRED,
                "sponsor_quota_exceeded",
                f"The sponsor contract allows {limit} {dimension}; this operation would exceed it.",
                quota={"limit_id": dimension, "limit": limit, "used": used},
            )


async def enforce_sponsor_capacity(
    session: AsyncSession,
    sponsor: User,
    dimension: str,
    *,
    increment: int = 1,
) -> None:
    # Every structural quota mutation for one sponsor serializes on the same
    # row.  Without this lock two concurrent creates can both observe one free
    # slot and commit past the contract limit.
    await session.execute(
        select(User.id).where(User.id == sponsor.id).with_for_update()
    )
    usage = await sponsor_usage(session, sponsor.id)
    usage[dimension] += increment
    await enforce_sponsor_usage(session, sponsor, {dimension: usage[dimension]})


def strongest(roles: Iterable[OrganizationRole]) -> OrganizationRole | None:
    values = list(roles)
    return max(values, key=ROLE_STRENGTH.get) if values else None

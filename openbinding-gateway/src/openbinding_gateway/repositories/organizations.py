"""Organization, membership, project and invitation queries; callers decide who may see or change what."""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    AuditEvent,
    Organization,
    OrganizationInvitation,
    OrganizationMembership,
    OrganizationRole,
    Project,
)


async def list_all(session: AsyncSession) -> list[Organization]:
    """Every organization by name; the caller keeps those its user holds a role in."""
    rows = await session.execute(select(Organization).order_by(Organization.name))
    return list(rows.scalars().all())


async def get_membership(
    session: AsyncSession, organization_id: uuid.UUID, user_id: uuid.UUID
) -> OrganizationMembership | None:
    """The direct membership of a user in one organization (no inheritance from ancestors)."""
    return (
        await session.execute(
            select(OrganizationMembership).where(
                OrganizationMembership.organization_id == organization_id,
                OrganizationMembership.user_id == user_id,
            )
        )
    ).scalars().first()


async def list_members(session: AsyncSession, organization_id: uuid.UUID) -> list[OrganizationMembership]:
    """The direct memberships of an organization, oldest first."""
    rows = await session.execute(
        select(OrganizationMembership)
        .where(OrganizationMembership.organization_id == organization_id)
        .order_by(OrganizationMembership.created_at)
    )
    return list(rows.scalars().all())


async def lock_members(session: AsyncSession, organization_id: uuid.UUID) -> list[OrganizationMembership]:
    """The direct memberships of an organization, locked for the rest of the transaction."""
    rows = await session.execute(
        select(OrganizationMembership)
        .where(OrganizationMembership.organization_id == organization_id)
        .with_for_update()
    )
    return list(rows.scalars().all())


async def count_owners(session: AsyncSession, organization_id: uuid.UUID) -> int:
    owners = await session.scalar(
        select(func.count(OrganizationMembership.id)).where(
            OrganizationMembership.organization_id == organization_id,
            OrganizationMembership.role == OrganizationRole.OWNER,
        )
    )
    return int(owners or 0)


async def list_projects(
    session: AsyncSession, organization_id: uuid.UUID, *, ordered: bool = True
) -> list[Project]:
    """Every project of one organization, whatever its visibility; the caller has checked access."""
    query = select(Project).where(Project.organization_id == organization_id)
    if ordered:
        query = query.order_by(Project.name)
    return list((await session.execute(query)).scalars().all())


async def project_slug_in_use(session: AsyncSession, organization_id: uuid.UUID, slug: str) -> bool:
    count = await session.scalar(
        select(func.count(Project.id)).where(Project.organization_id == organization_id, Project.slug == slug)
    )
    return bool(count)


async def find_invitation_by_prefix(session: AsyncSession, token_prefix: str) -> OrganizationInvitation | None:
    return (
        await session.execute(
            select(OrganizationInvitation).where(OrganizationInvitation.token_prefix == token_prefix)
        )
    ).scalars().first()


def _audit_conditions(organization_id: uuid.UUID, action: str | None) -> list:
    conditions = [AuditEvent.organization_id == organization_id]
    if action:
        conditions.append(AuditEvent.action == action)
    return conditions


async def count_audit_events(
    session: AsyncSession, organization_id: uuid.UUID, *, action: str | None = None
) -> int:
    total = await session.scalar(
        select(func.count(AuditEvent.id)).where(*_audit_conditions(organization_id, action))
    )
    return int(total or 0)


async def list_audit_events(
    session: AsyncSession,
    organization_id: uuid.UUID,
    *,
    action: str | None = None,
    offset: int = 0,
    limit: int = 100,
) -> list[AuditEvent]:
    rows = await session.execute(
        select(AuditEvent)
        .where(*_audit_conditions(organization_id, action))
        .order_by(AuditEvent.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    return list(rows.scalars().all())

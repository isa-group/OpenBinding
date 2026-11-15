"""The audit log of an organization: one ``audit_events`` row per change a member makes."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import AuditEvent, User


def audit(
    session: AsyncSession,
    actor: User,
    action: str,
    target_type: str,
    target_id: uuid.UUID,
    organization_id: uuid.UUID,
    **detail: Any,
) -> None:
    """Add the audit event of ``actor``'s ``action`` on a target of ``organization_id`` to the transaction."""
    session.add(AuditEvent(
        organization_id=organization_id, actor_id=actor.id, action=action,
        target_type=target_type, target_id=target_id, detail=detail,
    ))

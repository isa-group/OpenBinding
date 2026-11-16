"""The inbox: one ``notifications`` row per thing a user is told, written in the transaction that caused it."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import Notification

#: What a notification is about, as SPHERE's notification kinds; ``UpstreamEvent`` arrives in F6.
ORGANIZATION_INVITATION = "OrganizationInvitation"
SYSTEM = "System"
COMPOSITION_UPDATED = "CompositionUpdated"
RUN_FINISHED = "RunFinished"
RUN_FAILED = "RunFailed"
KINDS = (ORGANIZATION_INVITATION, SYSTEM, COMPOSITION_UPDATED, RUN_FINISHED, RUN_FAILED)


def notify(
    session: AsyncSession,
    user_id: uuid.UUID,
    kind: str,
    subject: str,
    body: str,
    **payload: Any,
) -> Notification:
    """Add a notification of ``kind`` for ``user_id`` to the transaction."""
    row = Notification(user_id=user_id, kind=kind, subject=subject[:240], body=body[:4000], payload=payload)
    session.add(row)
    return row

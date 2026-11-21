"""The inbox: one ``notifications`` row per thing a user is told, written in the transaction that caused it.

Adapted from SPHERE (SCORELabUS/SPHERE, MIT licence, revision 73779a8a), ``api/src/main/services/
NotificationService.ts``: the kinds, and the per-kind channels a user turns off (missing preferences are "on").
A notification is stored only when the user keeps the inbox on, globally and for its kind. SPHERE pushes the new
notification to a stream held in its process; here the stream reads what was committed (``routes/
notifications.py``), so every replica serves it and nothing rolled back is ever shown. No email is sent yet.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import Notification, User, utcnow

#: What a notification is about, as SPHERE's notification kinds.
ORGANIZATION_INVITATION = "OrganizationInvitation"
SYSTEM = "System"
COMPOSITION_UPDATED = "CompositionUpdated"
RUN_FINISHED = "RunFinished"
RUN_FAILED = "RunFailed"
#: A version was adopted in a composition environment (F4): told to its operator and the composition's followers.
COMPOSITION_ADOPTED = "CompositionAdopted"
#: A pricing a live composition version reads changed upstream (F6): told to the members who can act.
UPSTREAM_EVENT = "UpstreamEvent"
KINDS = (ORGANIZATION_INVITATION, SYSTEM, COMPOSITION_UPDATED, RUN_FINISHED, RUN_FAILED, COMPOSITION_ADOPTED,
         UPSTREAM_EVENT)
#: The channels a user chooses per kind.
CHANNELS = ("inbox", "email")
#: The channels a kind starts with when the user chose nothing for it: both on, unless listed here.
DEFAULT_CHANNELS: dict[str, dict[str, bool]] = {
    COMPOSITION_ADOPTED: {"inbox": True, "email": False},
    UPSTREAM_EVENT: {"inbox": True, "email": False},
}


def default_channels(kind: str) -> dict[str, bool]:
    """What ``kind`` reaches before the user chooses: inbox and email on, except where ``DEFAULT_CHANNELS`` says."""
    return {"inbox": True, "email": True, **DEFAULT_CHANNELS.get(kind, {})}

#: How long the inbox keeps a notification.
RETENTION_DAYS = 7


def channels(preferences: dict[str, Any] | None, kind: str) -> dict[str, bool]:
    """Whether ``kind`` reaches the inbox and the email of a user with these preferences: on unless turned off,
    and the inbox off altogether when the account's ``inbox`` preference is off."""
    preferences = preferences or {}
    chosen = (preferences.get("kinds") or {}).get(kind) or {}
    default = default_channels(kind)
    return {
        "inbox": preferences.get("inbox", True) is not False and chosen.get("inbox", default["inbox"]) is not False,
        "email": chosen.get("email", default["email"]) is not False,
    }


async def notify(
    session: AsyncSession,
    user_id: uuid.UUID,
    kind: str,
    subject: str,
    body: str,
    **payload: Any,
) -> Notification | None:
    """Add a notification of ``kind`` for ``user_id`` to the transaction, unless the user turned its inbox off
    (or is gone); returns it, or ``None``."""
    user = await session.get(User, user_id)
    if user is None or not channels(user.preferences, kind)["inbox"]:
        return None
    row = Notification(user_id=user_id, kind=kind, subject=subject[:240], body=body[:4000], payload=payload)
    session.add(row)
    return row


def retention_cutoff():
    return utcnow() - timedelta(days=RETENTION_DAYS)


async def unread_count(session: AsyncSession, user_id: uuid.UUID) -> int:
    """How many notifications of the inbox ``user_id`` has not read."""
    return int(await session.scalar(
        select(func.count(Notification.id)).where(
            Notification.user_id == user_id,
            Notification.read_at.is_(None),
            Notification.created_at >= retention_cutoff(),
        )
    ) or 0)

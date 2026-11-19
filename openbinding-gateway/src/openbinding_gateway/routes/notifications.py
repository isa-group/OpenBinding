"""An account inbox with explicit read state, preferences per kind and channel, and a live stream.

The kinds, the unread count, deleting one, and the stream with its ``connected``, ``notification`` and
``unread-count`` events are adapted from SPHERE (SCORELabUS/SPHERE, MIT licence, revision 73779a8a),
``api/src/main/controllers/NotificationController.ts`` and ``routes/NotificationRoutes.ts``. Two of its defects
are not copied: the stream takes a single-use ticket, never an access token in its URL, and a user deletes only
their own notifications.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import AsyncIterator, Literal, Optional

from fastapi import APIRouter, Depends, Query, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, session_dependency
from ..core.settings import get_settings
from ..modules.identity.application import session_still_valid
from ..core import revision
from ..db import base as db_base
from ..db.models import Notification, NotificationStreamTicket, User, utcnow
from ..models.errors import ErrorResponse, api_error
from ..models.platform import NotificationView
from ..modules.shared.application import (
    NOTIFICATION_KINDS,
    NOTIFICATION_RETENTION_DAYS,
    default_channels,
    retention_cutoff,
    unread_count,
)

router = APIRouter(prefix="/v1/notifications", tags=["Notifications"])

NOTIFICATION_RETENTION_DAYS = NOTIFICATION_RETENTION_DAYS
NotificationKind = Literal[
    "OrganizationInvitation", "System", "CompositionUpdated", "RunFinished", "RunFailed", "CompositionAdopted",
]

#: How long a stream ticket may wait to be used.
TICKET_SECONDS = 60
#: How long one stream stays open before the client reconnects with a new ticket, how often it reads the
#: inbox, and how often it says it is still there when nothing changed.
STREAM_SECONDS = 15 * 60.0
POLL_SECONDS = 2.0
#: How often an open stream checks that its account and browser session are still good.
SESSION_CHECK_SECONDS = 30.0
KEEPALIVE_SECONDS = 15.0
#: The reconnection delay an ``EventSource`` is told to use.
RETRY_MS = 5000


class KindChannels(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inbox: bool = True
    email: bool = True


class NotificationPreferences(BaseModel):
    model_config = ConfigDict(extra="ignore")
    inbox: bool = True
    email_contract_changes: bool = True
    email_invitations: bool = True
    email_job_failures: bool = False
    #: The channels of each kind, as SPHERE's ``notificationPrefs``; a kind left out has both on.
    kinds: dict[str, KindChannels] = Field(default_factory=dict)

    @field_validator("kinds")
    @classmethod
    def known_kinds(cls, value: dict[str, KindChannels]) -> dict[str, KindChannels]:
        unknown = sorted(set(value) - set(NOTIFICATION_KINDS))
        if unknown:
            raise ValueError(f"unknown notification kinds: {', '.join(unknown)}")
        return value


class UnreadCount(BaseModel):
    count: int


class StreamTicket(BaseModel):
    ticket: str = Field(description="Open `GET /v1/notifications/stream?ticket=` with it, once, before it expires.")
    expires_at: datetime


def _view(row: Notification) -> NotificationView:
    return NotificationView.model_validate(row, from_attributes=True)


async def _prune(session: AsyncSession, user: User) -> None:
    await session.execute(
        delete(Notification).where(
            Notification.user_id == user.id,
            Notification.created_at < retention_cutoff(),
        ).execution_options(synchronize_session=False)
    )


@router.get("", response_model=list[NotificationView], operation_id="listNotifications")
async def list_notifications(
    unread_only: bool = False,
    kind: Optional[NotificationKind] = Query(default=None, description="Only notifications of this kind."),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=200),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[NotificationView]:
    """The inbox of the last seven days, the newest first; older notifications are deleted as it is read."""
    await _prune(session, user)
    query = select(Notification).where(
        Notification.user_id == user.id,
        Notification.created_at >= retention_cutoff(),
    )
    if unread_only:
        query = query.where(Notification.read_at.is_(None))
    if kind is not None:
        query = query.where(Notification.kind == kind)
    rows = (await session.execute(
        query.order_by(Notification.created_at.desc(), Notification.id).offset(offset).limit(limit)
    )).scalars().all()
    return [_view(row) for row in rows]


@router.get("/unread-count", response_model=UnreadCount, operation_id="countUnreadNotifications")
async def count_unread_notifications(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> UnreadCount:
    """How many notifications of the inbox the caller has not read (the header bell's badge)."""
    return UnreadCount(count=await unread_count(session, user.id))


@router.post("/read-all", response_model=list[NotificationView], operation_id="readAllNotifications")
async def mark_all_notifications_read(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[NotificationView]:
    await _prune(session, user)
    query = select(Notification).where(
        Notification.user_id == user.id,
        Notification.read_at.is_(None),
        Notification.created_at >= retention_cutoff(),
    )
    rows = (await session.execute(query)).scalars().all()
    now = utcnow()
    for row in rows:
        row.read_at = now
    return [_view(row) for row in rows]


@router.post(
    "/stream-ticket",
    response_model=StreamTicket,
    status_code=status.HTTP_201_CREATED,
    operation_id="createNotificationStreamTicket",
)
async def create_stream_ticket(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StreamTicket:
    """A single-use ticket for the caller's notification stream, valid one minute. The stream is opened with the
    ticket in its URL because an ``EventSource`` sends no ``Authorization`` header; the access token never is."""
    now = utcnow()
    await session.execute(
        delete(NotificationStreamTicket).where(
            NotificationStreamTicket.user_id == user.id, NotificationStreamTicket.expires_at < now,
        ).execution_options(synchronize_session=False)
    )
    ticket = f"obt_{secrets.token_urlsafe(32)}"
    expires_at = now + timedelta(seconds=TICKET_SECONDS)
    session.add(NotificationStreamTicket(
        user_id=user.id, ticket_hash=hashlib.sha256(ticket.encode()).hexdigest(), expires_at=expires_at,
        # The browser session that bought it: the stream ends with that session (null for an API key).
        session_id=getattr(user, "_identity_session_id", None),
    ))
    await session.flush()
    return StreamTicket(ticket=ticket, expires_at=expires_at)


async def _redeem(session: AsyncSession, ticket: str) -> tuple[uuid.UUID, uuid.UUID | None] | None:
    """The user (and browser session) a ticket was minted for, deleting it; ``None`` when unknown, used, expired,
    or bought by a session that has ended since."""
    row = await session.scalar(
        select(NotificationStreamTicket).where(
            NotificationStreamTicket.ticket_hash == hashlib.sha256(ticket.encode()).hexdigest()
        ).with_for_update()
    )
    if row is None:
        return None
    await session.delete(row)
    await session.flush()
    expires = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=utcnow().tzinfo)
    if expires <= utcnow():
        return None
    if not await session_still_valid(session, row.user_id, row.session_id, settings=get_settings()):
        return None
    return row.user_id, row.session_id


@asynccontextmanager
async def _open_session() -> AsyncIterator[AsyncSession]:
    """A short session for one read of the inbox; the stream holds no connection between reads."""
    async with db_base.session_factory()() as session:
        yield session


async def _pause(seconds: float) -> None:
    await asyncio.sleep(seconds)


def _event(name: str, data: dict) -> str:
    return f"event: {name}\ndata: {json.dumps(data, default=str, separators=(',', ':'))}\n\n"


async def _events(user_id: uuid.UUID, session_id: uuid.UUID | None = None) -> AsyncIterator[str]:
    """The stream: ``connected``, the unread count, then each committed notification and each new count.

    It reads the inbox every ``POLL_SECONDS`` rather than being pushed to, so any replica serves any user and
    only committed notifications are shown. It ends after ``STREAM_SECONDS``; the client reconnects. Every
    ``SESSION_CHECK_SECONDS`` it checks that the account is active and the browser session that opened it still
    live, and ends with ``event: session-ended`` when not (a sign-out ends the stream too).
    """
    yield f"retry: {RETRY_MS}\n\n" + _event("connected", {"userId": str(user_id)})
    since = utcnow() - timedelta(seconds=1)
    seen: set[uuid.UUID] = set()
    async with _open_session() as session:
        count = await unread_count(session, user_id)
    yield _event("unread-count", {"count": count})
    deadline = time.monotonic() + STREAM_SECONDS
    quiet_since = time.monotonic()
    checked_at = time.monotonic()
    while time.monotonic() < deadline:
        await _pause(POLL_SECONDS)
        if time.monotonic() - checked_at >= SESSION_CHECK_SECONDS:
            checked_at = time.monotonic()
            async with _open_session() as session:
                valid = await session_still_valid(session, user_id, session_id, settings=get_settings())
            if not valid:
                yield _event("session-ended", {})
                return
        async with _open_session() as session:
            rows = (await session.scalars(
                select(Notification).where(Notification.user_id == user_id, Notification.created_at >= since)
                .order_by(Notification.created_at, Notification.id)
            )).all()
            fresh = [row for row in rows if row.id not in seen]
            current = await unread_count(session, user_id)
        for row in fresh:
            seen.add(row.id)
            yield _event("notification", _view(row).model_dump(mode="json"))
        changed = current != count
        if changed:
            count = current
            yield _event("unread-count", {"count": count})
        if fresh or changed:
            quiet_since = time.monotonic()
        elif time.monotonic() - quiet_since >= KEEPALIVE_SECONDS:
            quiet_since = time.monotonic()
            yield ": keep-alive\n\n"


@router.get(
    "/stream",
    operation_id="streamNotifications",
    response_class=StreamingResponse,
    responses={
        200: {
            "description": "Server-sent events: `connected`, `unread-count` (`{count}`) and `notification` (a "
            "notification view). The stream ends after fifteen minutes; reconnect with a new ticket.",
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        },
        401: {"model": ErrorResponse, "description": "`invalid_ticket`: unknown, used or expired."},
    },
)
async def stream_notifications(
    ticket: str = Query(..., min_length=20, max_length=128, description="A ticket of `POST /stream-ticket`."),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StreamingResponse:
    """The caller's notifications as they arrive, as SPHERE's notification stream, opened with a single-use
    ticket instead of an access token in the URL."""
    redeemed = await _redeem(session, ticket)
    if redeemed is None:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "invalid_ticket", "The stream ticket is unknown, used or expired.")
    user_id, session_id = redeemed
    return StreamingResponse(
        _events(user_id, session_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{notification_id}/read", response_model=NotificationView, operation_id="readNotification")
async def mark_notification_read(
    notification_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> NotificationView:
    cutoff = retention_cutoff()
    row = await session.get(Notification, notification_id)
    if row is None or row.user_id != user.id or row.created_at < cutoff:
        if row and row.created_at < cutoff:
            await session.delete(row)
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Notification not found.")
    row.read_at = row.read_at or utcnow()
    return _view(row)


@router.delete(
    "/{notification_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteNotification",
    responses={404: {"model": ErrorResponse, "description": "No such notification of the caller's."}},
)
async def delete_notification(
    notification_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Delete one of the caller's notifications; anybody else's is 404."""
    row = await session.get(Notification, notification_id)
    if row is None or row.user_id != user.id:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Notification not found.")
    await session.delete(row)


def _with_every_kind(preferences: NotificationPreferences) -> NotificationPreferences:
    kinds = {kind: preferences.kinds.get(kind, KindChannels(**default_channels(kind))) for kind in NOTIFICATION_KINDS}
    return preferences.model_copy(update={"kinds": kinds})


@router.get(
    "/preferences",
    response_model=NotificationPreferences,
    operation_id="getNotificationPreferences",
    responses=revision.ETAG_RESPONSE,
)
async def get_preferences(response: Response, user: User = Depends(get_current_user)) -> NotificationPreferences:
    """The account's notification preferences, every kind's channels included."""
    # The revision is the account row's, shared with PATCH /v1/users/me.
    revision.set_etag(response, user)
    return _with_every_kind(NotificationPreferences(**(user.preferences or {})))


@router.put(
    "/preferences",
    response_model=NotificationPreferences,
    operation_id="updateNotificationPreferences",
    responses=revision.EDIT_RESPONSES,
)
async def update_preferences(
    payload: NotificationPreferences,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    if_match: str | None = revision.IF_MATCH_HEADER,
) -> NotificationPreferences:
    await revision.guard(session, user, if_match)
    current = dict(user.preferences or {})
    # A body without ``kinds`` keeps the channels chosen per kind.
    current.update(payload.model_dump(exclude={"kinds"} if "kinds" not in payload.model_fields_set else None))
    user.preferences = current
    await session.flush()
    await session.refresh(user, ["updated_at"])
    revision.set_etag(response, user)
    return _with_every_kind(NotificationPreferences(**current))

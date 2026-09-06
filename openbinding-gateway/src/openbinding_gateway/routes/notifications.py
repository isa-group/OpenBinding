"""An account inbox with explicit read state and lightweight preferences."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, session_dependency
from ..db.models import Notification, User, utcnow
from ..models.errors import api_error
from ..models.platform import NotificationView

router = APIRouter(prefix="/v1/notifications", tags=["Notifications"])


class NotificationPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inbox: bool = True
    email_contract_changes: bool = True
    email_invitations: bool = True
    email_job_failures: bool = False


def _view(row: Notification) -> NotificationView:
    return NotificationView.model_validate(row, from_attributes=True)


@router.get("", response_model=list[NotificationView], operation_id="listNotifications")
async def list_notifications(
    unread_only: bool = False,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[NotificationView]:
    query = select(Notification).where(Notification.user_id == user.id)
    if unread_only:
        query = query.where(Notification.read_at.is_(None))
    rows = (await session.execute(query.order_by(Notification.created_at.desc()).limit(200))).scalars().all()
    return [_view(row) for row in rows]


@router.post("/{notification_id}/read", response_model=NotificationView, operation_id="readNotification")
async def mark_notification_read(
    notification_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> NotificationView:
    row = await session.get(Notification, notification_id)
    if row is None or row.user_id != user.id:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Notification not found.")
    row.read_at = row.read_at or utcnow()
    return _view(row)


@router.get("/preferences", response_model=NotificationPreferences, operation_id="getNotificationPreferences")
async def get_preferences(user: User = Depends(get_current_user)) -> NotificationPreferences:
    return NotificationPreferences(**(user.preferences or {}))


@router.put("/preferences", response_model=NotificationPreferences, operation_id="updateNotificationPreferences")
async def update_preferences(
    payload: NotificationPreferences,
    user: User = Depends(get_current_user),
) -> NotificationPreferences:
    user.preferences = payload.model_dump()
    return payload

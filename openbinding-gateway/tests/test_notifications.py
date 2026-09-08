"""Tests for notification inbox, retention, and read status management."""

from __future__ import annotations

from datetime import timedelta
import uuid

from sqlalchemy import select

from openbinding_gateway.db.models import Notification, utcnow


async def register_and_login(client, details: dict) -> tuple[dict, dict]:
    reg_resp = await client.post("/v1/auth/register", json=details)
    assert reg_resp.status_code == 201, reg_resp.text
    profile = reg_resp.json()

    login_resp = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login_resp.status_code == 200, login_resp.text
    token = login_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    return profile, headers


async def test_notifications_within_seven_days_are_returned_and_older_are_pruned(
    api_client, registration, db_session
):
    details = registration()
    profile, headers = await register_and_login(api_client, details)
    user_id = uuid.UUID(profile["id"])

    now = utcnow()
    # Notification 2 days old (valid, should be kept)
    notif_recent = Notification(
        user_id=user_id,
        kind="info",
        subject="Recent notification",
        body="This is 2 days old.",
        created_at=now - timedelta(days=2),
    )
    # Notification 6 days old (valid, should be kept)
    notif_six_days = Notification(
        user_id=user_id,
        kind="info",
        subject="Six days old",
        body="This is 6 days old.",
        created_at=now - timedelta(days=6),
    )
    # Notification 8 days old (expired, should be pruned)
    notif_expired = Notification(
        user_id=user_id,
        kind="info",
        subject="Expired notification",
        body="This is 8 days old.",
        created_at=now - timedelta(days=8),
    )

    db_session.add_all([notif_recent, notif_six_days, notif_expired])
    await db_session.commit()

    # Request notifications list
    resp = await api_client.get("/v1/notifications", headers=headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()

    subjects = [item["subject"] for item in data]
    assert "Recent notification" in subjects
    assert "Six days old" in subjects
    assert "Expired notification" not in subjects
    assert len(data) == 2

    # Verify expired notification was pruned from the database
    remaining = (
        await db_session.execute(
            select(Notification).where(Notification.user_id == user_id)
        )
    ).scalars().all()
    remaining_subjects = [item.subject for item in remaining]
    assert "Expired notification" not in remaining_subjects
    assert len(remaining) == 2


async def test_notifications_unread_only_filter(api_client, registration, db_session):
    details = registration()
    profile, headers = await register_and_login(api_client, details)
    user_id = uuid.UUID(profile["id"])

    now = utcnow()
    unread_notif = Notification(
        user_id=user_id,
        kind="info",
        subject="Unread message",
        body="Please read me.",
        read_at=None,
        created_at=now - timedelta(days=1),
    )
    read_notif = Notification(
        user_id=user_id,
        kind="info",
        subject="Already read message",
        body="I was read.",
        read_at=now - timedelta(hours=5),
        created_at=now - timedelta(days=1),
    )

    db_session.add_all([unread_notif, read_notif])
    await db_session.commit()

    # unread_only=false
    resp_all = await api_client.get("/v1/notifications", headers=headers)
    assert resp_all.status_code == 200
    assert len(resp_all.json()) == 2

    # unread_only=true
    resp_unread = await api_client.get("/v1/notifications?unread_only=true", headers=headers)
    assert resp_unread.status_code == 200
    unread_data = resp_unread.json()
    assert len(unread_data) == 1
    assert unread_data[0]["subject"] == "Unread message"


async def test_mark_individual_notification_as_read(api_client, registration, db_session):
    details = registration()
    profile, headers = await register_and_login(api_client, details)
    user_id = uuid.UUID(profile["id"])

    notif = Notification(
        user_id=user_id,
        kind="alert",
        subject="System update",
        body="Update available",
        read_at=None,
        created_at=utcnow() - timedelta(hours=2),
    )
    db_session.add(notif)
    await db_session.commit()

    resp = await api_client.post(f"/v1/notifications/{notif.id}/read", headers=headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["id"] == str(notif.id)
    assert data["read_at"] is not None


async def test_mark_all_notifications_read(api_client, registration, db_session):
    details = registration()
    profile, headers = await register_and_login(api_client, details)
    user_id = uuid.UUID(profile["id"])

    now = utcnow()
    notif1 = Notification(
        user_id=user_id,
        kind="alert",
        subject="Unread 1",
        body="Message 1",
        read_at=None,
        created_at=now - timedelta(hours=3),
    )
    notif2 = Notification(
        user_id=user_id,
        kind="alert",
        subject="Unread 2",
        body="Message 2",
        read_at=None,
        created_at=now - timedelta(hours=1),
    )
    notif_already_read = Notification(
        user_id=user_id,
        kind="alert",
        subject="Already Read",
        body="Message 3",
        read_at=now - timedelta(hours=4),
        created_at=now - timedelta(hours=5),
    )

    db_session.add_all([notif1, notif2, notif_already_read])
    await db_session.commit()

    resp = await api_client.post("/v1/notifications/read-all", headers=headers)
    assert resp.status_code == 200, resp.text
    updated = resp.json()
    assert len(updated) == 2
    for item in updated:
        assert item["read_at"] is not None

    # Check unread count is now 0
    resp_unread = await api_client.get("/v1/notifications?unread_only=true", headers=headers)
    assert resp_unread.status_code == 200
    assert len(resp_unread.json()) == 0


async def test_expired_notification_cannot_be_marked_read(api_client, registration, db_session):
    details = registration()
    profile, headers = await register_and_login(api_client, details)
    user_id = uuid.UUID(profile["id"])

    expired_notif = Notification(
        user_id=user_id,
        kind="info",
        subject="Very old notification",
        body="More than 7 days old.",
        read_at=None,
        created_at=utcnow() - timedelta(days=10),
    )
    db_session.add(expired_notif)
    await db_session.commit()

    resp = await api_client.post(f"/v1/notifications/{expired_notif.id}/read", headers=headers)
    assert resp.status_code == 404

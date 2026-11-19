"""Notification kinds, the unread count, deleting, preferences per kind, the ticketed stream and beta features
(F2c G5).

As SPHERE's inbox: notifications have a kind (OrganizationInvitation, System, CompositionUpdated, RunFinished,
RunFailed), the inbox is filtered by kind and paged, the bell reads the unread count, and a user deletes their own
notifications (anybody else's is 404). A user turns a kind's inbox off and its notifications are not stored. The
live stream is opened with a single-use ticket that a signed-in request mints, never with the access token in its
URL, and sends ``connected``, ``unread-count`` and ``notification`` events. A run that finishes or fails tells
whoever launched it. ``/v1/users/me/settings/beta-features`` keeps the BetaGate opt-in.
"""

from __future__ import annotations

import json
import uuid
from contextlib import asynccontextmanager
from datetime import timedelta

from sqlalchemy import select

from analysis_b3_b4_b6._helpers import account_with_revision, only_job, submit
from openbinding_gateway.db.models import Notification, NotificationStreamTicket, utcnow
from openbinding_gateway.modules.shared.application import notify
from openbinding_gateway.routes import notifications as routes
from test_job_evidence import REAL_REEVALUATE, bim_back, bim_down, engine  # noqa: F401


async def signed_in(client, registration) -> tuple[uuid.UUID, dict[str, str]]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    login = await client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]},
    )
    return uuid.UUID(created.json()["id"]), {"Authorization": f"Bearer {login.json()['access_token']}"}


def add(db, user_id, kind: str, subject: str, *, read: bool = False, hours: int = 1) -> Notification:
    row = Notification(
        user_id=user_id, kind=kind, subject=subject, body=subject,
        read_at=utcnow() if read else None, created_at=utcnow() - timedelta(hours=hours),
    )
    db.add(row)
    return row


async def test_the_inbox_filters_by_kind_pages_and_counts_the_unread(api_client, registration, db_session):
    user_id, headers = await signed_in(api_client, registration)
    add(db_session, user_id, "System", "one", hours=3)
    add(db_session, user_id, "RunFinished", "two", hours=2)
    add(db_session, user_id, "RunFinished", "three", read=True, hours=1)
    add(db_session, user_id, "System", "old", hours=24 * 8)
    await db_session.commit()

    runs = await api_client.get("/v1/notifications", headers=headers, params={"kind": "RunFinished"})
    page = await api_client.get("/v1/notifications", headers=headers, params={"offset": 1, "limit": 1})
    count = await api_client.get("/v1/notifications/unread-count", headers=headers)
    unknown = await api_client.get("/v1/notifications", headers=headers, params={"kind": "Nope"})

    assert [row["subject"] for row in runs.json()] == ["three", "two"]
    assert [row["subject"] for row in page.json()] == ["two"]
    assert count.json() == {"count": 2}
    assert unknown.status_code == 422


async def test_a_user_deletes_only_their_own_notifications(api_client, registration, db_session):
    user_id, headers = await signed_in(api_client, registration)
    other_id, other = await signed_in(api_client, registration)
    mine = add(db_session, user_id, "System", "mine")
    theirs = add(db_session, other_id, "System", "theirs")
    await db_session.commit()

    assert (await api_client.delete(f"/v1/notifications/{theirs.id}", headers=headers)).status_code == 404
    assert (await api_client.delete(f"/v1/notifications/{mine.id}", headers=headers)).status_code == 204
    assert (await api_client.delete(f"/v1/notifications/{mine.id}", headers=headers)).status_code == 404
    assert [row["subject"] for row in (await api_client.get("/v1/notifications", headers=other)).json()] == ["theirs"]


async def test_a_kind_turned_off_is_not_stored(api_client, registration, db_session):
    user_id, headers = await signed_in(api_client, registration)

    read = await api_client.get("/v1/notifications/preferences", headers=headers)
    assert set(read.json()["kinds"]) == {
        "OrganizationInvitation", "System", "CompositionUpdated", "RunFinished", "RunFailed", "CompositionAdopted",
    }
    assert read.json()["kinds"]["System"] == {"inbox": True, "email": True}
    # An adoption reaches the inbox by default, never the email until chosen.
    assert read.json()["kinds"]["CompositionAdopted"] == {"inbox": True, "email": False}
    turned = await api_client.put(
        "/v1/notifications/preferences", headers=headers, json={"kinds": {"System": {"inbox": False, "email": True}}},
    )
    assert turned.status_code == 200, turned.text
    # A body without kinds keeps them.
    kept = await api_client.put("/v1/notifications/preferences", headers=headers, json={"email_job_failures": True})
    assert kept.json()["kinds"]["System"]["inbox"] is False and kept.json()["email_job_failures"] is True
    bad = await api_client.put("/v1/notifications/preferences", headers=headers, json={"kinds": {"Nope": {}}})
    assert bad.status_code == 422

    await db_session.refresh(await _user(db_session, user_id))
    assert await notify(db_session, user_id, "System", "s", "b") is None
    assert await notify(db_session, user_id, "RunFailed", "s", "b") is not None


async def _user(db, user_id):
    from openbinding_gateway.db.models import User

    return await db.get(User, user_id)


async def test_the_stream_opens_once_with_a_ticket(api_client, registration, db_session, monkeypatch):
    user_id, headers = await signed_in(api_client, registration)
    add(db_session, user_id, "System", "before")
    await db_session.commit()

    @asynccontextmanager
    async def same_session():
        yield db_session

    pauses: list[float] = []

    async def pause(seconds: float) -> None:
        if not pauses:
            add(db_session, user_id, "RunFinished", "live", hours=0)
            await db_session.commit()
        pauses.append(seconds)

    monkeypatch.setattr(routes, "_open_session", same_session)
    monkeypatch.setattr(routes, "_pause", pause)
    monkeypatch.setattr(routes, "STREAM_SECONDS", 0.5)
    monkeypatch.setattr(routes, "POLL_SECONDS", 0.2)

    minted = await api_client.post("/v1/notifications/stream-ticket", headers=headers)
    assert minted.status_code == 201, minted.text
    ticket = minted.json()["ticket"]
    stored = await db_session.scalar(select(NotificationStreamTicket).where(NotificationStreamTicket.user_id == user_id))
    assert stored is not None and ticket not in stored.ticket_hash

    opened = await api_client.get("/v1/notifications/stream", params={"ticket": ticket})

    assert opened.status_code == 200, opened.text
    assert opened.headers["content-type"].startswith("text/event-stream")
    events = [
        (block.split("\n")[0].removeprefix("event: "), json.loads(block.split("data: ", 1)[1]))
        for block in opened.text.split("\n\n") if block.startswith("event: ")
    ]
    assert events[0] == ("connected", {"userId": str(user_id)})
    assert events[1] == ("unread-count", {"count": 1})
    names = [name for name, _ in events]
    assert ("notification" in names) and events[names.index("notification")][1]["subject"] == "live"
    assert events[-1] == ("unread-count", {"count": 2})
    # Used once: the same ticket, a made-up one and an expired one are refused.
    again = await api_client.get("/v1/notifications/stream", params={"ticket": ticket})
    assert again.status_code == 401
    assert (await api_client.get("/v1/notifications/stream", params={"ticket": "obt_" + "x" * 40})).status_code == 401
    late = (await api_client.post("/v1/notifications/stream-ticket", headers=headers)).json()["ticket"]
    for row in (await db_session.scalars(select(NotificationStreamTicket))).all():
        row.expires_at = utcnow() - timedelta(seconds=1)
    await db_session.commit()
    assert (await api_client.get("/v1/notifications/stream", params={"ticket": late})).status_code == 401
    # An access token is not a ticket.
    token = headers["Authorization"].removeprefix("Bearer ")
    assert (await api_client.get("/v1/notifications/stream", params={"ticket": token})).status_code in (401, 422)


async def test_a_finished_run_tells_whoever_launched_it(
    api_client, db_session, registration, engine, bim_back,  # noqa: F811
):
    headers, revision_id = await account_with_revision(api_client, registration)

    await submit(api_client, headers, revision_id)

    job = await only_job(db_session)
    inbox = (await api_client.get("/v1/notifications", headers=headers)).json()
    assert [(row["kind"], row["payload"]["run_id"]) for row in inbox] == [("RunFinished", str(job.id))]


async def test_a_failed_run_tells_whoever_launched_it(
    api_client, db_session, registration, engine, bim_down,  # noqa: F811
):
    headers, revision_id = await account_with_revision(api_client, registration)

    await submit(api_client, headers, revision_id)

    inbox = (await api_client.get("/v1/notifications", headers=headers, params={"kind": "RunFailed"})).json()
    assert [row["subject"] for row in inbox] == ["Run failed"]


async def test_beta_features_are_opted_into(api_client, registration):
    _, headers = await signed_in(api_client, registration)
    url = "/v1/users/me/settings/beta-features"

    first = await api_client.get(url, headers=headers)
    assert first.json() == {"enabled": False} and "ETag" in first.headers
    stale = first.headers["ETag"]
    turned = await api_client.put(url, headers={**headers, "If-Match": stale}, json={"enabled": True})
    assert turned.status_code == 200 and turned.json() == {"enabled": True}
    assert (await api_client.get(url, headers=headers)).json() == {"enabled": True}
    refused = await api_client.put(url, headers={**headers, "If-Match": stale}, json={"enabled": False})
    assert refused.status_code == 412
    assert (await api_client.get(url)).status_code == 401

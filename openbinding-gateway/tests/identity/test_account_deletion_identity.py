"""Deleting an Identity account ends its sessions upstream and leaves nothing that can sign in (J10)."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from openbinding_gateway.db.models import AuthIdentity, IdentitySession, NotificationStreamTicket, User

from ._flow import known_user, sign_in

pytestmark = pytest.mark.usefixtures("fake_issuer")


async def test_deleting_an_identity_account_needs_no_password_and_ends_everything(browser, fake_issuer, db_session) -> None:
    user, _, person = await known_user(db_session, fake_issuer)
    await sign_in(browser, fake_issuer, person)
    token = (await browser.post("/v1/auth/identity/session")).json()["access_token"]
    headers = {"authorization": f"Bearer {token}"}
    await browser.post("/v1/notifications/stream-ticket", headers=headers)
    username = user.username
    deleted = await browser.request("DELETE", "/v1/users/me", headers=headers, json={"confirmation": username})
    assert deleted.status_code == 204, deleted.text
    assert len(fake_issuer.logouts) == 1
    assert (await browser.get("/v1/users/me", headers=headers)).status_code == 401
    assert (await browser.post("/v1/auth/identity/session")).status_code == 401
    for model in (IdentitySession, AuthIdentity, NotificationStreamTicket):
        assert (await db_session.execute(select(model))).scalars().all() == []
    user = await db_session.get(User, user.id, populate_existing=True)
    assert user.username.startswith("deleted-") and user.display_name is None and user.avatar is None
    again = await sign_in(browser, fake_issuer, person)
    assert "/sso/identity/username" in again.headers["location"]

"""Deleting an Identity account ends its sessions upstream and leaves nothing that can sign in (J10)."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from openbinding_gateway.db.models import (
    AuthIdentity,
    IdentitySession,
    NotificationStreamTicket,
    Organization,
    OrganizationMembership,
    User,
)

from ._flow import choose, first_sign_in, known_user, sign_in

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


async def test_a_provisioned_accounts_personal_organization_is_deleted_with_it(browser, fake_issuer, db_session) -> None:
    person = fake_issuer.user()
    await first_sign_in(browser, fake_issuer, person)
    assert (await choose(browser, "leaving")).status_code == 201
    user = (await db_session.execute(select(User).where(User.username == "leaving"))).scalars().one()
    personal_id = (await db_session.execute(
        select(Organization.id).where(Organization.personal_owner_id == user.id)
    )).scalars().one()
    token = (await browser.post("/v1/auth/identity/session")).json()["access_token"]
    preview = await browser.get("/v1/users/me/deletion", headers={"authorization": f"Bearer {token}"})
    assert preview.json()["personal_organization"]["slug"] == "leaving"
    deleted = await browser.request(
        "DELETE", "/v1/users/me", headers={"authorization": f"Bearer {token}"}, json={"confirmation": "leaving"}
    )
    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    assert await db_session.get(Organization, personal_id) is None
    members = (await db_session.execute(
        select(OrganizationMembership).where(OrganizationMembership.organization_id == personal_id)
    )).scalars().all()
    assert members == []
    # A new sign-in of the same person may take the name again, with a new personal organization.
    await sign_in(browser, fake_issuer, person)
    assert (await choose(browser, "leaving")).status_code == 201

"""Rollback is a setting: AUTH_PROVIDER=local and back, keeping the same account (plan §15, O16, J8).

Ported from SPHERE's rollback test (``api/src/test/unit-tests/scoretech-identity.test.ts``).
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from openbinding_gateway.db.models import IdentitySession, User

from ._flow import choose, first_sign_in, sign_in

pytestmark = pytest.mark.usefixtures("fake_issuer")


async def test_back_and_forth_between_identity_and_local(browser, fake_issuer, db_session, scoretech, monkeypatch) -> None:
    person = fake_issuer.user(email="roll@example.org")
    await first_sign_in(browser, fake_issuer, person)
    assert (await choose(browser, "roller")).status_code == 201
    token = (await browser.post("/v1/auth/identity/session")).json()["access_token"]
    bearer = {"authorization": f"Bearer {token}"}
    user = (await db_session.execute(select(User).where(User.username == "roller"))).scalars().one()

    monkeypatch.setattr(scoretech, "auth_provider", "local")
    monkeypatch.setattr(scoretech, "expose_recovery_tokens", True)
    assert (await browser.get("/v1/users/me", headers=bearer)).status_code == 401
    assert (await browser.post("/v1/auth/identity/session")).status_code == 401
    login = await browser.post("/v1/auth/login", json={"username_or_email": "roller", "password": "anything-at-all"})
    assert login.status_code == 401
    reset = await browser.post("/v1/auth/password-reset/request", json={"email": "roll@example.org"})
    assert reset.status_code == 202 and reset.json().get("token")
    done = await browser.post(
        "/v1/auth/password-reset/complete", json={"token": reset.json()["token"], "new_password": "rolled-back-password-1"}
    )
    assert done.status_code == 204, done.text
    local = await browser.post("/v1/auth/login", json={"username_or_email": "roller", "password": "rolled-back-password-1"})
    assert local.status_code == 200
    local_bearer = {"authorization": f"Bearer {local.json()['access_token']}"}
    me = await browser.get("/v1/users/me", headers=local_bearer)
    assert me.status_code == 200 and me.json()["id"] == str(user.id)
    reasons = (await db_session.execute(select(IdentitySession.revoked_reason).where(IdentitySession.user_id == user.id))).scalars().all()
    assert reasons == ["password_reset"]

    monkeypatch.setattr(scoretech, "auth_provider", "scoretech")
    monkeypatch.setattr(scoretech, "expose_recovery_tokens", False)
    assert (await browser.get("/v1/users/me", headers=local_bearer)).status_code == 401
    assert (await browser.post("/v1/auth/login", json={"username_or_email": "roller", "password": "rolled-back-password-1"})).status_code == 409
    again = await sign_in(browser, fake_issuer, person)
    assert "/sso/identity/callback" in again.headers["location"]
    token = (await browser.post("/v1/auth/identity/session")).json()["access_token"]
    me = await browser.get("/v1/users/me", headers={"authorization": f"Bearer {token}"})
    assert me.json()["id"] == str(user.id)

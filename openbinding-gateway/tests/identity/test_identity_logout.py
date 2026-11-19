"""Logout, deactivation and a change of mode take effect on the next request (T13, T20, O14)."""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import timedelta

import pytest
from sqlalchemy import select

from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import AuditEvent, IdentitySession, User, UserRole, utcnow
from openbinding_gateway.routes import notifications as notification_routes
from openbinding_gateway.security.tokens import issue_access_token

from ._flow import choose, first_sign_in, known_user, session_cookie, sign_in

pytestmark = pytest.mark.usefixtures("fake_issuer")


async def bearer_of(browser) -> dict[str, str]:
    minted = await browser.post("/v1/auth/identity/session")
    assert minted.status_code == 200, minted.text
    return {"authorization": f"Bearer {minted.json()['access_token']}"}


async def signed_in(browser, fake, db, **values):
    user, identity, person = await known_user(db, fake, **values)
    await sign_in(browser, fake, person)
    return user, person, await bearer_of(browser)


async def test_logout_ends_the_bearer_at_once_and_the_sso_session(browser, fake_issuer, db_session) -> None:
    user, _, headers = await signed_in(browser, fake_issuer, db_session)
    assert (await browser.get("/v1/users/me", headers=headers)).status_code == 200
    out = await browser.post("/v1/auth/identity/logout")
    assert out.status_code == 204 and session_cookie(browser) is None
    assert (await browser.get("/v1/users/me", headers=headers)).status_code == 401
    assert len(fake_issuer.logouts) == 1
    assert (await browser.post("/v1/auth/identity/session")).status_code == 401
    row = (await db_session.execute(select(IdentitySession).where(IdentitySession.user_id == user.id))).scalars().one()
    assert row.revoked_reason == "logout"
    audit = (await db_session.execute(select(AuditEvent).where(AuditEvent.action == "account.signed_out"))).scalars().one()
    assert audit.detail == {"scope": "this"}
    assert (await browser.post("/v1/auth/identity/logout")).status_code == 204


async def test_logout_of_all_ends_every_session_of_the_account(browser, fake_issuer, db_session) -> None:
    from httpx import ASGITransport, AsyncClient

    from openbinding_gateway.main import app

    user, person, headers = await signed_in(browser, fake_issuer, db_session)
    async with AsyncClient(transport=ASGITransport(app=app), base_url=str(browser.base_url), headers={"origin": browser.headers["origin"]}) as other:
        await sign_in(other, fake_issuer, person)
        other_headers = await bearer_of(other)
        out = await browser.post("/v1/auth/identity/logout", json={"scope": "all"})
        assert out.status_code == 204
        assert (await browser.get("/v1/users/me", headers=other_headers)).status_code == 401
        assert (await other.post("/v1/auth/identity/session")).status_code == 401
    assert len(fake_issuer.logouts) == 2
    reasons = (await db_session.execute(select(IdentitySession.revoked_reason).where(IdentitySession.user_id == user.id))).scalars().all()
    assert sorted(reasons) == ["logout_all", "logout_all"]


async def test_logout_with_only_a_pending_sign_up_ends_it_upstream(browser, fake_issuer, identity_stores) -> None:
    store, _ = identity_stores
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    assert any(ns == "identity-pending" for ns, _ in store.values)
    out = await browser.post("/v1/auth/identity/logout")
    assert out.status_code == 204 and browser.cookies.get("__Host-ob_pending") is None
    assert len(fake_issuer.logouts) == 1
    assert not any(ns == "identity-pending" for ns, _ in store.values)
    assert (await choose(browser, "toolate")).status_code == 404


async def test_logout_needs_the_frontend_origin(browser, fake_issuer, db_session) -> None:
    await signed_in(browser, fake_issuer, db_session)
    assert (await browser.post("/v1/auth/identity/logout", headers={"origin": "https://evil.test"})).status_code == 403
    assert session_cookie(browser)


async def test_a_ticket_bought_before_logout_cannot_open_a_stream(browser, fake_issuer, db_session) -> None:
    _, _, headers = await signed_in(browser, fake_issuer, db_session)
    ticket = (await browser.post("/v1/notifications/stream-ticket", headers=headers)).json()["ticket"]
    await browser.post("/v1/auth/identity/logout")
    opened = await browser.get("/v1/notifications/stream", params={"ticket": ticket})
    assert opened.status_code == 401


async def test_an_open_stream_ends_within_one_check(browser, fake_issuer, db_session, monkeypatch) -> None:
    user, _, headers = await signed_in(browser, fake_issuer, db_session)

    @asynccontextmanager
    async def same_session():
        yield db_session

    checks = {"n": 0}

    async def pause(seconds: float) -> None:
        checks["n"] += 1
        if checks["n"] == 2:
            row = (await db_session.execute(select(IdentitySession).where(IdentitySession.user_id == user.id))).scalars().one()
            row.revoked_at, row.revoked_reason = utcnow(), "logout"
            await db_session.flush()

    monkeypatch.setattr(notification_routes, "_open_session", same_session)
    monkeypatch.setattr(notification_routes, "_pause", pause)
    monkeypatch.setattr(notification_routes, "SESSION_CHECK_SECONDS", 0.0)
    monkeypatch.setattr(notification_routes, "STREAM_SECONDS", 30.0)
    ticket = (await browser.post("/v1/notifications/stream-ticket", headers=headers)).json()["ticket"]
    opened = await browser.get("/v1/notifications/stream", params={"ticket": ticket})
    assert opened.status_code == 200
    names = [block.split("\n")[0] for block in opened.text.split("\n\n") if block.startswith("event: ")]
    assert names[-1] == "event: session-ended" and checks["n"] <= 3


async def test_deactivation_ends_every_session(browser, fake_issuer, db_session, api_client, registration) -> None:
    user, _, headers = await signed_in(browser, fake_issuer, db_session)
    admin = User(username=f"adm{uuid.uuid4().hex[:6]}", email=f"{uuid.uuid4().hex}@example.invalid", password_hash="x", plan_cache="", role=UserRole.ADMIN)
    db_session.add(admin)
    await db_session.flush()
    secret = get_settings().gateway_jwt_secret
    # An administrator's token of the local era is refused in scoretech mode: give it a scoretech session too.
    from openbinding_gateway.modules.identity.application import sessions
    from openbinding_gateway.db.models import AuthIdentity
    from ._settings import ISSUER

    identity = AuthIdentity(user_id=admin.id, provider="scoretech", issuer=ISSUER, subject="admin-sub", attributes={})
    db_session.add(identity)
    await db_session.flush()
    from openbinding_gateway.modules.identity.domain.claims import TokenSet

    row, _ = await sessions.create(db_session, admin, "scoretech", settings=get_settings(), identity=identity, tokens=TokenSet(access_token="a", refresh_token="r", expires_in=300))
    admin_token = issue_access_token(secret, user_id=admin.id, ttl_seconds=60, session_id=row.id, provider="scoretech")
    changed = await browser.patch(f"/v1/admin/users/{user.id}", json={"is_active": False}, headers={"authorization": f"Bearer {admin_token}"})
    assert changed.status_code == 200, changed.text
    assert (await browser.get("/v1/users/me", headers=headers)).status_code == 401
    reasons = (await db_session.execute(select(IdentitySession.revoked_reason).where(IdentitySession.user_id == user.id))).scalars().all()
    assert reasons == ["deactivated"]


async def test_tokens_of_one_mode_are_refused_in_the_other(browser, fake_issuer, db_session, scoretech, monkeypatch) -> None:
    user, _, headers = await signed_in(browser, fake_issuer, db_session)
    monkeypatch.setattr(scoretech, "auth_provider", "local")
    assert (await browser.get("/v1/users/me", headers=headers)).status_code == 401
    monkeypatch.setattr(scoretech, "auth_provider", "scoretech")
    assert (await browser.get("/v1/users/me", headers=headers)).status_code == 200
    bare = issue_access_token(scoretech.gateway_jwt_secret, user_id=user.id, ttl_seconds=60)
    assert (await browser.get("/v1/users/me", headers={"authorization": f"Bearer {bare}"})).status_code == 401
    local_sid = issue_access_token(scoretech.gateway_jwt_secret, user_id=user.id, ttl_seconds=60, session_id=uuid.uuid4(), provider="local")
    assert (await browser.get("/v1/users/me", headers={"authorization": f"Bearer {local_sid}"})).status_code == 401


async def test_an_idle_session_ends_its_tokens(browser, fake_issuer, db_session) -> None:
    user, _, headers = await signed_in(browser, fake_issuer, db_session)
    row = (await db_session.execute(select(IdentitySession).where(IdentitySession.user_id == user.id))).scalars().one()
    row.idle_expires_at = utcnow() - timedelta(seconds=1)
    await db_session.flush()
    assert (await browser.get("/v1/users/me", headers=headers)).status_code == 401


async def test_a_sid_of_another_user_is_refused(browser, fake_issuer, db_session) -> None:
    user, _, _ = await signed_in(browser, fake_issuer, db_session)
    row = (await db_session.execute(select(IdentitySession).where(IdentitySession.user_id == user.id))).scalars().one()
    other = User(username=f"o{uuid.uuid4().hex[:6]}", email=f"{uuid.uuid4().hex}@example.invalid", password_hash="x", plan_cache="")
    db_session.add(other)
    await db_session.flush()
    forged = issue_access_token(get_settings().gateway_jwt_secret, user_id=other.id, ttl_seconds=60, session_id=row.id, provider="scoretech")
    assert (await browser.get("/v1/users/me", headers={"authorization": f"Bearer {forged}"})).status_code == 401


async def test_api_keys_are_unaffected_by_logout(api_client, registration, scoretech, monkeypatch) -> None:
    monkeypatch.setattr(scoretech, "auth_provider", "local")
    details = registration()
    await api_client.post("/v1/auth/register", json=details)
    login = await api_client.post("/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]})
    headers = {"authorization": f"Bearer {login.json()['access_token']}"}
    from _b1_helpers import make_key

    key = await make_key(api_client, headers, ["account:read"])
    await api_client.post("/v1/auth/identity/logout", headers={"origin": "http://localhost:5173"})
    assert (await api_client.get("/v1/users/me", headers=key)).status_code == 200

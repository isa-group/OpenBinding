"""``POST /v1/auth/identity/session``: short tokens from the cookie and single-flight Identity renewal (T11, T12)."""

from __future__ import annotations

import asyncio
from datetime import timedelta

import jwt
import pytest
from sqlalchemy import select, update

from openbinding_gateway.db.models import IdentitySession, User, utcnow
from openbinding_gateway.modules.identity.adapters.stores import MemorySessionLock
from openbinding_gateway.modules.identity.application import renewal, set_lock

from ._flow import known_user, session_cookie, sign_in

pytestmark = pytest.mark.usefixtures("fake_issuer")


async def signed_in(browser, fake, db, *, access_ttl: int = 300, **values):
    fake.access_ttl = access_ttl
    user, identity, person = await known_user(db, fake, **values)
    response = await sign_in(browser, fake, person)
    assert "/sso/identity/callback" in response.headers["location"], response.headers["location"]
    row = (await db.execute(select(IdentitySession).where(IdentitySession.user_id == user.id))).scalars().one()
    return user, row, person


async def mint(browser, **headers):
    return await browser.post("/v1/auth/identity/session", headers=headers or None)


async def test_a_fresh_session_mints_a_token_with_sid_and_no_upstream_refresh(browser, fake_issuer, db_session) -> None:
    user, row, _ = await signed_in(browser, fake_issuer, db_session)
    response = await mint(browser)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["token_type"] == "bearer" and body["expires_in"] == 300
    claims = jwt.decode(body["access_token"], options={"verify_signature": False})
    assert claims["sid"] == str(row.id) and claims["prv"] == "scoretech" and claims["sub"] == str(user.id)
    assert fake_issuer.refresh_grants() == 0
    me = await browser.get("/v1/users/me", headers={"authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200 and me.json()["id"] == str(user.id)


async def test_the_session_route_bumps_idle_and_keeps_the_cookie(browser, fake_issuer, db_session) -> None:
    _, row, _ = await signed_in(browser, fake_issuer, db_session)
    before = row.idle_expires_at
    cookie = session_cookie(browser)
    response = await mint(browser)
    await db_session.refresh(row)
    assert row.idle_expires_at >= before and session_cookie(browser) == cookie
    assert "max-age=" in response.headers["set-cookie"].lower()


async def test_five_parallel_renewals_make_one_refresh(pooled, fake_issuer) -> None:
    factory, browser = pooled
    async with factory() as db:
        user, _, person = await known_user(db, fake_issuer)
        await db.commit()
    fake_issuer.access_ttl = 10
    await sign_in(browser, fake_issuer, person)
    fake_issuer.access_ttl = 300
    results = await asyncio.gather(*(mint(browser) for _ in range(5)))
    assert [r.status_code for r in results] == [200] * 5, [r.text for r in results]
    assert fake_issuer.refresh_grants() == 1
    assert getattr(fake_issuer, "reused", 0) == 0
    async with factory() as db:
        row = (await db.execute(select(IdentitySession).where(IdentitySession.user_id == user.id))).scalars().one()
        assert row.refresh_generation == 1 and row.revoked_at is None


async def test_a_lock_held_by_another_worker_is_waited_for_and_its_renewal_used(browser, fake_issuer, db_session, monkeypatch) -> None:
    _, row, _ = await signed_in(browser, fake_issuer, db_session, access_ttl=10)
    table: dict = {}
    other = MemorySessionLock(table)
    set_lock(MemorySessionLock(table))
    held = await other.acquire(f"identity:refresh:{row.id}", 30_000)

    async def other_worker_finishes() -> None:
        await asyncio.sleep(0.3)
        await db_session.execute(
            update(IdentitySession).where(IdentitySession.id == row.id).values(
                access_expires_at=utcnow() + timedelta(seconds=300), refresh_generation=1
            )
        )
        await other.release(f"identity:refresh:{row.id}", held)

    worker = asyncio.create_task(other_worker_finishes())
    response = await mint(browser)
    await worker
    assert response.status_code == 200 and fake_issuer.refresh_grants() == 0


async def test_a_lock_never_released_is_a_503_with_retry_after_1(browser, fake_issuer, db_session, monkeypatch) -> None:
    monkeypatch.setattr(renewal, "LOCK_WAIT_S", 0.3)
    _, row, _ = await signed_in(browser, fake_issuer, db_session, access_ttl=10)
    table: dict = {}
    set_lock(MemorySessionLock(table))
    await MemorySessionLock(table).acquire(f"identity:refresh:{row.id}", 30_000)
    response = await mint(browser)
    assert response.status_code == 503 and response.headers["retry-after"] == "1"
    assert response.json()["detail"]["code"] == "identity_unavailable"
    assert fake_issuer.refresh_grants() == 0


async def test_identity_down_is_a_503_and_the_session_survives(browser, fake_issuer, db_session) -> None:
    _, row, _ = await signed_in(browser, fake_issuer, db_session, access_ttl=10)
    fake_issuer.switches.add("down")
    response = await mint(browser)
    assert response.status_code == 503 and "retry-after" in response.headers
    await db_session.refresh(row)
    assert row.revoked_at is None
    fake_issuer.switches.clear()
    assert (await mint(browser)).status_code == 200


async def test_an_ended_identity_session_ends_ours_and_clears_the_cookie(browser, fake_issuer, db_session) -> None:
    _, row, person = await signed_in(browser, fake_issuer, db_session, access_ttl=10)
    fake_issuer.end_sso(person.sub)
    response = await mint(browser)
    assert response.status_code == 401 and response.json()["detail"]["code"] == "session_ended"
    assert 'ob_session=""' in response.headers["set-cookie"] or "max-age=0" in response.headers["set-cookie"].lower()
    await db_session.refresh(row)
    assert row.revoked_reason == "identity_ended"
    assert (await mint(browser)).status_code == 401


async def test_a_logout_racing_a_renewal_revokes_the_new_token_and_stays_revoked(browser, fake_issuer, db_session, monkeypatch) -> None:
    _, row, _ = await signed_in(browser, fake_issuer, db_session, access_ttl=10)
    from openbinding_gateway.modules.identity.application import get_oidc

    oidc = get_oidc()
    real = oidc.refresh
    obtained: list[str] = []

    async def refresh_then_logout(token):
        tokens = await real(token)
        obtained.append(tokens.refresh_token)
        await db_session.execute(
            update(IdentitySession).where(IdentitySession.id == row.id).values(revoked_at=utcnow(), revoked_reason="logout")
        )
        return tokens

    monkeypatch.setattr(oidc, "refresh", refresh_then_logout)
    response = await mint(browser)
    assert response.status_code == 401
    assert obtained and obtained[0] in fake_issuer.revoked
    await db_session.refresh(row)
    assert row.revoked_reason == "logout" and row.refresh_generation == 0


async def test_a_reuse_after_another_writer_moved_the_generation_is_not_an_ended_session(browser, fake_issuer, db_session, monkeypatch) -> None:
    from openbinding_gateway.modules.identity.application import get_oidc, sessions

    _, row, _ = await signed_in(browser, fake_issuer, db_session, access_ttl=10)
    oidc = get_oidc()
    real = oidc.refresh

    async def another_writer_won(token):
        fresh = await real(token)
        await db_session.execute(
            update(IdentitySession).where(IdentitySession.id == row.id).values(
                refresh_generation=1,
                refresh_ciphertext=sessions.seal_refresh(__import__("openbinding_gateway.core.settings", fromlist=["x"]).get_settings(), row.id, fresh.refresh_token, 1),
                access_expires_at=utcnow() + timedelta(seconds=300),
            )
        )
        return await real(token)

    monkeypatch.setattr(oidc, "refresh", another_writer_won)
    response = await mint(browser)
    assert response.status_code == 200, response.text
    await db_session.refresh(row)
    assert row.revoked_at is None and row.refresh_generation == 1


async def test_a_removed_permission_ends_the_session_at_renewal(browser, fake_issuer, db_session) -> None:
    _, row, _ = await signed_in(browser, fake_issuer, db_session, access_ttl=10)
    fake_issuer.switches.add("no_permission")
    response = await mint(browser)
    assert response.status_code == 401 and response.json()["detail"]["code"] == "session_ended"
    await db_session.refresh(row)
    assert row.revoked_reason == "identity_ended"


async def test_a_subject_change_at_refresh_is_refused(browser, fake_issuer, db_session) -> None:
    _, row, person = await signed_in(browser, fake_issuer, db_session, access_ttl=10)
    intruder = fake_issuer.user()
    for entry in fake_issuer.refresh_tokens.values():
        if entry["user"] == person.sub:
            entry["user"] = intruder.sub
    response = await mint(browser)
    assert response.status_code == 401
    await db_session.refresh(row)
    assert row.revoked_reason == "identity_ended"


async def test_an_idle_session_is_refused(browser, fake_issuer, db_session) -> None:
    _, row, _ = await signed_in(browser, fake_issuer, db_session)
    row.idle_expires_at = utcnow() - timedelta(seconds=1)
    await db_session.flush()
    response = await mint(browser)
    assert response.status_code == 401 and response.json()["detail"]["code"] == "session_ended"


async def test_no_cookie_is_no_session(browser) -> None:
    response = await mint(browser)
    assert response.status_code == 401 and response.json()["detail"]["code"] == "no_session"


async def test_the_origin_must_be_the_frontend(browser, fake_issuer, db_session) -> None:
    await signed_in(browser, fake_issuer, db_session)
    assert (await mint(browser, origin="https://evil.test")).status_code == 403
    browser.headers.pop("origin")
    assert (await mint(browser)).status_code == 403


async def test_a_lock_backend_that_fails_is_a_503_and_never_an_unlocked_refresh(browser, fake_issuer, db_session) -> None:
    class Down:
        async def acquire(self, key, ttl_ms):
            raise ConnectionError("redis is down")

        async def release(self, key, token):
            raise ConnectionError("redis is down")

    _, row, _ = await signed_in(browser, fake_issuer, db_session, access_ttl=10)
    set_lock(Down())
    response = await mint(browser)
    assert response.status_code == 503 and fake_issuer.refresh_grants() == 0
    await db_session.refresh(row)
    assert row.revoked_at is None


async def test_a_refresh_without_an_id_token_keeps_the_profile_and_moves_liveness(browser, fake_issuer, db_session) -> None:
    user, _, _ = await signed_in(browser, fake_issuer, db_session, access_ttl=10, display_name="Shown Name")
    await db_session.refresh(user)
    before = (user.email, user.email_verified, user.display_name, user.avatar)
    first_seen = user.last_identity_refresh_at
    fake_issuer.switches.add("refresh_without_id_token")
    fake_issuer.users[next(iter(fake_issuer.users))].display_name = "Changed Upstream"
    await asyncio.sleep(0.01)
    assert (await mint(browser)).status_code == 200
    user = await db_session.get(User, user.id, populate_existing=True)
    assert (user.email, user.email_verified, user.display_name, user.avatar) == before
    assert user.last_identity_refresh_at > first_seen

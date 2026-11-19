"""Personal API keys stop when their owner stops proving they hold an Identity account (plan §5, T17, D-j)."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select

from _b1_helpers import make_key
from openbinding_gateway.db.models import ApiKey, User, utcnow

from ._flow import known_user, sign_in

pytestmark = pytest.mark.usefixtures("fake_issuer")


async def keyed(browser, fake, db, **values):
    user, _, person = await known_user(db, fake, **values)
    await sign_in(browser, fake, person)
    token = (await browser.post("/v1/auth/identity/session")).json()["access_token"]
    bearer = {"authorization": f"Bearer {token}"}
    key = await make_key(browser, bearer, ["account:read"])
    return user, person, bearer, key


async def _age(db, user: User, days: int) -> None:
    user.last_identity_refresh_at = utcnow() - timedelta(days=days)
    await db.flush()


async def test_a_fresh_owner_uses_the_key_and_31_days_suspend_it(browser, fake_issuer, db_session) -> None:
    user, person, _, key = await keyed(browser, fake_issuer, db_session)
    assert (await browser.get("/v1/users/me", headers=key)).status_code == 200
    row = (await db_session.execute(select(ApiKey).where(ApiKey.user_id == user.id))).scalars().one()
    await db_session.refresh(row)
    grants, used = dict(row.grants), row.last_used_at
    assert used is not None
    await _age(db_session, user, 31)
    refused = await browser.get("/v1/users/me", headers=key)
    assert refused.status_code == 401 and refused.json()["detail"]["code"] == "api_key_suspended"
    await db_session.refresh(row)
    assert row.revoked_at is None and row.grants == grants and row.last_used_at == used
    await sign_in(browser, fake_issuer, person)
    assert (await browser.get("/v1/users/me", headers=key)).status_code == 200


async def test_an_owner_without_an_identity_cannot_use_keys_in_scoretech_mode(browser, fake_issuer, db_session) -> None:
    user, _, _, key = await keyed(browser, fake_issuer, db_session)
    user.last_identity_refresh_at = None
    await db_session.flush()
    assert (await browser.get("/v1/users/me", headers=key)).status_code == 401


async def test_local_mode_admits_whatever_the_date(browser, fake_issuer, db_session, scoretech, monkeypatch) -> None:
    user, _, _, key = await keyed(browser, fake_issuer, db_session)
    await _age(db_session, user, 400)
    monkeypatch.setattr(scoretech, "auth_provider", "local")
    assert (await browser.get("/v1/users/me", headers=key)).status_code == 200


async def test_an_orphaned_administrator_key_is_suspended_too(browser, fake_issuer, db_session) -> None:
    from openbinding_gateway.db.models import UserRole

    user, _, _, key = await keyed(browser, fake_issuer, db_session)
    user.role = UserRole.ADMIN
    await _age(db_session, user, 31)
    assert (await browser.get("/v1/admin/users", headers=key)).status_code == 401


async def test_the_profile_says_when_the_keys_stop(browser, fake_issuer, db_session, scoretech) -> None:
    user, _, bearer, _ = await keyed(browser, fake_issuer, db_session)
    me = (await browser.get("/v1/users/me", headers=bearer)).json()
    await db_session.refresh(user)
    expected = (user.last_identity_refresh_at.replace(tzinfo=None) + timedelta(days=scoretech.api_key_orphan_days))
    assert me["api_keys_suspended_at"].startswith(expected.isoformat()[:16])


async def test_the_profile_field_is_null_in_local_mode(api_client, registration, scoretech, monkeypatch) -> None:
    monkeypatch.setattr(scoretech, "auth_provider", "local")
    details = registration()
    await api_client.post("/v1/auth/register", json=details)
    login = await api_client.post("/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]})
    me = await api_client.get("/v1/users/me", headers={"authorization": f"Bearer {login.json()['access_token']}"})
    assert me.json()["api_keys_suspended_at"] is None


def test_the_orphan_window_is_bounded() -> None:
    from pydantic import ValidationError

    from openbinding_gateway.core.settings import Settings

    for days in (0, 366):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, api_key_orphan_days=days)

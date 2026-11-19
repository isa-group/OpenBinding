"""The first administrator of an Identity deployment comes from ``BOOTSTRAP_ADMIN_SUB`` only (plan §5, T16)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from openbinding_gateway.db.models import AuditEvent, User, UserRole

from ._flow import choose, first_sign_in, known_user, sign_in

pytestmark = pytest.mark.usefixtures("fake_issuer")


async def _admins(db) -> list[User]:
    return (await db.execute(select(User).where(User.role == UserRole.ADMIN))).scalars().all()


async def test_the_configured_sub_becomes_administrator_once(browser, fake_issuer, db_session, scoretech, monkeypatch) -> None:
    person = fake_issuer.user(roles=["openbinding:access"])
    monkeypatch.setattr(scoretech, "bootstrap_admin_sub", person.sub)
    await first_sign_in(browser, fake_issuer, person)
    assert (await choose(browser, "boss")).status_code == 201
    assert [user.username for user in await _admins(db_session)] == ["boss"]
    events = (await db_session.execute(select(AuditEvent).where(AuditEvent.action == "account.admin.bootstrapped"))).scalars().all()
    assert len(events) == 1
    await sign_in(browser, fake_issuer, person)
    assert len((await db_session.execute(select(AuditEvent).where(AuditEvent.action == "account.admin.bootstrapped"))).scalars().all()) == 1


async def test_not_while_an_administrator_exists(browser, fake_issuer, db_session, scoretech, monkeypatch) -> None:
    db_session.add(User(username="already", email="a@example.invalid", password_hash="x", plan_cache="", role=UserRole.ADMIN))
    await db_session.flush()
    user, _, person = await known_user(db_session, fake_issuer)
    monkeypatch.setattr(scoretech, "bootstrap_admin_sub", person.sub)
    await sign_in(browser, fake_issuer, person)
    await db_session.refresh(user)
    assert user.role is UserRole.USER


async def test_another_sub_or_the_same_sub_of_another_issuer_never(browser, fake_issuer, db_session, scoretech, monkeypatch) -> None:
    user, _, person = await known_user(db_session, fake_issuer)
    monkeypatch.setattr(scoretech, "bootstrap_admin_sub", "somebody-else")
    await sign_in(browser, fake_issuer, person)
    await db_session.refresh(user)
    assert user.role is UserRole.USER
    from openbinding_gateway.modules.identity.application.bootstrap import promote_if_bootstrap
    from openbinding_gateway.modules.identity.domain.claims import IdentityClaims

    monkeypatch.setattr(scoretech, "bootstrap_admin_sub", person.sub)
    other = IdentityClaims(issuer="https://other.test/realms/score", subject=person.sub)
    assert await promote_if_bootstrap(db_session, scoretech, user, other) is False


async def test_administrador_in_the_id_token_never_promotes(browser, fake_issuer, db_session) -> None:
    user, _, person = await known_user(db_session, fake_issuer, roles=["openbinding:access", "administrador"])
    await sign_in(browser, fake_issuer, person)
    await db_session.refresh(user)
    assert user.role is UserRole.USER and await _admins(db_session) == []


async def test_local_mode_ignores_the_setting(db_session, scoretech, monkeypatch) -> None:
    from openbinding_gateway.modules.identity.application.bootstrap import promote_if_bootstrap
    from openbinding_gateway.modules.identity.domain.claims import IdentityClaims

    user = User(username=f"l{uuid.uuid4().hex[:6]}", email="l@example.invalid", password_hash="x", plan_cache="")
    db_session.add(user)
    await db_session.flush()
    monkeypatch.setattr(scoretech, "bootstrap_admin_sub", "s")
    monkeypatch.setattr(scoretech, "auth_provider", "local")
    assert await promote_if_bootstrap(db_session, scoretech, user, IdentityClaims(issuer=scoretech.identity_issuer, subject="s")) is False

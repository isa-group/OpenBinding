"""Browser sessions: opaque cookies kept as hashes, the sealed refresh token, expiry and revocation."""

from __future__ import annotations

import re
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import AuthIdentity, IdentitySession, User, utcnow
from openbinding_gateway.modules.identity.application import sessions
from openbinding_gateway.modules.identity.domain.claims import TokenSet
from openbinding_gateway.security.tokens import issue_access_token, read_access_token

from ._settings import ISSUER, scoretech_settings

SECRET_REFRESH = "plain-refresh-token-that-must-never-be-stored-0001"


async def _user(db, name: str = "alice") -> User:
    user = User(username=f"{name}{uuid.uuid4().hex[:6]}", email=f"{uuid.uuid4().hex}@example.invalid", password_hash="x", plan_cache="")
    db.add(user)
    await db.flush()
    return user


async def _identity(db, user: User) -> AuthIdentity:
    identity = AuthIdentity(user_id=user.id, provider="scoretech", issuer=ISSUER, subject=f"sub-{uuid.uuid4().hex}", attributes={})
    db.add(identity)
    await db.flush()
    return identity


def _tokens(**values) -> TokenSet:
    return TokenSet(access_token="a", refresh_token=values.pop("refresh", SECRET_REFRESH), expires_in=300, **values)


async def test_the_cookie_is_43_base64url_characters_and_only_its_hash_is_stored(db_session) -> None:
    settings = scoretech_settings()
    user = await _user(db_session)
    row, value = await sessions.create(db_session, user, "scoretech", settings=settings, identity=await _identity(db_session, user), tokens=_tokens())
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", value)
    assert row.token_hash == sessions.cookie_hash(value) and value not in row.token_hash
    assert (await sessions.find_by_cookie(db_session, value)).id == row.id
    assert await sessions.find_by_cookie(db_session, value + "x") is None


async def test_the_ciphertext_never_contains_the_token_and_opens_only_for_its_row(db_session) -> None:
    settings = scoretech_settings()
    user = await _user(db_session)
    identity = await _identity(db_session, user)
    first, _ = await sessions.create(db_session, user, "scoretech", settings=settings, identity=identity, tokens=_tokens())
    second, _ = await sessions.create(db_session, user, "scoretech", settings=settings, identity=identity, tokens=_tokens(refresh="other"))
    assert SECRET_REFRESH not in first.refresh_ciphertext
    assert sessions.open_refresh(settings, first) == SECRET_REFRESH
    second.refresh_ciphertext = first.refresh_ciphertext
    with pytest.raises(sessions.SealedTokenInvalid):
        sessions.open_refresh(settings, second)


async def test_a_ciphertext_of_another_generation_does_not_open(db_session) -> None:
    settings = scoretech_settings()
    user = await _user(db_session)
    row, _ = await sessions.create(db_session, user, "scoretech", settings=settings, identity=await _identity(db_session, user), tokens=_tokens())
    row.refresh_generation += 1
    with pytest.raises(sessions.SealedTokenInvalid):
        sessions.open_refresh(settings, row)
    row.refresh_ciphertext = sessions.seal_refresh(settings, row.id, "next", row.refresh_generation)
    assert sessions.open_refresh(settings, row) == "next"


async def test_a_scoretech_session_needs_its_identity_and_tokens(db_session) -> None:
    user = await _user(db_session)
    with pytest.raises(ValueError):
        await sessions.create(db_session, user, "scoretech", settings=scoretech_settings())
    with pytest.raises(ValueError):
        await sessions.create(db_session, user, "cas", settings=scoretech_settings())


async def test_expiry_is_the_earlier_of_the_maximum_and_identity_refresh_expiry(db_session) -> None:
    settings = scoretech_settings()
    user = await _user(db_session)
    now = utcnow()
    row, _ = await sessions.create(
        db_session, user, "scoretech", settings=settings, identity=await _identity(db_session, user),
        tokens=_tokens(refresh_expires_in=3600), now=now,
    )
    assert sessions.as_utc(row.expires_at) == now + timedelta(seconds=3600)
    assert sessions.as_utc(row.idle_expires_at) == now + timedelta(seconds=settings.session_idle_s)
    assert sessions.as_utc(row.access_expires_at) == now + timedelta(seconds=300)
    local, _ = await sessions.create(db_session, user, "local", settings=settings, now=now)
    assert sessions.as_utc(local.expires_at) == now + timedelta(seconds=settings.session_max_s)
    assert local.refresh_ciphertext is None


async def test_active_for_token_checks_revocation_expiry_idle_provider_and_user(db_session) -> None:
    settings = scoretech_settings()
    user = await _user(db_session)
    other = await _user(db_session, "bob")
    now = utcnow()
    row, _ = await sessions.create(db_session, user, "scoretech", settings=settings, identity=await _identity(db_session, user), tokens=_tokens(), now=now)
    assert (await sessions.active_for_token(db_session, row.id, user.id, "scoretech", settings=settings, now=now)).id == user.id
    assert await sessions.active_for_token(db_session, row.id, other.id, "scoretech", settings=settings, now=now) is None
    assert await sessions.active_for_token(db_session, row.id, user.id, "local", settings=settings, now=now) is None
    local_mode = get_settings().model_copy(update={"auth_provider": "local"})
    assert await sessions.active_for_token(db_session, row.id, user.id, "scoretech", settings=local_mode, now=now) is None
    idle = now + timedelta(seconds=settings.session_idle_s + 1)
    assert await sessions.active_for_token(db_session, row.id, user.id, "scoretech", settings=settings, now=idle) is None
    await sessions.revoke(db_session, row, "logout", now=now)
    assert await sessions.active_for_token(db_session, row.id, user.id, "scoretech", settings=settings, now=now) is None


async def test_revoke_reasons_are_closed_and_revoking_a_user_ends_every_live_session(db_session) -> None:
    settings = scoretech_settings()
    user = await _user(db_session)
    rows = [(await sessions.create(db_session, user, "local", settings=settings))[0] for _ in range(3)]
    with pytest.raises(ValueError):
        await sessions.revoke(db_session, rows[0], "because")
    await sessions.revoke(db_session, rows[0], "logout")
    ended = await sessions.revoke(db_session, user, "deactivated")
    assert {row.id for row in ended} == {rows[1].id, rows[2].id}
    stored = (await db_session.execute(select(IdentitySession).where(IdentitySession.user_id == user.id))).scalars().all()
    assert {row.revoked_reason for row in stored} == {"logout", "deactivated"}


async def test_housekeeping_deletes_only_the_same_users_old_rows(db_session) -> None:
    settings = scoretech_settings()
    user, other = await _user(db_session), await _user(db_session, "bob")
    long_ago = utcnow() - timedelta(days=30)
    old, _ = await sessions.create(db_session, user, "local", settings=settings, now=long_ago)
    theirs, _ = await sessions.create(db_session, other, "local", settings=settings, now=long_ago)
    await sessions.revoke(db_session, old, "logout", now=long_ago)
    await sessions.revoke(db_session, theirs, "logout", now=long_ago)
    await sessions.create(db_session, user, "local", settings=settings)
    remaining = set((await db_session.execute(select(IdentitySession.id))).scalars())
    assert old.id not in remaining and theirs.id in remaining


def test_gateway_tokens_carry_sid_and_prv_and_no_role() -> None:
    import jwt

    sid, user = uuid.uuid4(), uuid.uuid4()
    secret = "x" * 40
    token = issue_access_token(secret, user_id=user, ttl_seconds=60, session_id=sid, provider="scoretech")
    body = jwt.decode(token, options={"verify_signature": False})
    assert body["sid"] == str(sid) and body["prv"] == "scoretech" and "role" not in body
    claims = read_access_token(secret, token)
    assert claims.session_id == sid and claims.provider == "scoretech"
    bare = read_access_token(secret, issue_access_token(secret, user_id=user, ttl_seconds=60))
    assert bare.session_id is None and bare.provider is None

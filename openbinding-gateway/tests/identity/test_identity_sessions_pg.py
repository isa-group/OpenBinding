"""``identity_sessions``, ``auth_identities`` and the case-insensitive username on PostgreSQL (the ``pg`` fixture).

SQLite enforces neither foreign keys nor these CHECKs the way PostgreSQL does, so every new constraint is
checked here against the migrated schema.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError

from openbinding_gateway.db.models import (
    AuthIdentity,
    IdentitySession,
    NotificationStreamTicket,
    User,
    utcnow,
)

ISSUER = "https://identity.test/identity/auth/realms/score"


def _user(name: str | None = None) -> User:
    suffix = uuid.uuid4().hex[:8]
    return User(username=name or f"u{suffix}", email=f"u{suffix}@example.invalid", password_hash="x", plan_cache="")


def _session(user: User, **values) -> IdentitySession:
    now = utcnow()
    defaults = dict(
        token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
        user_id=user.id,
        provider="local",
        idle_expires_at=now + timedelta(hours=1),
        expires_at=now + timedelta(days=1),
        last_renewed_at=now,
    )
    defaults.update(values)
    return IdentitySession(**defaults)


async def _expect_refused(pg, *objects) -> None:
    async with pg.session() as session:
        session.add_all(list(objects))
        with pytest.raises(IntegrityError):
            await session.commit()


async def test_a_scoretech_session_needs_an_identity_and_the_provider_is_closed(pg) -> None:
    user = _user()
    async with pg.session() as session:
        session.add(user)
        await session.commit()
    await _expect_refused(pg, _session(user, provider="scoretech"))
    await _expect_refused(pg, _session(user, provider="cas"))
    await _expect_refused(pg, _session(user, revoked_reason="because"))


async def test_the_token_hash_is_unique(pg) -> None:
    user = _user()
    async with pg.session() as session:
        session.add(user)
        await session.flush()
        session.add(_session(user, token_hash="a" * 64))
        await session.commit()
    await _expect_refused(pg, _session(user, token_hash="a" * 64))


async def test_sessions_and_tickets_cascade_from_users_and_identities(pg) -> None:
    user = _user()
    async with pg.session() as session:
        session.add(user)
        await session.flush()
        identity = AuthIdentity(user_id=user.id, provider="scoretech", issuer=ISSUER, subject="s1", attributes={})
        session.add(identity)
        await session.flush()
        row = _session(user, provider="scoretech", identity_id=identity.id)
        session.add(row)
        await session.flush()
        session.add(NotificationStreamTicket(user_id=user.id, ticket_hash="b" * 64, session_id=row.id, expires_at=utcnow()))
        await session.commit()
        await session.delete(identity)
        await session.commit()
        assert await session.scalar(select(IdentitySession.id).where(IdentitySession.id == row.id)) is None
        assert await session.scalar(select(NotificationStreamTicket.id)) is None
        other = _session(user)
        session.add(other)
        await session.commit()
        await session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user.id})
        await session.commit()
        assert await session.scalar(select(IdentitySession.id)) is None


async def test_provider_issuer_subject_is_unique_and_the_same_subject_may_come_from_two_issuers(pg) -> None:
    user = _user()
    async with pg.session() as session:
        session.add(user)
        await session.flush()
        session.add(AuthIdentity(user_id=user.id, provider="scoretech", issuer=ISSUER, subject="same", attributes={}))
        session.add(AuthIdentity(user_id=user.id, provider="scoretech", issuer=ISSUER + "x", subject="same", attributes={}))
        await session.commit()
    await _expect_refused(
        pg, AuthIdentity(user_id=user.id, provider="scoretech", issuer=ISSUER, subject="same", attributes={})
    )


async def test_usernames_are_unique_whatever_their_case(pg) -> None:
    async with pg.session() as session:
        session.add(_user("alice"))
        await session.commit()
    await _expect_refused(pg, _user("Alice"))
    async with pg.session() as session:
        index = await session.scalar(text("SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_users_username_lower'"))
    assert index is not None and "UNIQUE INDEX" in index and "lower((username)::text)" in index


async def test_two_concurrent_generation_writes_on_one_session_let_one_win(pg) -> None:
    user = _user()
    async with pg.session() as session:
        session.add(user)
        await session.flush()
        row = _session(user)
        session.add(row)
        await session.commit()
        sid = row.id

    async def write(value: str) -> int:
        async with pg.session() as session:
            result = await session.execute(
                update(IdentitySession)
                .where(IdentitySession.id == sid, IdentitySession.refresh_generation == 0, IdentitySession.revoked_at.is_(None))
                .values(refresh_generation=1, refresh_ciphertext=value)
            )
            await session.commit()
            return result.rowcount

    counts = await asyncio.gather(write("one"), write("two"))
    assert sorted(counts) == [0, 1]

"""Single-flight renewal across workers against the compose Redis (F-A step 5): two renewers, one Redis lock.

Each renewer stands for a gateway worker with its own in-process coalescing map; both share the Redis lock and
a database (a file SQLite here, one session per call as in production). The issuer is the in-process fake.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from identity._settings import scoretech_settings
from identity.fake_issuer import FakeIssuer, script_dns
from openbinding_gateway.db.base import Base
from openbinding_gateway.db.models import AuthIdentity, IdentitySession, User
from openbinding_gateway.modules.identity.adapters.oidc import IdentityOidc
from openbinding_gateway.modules.identity.adapters.stores import RedisSessionLock
from openbinding_gateway.modules.identity.application import set_lock, set_oidc
from openbinding_gateway.modules.identity.application import sessions
from openbinding_gateway.modules.identity.application.renewal import SessionRenewer
from openbinding_gateway.modules.identity.domain.errors import IdentityUnavailable

pytestmark = pytest.mark.integration

REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://redis:6379/0")


@pytest.fixture
async def world(tmp_path, monkeypatch):
    script_dns(monkeypatch)
    settings = scoretech_settings()
    fake = FakeIssuer(access_ttl=10)
    oidc = IdentityOidc(settings, transport=fake.transport())
    set_oidc(oidc)
    lock = RedisSessionLock(REDIS_URL)
    set_lock(lock)
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'workers.db'}", connect_args={"timeout": 30})
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    person = fake.user()
    verifier = "w" * 43
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    location = await oidc.authorization_url(
        {"client_id": oidc.client_id, "response_type": "code", "redirect_uri": oidc.callback_url, "state": "s",
         "nonce": "n", "code_challenge": challenge, "code_challenge_method": "S256"}
    )
    tokens = await oidc.exchange_code(fake.authorize(location, person)["code"], verifier)
    async with factory() as db:
        user = User(username=f"w{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex}@example.invalid", password_hash="x", plan_cache="")
        db.add(user)
        await db.flush()
        identity = AuthIdentity(user_id=user.id, provider="scoretech", issuer=oidc.issuer, subject=person.sub, attributes={})
        db.add(identity)
        await db.flush()
        row, _ = await sessions.create(db, user, "scoretech", settings=settings, identity=identity, tokens=tokens)
        await db.commit()
    # The session starts near expiry; the renewed access lasts long enough that nobody renews twice.
    fake.access_ttl = 300
    yield settings, fake, factory, row.id, lock
    set_oidc(None)
    set_lock(None)
    await lock.aclose()
    await engine.dispose()


async def _renew(renewer: SessionRenewer, settings, factory, sid) -> None:
    async with factory() as db:
        row = await db.get(IdentitySession, sid)
        await renewer.renew(db, settings, row)
        await db.commit()


async def test_two_workers_times_five_renewals_make_one_grant(world) -> None:
    settings, fake, factory, sid, _ = world
    workers = (SessionRenewer(), SessionRenewer())
    await asyncio.gather(*(_renew(workers[i % 2], settings, factory, sid) for i in range(10)))
    assert fake.refresh_grants() == 1 and getattr(fake, "reused", 0) == 0
    async with factory() as db:
        row = (await db.execute(select(IdentitySession).where(IdentitySession.id == sid))).scalars().one()
        assert row.refresh_generation == 1 and row.revoked_at is None


async def test_the_lock_owner_token_expires_and_only_its_owner_releases_it(world) -> None:
    _, _, _, sid, lock = world
    key = f"identity:refresh:{sid}"
    first = await lock.acquire(key, 300)
    assert await lock.acquire(key, 30_000) is None
    await asyncio.sleep(0.5)
    second = await lock.acquire(key, 30_000)
    assert second and await lock.release(key, first) is False
    assert await lock.release(key, second) is True


async def test_redis_unreachable_is_unavailable_with_no_grant(world) -> None:
    settings, fake, factory, sid, _ = world
    unreachable = RedisSessionLock("redis://127.0.0.1:1/0")
    set_lock(unreachable)
    try:
        with pytest.raises(IdentityUnavailable):
            await _renew(SessionRenewer(), settings, factory, sid)
    finally:
        await unreachable.aclose()
    assert fake.refresh_grants() == 0
    async with factory() as db:
        assert (await db.get(IdentitySession, sid)).revoked_at is None

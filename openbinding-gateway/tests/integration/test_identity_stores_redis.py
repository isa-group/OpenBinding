"""The identity one-time store and session lock against the compose Redis (the CI integration job)."""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest

from openbinding_gateway.modules.identity.adapters.stores import RedisOneTimeStore, RedisSessionLock

pytestmark = pytest.mark.integration

#: The compose service the integration job runs beside (``docker-compose.yml``); the suite's own
#: environment is cleaned of ``REDIS_URL`` by ``tests/conftest.py``.
REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://redis:6379/0")


@pytest.fixture
async def redis_pair():
    store = RedisOneTimeStore(REDIS_URL)
    lock = RedisSessionLock(client=store.redis)
    yield store, lock, f"it-{uuid.uuid4().hex}"
    await store.aclose()


async def test_redis_store_is_single_use_peekable_and_set_if_absent(redis_pair) -> None:
    store, _, ns = redis_pair
    await store.put(ns, "k", {"v": 1}, ttl=30)
    await store.put(ns, "k", {"v": 2}, ttl=30)
    assert await store.peek(ns, "k") == {"v": 1}
    assert await store.pop(ns, "k") == {"v": 1}
    assert await store.pop(ns, "k") is None
    await store.put(ns, "d", {"v": 3}, ttl=30)
    await store.delete(ns, "d")
    assert await store.peek(ns, "d") is None


async def test_redis_store_expires(redis_pair) -> None:
    store, _, ns = redis_pair
    await store.put(ns, "e", {"v": 1}, ttl=1)
    await asyncio.sleep(1.3)
    assert await store.peek(ns, "e") is None


async def test_redis_lock_owner_token_and_compare_and_delete(redis_pair) -> None:
    _, lock, ns = redis_pair
    key = f"{ns}:refresh"
    token = await lock.acquire(key, 30_000)
    assert token
    assert await lock.acquire(key, 30_000) is None
    assert await lock.release(key, "someone-else") is False
    assert await lock.acquire(key, 30_000) is None
    assert await lock.release(key, token) is True
    assert await lock.acquire(key, 30_000)


async def test_redis_lock_expiry_frees_it_and_the_old_owner_cannot_free_the_new(redis_pair) -> None:
    _, lock, ns = redis_pair
    key = f"{ns}:expiry"
    old = await lock.acquire(key, 300)
    await asyncio.sleep(0.5)
    new = await lock.acquire(key, 30_000)
    assert new
    assert await lock.release(key, old) is False
    assert await lock.release(key, new) is True

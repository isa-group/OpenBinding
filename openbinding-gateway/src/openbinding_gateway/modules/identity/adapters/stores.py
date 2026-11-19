"""The one-time store and the session lock, in memory and in Redis.

``RedisOneTimeStore`` is the store the US CAS flow used (moved here from ``cas.py``): keys
``openbinding:{namespace}:{key}``, ``SET NX EX`` to put, ``GET`` to peek, ``GETDEL`` to pop. ``RedisSessionLock``
is ``SET NX PX`` with a random owner token, released by a Lua compare-and-delete so that a worker whose lock
expired can never free the lock another worker took since. The memory versions are for tests and development;
``IDENTITY_STORE_BACKEND=memory`` is refused in production.
"""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from redis.asyncio import Redis


def _redis_key(namespace: str, key: str) -> str:
    return f"openbinding:{namespace}:{key}"


@dataclass
class MemoryOneTimeStore:
    """Per-process records with a monotonic expiry."""

    values: dict[tuple[str, str], tuple[dict, float]] = field(default_factory=dict)
    clock: Callable[[], float] = time.monotonic

    def _live(self, namespace: str, key: str) -> dict | None:
        stored = self.values.get((namespace, key))
        if stored is None:
            return None
        value, expires_at = stored
        if expires_at <= self.clock():
            self.values.pop((namespace, key), None)
            return None
        return value

    async def put(self, namespace: str, key: str, value: dict, ttl: int) -> None:
        if self._live(namespace, key) is not None:
            return
        self.values[(namespace, key)] = (json.loads(json.dumps(value)), self.clock() + ttl)

    async def peek(self, namespace: str, key: str) -> dict | None:
        value = self._live(namespace, key)
        return None if value is None else json.loads(json.dumps(value))

    async def pop(self, namespace: str, key: str) -> dict | None:
        value = self._live(namespace, key)
        self.values.pop((namespace, key), None)
        return value

    async def delete(self, namespace: str, key: str) -> None:
        self.values.pop((namespace, key), None)


class RedisOneTimeStore:
    def __init__(self, url: str | None = None, *, client: Redis | None = None) -> None:
        if client is None and url is None:
            raise ValueError("a Redis URL or client is required")
        self.redis = client if client is not None else Redis.from_url(url, decode_responses=True)

    async def put(self, namespace: str, key: str, value: dict, ttl: int) -> None:
        await self.redis.set(_redis_key(namespace, key), json.dumps(value), ex=ttl, nx=True)

    async def peek(self, namespace: str, key: str) -> dict | None:
        raw = await self.redis.get(_redis_key(namespace, key))
        return json.loads(raw) if raw else None

    async def pop(self, namespace: str, key: str) -> dict | None:
        raw = await self.redis.getdel(_redis_key(namespace, key))
        return json.loads(raw) if raw else None

    async def delete(self, namespace: str, key: str) -> None:
        await self.redis.delete(_redis_key(namespace, key))

    async def aclose(self) -> None:
        await self.redis.aclose()


@dataclass
class MemorySessionLock:
    """A lock table in memory; two instances built on the same ``table`` behave as two workers of one Redis."""

    table: dict[str, tuple[str, float]] = field(default_factory=dict)
    clock: Callable[[], float] = time.monotonic

    async def acquire(self, key: str, ttl_ms: int) -> str | None:
        held = self.table.get(key)
        now = self.clock()
        if held is not None and held[1] > now:
            return None
        token = secrets.token_hex(16)
        self.table[key] = (token, now + ttl_ms / 1000)
        return token

    async def release(self, key: str, token: str) -> bool:
        held = self.table.get(key)
        if held is None or held[0] != token or held[1] <= self.clock():
            return False
        del self.table[key]
        return True


#: Delete the key only while it still holds the caller's owner token.
_COMPARE_AND_DELETE = """
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
end
return 0
"""


class RedisSessionLock:
    def __init__(self, url: str | None = None, *, client: Redis | None = None) -> None:
        if client is None and url is None:
            raise ValueError("a Redis URL or client is required")
        self.redis = client if client is not None else Redis.from_url(url, decode_responses=True)

    async def acquire(self, key: str, ttl_ms: int) -> str | None:
        token = secrets.token_hex(16)
        taken = await self.redis.set(f"openbinding:{key}", token, px=ttl_ms, nx=True)
        return token if taken else None

    async def release(self, key: str, token: str) -> bool:
        deleted = await self.redis.eval(_COMPARE_AND_DELETE, 1, f"openbinding:{key}", token)
        return bool(deleted)

    async def aclose(self) -> None:
        await self.redis.aclose()

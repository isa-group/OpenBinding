"""The identity module's one-time store and session lock (memory adapters; Redis in tests/integration)."""

from __future__ import annotations

from openbinding_gateway.modules.identity.adapters.stores import MemoryOneTimeStore, MemorySessionLock


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


async def test_pop_consumes_a_record_once() -> None:
    store = MemoryOneTimeStore()
    await store.put("flow", "s1", {"nonce": "n"}, ttl=60)
    assert await store.pop("flow", "s1") == {"nonce": "n"}
    assert await store.pop("flow", "s1") is None


async def test_peek_does_not_consume_and_returns_a_copy() -> None:
    store = MemoryOneTimeStore()
    await store.put("flow", "s1", {"nonce": "n"}, ttl=60)
    seen = await store.peek("flow", "s1")
    seen["nonce"] = "changed"
    assert await store.peek("flow", "s1") == {"nonce": "n"}
    assert await store.pop("flow", "s1") == {"nonce": "n"}


async def test_records_expire_with_their_ttl() -> None:
    clock = Clock()
    store = MemoryOneTimeStore(clock=clock)
    await store.put("flow", "s1", {"v": 1}, ttl=10)
    clock.now += 9.9
    assert await store.peek("flow", "s1") == {"v": 1}
    clock.now += 0.2
    assert await store.peek("flow", "s1") is None
    assert await store.pop("flow", "s1") is None


async def test_put_never_overwrites_a_live_record() -> None:
    clock = Clock()
    store = MemoryOneTimeStore(clock=clock)
    await store.put("flow", "s1", {"v": 1}, ttl=10)
    await store.put("flow", "s1", {"v": 2}, ttl=10)
    assert await store.peek("flow", "s1") == {"v": 1}
    clock.now += 11
    await store.put("flow", "s1", {"v": 3}, ttl=10)
    assert await store.peek("flow", "s1") == {"v": 3}


async def test_delete_and_namespaces() -> None:
    store = MemoryOneTimeStore()
    await store.put("a", "k", {"v": 1}, ttl=10)
    await store.put("b", "k", {"v": 2}, ttl=10)
    await store.delete("a", "k")
    assert await store.peek("a", "k") is None
    assert await store.peek("b", "k") == {"v": 2}


async def test_the_lock_is_exclusive_across_workers_sharing_a_table() -> None:
    clock = Clock()
    table: dict = {}
    first, second = MemorySessionLock(table, clock), MemorySessionLock(table, clock)
    token = await first.acquire("identity:refresh:sid", 30_000)
    assert token
    assert await second.acquire("identity:refresh:sid", 30_000) is None
    assert await second.acquire("identity:refresh:other", 30_000)
    assert await first.release("identity:refresh:sid", token) is True
    assert await second.acquire("identity:refresh:sid", 30_000)


async def test_a_non_owner_cannot_release_the_lock() -> None:
    clock = Clock()
    lock = MemorySessionLock(clock=clock)
    token = await lock.acquire("k", 1000)
    assert await lock.release("k", "not-the-owner") is False
    assert await lock.acquire("k", 1000) is None
    assert await lock.release("k", token) is True


async def test_expiry_frees_the_lock_and_the_old_owner_cannot_free_the_new_one() -> None:
    clock = Clock()
    lock = MemorySessionLock(clock=clock)
    old = await lock.acquire("k", 1000)
    clock.now += 1.5
    new = await lock.acquire("k", 1000)
    assert new and new != old
    assert await lock.release("k", old) is False
    assert await lock.acquire("k", 1000) is None
    assert await lock.release("k", new) is True

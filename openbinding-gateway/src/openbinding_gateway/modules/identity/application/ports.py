"""The ports the identity module's application code talks to, implemented in ``adapters``."""

from __future__ import annotations

from typing import Protocol


class OneTimeStore(Protocol):
    """Short-lived JSON records keyed by ``(namespace, key)``: flow state, pending sign-ups.

    ``put`` never overwrites (set-if-absent); ``peek`` reads without consuming; ``pop`` reads and deletes in one
    step, so a record is consumed exactly once; ``delete`` drops it.
    """

    async def put(self, namespace: str, key: str, value: dict, ttl: int) -> None: ...

    async def peek(self, namespace: str, key: str) -> dict | None: ...

    async def pop(self, namespace: str, key: str) -> dict | None: ...

    async def delete(self, namespace: str, key: str) -> None: ...


class SessionLock(Protocol):
    """A lock shared by every worker of the gateway, held by whoever holds its owner token.

    ``acquire`` answers the owner token, or ``None`` while somebody else holds the lock; ``release`` frees it
    only for the owner (``False`` otherwise), so a worker whose lock expired cannot free another worker's.
    """

    async def acquire(self, key: str, ttl_ms: int) -> str | None: ...

    async def release(self, key: str, token: str) -> bool: ...

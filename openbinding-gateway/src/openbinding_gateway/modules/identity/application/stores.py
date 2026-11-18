"""The registry of the identity module's ports: the one-time store and the lock.

``application`` never imports ``adapters`` (the module-inside contract), so the composition root installs the
adapters here (``main._lifespan``, by ``IDENTITY_STORE_BACKEND``) and the tests install memory ones
(``tests/conftest.py``), as the plans module's pricing source is installed.
"""

from __future__ import annotations

from .ports import OneTimeStore, SessionLock


class IdentityStoreNotConfigured(RuntimeError):
    """No store or lock was installed: the gateway was started without its lifespan."""


_store: OneTimeStore | None = None
_lock: SessionLock | None = None


def set_store(store: OneTimeStore | None) -> None:
    global _store
    _store = store


def get_store() -> OneTimeStore:
    if _store is None:
        raise IdentityStoreNotConfigured("no identity one-time store is installed")
    return _store


def set_lock(lock: SessionLock | None) -> None:
    global _lock
    _lock = lock


def get_lock() -> SessionLock:
    if _lock is None:
        raise IdentityStoreNotConfigured("no identity session lock is installed")
    return _lock

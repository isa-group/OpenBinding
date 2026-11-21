"""The registry of the identity module's ports: the one-time store, the lock, the Identity client and the
account hook.

``application`` never imports ``adapters`` (the module-inside contract), so the composition root installs the
adapters here (``main._lifespan``, by ``IDENTITY_STORE_BACKEND``) and the tests install memory ones
(``tests/conftest.py``), as the plans module's pricing source is installed.
"""

from __future__ import annotations

from .ports import AccountHook, OidcClient, OneTimeStore, SessionLock


class IdentityStoreNotConfigured(RuntimeError):
    """No store or lock was installed: the gateway was started without its lifespan."""


_store: OneTimeStore | None = None
_oidc: OidcClient | None = None
_lock: SessionLock | None = None
_account_hook: AccountHook | None = None


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


def set_oidc(client: OidcClient | None) -> None:
    global _oidc
    _oidc = client


def get_oidc() -> OidcClient:
    if _oidc is None:
        raise IdentityStoreNotConfigured("no SCORETech Identity client is installed")
    return _oidc


def set_account_hook(hook: AccountHook | None) -> None:
    global _account_hook
    _account_hook = hook


def get_account_hook() -> AccountHook:
    """The hook ``main`` installs when it is imported; without it no account is provisioned, since an account
    must not exist without its personal organization."""
    if _account_hook is None:
        raise IdentityStoreNotConfigured("no account hook is installed")
    return _account_hook

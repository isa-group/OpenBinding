"""What ``GET /v1/auth/config`` tells the frontend, and the mode checks of the sign-in routes.

Adapted from SPHERE's ``authenticationConfig`` (``api/src/main/services/scoretech/config.ts``, MIT,
SCORELabUS/SPHERE@73779a8a): the provider and the three browser URLs, never a secret, a client id or the
transport. SPHERE's ``identityAvailable`` is not copied; an unreachable Identity is reported by the login
route (``identity_error=unavailable``).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from fastapi import Depends, status

from ....core.settings import Settings, get_settings
from ....models.accounts import AuthConfigView
from ....models.errors import api_error

Provider = Literal["local", "scoretech", "any"]


def auth_config_view(settings: Settings) -> AuthConfigView:
    if settings.auth_provider != "scoretech":
        return AuthConfigView(provider="local")
    login = settings.identity_login_url
    return AuthConfigView(
        provider="scoretech",
        login_url=login,
        register_url=f"{login}?screen=register",
        account_url=settings.identity_account_url,
    )


def startup_warnings(settings: Settings) -> list[str]:
    """The warnings the gateway logs once at startup about how it signs people in."""
    warnings = []
    if settings.app_env == "prod" and settings.auth_provider == "local":
        warnings.append(
            "auth_provider_local_in_production: AUTH_PROVIDER=local in production is the documented "
            "rollback; set AUTH_PROVIDER=scoretech once the Identity client exists (docs/IDENTITY.md)"
        )
    return warnings


def refuse_outside(mode: Provider, settings: Settings) -> None:
    """Raise the 409 of a route that serves another mode than the gateway's (``requires_provider``)."""
    if mode == "any" or mode == settings.auth_provider:
        return
    if mode == "scoretech":
        raise api_error(
            status.HTTP_409_CONFLICT,
            "identity_disabled",
            "This gateway does not sign people in with SCORETech Identity (AUTH_PROVIDER=local).",
        )
    raise api_error(
        status.HTTP_409_CONFLICT,
        "local_auth_disabled",
        "This gateway signs people in with SCORETech Identity; local credentials are not accepted.",
    )


@lru_cache(maxsize=None)
def requires_provider(mode: Provider, *, browser: bool = False):
    """A dependency that refuses (409) a request for a route of another mode than the gateway's.

    Every ``/v1/auth`` route declares one (``tests/identity/test_auth_route_modes.py`` enumerates them), so
    routes are mounted in both modes and the OpenAPI document does not depend on ``AUTH_PROVIDER``. ``browser``
    routes are navigated to, not fetched: they answer a redirect themselves instead of a 409. The returned
    function carries ``auth_provider`` (and ``auth_browser``) so the route table can be checked.
    """

    def dependency(settings: Settings = Depends(get_settings)) -> None:
        if not browser:
            refuse_outside(mode, settings)

    dependency.auth_provider = mode  # type: ignore[attr-defined]
    dependency.auth_browser = browser  # type: ignore[attr-defined]
    dependency.__name__ = f"requires_provider_{mode}{'_browser' if browser else ''}"
    return dependency


def managed_by_identity(settings: Settings) -> None:
    """409 ``managed_by_identity`` for a change of email or password in ``scoretech`` mode."""
    if settings.auth_provider == "scoretech":
        raise api_error(
            status.HTTP_409_CONFLICT,
            "managed_by_identity",
            "Your email and sign-in are managed in your SCORETech Identity account.",
        )

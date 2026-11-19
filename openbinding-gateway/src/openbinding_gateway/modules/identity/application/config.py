"""What ``GET /v1/auth/config`` tells the frontend, and the mode checks of the sign-in routes.

Adapted from SPHERE's ``authenticationConfig`` (``api/src/main/services/scoretech/config.ts``, MIT,
SCORELabUS/SPHERE@73779a8a): the provider and the three browser URLs, never a secret, a client id or the
transport. SPHERE's ``identityAvailable`` is not copied; an unreachable Identity is reported by the login
route (``identity_error=unavailable``).
"""

from __future__ import annotations

from typing import Literal

from fastapi import status

from ....core.settings import Settings
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

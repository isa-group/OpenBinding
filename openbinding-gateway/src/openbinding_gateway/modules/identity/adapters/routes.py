"""The sign-in routes: ``GET /v1/auth/config`` and the SCORETech Identity backend-for-frontend.

Every ``/v1/auth`` route is mounted in both modes and declares the mode it serves with
``requires_provider`` (``tests/identity/test_auth_route_modes.py`` enumerates them), so there is one OpenAPI
document whatever ``AUTH_PROVIDER`` says. Adapted from SPHERE's ``ScoretechIdentityController``
(SCORELabUS/SPHERE@73779a8a, MIT), whose mode policy matched paths by regex.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import session_dependency
from ....core.ratelimit import enforce_auth_rate_limit
from ....core.settings import Settings, get_settings
from ....models.accounts import AuthConfigView
from ..application import flows
from ..application.config import Provider, auth_config_view, refuse_outside
from ..application.stores import IdentityStoreNotConfigured
from ..domain.errors import IDENTITY_ERROR_CODES, IdentityError
from . import cookies

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/auth", tags=["Authentication"])


@lru_cache(maxsize=None)
def requires_provider(mode: Provider, *, browser: bool = False):
    """A dependency that refuses (409) a request for a route of another mode than the gateway's.

    ``browser`` routes are navigated to, not fetched: they answer a redirect themselves instead of a 409.
    The returned function carries ``auth_provider`` so the route table can be checked.
    """

    def dependency(settings: Settings = Depends(get_settings)) -> None:
        if not browser:
            refuse_outside(mode, settings)

    dependency.auth_provider = mode  # type: ignore[attr-defined]
    dependency.__name__ = f"requires_provider_{mode}{'_browser' if browser else ''}"
    return dependency


@router.get(
    "/config",
    response_model=AuthConfigView,
    operation_id="getAuthConfig",
    summary="How this gateway signs people in",
    dependencies=[Depends(requires_provider("any"))],
)
async def get_auth_config(settings: Settings = Depends(get_settings)) -> AuthConfigView:
    """The provider and, in `scoretech` mode, where the browser signs in, registers and manages its account.

    Public; it names no secret, client id or internal address.
    """
    return auth_config_view(settings)


def _redirect(location: str, status_code: int = status.HTTP_303_SEE_OTHER) -> RedirectResponse:
    return RedirectResponse(location, status_code=status_code)


def _apply(response: RedirectResponse, settings: Settings, outcome: flows.Outcome) -> RedirectResponse:
    if outcome.session_cookie:
        cookies.set_cookie(
            response, settings, cookies.name(settings, cookies.SESSION), outcome.session_cookie, outcome.session_max_age
        )
    elif outcome.clear_session:
        cookies.clear_cookie(response, settings, cookies.name(settings, cookies.SESSION))
    if outcome.pending_cookie:
        cookies.set_cookie(
            response, settings, cookies.name(settings, cookies.PENDING), outcome.pending_cookie, outcome.pending_max_age
        )
    return response


_REDIRECT_CODES = ", ".join(f"`{code}`" for code in IDENTITY_ERROR_CODES)


@router.get(
    "/identity/login",
    operation_id="startIdentitySignIn",
    summary="Start signing in (or registering) with SCORETech Identity",
    status_code=status.HTTP_302_FOUND,
    response_class=RedirectResponse,
    dependencies=[Depends(requires_provider("scoretech", browser=True))],
    responses={
        302: {"description": "To SCORETech Identity's sign-in (or registration) page, with a flow cookie."},
        303: {"description": "To `/authentication?identity_error=unavailable` when Identity cannot be used."},
        429: {"description": "Too many sign-ins from this address; see `Retry-After`."},
    },
)
async def identity_login(
    request: Request,
    screen: Literal["login", "register"] = Query(default="login"),
    return_to: str | None = Query(default=None, alias="returnTo", max_length=2048),
    settings: Settings = Depends(get_settings),
) -> RedirectResponse:
    """Navigated to by the browser. `returnTo` is a frontend path, kept only when it is safe."""
    if settings.auth_provider != "scoretech":
        return _redirect(flows.error_target(settings, "unavailable"))
    await enforce_auth_rate_limit(request, "identity_login", None, settings)
    try:
        begun = await flows.begin(settings, return_to, register=screen == "register")
    except (IdentityError, IdentityStoreNotConfigured) as error:
        logger.info("identity_login_unavailable error=%s", type(error).__name__)
        return _redirect(flows.error_target(settings, "unavailable"))
    except Exception as error:  # noqa: BLE001 - a store outage must not loop the browser
        logger.warning("identity_login_unavailable error=%s", type(error).__name__)
        return _redirect(flows.error_target(settings, "unavailable"))
    response = _redirect(begun.location, status.HTTP_302_FOUND)
    cookies.set_cookie(response, settings, cookies.flow_name(settings, begun.state), begun.binding, flows.FLOW_TTL_S)
    return response


@router.get(
    "/identity/callback",
    operation_id="completeIdentitySignIn",
    summary="Finish a SCORETech Identity sign-in and return to the frontend",
    status_code=status.HTTP_303_SEE_OTHER,
    response_class=RedirectResponse,
    dependencies=[Depends(requires_provider("scoretech", browser=True))],
    responses={
        303: {
            "description": (
                "To `/sso/identity/callback?returnTo=` with a session cookie, to `/sso/identity/username?returnTo=` "
                "for a first sign-in, or to `/authentication?identity_error=<code>`, where code is one of: "
                + _REDIRECT_CODES
                + ". The destination comes from configuration only, never from the request."
            )
        },
        429: {"description": "Too many callbacks from this address; see `Retry-After`."},
    },
)
async def identity_callback(
    request: Request,
    state: str | None = Query(default=None, max_length=128),
    code: str | None = Query(default=None, max_length=8192),
    error: str | None = Query(default=None, max_length=128),
    iss: str | None = Query(default=None, max_length=2048),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> RedirectResponse:
    if settings.auth_provider != "scoretech":
        return _redirect(flows.error_target(settings, "unavailable"))
    await enforce_auth_rate_limit(request, "identity_callback", None, settings)
    flow_cookie = cookies.flow_name(settings, state) if state and flows.HEX64.fullmatch(state) else None
    try:
        outcome = await flows.callback(
            session,
            settings,
            state=state,
            code=code,
            error=error,
            iss=iss,
            binding=request.cookies.get(flow_cookie) if flow_cookie else None,
            presented_session=request.cookies.get(cookies.name(settings, cookies.SESSION)),
        )
    except Exception as failure:  # noqa: BLE001 - every failure becomes a redirect with a closed code
        await session.rollback()
        logger.warning("identity_callback_failed error=%s", type(failure).__name__)
        outcome = flows.Outcome(target=flows.error_target(settings, "signin_failed"))
    response = _apply(_redirect(outcome.target), settings, outcome)
    if flow_cookie and flow_cookie in request.cookies and not outcome.target.endswith("identity_error=expired"):
        cookies.clear_cookie(response, settings, flow_cookie)
    return response

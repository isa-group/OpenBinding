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

from datetime import timedelta

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import session_dependency
from ....core.ratelimit import enforce_auth_rate_limit
from ....core.settings import Settings, get_settings
from ....models.accounts import AccessGrant, AuthConfigView, SignOutRequest, CompletedSignUp, CompleteSignUpRequest, PendingSignUp
from ....models.errors import CONFLICT_RESPONSE, ErrorResponse, NOT_FOUND_RESPONSE, api_error
from ....security.tokens import issue_access_token
from ....db.models import IdentitySession, User, utcnow
from sqlalchemy import update
from ..application import flows, provisioning, sessions
from ..application.renewal import RenewalBusy, renewer
from ..application.config import Provider, auth_config_view, refuse_outside
from ..application.stores import IdentityStoreNotConfigured
from ..domain.errors import IDENTITY_ERROR_CODES, IdentityEnded, IdentityError, IdentityUnavailable
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


_PENDING_RESPONSES = {404: {**NOT_FOUND_RESPONSE, "description": "No sign-up is waiting (`no_pending_signup`)."}}


@router.get(
    "/identity/pending",
    response_model=PendingSignUp,
    operation_id="getPendingIdentitySignUp",
    summary="The first SCORETech sign-in waiting for its username",
    dependencies=[Depends(requires_provider("scoretech"))],
    responses=_PENDING_RESPONSES,
)
async def identity_pending(
    request: Request,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> PendingSignUp:
    """Read with the pending cookie the callback set; the email is shown only when Identity verified it."""
    found = await provisioning.read_pending(session, request.cookies.get(cookies.name(settings, cookies.PENDING)))
    if found is None:
        raise provisioning._no_pending()
    _, record = found
    return PendingSignUp(
        suggested_username=await provisioning.suggestion(session, record),
        email=record.get("email") if record.get("email_verified") else None,
        email_verified=record.get("email_verified") is True,
        display_name=record.get("display_name"),
        expires_at=provisioning.expires_at_of(record),
    )


@router.post(
    "/identity/complete",
    response_model=CompletedSignUp,
    status_code=status.HTTP_201_CREATED,
    operation_id="completeIdentitySignUp",
    summary="Choose a username and create the account of a first SCORETech sign-in",
    dependencies=[Depends(requires_provider("scoretech"))],
    responses={
        **_PENDING_RESPONSES,
        403: {"model": ErrorResponse, "description": "Not from the frontend's origin (`origin_refused`)."},
        409: {
            **CONFLICT_RESPONSE,
            "description": (
                "`username_taken`, `username_unavailable`, `account_not_linked`, `pending_in_progress` or "
                "`identity_already_provisioned`."
            ),
        },
        429: {"description": "Too many attempts; see `Retry-After`."},
    },
)
async def identity_complete(
    payload: CompleteSignUpRequest,
    request: Request,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> JSONResponse:
    cookies.require_same_origin(request, settings)
    pending_cookie = request.cookies.get(cookies.name(settings, cookies.PENDING))
    key = provisioning.pending_key(pending_cookie) if pending_cookie else None
    await enforce_auth_rate_limit(request, "identity_complete", key, settings)
    done = await provisioning.complete(session, settings, pending_cookie, payload.username)
    response = JSONResponse(CompletedSignUp(return_to=done.return_to).model_dump(), status_code=status.HTTP_201_CREATED)
    cookies.set_cookie(response, settings, cookies.name(settings, cookies.SESSION), done.session_cookie, done.session_max_age)
    cookies.clear_cookie(response, settings, cookies.name(settings, cookies.PENDING))
    return response


def _cleared_session_header(settings: Settings) -> str:
    response = Response()
    cookies.clear_cookie(response, settings, cookies.name(settings, cookies.SESSION))
    return response.headers["set-cookie"]


def _session_refused(settings: Settings, code: str, message: str) -> Exception:
    return api_error(
        status.HTTP_401_UNAUTHORIZED, code, message, headers={"Set-Cookie": _cleared_session_header(settings)}
    )


def _identity_unavailable(retry_after: int) -> Exception:
    return api_error(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "identity_unavailable",
        "SCORETech Identity cannot renew this session right now; try again shortly.",
        headers={"Retry-After": str(retry_after)},
    )


@router.post(
    "/identity/session",
    response_model=AccessGrant,
    operation_id="mintSessionAccessToken",
    summary="Mint a short gateway token from the session cookie, renewing Identity when needed",
    dependencies=[Depends(requires_provider("any"))],
    responses={
        401: {"model": ErrorResponse, "description": "`no_session` or `session_ended`; the cookie is cleared."},
        403: {"model": ErrorResponse, "description": "Not from the frontend's origin (`origin_refused`)."},
        429: {"description": "Too many renewals; see `Retry-After`."},
        503: {"model": ErrorResponse, "description": "`identity_unavailable`; see `Retry-After`. The session survives."},
    },
)
async def identity_session(
    request: Request,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> JSONResponse:
    """The browser's only credential is the HttpOnly cookie; this turns it into a 5-minute bearer token.

    Each call also keeps the session from going idle. In `scoretech` mode the Identity access behind it is
    renewed (once per expiry, whatever the number of tabs or workers).
    """
    cookies.require_same_origin(request, settings)
    value = request.cookies.get(cookies.name(settings, cookies.SESSION))
    await enforce_auth_rate_limit(
        request, "identity_session", sessions.cookie_hash(value) if value else None, settings
    )
    row = await sessions.find_by_cookie(session, value)
    if row is None:
        raise _session_refused(settings, "no_session", "There is no session; sign in.")
    now = utcnow()
    if not sessions.is_live(row, now) or row.provider != settings.auth_provider:
        raise _session_refused(settings, "session_ended", "This session has ended; sign in again.")
    try:
        await renewer.renew(session, settings, row)
    except RenewalBusy:
        raise _identity_unavailable(1) from None
    except IdentityEnded:
        raise _session_refused(settings, "session_ended", "This session has ended; sign in again.") from None
    except IdentityUnavailable:
        raise _identity_unavailable(5) from None
    row = (
        await session.execute(
            select(IdentitySession).where(IdentitySession.id == row.id).execution_options(populate_existing=True)
        )
    ).scalars().one()
    user = await session.get(User, row.user_id)
    if row.revoked_at is not None:
        raise _session_refused(settings, "session_ended", "This session has ended; sign in again.")
    if user is None or not user.is_active or user.deleted_at is not None:
        await sessions.revoke(session, row, "deactivated")
        raise _session_refused(settings, "session_ended", "This account is not active.")
    idle = now + timedelta(seconds=settings.session_idle_s)
    await session.execute(
        update(IdentitySession)
        .where(IdentitySession.id == row.id, IdentitySession.revoked_at.is_(None))
        .values(idle_expires_at=idle, last_renewed_at=now)
        .execution_options(synchronize_session=False)
    )
    row.idle_expires_at, row.last_renewed_at = idle, now
    secret = settings.gateway_jwt_secret
    if not secret:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "auth_unavailable", "This gateway has no signing secret configured.")
    token = issue_access_token(
        secret,
        user_id=user.id,
        ttl_seconds=settings.access_token_ttl_s,
        session_id=row.id,
        provider=row.provider,
        issuer=settings.gateway_jwt_issuer,
        audience=settings.gateway_jwt_audience,
    )
    response = JSONResponse(
        AccessGrant(access_token=token, expires_in=settings.access_token_ttl_s).model_dump()
    )
    cookies.set_cookie(
        response, settings, cookies.name(settings, cookies.SESSION), value, sessions.remaining_seconds(row, now)
    )
    return response


@router.post(
    "/identity/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="signOut",
    summary="Sign out: end this session (or every session of the account) and the SCORETech SSO session",
    dependencies=[Depends(requires_provider("any"))],
    responses={403: {"model": ErrorResponse, "description": "Not from the frontend's origin (`origin_refused`)."}},
)
async def identity_logout(
    request: Request,
    payload: SignOutRequest | None = None,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Always 204. A tokens minted from the session stop working at once; in `scoretech` mode the Identity
    session behind it is ended too (so signing in again asks for a code), and so is a sign-up still waiting
    for its username."""
    cookies.require_same_origin(request, settings)
    await sessions.logout(
        session,
        settings,
        session_cookie=request.cookies.get(cookies.name(settings, cookies.SESSION)),
        pending_cookie=request.cookies.get(cookies.name(settings, cookies.PENDING)),
        scope=(payload.scope if payload else "this"),
    )
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    cookies.clear_cookie(response, settings, cookies.name(settings, cookies.SESSION))
    cookies.clear_cookie(response, settings, cookies.name(settings, cookies.PENDING))
    return response

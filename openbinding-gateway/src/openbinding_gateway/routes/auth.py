"""Registering, signing in, and ending a session.

Registration is open: anyone may create an account, and it starts on the free
plan. That is a product decision rather than an oversight, and it is the reason
the quota work exists - an open door needs a meter behind it, not a lock.

A sign-in or a registration opens the same browser session SCORETech Identity
sign-ins open (``identity_sessions``, provider ``local``): an HttpOnly cookie the
SPA turns into short gateway tokens at ``POST /v1/auth/identity/session`` and ends
at ``POST /v1/auth/identity/logout``. The token login returns is bound to that
session (``sid``), so signing out ends it at once. A present ``Origin`` outside the
frontend's must not sign anybody in (login CSRF); an absent one passes, for scripts.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.contracts import create_contract_or_mark_pending

from ..access.dependencies import get_user_by_identifier, session_dependency
from ..core.ratelimit import enforce_auth_rate_limit
from ..core.settings import Settings, get_settings
from ..db.models import ApiKey, AuditEvent, Notification, PasswordResetToken, User, UserRole, utcnow
from ..mailer import send_mail
from ..models.accounts import (
    AccessGrant,
    LoginRequest,
    RegisterRequest,
    PasswordResetComplete,
    PasswordResetRequest,
    UserProfile,
)
from ..models.errors import (
    CONFLICT_RESPONSE,
    ErrorResponse,
    UNAUTHORIZED_RESPONSE,
    UNAVAILABLE_RESPONSE,
    api_error,
)
from ..security.passwords import hash_password, password_complaint, verify_password
from .users import profile_of
from ..modules.identity.application import (
    access_token_for,
    end_all,
    open_local,
    presented_session,
    refuse_foreign_origin,
    remaining_seconds,
    requires_provider,
    set_session_cookie,
    username_reserved,
    username_unavailable,
)

#: Every route here serves ``AUTH_PROVIDER=local`` only: in ``scoretech`` mode each answers 409
#: ``local_auth_disabled`` (SCORETech Identity is then the only way in).
router = APIRouter(
    prefix="/v1/auth", tags=["Authentication"], dependencies=[Depends(requires_provider("local"))]
)

ORIGIN_REFUSED_RESPONSE = {
    "model": ErrorResponse,
    "description": "Sent by a browser from another origin than the frontend's (`origin_refused`).",
}

TOO_MANY_ATTEMPTS_RESPONSE = {
    "model": ErrorResponse,
    "description": "Too many attempts from this address; see the `Retry-After` header.",
}


def _signing_secret(settings: Settings) -> str:
    secret = settings.gateway_jwt_secret
    if not secret:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "auth_unavailable",
            "This gateway has no signing secret configured.",
        )
    return secret


async def _open_session(
    session: AsyncSession, user: User, settings: Settings, request: Request, response: Response
) -> str:
    """Open a ``local`` browser session for ``user``, set its cookie on ``response``; a token bound to it."""
    secret = _signing_secret(settings)
    row, value = await open_local(session, user, settings=settings, presented=presented_session(request, settings))
    set_session_cookie(response, settings, value, remaining_seconds(row, utcnow()))
    return access_token_for(settings, secret, row)


async def _issue_session(
    session: AsyncSession, user: User, settings: Settings, request: Request, response: Response
) -> AccessGrant:
    """A local session (cookie) and a short token bound to it."""
    token = await _open_session(session, user, settings, request, response)
    return AccessGrant(access_token=token, expires_in=settings.access_token_ttl_s)


@router.post(
    "/register",
    response_model=UserProfile,
    status_code=status.HTTP_201_CREATED,
    operation_id="register",
    summary="Create an account",
    responses={403: ORIGIN_REFUSED_RESPONSE, 409: CONFLICT_RESPONSE, 422: {"description": "The password is not acceptable."},
               429: TOO_MANY_ATTEMPTS_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def register(
    request: RegisterRequest,
    http_request: Request,
    http_response: Response,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> UserProfile:
    """Create the account and sign it in: the answer sets the session cookie, as a sign-in does."""
    refuse_foreign_origin(http_request, settings)
    await enforce_auth_rate_limit(http_request, "register", request.email, settings)
    complaint = password_complaint(request.password)
    if complaint:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "weak_password", complaint)

    email = request.email.lower()
    if await get_user_by_identifier(session, request.username) or await get_user_by_identifier(
        session, email
    ):
        # One message for both cases: saying which of the two was taken tells
        # an unauthenticated caller who has an account here.
        raise api_error(
            status.HTTP_409_CONFLICT,
            "already_registered",
            "That username or email is already in use.",
        )
    if await username_reserved(session, request.username):
        raise username_unavailable()

    # The plan a sign-up starts on is configuration (SPACE_DEFAULT_PLAN). Unset,
    # the account is created without one and SPACE assigns the contract's plan.
    default_plan = settings.space_default_plan or None

    user = User(
        username=request.username,
        email=email,
        password_hash=hash_password(request.password),
        password_enabled=True,
        role=UserRole.USER,
        plan_cache=default_plan or "",
        # The SPACE contract is created next, by the caller of this module.
        # Until it exists the account is usable but unmetered, and this flag
        # is what later reconciles it.
        contract_pending=True,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError:
        # Two registrations racing for one name, or "Alice" beside "alice" (uq_users_username_lower).
        await session.rollback()
        raise api_error(
            status.HTTP_409_CONFLICT,
            "already_registered",
            "That username or email is already in use.",
        ) from None

    # A contract is what entitles the account to anything, but registration
    # does not depend on SPACE being up: the account is created either way and
    # `contract_pending` records that it still owes one, to be settled the next
    # time this user turns up. Losing the sign-up because a pricing service was
    # restarting would be a worse failure than a delayed contract.
    await create_contract_or_mark_pending(user, default_plan, settings)

    await _open_session(session, user, settings, http_request, http_response)
    return await profile_of(session, user)


@router.post(
    "/login",
    response_model=AccessGrant,
    operation_id="login",
    summary="Start a session",
    responses={401: UNAUTHORIZED_RESPONSE, 403: ORIGIN_REFUSED_RESPONSE, 429: TOO_MANY_ATTEMPTS_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def login(
    request: LoginRequest,
    http_request: Request,
    http_response: Response,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> AccessGrant:
    """The session cookie, and a token bound to that session (a SPA renews it from the cookie)."""
    refuse_foreign_origin(http_request, settings)
    # Before the password hash, which is the expensive part an attacker wants us to repeat.
    await enforce_auth_rate_limit(http_request, "login", request.username_or_email, settings)
    user = await get_user_by_identifier(session, request.username_or_email)

    # Verify even when there is no such user, so that a wrong username and a
    # wrong password take the same time to answer.
    password_hash = user.password_hash if user else _DUMMY_HASH
    password_matches = verify_password(request.password, password_hash)

    if user is None or not password_matches or not user.is_active or not user.password_enabled:
        raise api_error(
            status.HTTP_401_UNAUTHORIZED,
            "invalid_credentials",
            "Those credentials do not match an active account.",
        )

    return await _issue_session(session, user, settings, http_request, http_response)


#: An argon2 hash of nothing in particular, used to spend the same time on a
#: login for an account that does not exist as on one that does.
_DUMMY_HASH = hash_password("openbinding-timing-equalizer")


@router.post(
    "/password-reset/request",
    status_code=status.HTTP_202_ACCEPTED,
    operation_id="requestPasswordReset",
    summary="Request a one-time password reset",
    responses={429: TOO_MANY_ATTEMPTS_RESPONSE},
)
async def request_password_reset(
    payload: PasswordResetRequest,
    http_request: Request,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> dict:
    # Counted per address and per email (hashed) whether or not the account exists: the answer stays uniform.
    await enforce_auth_rate_limit(http_request, "reset_request", str(payload.email).lower(), settings)
    user = await get_user_by_identifier(session, str(payload.email).lower())
    response = {"accepted": True, "delivery": "email" if settings.smtp_url else "inbox"}
    if user is None or not user.is_active:
        return response
    secret = secrets.token_urlsafe(32)
    prefix = secrets.token_hex(6)
    token = f"obr_{prefix}_{secret}"
    session.add(PasswordResetToken(
        user_id=user.id, token_prefix=f"obr_{prefix}",
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        expires_at=utcnow() + timedelta(minutes=30),
    ))
    session.add(Notification(
        user_id=user.id, kind="password_reset", subject="Password reset requested",
        body="A password reset was requested. It expires in 30 minutes.", payload={},
    ))
    # The frontend's reset screen (`/reset-password`, frontend/src/routes/router.tsx) reads `token` from its query.
    reset_url = f"{settings.frontend_url.rstrip('/')}/reset-password?{urlencode({'token': token})}"
    await send_mail(
        settings, user.email, "Reset your OpenBinding password",
        f"Use this single-use link within 30 minutes:\n\n{reset_url}\n",
    )
    if settings.expose_recovery_tokens:
        response["token"] = token
    return response


@router.post(
    "/password-reset/complete",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="completePasswordReset",
    summary="Spend a reset token and set a password",
    responses={429: TOO_MANY_ATTEMPTS_RESPONSE},
)
async def complete_password_reset(
    payload: PasswordResetComplete,
    http_request: Request,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> None:
    await enforce_auth_rate_limit(http_request, "reset_complete", None, settings)
    complaint = password_complaint(payload.new_password)
    if complaint:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "weak_password", complaint)
    parts = payload.token.split("_", 2)
    if len(parts) != 3 or parts[0] != "obr":
        raise api_error(status.HTTP_401_UNAUTHORIZED, "reset_token_invalid", "Reset token is invalid or expired.")
    stored = (await session.execute(select(PasswordResetToken).where(
        PasswordResetToken.token_prefix == f"obr_{parts[1]}"
    ))).scalars().first()
    candidate = hashlib.sha256(payload.token.encode()).hexdigest()
    valid = stored is not None and stored.used_at is None and stored.expires_at.replace(
        tzinfo=stored.expires_at.tzinfo or utcnow().tzinfo
    ) > utcnow() and secrets.compare_digest(candidate, stored.token_hash)
    if not valid:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "reset_token_invalid", "Reset token is invalid or expired.")
    user = await session.get(User, stored.user_id)
    if user is None or not user.is_active:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "reset_token_invalid", "Reset token is invalid or expired.")
    user.password_hash = hash_password(payload.new_password)
    user.password_enabled = True
    stored.used_at = utcnow()
    await session.execute(ApiKey.__table__.update().where(
        ApiKey.user_id == user.id, ApiKey.revoked_at.is_(None)
    ).values(revoked_at=utcnow()))
    # Every browser session of the account ends too (and any SCORETech session behind one, after a rollback).
    await end_all(session, settings, user, "password_reset")
    session.add(AuditEvent(
        actor_id=user.id, action="account.password_reset.completed", target_type="User", target_id=user.id, detail={},
    ))

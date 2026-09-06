"""Registering, signing in, and ending a session.

Registration is open: anyone may create an account, and it starts on the free
plan. That is a product decision rather than an oversight, and it is the reason
the quota work exists - an open door needs a meter behind it, not a lock.

Sessions are a short-lived access token plus a refresh token that is rotated on
every use. Rotation is what makes a stolen refresh token survivable: using it
invalidates it, so the legitimate holder and the thief cannot both keep going,
and the one who loses is forced to sign in again.
"""

from __future__ import annotations

import uuid
import hashlib
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_user_by_identifier, session_dependency
from ..core.settings import Settings, get_settings
from ..db.models import ApiKey, Notification, PasswordResetToken, RefreshToken, User, UserRole, utcnow
from ..mailer import send_mail
from ..models.accounts import (
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    RegisterRequest,
    PasswordResetComplete,
    PasswordResetRequest,
    TokenPair,
    UserProfile,
)
from ..models.errors import (
    CONFLICT_RESPONSE,
    UNAUTHORIZED_RESPONSE,
    UNAVAILABLE_RESPONSE,
    api_error,
)
from ..security.passwords import hash_password, password_complaint, verify_password
from ..security.tokens import (
    TokenError,
    issue_access_token,
    issue_refresh_token,
    read_refresh_token,
)
from .. import space_client
from ..space_client import PricingUnavailable
from ..pricing_catalog import PricingCatalogError, live_catalog

router = APIRouter(prefix="/v1/auth", tags=["Authentication"])


def _signing_secret(settings: Settings) -> str:
    secret = settings.gateway_jwt_secret
    if not secret:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "auth_unavailable",
            "This gateway has no signing secret configured.",
        )
    return secret


def _profile(user: User) -> UserProfile:
    return UserProfile(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role.value,
        is_active=user.is_active,
        plan=user.plan_cache,
        created_at=user.created_at,
    )


async def _issue_session(
    session: AsyncSession, user: User, settings: Settings
) -> TokenPair:
    """A fresh access token plus a refresh token recorded for later revocation."""
    secret = _signing_secret(settings)
    jti = uuid.uuid4()

    session.add(
        RefreshToken(
            jti=jti,
            user_id=user.id,
            expires_at=utcnow() + timedelta(seconds=settings.refresh_token_ttl_s),
        )
    )

    return TokenPair(
        access_token=issue_access_token(
            secret,
            user_id=user.id,
            role=user.role.value,
            ttl_seconds=settings.access_token_ttl_s,
        ),
        refresh_token=issue_refresh_token(
            secret, user_id=user.id, jti=jti, ttl_seconds=settings.refresh_token_ttl_s
        ),
        expires_in=settings.access_token_ttl_s,
    )


@router.post(
    "/register",
    response_model=UserProfile,
    status_code=status.HTTP_201_CREATED,
    operation_id="register",
    summary="Create an account",
    responses={409: CONFLICT_RESPONSE, 422: {"description": "The password is not acceptable."},
               503: UNAVAILABLE_RESPONSE},
)
async def register(
    request: RegisterRequest,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> UserProfile:
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

    try:
        default_plan = (await live_catalog(session, settings)).default_plan
    except PricingCatalogError as exc:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "pricing_unavailable",
            f"The active pricing cannot be resolved: {exc}",
        ) from exc

    user = User(
        username=request.username,
        email=email,
        password_hash=hash_password(request.password),
        password_enabled=True,
        role=UserRole.USER,
        plan_cache=default_plan,
        # The SPACE contract is created next, by the caller of this module.
        # Until it exists the account is usable but unmetered, and this flag
        # is what later reconciles it.
        contract_pending=True,
    )
    session.add(user)
    await session.flush()

    # A contract is what entitles the account to anything, but registration
    # does not depend on SPACE being up: the account is created either way and
    # `contract_pending` records that it still owes one, to be settled the next
    # time this user turns up. Losing the sign-up because a pricing service was
    # restarting would be a worse failure than a delayed contract.
    try:
        from ..access.contracts import live_pricing_version

        await space_client.get_gate().create_contract(
            user.id,
            default_plan,
            user.email,
            await live_pricing_version(session),
        )
        user.contract_pending = False
    except PricingUnavailable:
        user.contract_pending = True

    return _profile(user)


@router.post(
    "/login",
    response_model=TokenPair,
    operation_id="login",
    summary="Start a session",
    responses={401: UNAUTHORIZED_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def login(
    request: LoginRequest,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> TokenPair:
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

    return await _issue_session(session, user, settings)


@router.post(
    "/refresh",
    response_model=TokenPair,
    operation_id="refreshSession",
    summary="Exchange a refresh token for a new pair",
    responses={401: UNAUTHORIZED_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def refresh(
    request: RefreshRequest,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> TokenPair:
    try:
        claims = read_refresh_token(_signing_secret(settings), request.refresh_token)
    except TokenError as error:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "invalid_token", str(error)) from error

    stored = await session.get(RefreshToken, claims.jti)
    if stored is None or not stored.is_usable or stored.user_id != claims.user_id:
        raise api_error(
            status.HTTP_401_UNAUTHORIZED,
            "invalid_token",
            "That refresh token is spent, revoked or expired.",
        )

    user = await session.get(User, claims.user_id)
    if user is None or not user.is_active:
        raise api_error(
            status.HTTP_401_UNAUTHORIZED, "invalid_token", "That account is not active."
        )

    # Rotation: the presented token is spent whether or not the caller ever
    # sees the new one, so it cannot be replayed.
    stored.revoked_at = utcnow()

    return await _issue_session(session, user, settings)


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="logout",
    summary="End a session",
    responses={503: UNAVAILABLE_RESPONSE},
)
async def logout(
    request: LogoutRequest,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> None:
    """Revoke a refresh token.

    Answers the same way whatever the token turns out to be. Signing out is not
    an operation anybody should be able to use to find out whether a token was
    real, and the caller's intent is satisfied either way.
    """
    try:
        claims = read_refresh_token(_signing_secret(settings), request.refresh_token)
    except TokenError:
        return None

    stored = await session.get(RefreshToken, claims.jti)
    if stored is not None and stored.revoked_at is None:
        stored.revoked_at = utcnow()
    return None


#: An argon2 hash of nothing in particular, used to spend the same time on a
#: login for an account that does not exist as on one that does.
_DUMMY_HASH = hash_password("openbinding-timing-equalizer")


@router.post(
    "/password-reset/request",
    status_code=status.HTTP_202_ACCEPTED,
    operation_id="requestPasswordReset",
    summary="Request a one-time password reset",
)
async def request_password_reset(
    payload: PasswordResetRequest,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> dict:
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
    reset_url = f"{settings.frontend_url.rstrip('/')}/reset-password?token={token}"
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
)
async def complete_password_reset(
    payload: PasswordResetComplete,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
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
    await session.execute(RefreshToken.__table__.update().where(
        RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None)
    ).values(revoked_at=utcnow()))
    await session.execute(ApiKey.__table__.update().where(
        ApiKey.user_id == user.id, ApiKey.revoked_at.is_(None)
    ).values(revoked_at=utcnow()))

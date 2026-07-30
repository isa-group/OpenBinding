"""Who is calling, and whether they may.

The gateway serves two channels that used to be indistinguishable because
neither was authenticated: a browser and a script both simply posted to
``/v1/solve``. They stay indistinguishable here, deliberately - a session token
and an API key resolve to the same ``User`` row, so the pricing plan applies to
the caller rather than to the way they arrived.

``get_current_user`` refuses anyone it cannot identify; ``get_optional_user``
answers ``None`` instead, which is what the endpoints that stay open to visitors
need. Both go through the same resolution, so there is one place where a
credential turns into a user.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import Settings, get_settings
from ..db import base as db_base
from ..db.models import ApiKey, User, utcnow
from ..models.errors import api_error
from ..security.apikeys import looks_like_api_key, matches, prefix_of
from ..security.tokens import TokenError, bearer_token, read_access_token

#: What an unauthenticated caller is told to send.
_AUTHENTICATE_CHALLENGE = {"WWW-Authenticate": 'Bearer realm="openbinding"'}

#: How stale ``last_used_at`` is allowed to get before it is worth a write.
LAST_USED_RESOLUTION = timedelta(minutes=1)


def _as_utc(moment: datetime) -> datetime:
    """SQLite hands back naive datetimes; the stored value is UTC either way."""
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def accounts_enabled() -> bool:
    """Whether this deployment has the accounts module switched on."""
    return db_base.is_configured()


def require_accounts() -> None:
    """Refuse politely when the gateway is running without a database.

    The routes exist in the OpenAPI document whether or not a deployment
    configured a database, because the document describes the API rather than
    one installation of it. This is what the caller gets when the installation
    has not.
    """
    if not accounts_enabled():
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "accounts_unavailable",
            "This gateway is running without an accounts database.",
        )


async def session_dependency():
    """``get_session``, but with a clear failure when there is no database."""
    require_accounts()
    async for session in db_base.get_session():
        yield session


async def optional_session():
    """A session when there is a database, and ``None`` when there is not.

    The solving endpoints work either way: with a database a job gets an owner
    and a row, without one it behaves as the anonymous gateway always did.
    """
    if not accounts_enabled():
        yield None
        return
    async for session in db_base.get_session():
        yield session


def _signing_secret(settings: Settings) -> str:
    secret = settings.gateway_jwt_secret
    if not secret:
        # Refusing is the only safe answer: there is no default worth having,
        # and inventing one per process would sign tokens no replica accepts.
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "auth_unavailable",
            "This gateway has no signing secret configured.",
        )
    return secret


def _credential(request: Request) -> Optional[str]:
    """The credential this request carries, from either header.

    ``X-API-Key`` is the API channel's, ``Authorization: Bearer`` the browser's,
    and a script may put its key in either. Which kind of credential it is gets
    decided by whoever resolves it, not here.
    """
    api_key_header = request.headers.get("x-api-key")
    if api_key_header and api_key_header.strip():
        return api_key_header.strip()
    return bearer_token(request.headers.get("authorization"))


async def _user_for_api_key(credential: str, session: AsyncSession) -> Optional[User]:
    """The owner of an API key, or ``None``.

    Looked up by prefix and then compared in constant time, so an attacker
    learns nothing from how long a wrong key takes to be refused. Touching
    ``last_used_at`` is throttled: it is an audit hint, and writing a row on
    every API call would turn a read path into a write one.
    """
    prefix = prefix_of(credential)
    if prefix is None:
        return None

    result = await session.execute(select(ApiKey).where(ApiKey.prefix == prefix))
    api_key = result.scalars().first()
    if api_key is None or not api_key.is_active:
        return None
    if not matches(credential, api_key.secret_hash):
        return None

    now = utcnow()
    if api_key.last_used_at is None or (now - _as_utc(api_key.last_used_at)) > LAST_USED_RESOLUTION:
        api_key.last_used_at = now

    return await session.get(User, api_key.user_id)


async def _user_for_credential(
    credential: str, session: AsyncSession, settings: Settings
) -> Optional[User]:
    """The user a credential names, or ``None`` if it names nobody.

    This is the point where the two channels stop being different. A browser
    arrives with a session token and a script with an API key, and both leave
    here as the same ``User`` - which is what makes one pricing plan apply to
    someone however they chose to call.
    """
    if looks_like_api_key(credential):
        return await _user_for_api_key(credential, session)

    try:
        claims = read_access_token(_signing_secret(settings), credential)
    except TokenError:
        return None

    return await session.get(User, claims.user_id)


async def get_optional_user(
    request: Request,
    session: Optional[AsyncSession] = Depends(optional_session),
) -> Optional[User]:
    """The caller, when there is one. Visitors get ``None``, not an error.

    ``optional_session`` rather than ``session_dependency``, because this is the
    dependency public endpoints use and a gateway configured without a database
    still has to serve them. Insisting on a session would turn "nobody is signed
    in" into a 503 on a deployment where nobody can sign in at all.
    """
    if session is None:
        return None

    credential = _credential(request)
    if not credential:
        return None

    user = await _user_for_credential(credential, session, get_settings())
    if user is None or not user.is_active:
        return None
    return user


async def get_current_user(
    request: Request,
    session: AsyncSession = Depends(session_dependency),
) -> User:
    """The caller, or a refusal.

    A deactivated account is treated as no account at all rather than as a
    separate kind of failure, so that disabling someone takes effect on their
    next request without needing their tokens back.
    """
    credential = _credential(request)
    if not credential:
        raise api_error(
            status.HTTP_401_UNAUTHORIZED,
            "unauthorized",
            "This endpoint needs an account. Send a session token or an API key.",
            headers=_AUTHENTICATE_CHALLENGE,
        )

    user = await _user_for_credential(credential, session, get_settings())
    if user is None or not user.is_active:
        raise api_error(
            status.HTTP_401_UNAUTHORIZED,
            "unauthorized",
            "That credential is not valid.",
            headers=_AUTHENTICATE_CHALLENGE,
        )
    return user


async def solve_caller(
    request: Request,
    session: Optional[AsyncSession] = Depends(optional_session),
) -> Optional[User]:
    """Who is solving, under this deployment's rules.

    Three cases, and they are all deliberate. A gateway with no accounts
    database keeps serving anonymously. A gateway with accounts and
    ``AUTH_REQUIRED_FOR_SOLVE`` insists on knowing who is asking, because a
    solve is the expensive thing and an unattributed one cannot be metered.
    With that switched off, a caller is identified when they offer a
    credential and tolerated when they do not.
    """
    if session is None:
        return None

    settings = get_settings()
    credential = _credential(request)

    if not settings.auth_required_for_solve and not credential:
        return None

    if not credential:
        raise api_error(
            status.HTTP_401_UNAUTHORIZED,
            "unauthorized",
            "Solving needs an account. Send a session token or an API key.",
            headers=_AUTHENTICATE_CHALLENGE,
        )

    user = await _user_for_credential(credential, session, settings)
    if user is None or not user.is_active:
        raise api_error(
            status.HTTP_401_UNAUTHORIZED,
            "unauthorized",
            "That credential is not valid.",
            headers=_AUTHENTICATE_CHALLENGE,
        )
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "forbidden",
            "This endpoint is for administrators.",
        )
    return user


async def get_user_by_identifier(session: AsyncSession, identifier: str) -> Optional[User]:
    """Look someone up by username or by email.

    Sign-in accepts either, so this is where "which one is it?" is answered
    once. Email is matched lower-cased because that is how it is stored.
    """
    lowered = identifier.strip().lower()
    result = await session.execute(
        select(User).where((User.username == identifier.strip()) | (User.email == lowered))
    )
    return result.scalars().first()

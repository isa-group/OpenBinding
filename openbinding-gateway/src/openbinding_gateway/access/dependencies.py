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

from typing import Optional

from fastapi import Depends, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import Settings, get_settings
from ..db import base as db_base
from ..db.models import User
from ..models.errors import api_error
from ..security.tokens import TokenError, bearer_token, read_access_token

#: What an unauthenticated caller is told to send.
_AUTHENTICATE_CHALLENGE = {"WWW-Authenticate": 'Bearer realm="openbinding"'}


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


async def _user_for_credential(
    credential: str, session: AsyncSession, settings: Settings
) -> Optional[User]:
    """The user a credential names, or ``None`` if it names nobody."""
    try:
        claims = read_access_token(_signing_secret(settings), credential)
    except TokenError:
        return None

    return await session.get(User, claims.user_id)


async def get_optional_user(
    request: Request,
    session: AsyncSession = Depends(session_dependency),
) -> Optional[User]:
    """The caller, when there is one. Visitors get ``None``, not an error."""
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

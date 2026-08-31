"""Who is calling, and whether they may.

The gateway serves two authenticated channels: browser sessions and API keys.
Both resolve to the same ``User`` row so pricing applies to the account, while
the API-key identity is retained long enough to enforce its immutable
permissions and exact Engine boundary.

``get_current_user`` refuses anyone it cannot identify; ``get_optional_user``
answers ``None`` instead, which is what the endpoints that stay open to visitors
need. Both go through the same resolution, so there is one place where a
credential turns into a user.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional

from fastapi import Depends, Request, Security, status
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import Settings, get_settings
from ..db import base as db_base
from ..db.models import ApiKey, User, utcnow
from ..models.errors import api_error
from ..security.apikeys import (
    ApiKeyPermission,
    authenticated_api_key,
    looks_like_api_key,
    matches,
    permissions_of,
    prefix_of,
    required_permissions,
)
from ..security.tokens import TokenError, bearer_token, read_access_token
from .contracts import settle_pending_contract

#: What an unauthenticated caller is told to send.
_AUTHENTICATE_CHALLENGE = {"WWW-Authenticate": 'Bearer realm="openbinding"'}

# These dependencies do two jobs at once: parse the two supported credentials
# and make the same authentication contract visible in the generated OpenAPI.
# ``auto_error=False`` is deliberate because either mechanism is sufficient.
_BEARER_AUTH = HTTPBearer(
    auto_error=False,
    scheme_name="BearerAuth",
    description="Account access token, or an OpenBinding API key used as a Bearer token.",
)
_API_KEY_AUTH = APIKeyHeader(
    name="X-API-Key",
    auto_error=False,
    scheme_name="ApiKeyAuth",
    description=(
        "OpenBinding API key. Each key has immutable granular permissions and "
        "access to either selected immutable Engine revisions or all visible Engines."
    ),
)

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

    Public catalogue and validation endpoints can still operate without the
    accounts module. Engine discovery, registration and execution depend on
    ``solve_caller`` and fail closed when this yields ``None``.
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


def _credential(
    request: Request,
    bearer: HTTPAuthorizationCredentials | None = None,
    api_key: str | None = None,
) -> Optional[str]:
    """The credential this request carries, from either header.

    ``X-API-Key`` is the API channel's, ``Authorization: Bearer`` the browser's,
    and a script may put its key in either. Which kind of credential it is gets
    decided by whoever resolves it, not here.
    """
    api_key_header = api_key or request.headers.get("x-api-key")
    if api_key_header and api_key_header.strip():
        return api_key_header.strip()
    if bearer is not None:
        return bearer.credentials
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

    user = await session.get(User, api_key.user_id)
    if user is not None:
        # SQLAlchemy model instances may safely carry request-local, unmapped
        # attributes. This keeps the existing User-shaped dependency contract
        # while preserving which key authenticated it for authorization and
        # Engine allow-list checks deeper in the call graph.
        user._authenticated_api_key = api_key  # type: ignore[attr-defined]
    return user


async def _user_for_credential(
    credential: str, session: AsyncSession, settings: Settings
) -> Optional[User]:
    """The user a credential names, or ``None`` if it names nobody.

    Both channels leave here as the same ``User`` for ownership and pricing,
    but API-key resolution also attaches the verified key to that request's
    ORM instance so authorization does not lose its narrower policy.
    """
    if looks_like_api_key(credential):
        return await _user_for_api_key(credential, session)

    try:
        claims = read_access_token(_signing_secret(settings), credential)
    except TokenError:
        return None

    user = await session.get(User, claims.user_id)
    if user is not None:
        user._authenticated_api_key = None  # type: ignore[attr-defined]
    return user


def _route_path(request: Request) -> str:
    route = request.scope.get("route")
    return str(getattr(route, "path", request.url.path))


def _authorize_api_key(request: Request, user: User) -> None:
    """Apply the immutable key policy after authentication.

    Browser/session tokens retain the account's normal rights. API keys must
    carry every permission required by this route, while role checks continue
    to run independently afterwards.
    """

    api_key = authenticated_api_key(user)
    request.state.api_key = api_key
    if api_key is None:
        return

    required = set(required_permissions(_route_path(request), request.method))
    if (
        _route_path(request) == "/v1/engine-registrations"
        and request.query_params.get("review", "").lower() in {"1", "true", "yes", "on"}
    ):
        required.add(ApiKeyPermission.ENGINES_MODERATE.value)
    missing = sorted(required - permissions_of(api_key))
    if missing:
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "insufficient_api_key_permission",
            "This API key does not grant every permission required by the endpoint.",
            required_permissions=sorted(required),
            missing_permissions=missing,
        )


async def get_optional_user(
    request: Request,
    session: Optional[AsyncSession] = Depends(optional_session, scope="function"),
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
    _authorize_api_key(request, user)
    return user


async def get_current_user(
    request: Request,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Security(_BEARER_AUTH)],
    api_key: Annotated[str | None, Security(_API_KEY_AUTH)],
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> User:
    """The caller, or a refusal.

    A deactivated account is treated as no account at all rather than as a
    separate kind of failure, so that disabling someone takes effect on their
    next request without needing their tokens back.
    """
    credential = _credential(request, bearer, api_key)
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

    _authorize_api_key(request, user)

    # An account registered while SPACE was unreachable owes a contract, and
    # nothing else ever settles it. Doing it here is what the flag was for.
    await settle_pending_contract(user, session)
    return user


async def solve_caller(
    request: Request,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Security(_BEARER_AUTH)],
    api_key: Annotated[str | None, Security(_API_KEY_AUTH)],
    session: Optional[AsyncSession] = Depends(optional_session, scope="function"),
) -> User:
    """The authenticated account allowed to use an Engine.

    Solving is the expensive operation and the one a plan is sold by, and an
    unattributed solve cannot be metered, cannot be attributed to a job
    somebody can read back, and cannot be refused when an allowance runs out.
    There used to be a switch to permit it; there is not, because a deployment
    that turns metering off by accident finds out from its bill.

    Engine execution is never anonymous. A deployment without the accounts
    module therefore reports that authentication is unavailable instead of
    silently becoming a public solver.
    """
    if session is None:
        require_accounts()
        raise AssertionError("require_accounts() must refuse an unconfigured gateway")

    settings = get_settings()
    credential = _credential(request, bearer, api_key)

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
    _authorize_api_key(request, user)
    await settle_pending_contract(user, session)
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "forbidden",
            "This endpoint is for administrators.",
        )
    return user


async def require_v1_admin(user: User = Depends(solve_caller)) -> User:
    """An administrator authenticated through the fail-closed BIM v1 channel."""
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

"""Issuing and reading the gateway's own session tokens.

Two kinds, with different lifetimes and different amounts of trust. An access
token is short-lived, carries the claims an endpoint needs, and is never stored:
it is believed because it is signed and has not expired yet. A refresh token is
long-lived and therefore worth being able to take back, so it carries a ``jti``
that names a row in ``refresh_tokens``; revoking that row ends the session.

Every token says which kind it is, and the readers below refuse the other kind.
Without that, a refresh token - the long-lived one - would be accepted wherever
an access token is, which is the whole point of separating them.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

import jwt

from ..core.settings import get_settings

ALGORITHM = "HS256"
TokenKind = Literal["access", "refresh"]


class TokenError(Exception):
    """A token that cannot be trusted: bad signature, expired, or the wrong kind."""


@dataclass(frozen=True)
class AccessClaims:
    user_id: uuid.UUID
    #: The browser session the token was minted from (``identity_sessions.id``), checked on every request.
    session_id: Optional[uuid.UUID] = None
    #: The provider of that session (``local`` or ``scoretech``), which must be the gateway's mode.
    provider: Optional[str] = None


@dataclass(frozen=True)
class RefreshClaims:
    user_id: uuid.UUID
    jti: uuid.UUID


def _identity(issuer: Optional[str], audience: Optional[str]) -> tuple[str, str]:
    """``iss`` and ``aud`` to write or require: explicit values, else the settings'.

    Resolved here, rather than by every caller, so that issuing a token and
    reading one can never be configured differently.
    """
    if issuer is not None and audience is not None:
        return issuer, audience
    settings = get_settings()
    return (
        issuer if issuer is not None else settings.gateway_jwt_issuer,
        audience if audience is not None else settings.gateway_jwt_audience,
    )


def _encode(
    secret: str,
    payload: dict,
    ttl_seconds: int,
    *,
    issuer: Optional[str],
    audience: Optional[str],
) -> str:
    now = datetime.now(timezone.utc)
    issuer, audience = _identity(issuer, audience)
    return jwt.encode(
        {
            **payload,
            "iss": issuer,
            "aud": audience,
            "iat": now,
            "exp": now + timedelta(seconds=ttl_seconds),
        },
        secret,
        algorithm=ALGORITHM,
    )


def _decode(
    secret: str,
    token: str,
    expected_kind: TokenKind,
    *,
    issuer: Optional[str],
    audience: Optional[str],
) -> dict:
    issuer, audience = _identity(issuer, audience)
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=[ALGORITHM],
            issuer=issuer,
            audience=audience,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.ExpiredSignatureError as error:
        raise TokenError("Token has expired.") from error
    except jwt.InvalidTokenError as error:
        raise TokenError("Token is not valid.") from error

    if claims.get("kind") != expected_kind:
        raise TokenError(f"Expected a {expected_kind} token.")
    return claims


def issue_access_token(
    secret: str,
    *,
    user_id: uuid.UUID,
    ttl_seconds: int,
    session_id: Optional[uuid.UUID] = None,
    provider: Optional[str] = None,
    issuer: Optional[str] = None,
    audience: Optional[str] = None,
) -> str:
    """An access token; ``session_id`` and ``provider`` (``sid``, ``prv``) bind it to a browser session.

    The token carries no role: the account's role is read from the database on every request.
    """
    payload: dict = {"sub": str(user_id), "kind": "access"}
    if session_id is not None:
        payload["sid"] = str(session_id)
        payload["prv"] = provider
    return _encode(
        secret,
        payload,
        ttl_seconds,
        issuer=issuer,
        audience=audience,
    )


def issue_refresh_token(
    secret: str,
    *,
    user_id: uuid.UUID,
    jti: uuid.UUID,
    ttl_seconds: int,
    issuer: Optional[str] = None,
    audience: Optional[str] = None,
) -> str:
    return _encode(
        secret,
        {"sub": str(user_id), "jti": str(jti), "kind": "refresh"},
        ttl_seconds,
        issuer=issuer,
        audience=audience,
    )


def read_access_token(
    secret: str,
    token: str,
    *,
    issuer: Optional[str] = None,
    audience: Optional[str] = None,
) -> AccessClaims:
    claims = _decode(secret, token, "access", issuer=issuer, audience=audience)
    try:
        user_id = uuid.UUID(claims["sub"])
        session_id = uuid.UUID(claims["sid"]) if claims.get("sid") is not None else None
    except (KeyError, ValueError, TypeError, AttributeError) as error:
        raise TokenError("Token is missing a usable subject.") from error
    provider = claims.get("prv")
    if session_id is not None and provider not in ("local", "scoretech"):
        raise TokenError("Token names a session without its provider.")
    return AccessClaims(user_id=user_id, session_id=session_id, provider=provider)


def read_refresh_token(
    secret: str,
    token: str,
    *,
    issuer: Optional[str] = None,
    audience: Optional[str] = None,
) -> RefreshClaims:
    claims = _decode(secret, token, "refresh", issuer=issuer, audience=audience)
    try:
        return RefreshClaims(user_id=uuid.UUID(claims["sub"]), jti=uuid.UUID(claims["jti"]))
    except (KeyError, ValueError) as error:
        raise TokenError("Token is missing a usable subject or identifier.") from error


def bearer_token(authorization_header: Optional[str]) -> Optional[str]:
    """The credential out of an ``Authorization`` header, or ``None``.

    Both channels arrive here: a browser sends ``Bearer <jwt>`` and a script may
    send ``Bearer obk_...``. This only unwraps the scheme; telling the two apart
    is the caller's job, and the ``obk_`` prefix is what makes it possible.
    """
    if not authorization_header:
        return None
    scheme, _, credential = authorization_header.partition(" ")
    if scheme.lower() != "bearer" or not credential.strip():
        return None
    return credential.strip()

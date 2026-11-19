"""Signing in through SCORETech Identity: the authorization-code flow with PKCE, state, nonce and a browser binding.

Adapted from SPHERE's ``ScoretechIdentityService.begin`` and ``complete`` (SCORELabUS/SPHERE@73779a8a, MIT):

- ``begin`` stores the flow (nonce, PKCE verifier, the sha256 of a browser binding, ``returnTo``) for 600 s
  under a 64-hex ``state`` and hands the binding to the browser in a cookie of its own;
- ``callback`` compares the binding in constant time **before** consuming the flow, so a forged callback
  without the cookie cannot burn the legitimate one; then consumes it once, exchanges the code, verifies both
  tokens and finds the account by ``(scoretech, issuer, subject)`` only;
- every refusal after the code exchange ends the Identity session it just obtained, so no upstream session or
  token survives a refusal and "Try again" may choose another account.

The browser is only ever sent to the frontend's own screens, with a closed ``identity_error`` code on failure;
no token, code or state is ever put in a URL OpenBinding builds.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import secrets
from dataclasses import dataclass
from urllib.parse import urlencode

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.settings import Settings
from ....db.models import AuthIdentity, User, utcnow
from ..domain.claims import TokenSet
from ..domain.errors import IdentityError, IdentityUnavailable, PermissionMissing
from ..domain.rules import safe_return_to
from . import sessions
from .stores import get_oidc, get_store

logger = logging.getLogger(__name__)

FLOW_NAMESPACE = "identity-flow"
FLOW_TTL_S = 600
HEX64 = re.compile(r"[0-9a-f]{64}")
CODE_MAX = 4096

#: Identity's own ``error`` parameter, mapped to the closed codes (anything else: ``signin_failed``).
PROVIDER_ERRORS = {
    "access_denied": "access_denied",
    "temporarily_unavailable": "unavailable",
    "login_required": "expired",
}


def frontend_target(settings: Settings, path: str, **query: str) -> str:
    """An absolute URL of the frontend: the destination comes from configuration, never from the request."""
    suffix = f"?{urlencode(query)}" if query else ""
    return f"{settings.frontend_url.rstrip('/')}{path}{suffix}"


def error_target(settings: Settings, code: str) -> str:
    return frontend_target(settings, "/authentication", identity_error=code)


def binding_hash(binding: str) -> str:
    return hashlib.sha256(binding.encode("ascii")).hexdigest()


@dataclass(frozen=True)
class Begun:
    location: str
    state: str
    binding: str


async def begin(settings: Settings, return_to: object) -> Begun:
    """Store a new flow and answer where the browser goes (Identity's sign-in page, which also registers)."""
    oidc = get_oidc()
    state = secrets.token_hex(32)
    binding = secrets.token_hex(32)
    verifier = secrets.token_urlsafe(32)
    nonce = secrets.token_hex(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode()
    location = await oidc.authorization_url(
        {
            "client_id": oidc.client_id,
            "response_type": "code",
            "scope": "openid profile email",
            "redirect_uri": settings.identity_callback_url,
            "state": state,
            "nonce": nonce,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "ui_locales": "en",
        }
    )
    await get_store().put(
        FLOW_NAMESPACE,
        state,
        {
            "nonce": nonce,
            "verifier": verifier,
            "binding": binding_hash(binding),
            "return_to": safe_return_to(return_to),
            "issuer": oidc.issuer,
            "client_id": oidc.client_id,
        },
        FLOW_TTL_S,
    )
    return Begun(location=location, state=state, binding=binding)


@dataclass
class Outcome:
    """Where the callback sends the browser and the cookies it sets (values are shown once, never logged)."""

    target: str
    session_cookie: str | None = None
    session_max_age: int = 0
    pending_cookie: str | None = None
    pending_max_age: int = 0
    clear_session: bool = False


async def end_upstream(tokens: TokenSet) -> None:
    """End the Identity session behind ``tokens`` (then revoke the refresh token if that failed); best effort."""
    oidc = get_oidc()
    if not await oidc.end_session(tokens.refresh_token):
        await oidc.revoke(tokens.refresh_token)


async def _refuse(
    db: AsyncSession,
    settings: Settings,
    code: str,
    tokens: TokenSet,
    *,
    issuer: str,
    subject: str | None,
    user: User | None = None,
) -> Outcome:
    await end_upstream(tokens)
    detail: dict = {"reason": code, "issuer": issuer}
    if subject is not None:
        detail["subject_sha256"] = hashlib.sha256(subject.encode("utf-8")).hexdigest()
    sessions.audit(
        db,
        "account.identity.refused",
        actor=user.id if user else None,
        target=user.id if user else None,
        detail=detail,
    )
    logger.info("identity_signin_refused code=%s", code)
    return Outcome(target=error_target(settings, code))


async def callback(
    db: AsyncSession,
    settings: Settings,
    *,
    state: str | None,
    code: str | None,
    error: str | None,
    iss: str | None,
    binding: str | None,
    presented_session: str | None,
) -> Outcome:
    """Finish a sign-in: a session for a known identity, a pending sign-up for a new one, or an error code."""
    if not state or not HEX64.fullmatch(state) or not binding or not HEX64.fullmatch(binding):
        return Outcome(target=error_target(settings, "expired"))
    store = get_store()
    pending = await store.peek(FLOW_NAMESPACE, state)
    if pending is None or not hmac.compare_digest(binding_hash(binding), str(pending.get("binding", ""))):
        return Outcome(target=error_target(settings, "expired"))
    flow = await store.pop(FLOW_NAMESPACE, state)
    if flow is None:
        return Outcome(target=error_target(settings, "expired"))
    oidc = get_oidc()
    if flow.get("issuer") != oidc.issuer or flow.get("client_id") != oidc.client_id:
        return Outcome(target=error_target(settings, "expired"))
    if iss is not None and iss != oidc.issuer:
        return Outcome(target=error_target(settings, "signin_failed"))
    if error:
        return Outcome(target=error_target(settings, PROVIDER_ERRORS.get(error, "signin_failed")))
    if not code or len(code) > CODE_MAX:
        return Outcome(target=error_target(settings, "signin_failed"))
    try:
        tokens = await oidc.exchange_code(code, flow["verifier"])
    except IdentityUnavailable:
        return Outcome(target=error_target(settings, "unavailable"))
    except IdentityError:
        return Outcome(target=error_target(settings, "signin_failed"))
    try:
        claims = await oidc.verify(tokens, nonce=flow["nonce"])
    except PermissionMissing:
        return await _refuse(db, settings, "access_denied", tokens, issuer=oidc.issuer, subject=None)
    except IdentityUnavailable:
        await end_upstream(tokens)
        return Outcome(target=error_target(settings, "unavailable"))
    except IdentityError:
        return await _refuse(db, settings, "signin_failed", tokens, issuer=oidc.issuer, subject=None)
    return_to = flow.get("return_to") or "/"
    identity = (
        await db.execute(
            select(AuthIdentity).where(
                AuthIdentity.provider == "scoretech",
                AuthIdentity.issuer == claims.issuer,
                AuthIdentity.subject == claims.subject,
            )
        )
    ).scalars().first()
    if identity is None:
        from .provisioning import start_pending

        return await start_pending(db, settings, claims, tokens, return_to=return_to)
    user = await db.get(User, identity.user_id)
    if user is None or not user.is_active or user.deleted_at is not None:
        return await _refuse(
            db, settings, "account_disabled", tokens, issuer=claims.issuer, subject=claims.subject, user=user
        )
    now = utcnow()
    await sessions.sync_claims(db, user, claims, now=now)
    from .provisioning import after_sign_in

    await after_sign_in(db, settings, user, claims)
    outcome = Outcome(target=frontend_target(settings, "/sso/identity/callback", returnTo=return_to))
    previous = await sessions.find_by_cookie(db, presented_session)
    if previous is not None:
        await sessions.revoke(db, previous, "replaced", now=now)
    row, value = await sessions.create(
        db, user, "scoretech", settings=settings, identity=identity, tokens=tokens, now=now
    )
    sessions.audit(db, "account.signed_in", actor=user.id, target=user.id, detail={"provider": "scoretech"})
    outcome.session_cookie = value
    outcome.session_max_age = sessions.remaining_seconds(row, now)
    return outcome

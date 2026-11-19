"""First-time SCORETech Identity users: a pending sign-up, a chosen username, and never a link by email.

Shaped after SPACE's ``SphereAuthService`` pending and complete (``api/src/main/services/SphereAuthService.ts``,
SCORELabUS/space@3d35281, MIT). An unknown ``(scoretech, issuer, subject)`` becomes a pending record (the
verified claims and the Fernet-sealed tokens, 900 s) under the sha256 of a cookie of its own; the person
chooses a username; ``complete`` creates the account, its identity, its SPACE contract and its session in one
transaction. Nothing ever finds or merges an account by its email: a verified email already held by an
account whose own email is verified and which has no identity of this issuer refuses provisioning
(``account_not_linked``); any other holder's copy is released (``sessions.release_reason``).
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.contracts import create_contract_or_mark_pending
from ....core.settings import Settings
from ....db.models import AuthIdentity, EngineRegistrationRevision, EngineRevision, User, UserRole, utcnow
from ....models.errors import api_error
from ....security.passwords import hash_password
from ....security.secrets import CredentialStore, SecretsUnavailable
from ..domain.claims import IdentityClaims, TokenSet
from . import sessions
from .stores import get_lock, get_store

PENDING_NAMESPACE = "identity-pending"
PENDING_TTL_S = 900
LOCK_TTL_MS = 30_000

#: The prefix of the username a deleted account is given. Registration and first sign-ins refuse every name
#: that starts with it, so a deletion never finds its pseudonym taken.
PSEUDONYM_PREFIX = "deleted-"

#: Names no person may take: they read as the platform speaking.
RESERVED_USERNAMES = frozenset(
    {
        "admin", "administrator", "root", "openbinding", "score", "sphere", "space", "identity",
        "support", "security", "system", "api", "me", "new",
    }
)

_USERNAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$")


async def username_reserved(session: AsyncSession, username: str) -> bool:
    """Whether ``username`` is kept from new accounts.

    Engine namespaces are the username of whoever registered them, baked into immutable manifests (engines and
    engine registrations alike), and they outlive the account (a deleted account keeps them, under a
    pseudonymised username). A new account with that name would inherit them and could publish further versions
    under a namespace that consumers already trust, so the name stays taken. Names in the pseudonym space of
    deleted accounts are kept too, and so are the platform's own names.
    """
    name = username.casefold()
    if name.startswith(PSEUDONYM_PREFIX) or name in RESERVED_USERNAMES:
        return True
    for column in (EngineRevision.namespace, EngineRegistrationRevision.namespace):
        if await session.scalar(select(column).where(func.lower(column) == name).limit(1)):
            return True
    return False


def username_unavailable() -> Exception:
    return api_error(
        status.HTTP_409_CONFLICT,
        "username_unavailable",
        "That username is reserved: it names published engines, belongs to a deleted account, or is the platform's.",
    )


async def username_taken(session: AsyncSession, username: str) -> bool:
    return (
        await session.scalar(select(User.id).where(func.lower(User.username) == username.casefold()).limit(1))
    ) is not None


def pending_key(cookie_value: str) -> str:
    return hashlib.sha256(cookie_value.encode("utf-8")).hexdigest()


def _seal(settings: Settings, key: str, tokens: TokenSet) -> str:
    return CredentialStore.from_settings(settings).encrypt(
        json.dumps(
            {
                "key": key,
                "access_token": tokens.access_token,
                "refresh_token": tokens.refresh_token,
                "id_token": tokens.id_token,
                "expires_in": tokens.expires_in,
                "refresh_expires_in": tokens.refresh_expires_in,
            }
        )
    )


def open_tokens(settings: Settings, key: str, record: dict) -> TokenSet | None:
    """The tokens sealed in a pending record, or ``None`` when they do not open for this record."""
    try:
        value = json.loads(CredentialStore.from_settings(settings).decrypt(record.get("sealed", "")))
    except (SecretsUnavailable, ValueError, TypeError):
        return None
    if value.get("key") != key:
        return None
    return TokenSet(
        access_token=value["access_token"],
        refresh_token=value["refresh_token"],
        expires_in=value["expires_in"],
        id_token=value.get("id_token"),
        refresh_expires_in=value.get("refresh_expires_in"),
    )


def claims_of(record: dict) -> IdentityClaims:
    return IdentityClaims(
        issuer=record["issuer"],
        subject=record["subject"],
        email=record.get("email"),
        email_verified=record.get("email_verified") is True,
        display_name=record.get("display_name"),
        avatar=record.get("avatar"),
        profile_from_id_token=True,
    )


async def email_refusal(db: AsyncSession, claims: IdentityClaims) -> bool:
    """Whether a verified email of ``claims`` is held by an account that keeps it (``account_not_linked``)."""
    if not (claims.email and claims.email_verified):
        return False
    holder = await sessions.email_holder(db, claims.email)
    return holder is not None and await sessions.release_reason(db, holder, claims.issuer) is None


async def start_pending(db: AsyncSession, settings: Settings, claims: IdentityClaims, tokens: TokenSet, *, return_to: str):
    """At the callback, for an unknown identity: refuse a kept email, or store the pending sign-up."""
    from .flows import Outcome, _refuse, frontend_target

    if await email_refusal(db, claims):
        return await _refuse(db, settings, "account_not_linked", tokens, issuer=claims.issuer, subject=claims.subject)
    value = secrets.token_urlsafe(32)
    key = pending_key(value)
    expires_at = utcnow() + timedelta(seconds=PENDING_TTL_S)
    await get_store().put(
        PENDING_NAMESPACE,
        key,
        {
            "issuer": claims.issuer,
            "subject": claims.subject,
            "email": claims.email if claims.email_verified else None,
            "email_verified": claims.email_verified,
            "display_name": claims.display_name,
            "avatar": claims.avatar,
            "return_to": return_to,
            "expires_at": expires_at.isoformat(),
            "sealed": _seal(settings, key, tokens),
        },
        PENDING_TTL_S,
    )
    return Outcome(
        target=frontend_target(settings, "/sso/identity/username", returnTo=return_to),
        pending_cookie=value,
        pending_max_age=PENDING_TTL_S,
    )


def normalise_username(seed: str | None) -> str:
    """``seed`` lower-cased, characters outside ``[a-z0-9._-]`` dropped, fit to ``USERNAME_PATTERN``."""
    name = re.sub(r"[^a-z0-9._-]", "", (seed or "").lower())
    name = re.sub(r"^[^a-z0-9]+", "", name)[:64]
    if not name:
        return "user"
    if len(name) < 3:
        name = (name + "user")[:64]
    return name


async def suggestion(db: AsyncSession, record: dict) -> str:
    """The verified email's local part, else the display name, made free by ``-2`` … ``-9`` (advisory only).

    ``preferred_username`` is never read: OpenBinding does not ask Identity to share it.
    """
    email = record.get("email") if record.get("email_verified") else None
    base = normalise_username(email.split("@", 1)[0] if email else record.get("display_name"))
    for candidate in [base, *(f"{base[:61]}-{n}" for n in range(2, 10))]:
        if _USERNAME.fullmatch(candidate) and not await username_reserved(db, candidate) and not await username_taken(db, candidate):
            return candidate
    return base


async def read_pending(db: AsyncSession, cookie_value: str | None) -> tuple[str, dict] | None:
    if not cookie_value or len(cookie_value) > 128:
        return None
    key = pending_key(cookie_value)
    record = await get_store().peek(PENDING_NAMESPACE, key)
    return (key, record) if record is not None else None


@dataclass
class Completed:
    return_to: str
    session_cookie: str
    session_max_age: int


def _conflict(code: str, message: str) -> Exception:
    return api_error(status.HTTP_409_CONFLICT, code, message)


def _no_pending() -> Exception:
    return api_error(
        status.HTTP_404_NOT_FOUND, "no_pending_signup", "There is no sign-up waiting; start signing in again."
    )


async def complete(db: AsyncSession, settings: Settings, cookie_value: str | None, username: str) -> Completed:
    """Create the account of a pending sign-up with ``username`` (409s leave the pending sign-up for a retry)."""
    found = await read_pending(db, cookie_value)
    if found is None:
        raise _no_pending()
    key, _ = found
    lock = get_lock()
    token = await lock.acquire(f"identity-complete:{key}", LOCK_TTL_MS)
    if token is None:
        raise _conflict("pending_in_progress", "This sign-up is being completed already.")
    try:
        record = await get_store().peek(PENDING_NAMESPACE, key)
        if record is None:
            raise _no_pending()
        tokens = open_tokens(settings, key, record)
        if tokens is None:
            await get_store().delete(PENDING_NAMESPACE, key)
            raise _no_pending()
        claims = claims_of(record)
        if await username_reserved(db, username):
            raise username_unavailable()
        if await username_taken(db, username):
            raise _conflict("username_taken", "That username is taken.")
        if await email_refusal(db, claims):
            from .flows import end_upstream

            await get_store().delete(PENDING_NAMESPACE, key)
            await end_upstream(tokens)
            sessions.audit(db, "account.identity.refused", actor=None, target=None, detail={
                "reason": "account_not_linked", "issuer": claims.issuer,
                "subject_sha256": hashlib.sha256(claims.subject.encode("utf-8")).hexdigest(),
            })
            raise _conflict("account_not_linked", "That email belongs to another account; sign in with it instead.")
        completed = await _create(db, settings, claims, tokens, username, record.get("return_to") or "/")
        await get_store().delete(PENDING_NAMESPACE, key)
        return completed
    finally:
        await lock.release(f"identity-complete:{key}", token)


async def _create(
    db: AsyncSession, settings: Settings, claims: IdentityClaims, tokens: TokenSet, username: str, return_to: str
) -> Completed:
    now = utcnow()
    user_id = uuid.uuid4()
    email = sessions.placeholder_email(user_id)
    if claims.email and claims.email_verified:
        holder = await sessions.email_holder(db, claims.email)
        if holder is not None:
            reason = await sessions.release_reason(db, holder, claims.issuer)
            await sessions.release_email(db, holder, reason or "unverified_holder", actor=user_id)
        email = claims.email
    from .research import RESEARCH, eligible

    research = eligible(settings, claims.email, claims.email_verified)
    plan = RESEARCH if research else (settings.space_default_plan or None)
    user = User(
        id=user_id,
        username=username,
        email=email,
        email_verified=email == claims.email and claims.email_verified,
        display_name=claims.display_name,
        avatar=claims.avatar,
        last_identity_refresh_at=now,
        password_hash=hash_password(secrets.token_urlsafe(48)),
        password_enabled=False,
        role=UserRole.USER,
        plan_cache=plan or "",
        contract_pending=True,
    )
    identity = AuthIdentity(
        user_id=user_id, provider="scoretech", issuer=claims.issuer, subject=claims.subject, attributes={}
    )
    db.add(user)
    try:
        await db.flush()
        db.add(identity)
        await db.flush()
    except IntegrityError:
        await db.rollback()
        provisioned = await db.scalar(
            select(AuthIdentity.id).where(
                AuthIdentity.provider == "scoretech",
                AuthIdentity.issuer == claims.issuer,
                AuthIdentity.subject == claims.subject,
            )
        )
        if provisioned is not None:
            raise _conflict(
                "identity_already_provisioned", "This SCORETech account already has an OpenBinding account; start signing in again."
            ) from None
        raise _conflict("username_taken", "That username is taken.") from None
    await create_contract_or_mark_pending(user, plan, settings)
    if research:
        sessions.audit(db, "account.research.granted", actor=user.id, target=user.id, detail={"basis": "email"})
    await after_sign_in(db, settings, user, claims, provisioned=True)
    row, value = await sessions.create(db, user, "scoretech", settings=settings, identity=identity, tokens=tokens, now=now)
    sessions.audit(db, "account.identity.provisioned", actor=user.id, target=user.id, detail={"provider": "scoretech"})
    sessions.audit(db, "account.signed_in", actor=user.id, target=user.id, detail={"provider": "scoretech"})
    return Completed(return_to=return_to, session_cookie=value, session_max_age=sessions.remaining_seconds(row, now))


async def after_sign_in(
    db: AsyncSession, settings: Settings, user: User, claims: IdentityClaims, *, provisioned: bool = False
) -> None:
    """What every Identity sign-in, renewal and provisioning does after the claims are synchronised:
    the bootstrap administrator by ``sub``, and RESEARCH by a verified institutional email (a provisioned
    account got its plan at creation)."""
    from .bootstrap import promote_if_bootstrap
    from .research import grant_by_email

    await promote_if_bootstrap(db, settings, user, claims)
    if not provisioned:
        await grant_by_email(db, settings, user, claims)


def expires_at_of(record: dict) -> datetime:
    return datetime.fromisoformat(record["expires_at"])

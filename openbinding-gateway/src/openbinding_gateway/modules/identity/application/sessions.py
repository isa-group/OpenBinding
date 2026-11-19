"""Browser sessions: the opaque cookie, the row it names and the sealed Identity refresh token.

A session id is created only after authentication; the cookie holds 32 random bytes (base64url) and the row
only their sha256. Every gateway token names its row (``sid``) and provider (``prv``), and is checked against
the row on every request (``active_for_token``), so revoking the row ends the session at once. The Identity
refresh token is sealed with the credential store (Fernet) over ``{"sid", "rt", "gen"}``: a ciphertext moved to
another row, or left from an older generation, does not open. It is never in Redis, a log or a response.

Adapted from SPHERE's ``ScoretechIdentityService`` session handling (SCORELabUS/SPHERE@73779a8a, MIT), with
PostgreSQL as the authority instead of a cache entry holding the plain refresh token.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.settings import Settings
from ....db.models import SESSION_REVOKE_REASONS, AuditEvent, AuthIdentity, IdentitySession, User, utcnow
from ....security.secrets import CredentialStore, SecretsUnavailable
from ..domain.claims import IdentityClaims, TokenSet

#: Expired or revoked rows older than this are deleted when the same user opens a new session.
HOUSEKEEPING_AFTER = timedelta(days=7)


class SealedTokenInvalid(RuntimeError):
    """A sealed refresh token that does not open for this row and generation."""


def as_utc(moment: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; the stored value is UTC either way."""
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def new_cookie_value() -> str:
    """32 random bytes, base64url without padding: 43 characters."""
    return secrets.token_urlsafe(32)


def cookie_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _store(settings: Settings) -> CredentialStore:
    return CredentialStore.from_settings(settings)


def seal_refresh(settings: Settings, sid: uuid.UUID, token: str, generation: int) -> str:
    return _store(settings).encrypt(json.dumps({"sid": str(sid), "rt": token, "gen": generation}))


def open_refresh(settings: Settings, row: IdentitySession) -> str:
    """The plain refresh token of ``row``; ``SealedTokenInvalid`` unless it was sealed for this row and generation."""
    if not row.refresh_ciphertext:
        raise SealedTokenInvalid("the session holds no refresh token")
    try:
        value = json.loads(_store(settings).decrypt(row.refresh_ciphertext))
    except (SecretsUnavailable, ValueError) as error:
        raise SealedTokenInvalid("the refresh token does not open") from error
    if value.get("sid") != str(row.id) or value.get("gen") != row.refresh_generation or not value.get("rt"):
        raise SealedTokenInvalid("the refresh token belongs to another session or generation")
    return value["rt"]


async def housekeep(db: AsyncSession, user_id: uuid.UUID, now: datetime) -> None:
    """Delete this user's sessions that ended (expired or revoked) more than seven days ago."""
    cutoff = now - HOUSEKEEPING_AFTER
    await db.execute(
        delete(IdentitySession).where(
            IdentitySession.user_id == user_id,
            or_(IdentitySession.revoked_at < cutoff, IdentitySession.expires_at < cutoff),
        )
        .execution_options(synchronize_session="fetch")
    )


async def create(
    db: AsyncSession,
    user: User,
    provider: str,
    *,
    settings: Settings,
    identity: AuthIdentity | None = None,
    tokens: TokenSet | None = None,
    now: datetime | None = None,
) -> tuple[IdentitySession, str]:
    """A new session row for ``user`` and the cookie value that names it (shown once, stored as a hash)."""
    if provider not in ("local", "scoretech"):
        raise ValueError(f"unknown session provider {provider!r}")
    if provider == "scoretech" and (identity is None or tokens is None):
        raise ValueError("an Identity session needs its identity and tokens")
    now = now or utcnow()
    await housekeep(db, user.id, now)
    value = new_cookie_value()
    expires_at = now + timedelta(seconds=settings.session_max_s)
    refresh_expires_at = None
    if tokens is not None and tokens.refresh_expires_in:
        refresh_expires_at = now + timedelta(seconds=tokens.refresh_expires_in)
        expires_at = min(expires_at, refresh_expires_at)
    row = IdentitySession(
        id=uuid.uuid4(),
        token_hash=cookie_hash(value),
        user_id=user.id,
        provider=provider,
        identity_id=identity.id if identity is not None else None,
        refresh_generation=0,
        access_expires_at=now + timedelta(seconds=tokens.expires_in) if tokens is not None else None,
        refresh_expires_at=refresh_expires_at,
        idle_expires_at=now + timedelta(seconds=settings.session_idle_s),
        expires_at=expires_at,
        created_at=now,
        last_renewed_at=now,
    )
    if tokens is not None:
        row.refresh_ciphertext = seal_refresh(settings, row.id, tokens.refresh_token, 0)
    db.add(row)
    await db.flush()
    return row, value


def is_live(row: IdentitySession, now: datetime) -> bool:
    return (
        row.revoked_at is None
        and now < as_utc(row.expires_at)
        and now < as_utc(row.idle_expires_at)
    )


def remaining_seconds(row: IdentitySession, now: datetime) -> int:
    """The cookie's ``Max-Age``: what is left of the row's lifetime."""
    end = min(as_utc(row.expires_at), as_utc(row.idle_expires_at))
    return max(0, int((end - now).total_seconds()))


async def find_by_cookie(db: AsyncSession, value: str | None) -> IdentitySession | None:
    if not value or len(value) > 128:
        return None
    return (
        await db.execute(select(IdentitySession).where(IdentitySession.token_hash == cookie_hash(value)))
    ).scalars().first()


async def active_for_token(
    db: AsyncSession,
    sid: uuid.UUID,
    user_id: uuid.UUID,
    provider: str | None,
    *,
    settings: Settings,
    now: datetime | None = None,
) -> User | None:
    """The user of a live session named by a gateway token, in one joined read; ``None`` otherwise.

    Live: not revoked, before its maximum and idle expiries, of the gateway's provider (which the token's
    ``prv`` must name too), and of the token's user.
    """
    now = now or utcnow()
    if provider != settings.auth_provider:
        return None
    found = (
        await db.execute(
            select(IdentitySession, User)
            .join(User, User.id == IdentitySession.user_id)
            .where(IdentitySession.id == sid, IdentitySession.user_id == user_id)
        )
    ).first()
    if found is None:
        return None
    row, user = found
    if row.provider != provider or not is_live(row, now):
        return None
    user._identity_session_id = row.id  # type: ignore[attr-defined]
    return user


async def revoke(
    db: AsyncSession,
    target: IdentitySession | User | uuid.UUID,
    reason: str,
    *,
    now: datetime | None = None,
) -> list[IdentitySession]:
    """Revoke one session, or every live session of a user; the rows revoked now."""
    if reason not in SESSION_REVOKE_REASONS:
        raise ValueError(f"unknown revocation reason {reason!r}")
    now = now or utcnow()
    if isinstance(target, IdentitySession):
        rows = [target] if target.revoked_at is None else []
    else:
        user_id = target.id if isinstance(target, User) else target
        rows = list(
            (
                await db.execute(
                    select(IdentitySession).where(
                        IdentitySession.user_id == user_id, IdentitySession.revoked_at.is_(None)
                    )
                )
            ).scalars()
        )
    for row in rows:
        await db.execute(
            update(IdentitySession)
            .where(IdentitySession.id == row.id, IdentitySession.revoked_at.is_(None))
            .values(revoked_at=now, revoked_reason=reason)
            .execution_options(synchronize_session=False)
        )
        row.revoked_at = now
        row.revoked_reason = reason
    await db.flush()
    return rows


# -- claims ---------------------------------------------------------------------------------------------------


def placeholder_email(user_id: uuid.UUID) -> str:
    """The address of an account whose email Identity has not verified (the CAS precedent)."""
    return f"{user_id}@identity.openbinding.invalid"


def audit(
    db: AsyncSession, action: str, *, actor: uuid.UUID | None, target: uuid.UUID | None, detail: dict | None = None
) -> None:
    """An ``account.*`` audit row. Details carry ids, codes and reasons only: never an email or a token."""
    db.add(AuditEvent(actor_id=actor, action=action, target_type="User", target_id=target, detail=detail or {}))


async def has_identity_of(db: AsyncSession, user_id: uuid.UUID, issuer: str) -> bool:
    return (
        await db.scalar(
            select(AuthIdentity.id).where(
                AuthIdentity.user_id == user_id,
                AuthIdentity.provider == "scoretech",
                AuthIdentity.issuer == issuer,
            ).limit(1)
        )
    ) is not None


async def email_holder(db: AsyncSession, email: str, *, other_than: uuid.UUID | None = None) -> User | None:
    query = select(User).where(User.email == email)
    if other_than is not None:
        query = query.where(User.id != other_than)
    return (await db.execute(query)).scalars().first()


async def release_reason(db: AsyncSession, holder: User, issuer: str) -> str | None:
    """Why ``holder``'s copy of an email someone else verified may be released, or ``None`` if it may not.

    A holder with an Identity account of this issuer holds a stale copy (Identity forbids duplicate emails);
    a holder whose own email is unverified (every local, seeded or CAS account) proves nothing. A holder whose
    email is verified and who has no identity of this issuer keeps it.
    """
    if await has_identity_of(db, holder.id, issuer):
        return "stale_identity"
    if not holder.email_verified:
        return "unverified_holder"
    return None


async def release_email(db: AsyncSession, holder: User, reason: str, *, actor: uuid.UUID | None) -> None:
    holder.email = placeholder_email(holder.id)
    holder.email_verified = False
    audit(db, "account.email.released", actor=actor, target=holder.id, detail={"reason": reason})
    await db.flush()


async def sync_claims(db: AsyncSession, user: User, claims: IdentityClaims, *, now: datetime | None = None) -> None:
    """Bring what OpenBinding keeps of ``user`` up to date with a verified Identity sign-in or renewal.

    Liveness (``last_identity_refresh_at``) always moves. The profile moves only with a verified ID token:
    the verified email (released from a holder whose copy proves nothing, kept with an
    ``account.identity.email_conflict`` audit when a holder verified it too), ``email_verified``, the display
    name and the avatar. Nothing ever finds an account by its email.
    """
    user.last_identity_refresh_at = now or utcnow()
    if not claims.profile_from_id_token:
        return
    user.display_name = claims.display_name
    user.avatar = claims.avatar
    if claims.email and claims.email_verified and user.email != claims.email:
        holder = await email_holder(db, claims.email, other_than=user.id)
        reason = None if holder is None else await release_reason(db, holder, claims.issuer)
        if holder is not None and reason is None:
            audit(db, "account.identity.email_conflict", actor=user.id, target=user.id, detail={"holder": str(holder.id)})
        else:
            if holder is not None:
                await release_email(db, holder, reason, actor=user.id)
            user.email = claims.email
    user.email_verified = bool(claims.email and claims.email_verified and user.email == claims.email)

"""Renewing an Identity session single-flight: one refresh per session per expiry, however many tabs or workers ask.

Identity's refresh tokens are single use (``revokeRefreshToken``, reuse 0), so two workers presenting one token
end the person's session. A renewal therefore:

1. skips while the upstream access token has more than 30 s left;
2. coalesces in this process (one renewal per ``sid``; the others await it);
3. takes the shared lock ``identity:refresh:<sid>`` (Redis ``SET NX PX`` with an owner token) and, while
   another worker holds it, re-reads the row for up to 5 s: that worker's renewal is then used as it is;
   still locked after that, 503 ``identity_unavailable`` with ``Retry-After: 1``;
4. under the lock, re-reads the row, refreshes, verifies (the same subject, the permission), and writes with
   ``UPDATE … WHERE refresh_generation = :g AND revoked_at IS NULL`` committed before the lock is released;
   a write that loses (a logout meanwhile) revokes the token it just obtained;
5. ``invalid_grant`` ends the session only when the generation did not move meanwhile.

**Redis unreachable means 503 and the session survives: a refresh never runs without the lock.**

Adapted from SPHERE's ``ScoretechIdentityService.active`` (SCORELabUS/SPHERE@73779a8a, MIT) and SPACE's
revoke-on-loss (``api/src/main/services/ScoretechIdentityService.ts``, SCORELabUS/space@3d35281, MIT); SPHERE
answers lock losers with an immediate 503 and deletes the lock unconditionally, which this does not.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.settings import Settings
from ....db.models import AuthIdentity, IdentitySession, User, utcnow
from ..domain.errors import IdentityEnded, IdentityError, IdentityUnavailable
from . import sessions
from .stores import get_lock, get_oidc

logger = logging.getLogger(__name__)

#: Renew when the upstream access token has less than this left.
SKEW = timedelta(seconds=30)
LOCK_TTL_MS = 30_000
#: How long a renewal waits for another worker's lock, re-reading the row.
LOCK_WAIT_S = 5.0
POLL_S = 0.1


class RenewalBusy(IdentityUnavailable):
    """Another worker held the session's lock for the whole wait (``Retry-After: 1``)."""


def needs_refresh(row: IdentitySession, now: datetime) -> bool:
    if row.provider != "scoretech":
        return False
    expires = sessions.as_utc(row.access_expires_at)
    return expires is None or expires - now <= SKEW


async def _reread(db: AsyncSession, sid: uuid.UUID) -> IdentitySession | None:
    return (
        await db.execute(
            select(IdentitySession).where(IdentitySession.id == sid).execution_options(populate_existing=True)
        )
    ).scalars().first()


class SessionRenewer:
    """One per process: the coalescing map of renewals in flight (tests build two to stand for two workers)."""

    def __init__(self) -> None:
        self._inflight: dict[uuid.UUID, asyncio.Future] = {}

    async def renew(self, db: AsyncSession, settings: Settings, row: IdentitySession) -> None:
        """Make ``row``'s upstream access current, or raise ``IdentityEnded`` / ``IdentityUnavailable``."""
        if not needs_refresh(row, utcnow()):
            return
        running = self._inflight.get(row.id)
        if running is not None:
            await asyncio.shield(running)
            return
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        future.add_done_callback(lambda done: done.cancelled() or done.exception())
        self._inflight[row.id] = future
        try:
            await self._renew_locked(db, settings, row.id)
        except BaseException as error:
            future.set_exception(error)
            raise
        else:
            future.set_result(None)
        finally:
            self._inflight.pop(row.id, None)

    async def _renew_locked(self, db: AsyncSession, settings: Settings, sid: uuid.UUID) -> None:
        lock = get_lock()
        key = f"identity:refresh:{sid}"
        try:
            token = await lock.acquire(key, LOCK_TTL_MS)
        except Exception as error:  # noqa: BLE001 - no lock, no refresh: never an unlocked use of a single-use token
            logger.warning("identity_renewal_unavailable reason=lock_%s", type(error).__name__)
            raise IdentityUnavailable(message="lock_unavailable") from error
        deadline = time.monotonic() + LOCK_WAIT_S
        while token is None:
            await asyncio.sleep(POLL_S)
            row = await _reread(db, sid)
            if row is None or row.revoked_at is not None:
                raise IdentityEnded(message="session_ended")
            if not needs_refresh(row, utcnow()):
                return
            if time.monotonic() >= deadline:
                raise RenewalBusy(message="renewal_in_progress")
            try:
                token = await lock.acquire(key, LOCK_TTL_MS)
            except Exception as error:  # noqa: BLE001
                raise IdentityUnavailable(message="lock_unavailable") from error
        try:
            await self._refresh(db, settings, sid)
        finally:
            try:
                await lock.release(key, token)
            except Exception as error:  # noqa: BLE001 - the lock expires on its own
                logger.warning("identity_lock_release_failed error=%s", type(error).__name__)

    async def _refresh(self, db: AsyncSession, settings: Settings, sid: uuid.UUID) -> None:
        row = await _reread(db, sid)
        if row is None or row.revoked_at is not None or not sessions.is_live(row, utcnow()):
            raise IdentityEnded(message="session_ended")
        if not needs_refresh(row, utcnow()):
            return
        identity = await db.get(AuthIdentity, row.identity_id) if row.identity_id else None
        if identity is None:
            await self._end(db, row)
        generation = row.refresh_generation
        try:
            refresh_token = sessions.open_refresh(settings, row)
        except sessions.SealedTokenInvalid:
            await self._end(db, row)
        oidc = get_oidc()
        try:
            tokens = await oidc.refresh(refresh_token)
        except IdentityEnded:
            latest = await _reread(db, sid)
            if latest is not None and latest.revoked_at is None and latest.refresh_generation != generation:
                return
            await self._end(db, row)
        try:
            claims = await oidc.verify(tokens, subject=identity.subject)
        except IdentityUnavailable:
            raise
        except IdentityError:
            await oidc.end_session(tokens.refresh_token) or await oidc.revoke(tokens.refresh_token)
            await self._end(db, row)
        now = utcnow()
        values = {
            "refresh_generation": generation + 1,
            "refresh_ciphertext": sessions.seal_refresh(settings, sid, tokens.refresh_token, generation + 1),
            "access_expires_at": now + timedelta(seconds=tokens.expires_in),
        }
        if tokens.refresh_expires_in:
            refresh_expires = now + timedelta(seconds=tokens.refresh_expires_in)
            values["refresh_expires_at"] = refresh_expires
            values["expires_at"] = min(sessions.as_utc(row.expires_at), refresh_expires)
        written = await db.execute(
            update(IdentitySession)
            .where(
                IdentitySession.id == sid,
                IdentitySession.refresh_generation == generation,
                IdentitySession.revoked_at.is_(None),
            )
            .values(**values)
            .execution_options(synchronize_session=False)
        )
        if written.rowcount != 1:
            # A logout (or another writer) won: the token just obtained must not outlive it.
            await oidc.revoke(tokens.refresh_token)
            await db.commit()
            latest = await _reread(db, sid)
            if latest is None or latest.revoked_at is not None:
                raise IdentityEnded(message="session_ended")
            return
        user = await db.get(User, row.user_id)
        if user is not None:
            await sessions.sync_claims(db, user, claims, now=now)
            from .provisioning import after_sign_in

            await after_sign_in(db, settings, user, claims)
        await db.commit()
        await _reread(db, sid)

    async def _end(self, db: AsyncSession, row: IdentitySession):
        await sessions.revoke(db, row, "identity_ended")
        await db.commit()
        raise IdentityEnded(message="session_ended")


renewer = SessionRenewer()

"""What an administrator sees of an account's identity (F5-C C4): its link, its last renewal, its sessions, its RESEARCH basis.

Read for a page of accounts at once (one query each for identities, live sessions and RESEARCH grants), never per row.
Nothing here is shown to anybody but an administrator: ``UserRef`` and the profile never carry it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import AuditEvent, AuthIdentity, IdentitySession, utcnow


@dataclass(frozen=True)
class IdentityLink:
    provider: str
    issuer: str
    subject: str
    linked_at: datetime


@dataclass(frozen=True)
class AccountIdentityFacts:
    identity: IdentityLink | None = None
    #: Browser sessions neither revoked nor expired (absolute or idle), in either sign-in mode.
    active_sessions: int = 0
    #: How the account got RESEARCH last: ``email`` (a verified institutional email) or ``admin``; ``None`` if never.
    research_basis: str | None = None


async def identity_facts(db: AsyncSession, user_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, AccountIdentityFacts]:
    """The identity facts of each account in ``user_ids`` (an account with none gets the empty facts)."""
    ids = list(dict.fromkeys(user_ids))
    if not ids:
        return {}
    now = utcnow()
    links: dict[uuid.UUID, IdentityLink] = {}
    for row in (
        await db.execute(
            select(AuthIdentity).where(AuthIdentity.user_id.in_(ids)).order_by(AuthIdentity.created_at)
        )
    ).scalars():
        links.setdefault(row.user_id, IdentityLink(row.provider, row.issuer, row.subject, row.created_at))
    counts = dict(
        (
            await db.execute(
                select(IdentitySession.user_id, func.count())
                .where(
                    IdentitySession.user_id.in_(ids),
                    IdentitySession.revoked_at.is_(None),
                    IdentitySession.expires_at > now,
                    IdentitySession.idle_expires_at > now,
                )
                .group_by(IdentitySession.user_id)
            )
        ).all()
    )
    bases: dict[uuid.UUID, str] = {}
    for target, detail in (
        await db.execute(
            select(AuditEvent.target_id, AuditEvent.detail)
            .where(AuditEvent.action == "account.research.granted", AuditEvent.target_id.in_(ids))
            .order_by(AuditEvent.created_at.desc(), AuditEvent.id)
        )
    ).all():
        basis = (detail or {}).get("basis")
        if target not in bases and basis in ("email", "admin"):
            bases[target] = basis
    return {
        user_id: AccountIdentityFacts(links.get(user_id), int(counts.get(user_id, 0)), bases.get(user_id))
        for user_id in ids
    }

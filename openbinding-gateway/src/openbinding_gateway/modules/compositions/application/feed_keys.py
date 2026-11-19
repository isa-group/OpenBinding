"""The feed keys of a composition environment: minted and revoked (``access.dependencies`` resolves them).

A feed key belongs to its environment (``security.feed_keys``): it reads that environment's feed and nothing else,
survives its creator leaving the organization, and counts against nobody's ``maxApiKeys``. The secret is shown once
at minting and never again; only its SHA-256 is kept. An environment holds at most ``MAX_LIVE_FEED_KEYS`` live keys,
so rotating one means minting the second, reconfiguring the application and revoking the first. Revocation takes
effect on the next request (no cache) and is final.
"""

from __future__ import annotations

import uuid

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import Composition, CompositionEnvironment, CompositionEnvironmentKey, User, utcnow
from ....models.errors import api_error
from ....security import feed_keys
from ...shared.application import audit
from ..domain.environments import MAX_LIVE_FEED_KEYS
from .environments import TARGET, environment_unreadable

async def mint_key(
    session: AsyncSession, composition: Composition, environment: CompositionEnvironment, actor: User, label: str,
) -> tuple[CompositionEnvironmentKey, str]:
    """A new live key of ``environment`` and its secret (to show once); 409 ``feed_key_limit`` at the limit.

    The environment row is locked first, so two concurrent mints count each other.
    """
    locked = await session.scalar(
        select(CompositionEnvironment.id).where(CompositionEnvironment.id == environment.id).with_for_update()
    )
    if locked is None:
        raise environment_unreadable()
    live = int(await session.scalar(
        select(func.count()).select_from(CompositionEnvironmentKey).where(
            CompositionEnvironmentKey.environment_id == environment.id, CompositionEnvironmentKey.revoked_at.is_(None),
        )
    ) or 0)
    if live >= MAX_LIVE_FEED_KEYS:
        raise api_error(
            status.HTTP_409_CONFLICT, "feed_key_limit",
            f"An environment holds at most {MAX_LIVE_FEED_KEYS} live feed keys: revoke one first.",
            limit=MAX_LIVE_FEED_KEYS,
        )
    minted = feed_keys.mint()
    row = CompositionEnvironmentKey(
        environment_id=environment.id, prefix=minted.prefix, secret_hash=minted.secret_hash, label=label,
        created_by_id=actor.id,
    )
    session.add(row)
    await session.flush()
    await session.refresh(row, ["created_at"])
    audit(
        session, actor, "composition.environment_key_created", TARGET, environment.id, environment.organization_id,
        composition=composition.slug, environment=environment.slug, prefix=minted.prefix,
    )
    return row, minted.secret


async def revoke_key(
    session: AsyncSession, composition: Composition, environment: CompositionEnvironment, key: str, actor: User,
) -> None:
    """Revoke a live key of ``environment`` (by id); a revoked, missing or another environment's key is 404."""
    try:
        key_id = uuid.UUID(key)
    except ValueError:
        key_id = None
    row = None if key_id is None else await session.scalar(
        select(CompositionEnvironmentKey).where(
            CompositionEnvironmentKey.id == key_id, CompositionEnvironmentKey.environment_id == environment.id,
            CompositionEnvironmentKey.revoked_at.is_(None),
        ).with_for_update()
    )
    if row is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Feed key not found.")
    row.revoked_at = utcnow()
    row.revoked_by_id = actor.id
    await session.flush()
    audit(
        session, actor, "composition.environment_key_revoked", TARGET, environment.id, environment.organization_id,
        composition=composition.slug, environment=environment.slug, prefix=row.prefix,
    )

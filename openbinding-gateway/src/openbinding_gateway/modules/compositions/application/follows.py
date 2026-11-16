"""Following a composition: a user who reads it is told of each version sealed later.

Adapted from SPHERE (SCORELabUS/SPHERE, MIT licence, revision 73779a8a), ``api/src/main/services/
PricingFollowService.ts``: only a reader may follow (anybody else is told it does not exist), a follower who can no
longer read it still stops following and is told the same, and a new version tells every follower who still reads
it, skipping its author. OpenBinding's visibility is the composition's, not each version's, so "reads it" is a
role in its organization or a public composition.
"""

from __future__ import annotations

import uuid

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ....collaboration import effective_role
from ....db.models import Composition, CompositionFollow, CompositionVersion, Organization, User
from ...shared.application import COMPOSITION_UPDATED, notify

PUBLIC = "public"


async def is_following(session: AsyncSession, user_id: uuid.UUID, composition_id: uuid.UUID) -> bool:
    return await session.scalar(
        select(CompositionFollow.id).where(
            CompositionFollow.user_id == user_id, CompositionFollow.composition_id == composition_id,
        ).limit(1)
    ) is not None


async def follow(session: AsyncSession, user_id: uuid.UUID, composition_id: uuid.UUID) -> None:
    """Follow, idempotently (a concurrent follow of the same pair is the same follow)."""
    if await is_following(session, user_id, composition_id):
        return
    try:
        async with session.begin_nested():
            session.add(CompositionFollow(user_id=user_id, composition_id=composition_id))
            await session.flush()
    except IntegrityError:
        pass


async def unfollow(session: AsyncSession, user_id: uuid.UUID, composition_id: uuid.UUID) -> None:
    await session.execute(
        delete(CompositionFollow).where(
            CompositionFollow.user_id == user_id, CompositionFollow.composition_id == composition_id,
        ).execution_options(synchronize_session=False)
    )


async def forget(session: AsyncSession, composition_ids) -> None:
    """Drop every follow of ``composition_ids`` (a select or a list), before they are deleted."""
    await session.execute(
        delete(CompositionFollow).where(CompositionFollow.composition_id.in_(composition_ids))
        .execution_options(synchronize_session=False)
    )


async def notify_followers(
    session: AsyncSession, composition: Composition, version: CompositionVersion, author: User,
) -> int:
    """Tell every follower of ``composition`` who still reads it, but the author, that ``version`` was sealed;
    returns how many were told."""
    follower_ids = (await session.scalars(
        select(CompositionFollow.user_id).where(CompositionFollow.composition_id == composition.id)
    )).all()
    organization = await session.get(Organization, composition.organization_id)
    told = 0
    for follower_id in follower_ids:
        if follower_id == author.id:
            continue
        follower = await session.get(User, follower_id)
        if follower is None or not follower.is_active:
            continue
        if composition.visibility != PUBLIC and await effective_role(session, composition.organization_id, follower) is None:
            continue
        stored = await notify(
            session, follower_id, COMPOSITION_UPDATED,
            f"New version of {composition.name}",
            f"@{author.username} sealed version {version.label} of \"{composition.name}\".",
            organization_id=str(composition.organization_id),
            organization_slug=organization.slug if organization is not None else None,
            composition_id=str(composition.id), composition_slug=composition.slug,
            version_id=str(version.id), version=version.label,
        )
        told += stored is not None
    return told

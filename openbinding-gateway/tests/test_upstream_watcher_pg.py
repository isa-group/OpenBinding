"""The upstream watcher on PostgreSQL (F6 A9, A10): one replica per cycle, lease claims, and idempotent recording.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import pytest
from sqlalchemy import select, update

from _upstream_rows import ref, watch, world
from openbinding_gateway.db.models import PricingWatch
from openbinding_gateway.jobs.reconciler import RECONCILER_LOCK_KEY, acquire_cycle_lock
from openbinding_gateway.modules.compositions.application import upstream_watcher as uw

pytestmark = pytest.mark.asyncio


async def test_one_replica_takes_a_cycle_and_the_keys_differ(pg) -> None:
    assert uw.UPSTREAM_WATCH_LOCK_KEY != RECONCILER_LOCK_KEY
    async with pg.session() as a, pg.session() as b, pg.session() as c:
        assert await acquire_cycle_lock(a, uw.UPSTREAM_WATCH_LOCK_KEY)
        assert not await acquire_cycle_lock(b, uw.UPSTREAM_WATCH_LOCK_KEY)
        assert await acquire_cycle_lock(c, RECONCILER_LOCK_KEY)  # the reconciler is not held up
        await a.rollback()
        assert await acquire_cycle_lock(b, uw.UPSTREAM_WATCH_LOCK_KEY)


async def test_two_replicas_claim_disjoint_watches(pg) -> None:
    async with pg.session() as setup:
        w = await world(setup)
        ids = []
        for _ in range(6):
            watch_id = await watch(setup)
            await ref(setup, w, watch_id, version_index=1)
            ids.append(watch_id)
        await setup.execute(update(PricingWatch).values(next_poll_at=PricingWatch.created_at))
        await setup.commit()
    async with pg.session() as a, pg.session() as b:
        # Without the advisory lock, the lease claims still poll each watch once.
        first = await uw.claim_due(a, 4)
        second = await uw.claim_due(b, 4)
    assert len(first) == 4 and len(second) == 2 and not set(first) & set(second)
    async with pg.session() as c:
        assert await uw.claim_due(c, 10) == []  # the lease holds
        rows = (await c.scalars(select(PricingWatch).where(PricingWatch.id.in_(ids)))).all()
        assert all(row.next_poll_at > row.created_at for row in rows)

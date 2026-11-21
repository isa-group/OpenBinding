"""The upstream watcher on PostgreSQL (F6 A9, A10): one replica per cycle, lease claims, and idempotent recording.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import pytest
from sqlalchemy import select, update

from _upstream_rows import BREVO_2026_10, BREVO_2026_11, ref, watch, world
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


async def _later_version(session, w, ordinal: int):
    from _environment_rows import _version

    version_id, _ = await _version(session, w.composition_id, w.user_id, ordinal, f"1.{ordinal}.0")
    return version_id


def _classified():
    from openbinding_gateway.modules.compositions.application import upstream_classify as uc
    from openbinding_gateway.modules.compositions.domain.upstream import Category

    return uc.Classification(Category.VALUES_CHANGED, (), True, {"schema": uc.DIFF_SCHEMA})


async def _write_event(session, w, watch_id, ref_id):
    from openbinding_gateway.db.models import CompositionVersion, PricingWatch, PricingWatchRef
    from openbinding_gateway.modules.compositions.application import upstream_events

    watch = await session.get(PricingWatch, watch_id)
    version = await session.get(CompositionVersion, w.versions[0])
    ref_row = await session.get(PricingWatchRef, ref_id)
    return await upstream_events._write(session, watch, version, ref_row, "binding", _classified(),
                                        old_ref=BREVO_2026_10, new_ref=BREVO_2026_11, old_snapshot=None,
                                        new_snapshot=None)


async def test_a_seal_holding_the_composition_makes_the_event_born_resolved(pg) -> None:
    import asyncio

    from openbinding_gateway.db.models import Composition, CompositionUpstreamEvent

    async with pg.session() as setup:
        w = await world(setup)
        watch_id = await watch(setup, version_order=[BREVO_2026_11, BREVO_2026_10])
        ref_id = await ref(setup, w, watch_id)
        await setup.commit()
    async with pg.session() as sealing, pg.session() as cycle:
        await sealing.execute(select(Composition).where(Composition.id == w.composition_id)
                              .with_for_update(key_share=True))
        later = await _later_version(sealing, w, 3)
        await ref(sealing, w._replace(versions=(later,)) if hasattr(w, "_replace") else
                  type(w)(w.user_id, w.organization_id, w.composition_id, (later,), w.evaluations,
                          w.other_composition_id, w.other_version_id, w.other_evaluation_id),
                  watch_id, pinned=BREVO_2026_11)
        task = asyncio.create_task(_write_event(cycle, w, watch_id, ref_id))
        await asyncio.sleep(0.5)
        assert not task.done()  # FOR SHARE waits for the seal's FOR NO KEY UPDATE
        await sealing.commit()
        await task
    async with pg.session() as check:
        event = await check.scalar(select(CompositionUpstreamEvent))
        assert (event.state, event.resolved_by_version_id) == ("resolved", later)


async def test_a_cycle_holding_the_composition_makes_the_seal_resolve_the_event(pg) -> None:
    import asyncio

    from openbinding_gateway.db.models import Composition, CompositionUpstreamEvent, CompositionVersion, User
    from openbinding_gateway.modules.compositions.application import upstream_events

    async with pg.session() as setup:
        w = await world(setup)
        watch_id = await watch(setup, version_order=[BREVO_2026_11, BREVO_2026_10])
        await ref(setup, w, watch_id)
        await setup.commit()
    async with pg.session() as cycle, pg.session() as sealing:
        await cycle.execute(select(Composition).where(Composition.id == w.composition_id).with_for_update(read=True))
        from _upstream_rows import event as event_row

        event_id = await event_row(cycle, w, watch_id)

        async def seal() -> None:
            composition = await sealing.scalar(select(Composition).where(Composition.id == w.composition_id)
                                               .with_for_update(key_share=True))
            later = await _later_version(sealing, w, 3)
            await ref(sealing, type(w)(w.user_id, w.organization_id, w.composition_id, (later,), w.evaluations,
                                       w.other_composition_id, w.other_version_id, w.other_evaluation_id),
                      watch_id, pinned=BREVO_2026_11)
            version = await sealing.get(CompositionVersion, later)
            await upstream_events.resolve_on_seal(sealing, composition, version, await sealing.get(User, w.user_id))
            await sealing.commit()

        task = asyncio.create_task(seal())
        await asyncio.sleep(0.5)
        assert not task.done()  # the seal waits for the cycle's FOR SHARE
        await cycle.commit()
        await task
    async with pg.session() as check:
        event = await check.get(CompositionUpstreamEvent, event_id)
        assert event.state == "resolved"


async def test_an_organization_deleted_while_a_cycle_records_leaves_no_orphan(pg) -> None:
    """The delete locks the composition; the cycle's ``FOR SHARE`` waits, then finds it gone and writes nothing."""
    import asyncio

    from openbinding_gateway.db.models import CompositionUpstreamEvent, Organization
    from openbinding_gateway.routes.organizations import _delete_subtree, _lock_subtree

    async with pg.session() as setup:
        w = await world(setup)
        watch_id = await watch(setup, version_order=[BREVO_2026_11, BREVO_2026_10])
        ref_id = await ref(setup, w, watch_id)
        await setup.commit()
    async with pg.session() as deleting, pg.session() as cycle:
        await _lock_subtree(deleting, [w.organization_id])
        task = asyncio.create_task(_write_event(cycle, w, watch_id, ref_id))
        await asyncio.sleep(0.5)
        assert not task.done()
        organization = await deleting.get(Organization, w.organization_id)
        await _delete_subtree(deleting, organization, [w.organization_id])
        await deleting.commit()
        assert await task is False
    async with pg.session() as check:
        assert (await check.scalars(select(CompositionUpstreamEvent))).all() == []
        assert await check.get(PricingWatch, watch_id) is not None  # a public watch stays

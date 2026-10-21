"""The two purges of phase 17 on a real PostgreSQL 16: duplicate copies of a snapshot, and old error events.

Both were tested on SQLite only (``test_ir_cutover.py`` for the copy that ``recompile_stale_snapshots`` removes,
``test_error_event_purge.py`` for the reconciler's hourly purge, which there runs against doubles). Here the schema
is the migrated one (real foreign keys, the sealing triggers of case revisions, the partial and unique indexes) and
several sessions work at once:

* **Owners and organizations**: a copy is the *same owner's*; another owner's snapshot of the same package, and the
  case revisions of another organization, are never touched; the error-event purge is by age only and treats every
  organization alike; a package uploaded by another owner is another snapshot that the first owner cannot reach.
* **Races**: two replicas regenerating the same snapshot end in one consistent snapshot; two purges of the same
  expired events delete each event once and the loser waits for the winner (seen in ``pg_stat_activity``); a purge
  does not stop new events from being recorded; the replica that does not hold the reconciler's cycle lock purges
  nothing.
* **Deduplication and idempotency**: two uploads of the same package at once are one snapshot and one set of
  resources; a second recompilation or purge changes nothing; the reconciler purges once an hour.
* **Rollback**: a recompilation or a purge in a transaction that fails or is rolled back leaves every row it
  would have removed or rewritten.

Needs ``TEST_DATABASE_URL`` (the ``pg`` fixture skips without it); synthetic data, no network.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from _pg_support import settle
from test_engine_registry_service import make_user
from test_ir_cutover import count, snapshot_ir_problem, stored_ir
from test_snapshot_recompile import stale_pinned

from openbinding_gateway import telemetry
from openbinding_gateway.db import base as db_base
from openbinding_gateway.db.models import (
    BindingIRSnapshot,
    InstanceResource,
    InstanceSnapshot,
    Job,
    JobState,
    utcnow,
)
from openbinding_gateway.db.platform_models import ApiErrorEvent, BindingCaseRevision
from openbinding_gateway.integrations import bim
from openbinding_gateway.jobs import reconciler
from openbinding_gateway.services.snapshots import (
    compile_resolved,
    owned_snapshot,
    persist_snapshot,
    recompile_stale_snapshots,
)

class Abort(Exception):
    """A transaction that fails on its own, after the work it would have committed."""


# -- helpers: snapshots -------------------------------------------------------------------------------


async def a_copy_of(session, snapshot_id: str, owner) -> str:
    """What an upload (or a seed) after the release leaves: a second snapshot of the same package, current."""
    stale = await session.get(InstanceSnapshot, uuid.UUID(snapshot_id))
    copy = await persist_snapshot(await compile_resolved(stale.source_archive, session, owner), owner, session)
    await session.commit()
    assert copy != snapshot_id
    return copy


async def a_stale_world(pg, *, copy: bool = True):
    """Alice with a stale, pinned snapshot and (by default) a current copy of it; returns ``(alice id, stale id, copy id)``."""
    async with pg.session() as session:
        alice = await make_user(session)
        stale = await stale_pinned(session, alice)
        twin = await a_copy_of(session, stale, alice) if copy else None
    return alice.id, stale, twin


async def rows(pg, model) -> int:
    async with pg.session() as session:
        return await count(session, model)


async def exists(pg, snapshot_id: str) -> bool:
    async with pg.session() as session:
        return await session.get(InstanceSnapshot, uuid.UUID(snapshot_id)) is not None


async def resources_of(pg, snapshot_id: str) -> int:
    async with pg.session() as session:
        return int(await session.scalar(
            select(func.count()).select_from(InstanceResource).where(InstanceResource.snapshot_id == uuid.UUID(snapshot_id))
        ))


async def pinned_rows(pg, snapshot_id: str) -> list[tuple]:
    """The case revisions that pin the snapshot, as stored (they are sealed: they must never change)."""
    async with pg.session() as session:
        return [tuple(row) for row in (await session.execute(
            select(BindingCaseRevision.id, BindingCaseRevision.binding_case_id, BindingCaseRevision.revision,
                   BindingCaseRevision.digest, BindingCaseRevision.source_snapshot_id)
            .where(BindingCaseRevision.source_snapshot_id == uuid.UUID(snapshot_id))
            .order_by(BindingCaseRevision.id)
        )).all()]


async def problem_of(pg, snapshot_id: str) -> str | None:
    async with pg.session() as session:
        return await snapshot_ir_problem(session, uuid.UUID(snapshot_id))


async def is_current(pg, snapshot_id: str) -> bool:
    async with pg.session() as session:
        return bim.ir_is_installed(await stored_ir(session, snapshot_id))


async def recompile(pg):
    """The seed's step on a session of its own: recompile and commit."""
    async with pg.session() as session:
        report = await recompile_stale_snapshots(session)
        await session.commit()
    return report


# -- the duplicate copy of a package -------------------------------------------------------------------------


async def test_an_unused_copy_is_removed_with_its_resources_and_ir_and_the_snapshot_is_regenerated(pg):
    _, stale, twin = await a_stale_world(pg)
    assert await rows(pg, InstanceSnapshot) == 2 and await rows(pg, BindingIRSnapshot) == 2
    per_snapshot = await resources_of(pg, stale)
    assert per_snapshot and await resources_of(pg, twin) == per_snapshot
    sealed = await pinned_rows(pg, stale)

    report = await recompile(pg)

    assert [item[0] for item in report.recompiled] == [stale] and report.failures == ()
    assert not await exists(pg, twin)
    assert await resources_of(pg, twin) == 0  # no orphan resources of the removed copy
    assert (await rows(pg, InstanceSnapshot), await rows(pg, BindingIRSnapshot)) == (1, 1)
    assert await rows(pg, InstanceResource) == per_snapshot
    assert await is_current(pg, stale) and await problem_of(pg, stale) is None
    assert await pinned_rows(pg, stale) == sealed  # the sealed revision still pins it, unchanged


async def test_a_copy_that_a_job_uses_is_kept_and_reported_as_a_conflict(pg):
    alice_id, stale, twin = await a_stale_world(pg)
    async with pg.session() as session:
        session.add(Job(
            owner_id=alice_id, engine_id="random-search", engine_job_id="engine-1", service_url="http://engine",
            state=JobState.QUEUED, instance_snapshot_id=uuid.UUID(twin),
        ))
        await session.commit()
    sealed = await pinned_rows(pg, stale)

    report = await recompile(pg)

    assert not report.changed and report.failed == ((stale, "snapshot_conflict"),)
    assert await exists(pg, twin) and await exists(pg, stale)
    assert await rows(pg, InstanceSnapshot) == 2
    assert not await is_current(pg, stale) and await problem_of(pg, stale) == "contract_not_installed"
    assert await problem_of(pg, twin) is None
    assert await pinned_rows(pg, stale) == sealed


async def test_the_copy_is_the_same_owners_and_another_owners_snapshot_of_the_package_is_untouched(pg):
    alice_id, stale, twin = await a_stale_world(pg)
    async with pg.session() as session:
        bob = await make_user(session)
        archive = (await session.get(InstanceSnapshot, uuid.UUID(stale))).source_archive
        bobs = await persist_snapshot(await compile_resolved(archive, session, bob), bob, session)
        await session.commit()
    before = await rows(pg, InstanceResource)

    report = await recompile(pg)

    assert [item[0] for item in report.recompiled] == [stale] and report.failures == ()
    assert not await exists(pg, twin)  # alice's copy went
    assert await exists(pg, bobs)  # same package, same compilation digest, another owner: not alice's copy
    async with pg.session() as session:
        assert (await session.get(InstanceSnapshot, uuid.UUID(bobs))).owner_id == bob.id
        assert (await session.get(InstanceSnapshot, uuid.UUID(stale))).owner_id == alice_id
    assert await resources_of(pg, bobs) > 0 and await problem_of(pg, bobs) is None
    assert await rows(pg, InstanceResource) == before - await resources_of(pg, stale)  # only the copy's rows left


async def test_a_second_recompilation_changes_nothing(pg):
    _, stale, _ = await a_stale_world(pg)
    await recompile(pg)
    async with pg.session() as session:
        before = await stored_ir(session, stale)

    again = await recompile(pg)

    assert not again.changed and again.failures == ()
    async with pg.session() as session:
        assert await stored_ir(session, stale) == before
    assert (await rows(pg, InstanceSnapshot), await rows(pg, BindingIRSnapshot)) == (1, 1)


async def test_a_recompilation_that_is_rolled_back_leaves_the_copy_and_the_stale_snapshot_as_they_were(pg):
    _, stale, twin = await a_stale_world(pg)
    sealed = await pinned_rows(pg, stale)
    async with pg.session() as session:
        report = await recompile_stale_snapshots(session)
        assert report.changed
        await session.flush()
        await session.rollback()

    assert await exists(pg, twin) and await resources_of(pg, twin) > 0
    assert (await rows(pg, InstanceSnapshot), await rows(pg, BindingIRSnapshot)) == (2, 2)
    assert not await is_current(pg, stale) and await problem_of(pg, stale) == "contract_not_installed"
    assert await pinned_rows(pg, stale) == sealed
    # Nothing was poisoned: the same work is found again, and done.
    assert (await recompile(pg)).changed and not await exists(pg, twin)


async def test_a_transaction_that_fails_after_recompiling_leaves_every_row_it_would_have_removed(pg):
    _, stale, twin = await a_stale_world(pg)
    with pytest.raises(Abort):
        async with pg.session() as session:
            try:
                await recompile_stale_snapshots(session)
                raise Abort("the caller's next step failed before the commit")
            except BaseException:
                await session.rollback()
                raise

    assert await exists(pg, twin) and await exists(pg, stale)
    assert not await is_current(pg, stale)
    assert await rows(pg, InstanceResource) == 2 * await resources_of(pg, stale)


async def test_two_replicas_regenerating_the_same_snapshot_end_in_one_consistent_snapshot(pg):
    _, stale, twin = await a_stale_world(pg)
    sealed = await pinned_rows(pg, stale)

    async with pg.session() as a, pg.session() as b:
        pid_a, pid_b = await pg.backend_pid(a), await pg.backend_pid(b)
        assert pid_a != pid_b
        first = await recompile_stale_snapshots(a)  # the copy is deleted and the snapshot rewritten, uncommitted
        assert first.changed
        waiting = asyncio.create_task(recompile_stale_snapshots(b))
        await pg.wait_until_blocked(pid_b, seconds=60)  # b reached the rows a deleted and waits for a
        assert not waiting.done()
        await a.commit()
        (second,) = await settle(waiting, seconds=60)
        if isinstance(second, BaseException):
            await b.rollback()
        else:
            await b.commit()

    assert not isinstance(second, BaseException), second
    assert {code for _, code in second.failed} <= {"database_error"}  # it may lose the race; it may not corrupt
    assert (await rows(pg, InstanceSnapshot), await rows(pg, BindingIRSnapshot)) == (1, 1)
    assert not await exists(pg, twin) and await resources_of(pg, twin) == 0
    assert await is_current(pg, stale) and await problem_of(pg, stale) is None
    assert await pinned_rows(pg, stale) == sealed


async def test_two_uploads_of_the_same_package_at_once_are_one_snapshot(pg):
    async with pg.session() as session:
        alice = await make_user(session)
        stale = await stale_pinned(session, alice)
        archive = (await session.get(InstanceSnapshot, uuid.UUID(stale))).source_archive
        compilation = await compile_resolved(archive, session, alice)
        await session.commit()
    per_snapshot = await resources_of(pg, stale)

    async with pg.session() as a, pg.session() as b:
        pid_b = await pg.backend_pid(b)
        first = await persist_snapshot(compilation, await a.get(type(alice), alice.id), a)  # inserted, not committed
        waiting = asyncio.create_task(persist_snapshot(compilation, await b.get(type(alice), alice.id), b))
        await pg.wait_until_blocked(pid_b)  # the unique key (owner, package, compilation) stops the second upload
        await a.commit()
        (second,) = await settle(waiting)
        await b.commit()

    assert not isinstance(second, BaseException), second
    assert second == first  # the loser is given the snapshot that won
    assert await rows(pg, InstanceSnapshot) == 2  # the stale one and the one both uploads made
    assert await resources_of(pg, first) == per_snapshot and await rows(pg, InstanceResource) == 2 * per_snapshot
    assert await rows(pg, BindingIRSnapshot) == 2


async def test_the_same_package_uploaded_by_another_owner_is_another_snapshot_that_nobody_else_reaches(pg):
    async with pg.session() as session:
        alice, bob = await make_user(session), await make_user(session)
        stale = await stale_pinned(session, alice)
        archive = (await session.get(InstanceSnapshot, uuid.UUID(stale))).source_archive
        mine = await persist_snapshot(await compile_resolved(archive, session, alice), alice, session)
        theirs = await persist_snapshot(await compile_resolved(archive, session, bob), bob, session)
        await session.commit()

    assert len({stale, mine, theirs}) == 3
    async with pg.session() as session:
        assert (await owned_snapshot(mine, alice, session)).id == uuid.UUID(mine)
        assert await owned_snapshot(mine, bob, session) is None  # no organization shares it: no leak
        assert await owned_snapshot(theirs, alice, session) is None
        assert (await owned_snapshot(theirs, bob, session)).id == uuid.UUID(theirs)


# -- the old error events -----------------------------------------------------------------------------------


def an_event(organization_id, *, age_days: float, user_id=None, code: str = "rate_limit_exceeded") -> ApiErrorEvent:
    return ApiErrorEvent(
        id=uuid.uuid4(), user_id=user_id, organization_id=organization_id, status_code=429, category="concurrency",
        error_code=code, endpoint="/v1/jobs", http_method="POST", detail={}, created_at=utcnow() - timedelta(days=age_days),
    )


async def store_events(pg, *events: ApiErrorEvent) -> list[uuid.UUID]:
    async with pg.session() as session:
        session.add_all(events)
        await session.commit()
    return [item.id for item in events]


async def surviving(pg) -> set[uuid.UUID]:
    async with pg.session() as session:
        return set((await session.scalars(select(ApiErrorEvent.id))).all())


async def purge(pg) -> int:
    async with pg.session() as session:
        removed = await telemetry.purge_old_error_events(session, days=90)
        await session.commit()
    return removed


async def test_the_purge_is_by_age_only_and_treats_every_organization_alike(pg):
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    async with pg.session() as session:
        member = await make_user(session)
    old_a1, old_a2, old_b, old_nobody = await store_events(
        pg, an_event(org_a, age_days=91), an_event(org_a, age_days=400, user_id=member.id),
        an_event(org_b, age_days=200), an_event(None, age_days=95),
    )
    recent_a, recent_b, recent_nobody = await store_events(
        pg, an_event(org_a, age_days=89), an_event(org_b, age_days=1), an_event(None, age_days=0),
    )

    removed = await purge(pg)

    assert removed == 4
    assert await surviving(pg) == {recent_a, recent_b, recent_nobody}
    assert not ({old_a1, old_a2, old_b, old_nobody} & await surviving(pg))
    async with pg.session() as session:
        assert await session.get(type(member), member.id) is not None  # the account behind an event is not an event


async def test_purging_again_removes_nothing_more(pg):
    org = uuid.uuid4()
    await store_events(pg, an_event(org, age_days=120), an_event(org, age_days=3))

    assert (await purge(pg), await purge(pg)) == (1, 0)
    assert await rows(pg, ApiErrorEvent) == 1


async def test_a_purge_that_is_rolled_back_or_fails_removes_nothing(pg):
    org = uuid.uuid4()
    await store_events(pg, an_event(org, age_days=100), an_event(org, age_days=200), an_event(org, age_days=2))
    async with pg.session() as session:
        assert await telemetry.purge_old_error_events(session, days=90) == 2
        await session.rollback()
    assert await rows(pg, ApiErrorEvent) == 3

    with pytest.raises(Abort):
        async with pg.session() as session:
            try:
                await telemetry.purge_old_error_events(session, days=90)
                raise Abort("the next step failed before the commit")
            except BaseException:
                await session.rollback()
                raise
    assert await rows(pg, ApiErrorEvent) == 3
    assert await purge(pg) == 2  # and the work is still there to do


async def test_two_purges_of_the_same_events_delete_each_event_once_and_the_second_waits(pg):
    org = uuid.uuid4()
    await store_events(pg, *(an_event(org, age_days=100 + n) for n in range(5)))
    (kept,) = await store_events(pg, an_event(org, age_days=1))

    async with pg.session() as a, pg.session() as b:
        pid_a, pid_b = await pg.backend_pid(a), await pg.backend_pid(b)
        assert pid_a != pid_b
        first = await telemetry.purge_old_error_events(a, days=90)  # deleted, not committed
        waiting = asyncio.create_task(telemetry.purge_old_error_events(b, days=90))
        await pg.wait_until_blocked(pid_b)  # b is waiting for the rows a deleted
        assert not waiting.done()
        await a.commit()
        (second,) = await settle(waiting)
        await b.commit()

    assert (first, second) == (5, 0)  # one effect, however many replicas ran
    assert await surviving(pg) == {kept}


async def test_a_purge_does_not_stop_new_events_from_being_recorded(pg):
    org = uuid.uuid4()
    await store_events(pg, an_event(org, age_days=100), an_event(org, age_days=101))

    async with pg.session() as a:
        assert await telemetry.purge_old_error_events(a, days=90) == 2  # open and uncommitted
        (fresh,) = await asyncio.wait_for(store_events(pg, an_event(org, age_days=0)), 10)  # nobody waits
        await a.commit()

    assert await surviving(pg) == {fresh}


async def test_the_reconciler_purges_once_an_hour_on_the_real_database(pg, monkeypatch):
    org = uuid.uuid4()
    monkeypatch.setattr(reconciler, "_last_purge", None)
    (old,) = await store_events(pg, an_event(org, age_days=120))
    (recent,) = await store_events(pg, an_event(org, age_days=2))

    await reconciler._reconcile_cycle(pg.factory)
    assert await surviving(pg) == {recent}

    (old_again,) = await store_events(pg, an_event(org, age_days=130))
    await reconciler._reconcile_cycle(pg.factory)  # within the hour: not purged again
    assert await surviving(pg) == {recent, old_again}

    monkeypatch.setattr(reconciler, "_last_purge", reconciler.time.monotonic() - reconciler.ERROR_EVENT_PURGE_INTERVAL_S - 1)
    await reconciler._reconcile_cycle(pg.factory)  # the hour has passed
    assert await surviving(pg) == {recent}
    assert old not in await surviving(pg)


async def test_the_replica_without_the_cycle_lock_purges_nothing(pg, monkeypatch):
    org = uuid.uuid4()
    monkeypatch.setattr(reconciler, "_last_purge", None)
    monkeypatch.setattr(db_base, "is_configured", lambda: True)
    monkeypatch.setattr(db_base, "session_factory", lambda: pg.factory)
    sweeps = SimpleNamespace(left=1)

    async def sleep(_seconds):  # one cycle per run, without touching the polling of the test itself
        if sweeps.left <= 0:
            raise asyncio.CancelledError
        sweeps.left -= 1

    monkeypatch.setattr(reconciler, "asyncio", SimpleNamespace(sleep=sleep, CancelledError=asyncio.CancelledError))
    (old,) = await store_events(pg, an_event(org, age_days=150))

    async with pg.session() as holder:
        assert await reconciler.acquire_cycle_lock(holder) is True  # another replica is reconciling
        with pytest.raises(asyncio.CancelledError):
            await reconciler.run_reconciler(interval_s=0)
        assert await surviving(pg) == {old}  # this replica skipped the cycle
        await holder.rollback()

    sweeps.left = 1
    with pytest.raises(asyncio.CancelledError):
        await reconciler.run_reconciler(interval_s=0)  # the lock is free: the cycle runs and purges
    assert await surviving(pg) == set()

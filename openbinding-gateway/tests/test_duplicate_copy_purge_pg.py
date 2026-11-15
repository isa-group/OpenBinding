"""The purge of old error events on a real PostgreSQL 16.

It was tested on SQLite only (``test_error_event_purge.py`` for the reconciler's hourly purge, which there runs
against doubles). Here the schema is the migrated one and several sessions work at once:

* **Organizations**: the purge is by age only and treats every organization alike.
* **Races**: two purges of the same expired events delete each event once and the loser waits for the winner (seen
  in ``pg_stat_activity``); a purge does not stop new events from being recorded; the replica that does not hold the
  reconciler's cycle lock purges nothing.
* **Idempotency**: a second purge changes nothing; the reconciler purges once an hour.
* **Rollback**: a purge in a transaction that fails or is rolled back leaves every row it would have removed.

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

from openbinding_gateway import telemetry
from openbinding_gateway.db import base as db_base
from openbinding_gateway.db.models import utcnow
from openbinding_gateway.db.platform_models import ApiErrorEvent
from openbinding_gateway.jobs import reconciler

class Abort(Exception):
    """A transaction that fails on its own, after the work it would have committed."""


async def rows(pg, model) -> int:
    async with pg.session() as session:
        return int(await session.scalar(select(func.count()).select_from(model)) or 0)


# -- the old error events -----------------------------------------------------------------------------------


def an_event(organization_id, *, age_days: float, user_id=None, code: str = "rate_limit_exceeded") -> ApiErrorEvent:
    return ApiErrorEvent(
        id=uuid.uuid4(), user_id=user_id, organization_id=organization_id, status_code=429, category="concurrency",
        error_code=code, endpoint="/v1/organizations/acme/runs", http_method="POST", detail={}, created_at=utcnow() - timedelta(days=age_days),
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

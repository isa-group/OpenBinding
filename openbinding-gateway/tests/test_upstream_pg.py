"""The F6 tables on PostgreSQL: what the database itself enforces (F6 A7).

The triggers keep a watch's identity, a reference's row and an event's every column but its state, review and
resolution; the state machine moves an event forward only, reviews it once and resolves it once; the composite foreign
keys keep refs and events within their composition; the partial unique indexes keep one event per key under two
concurrent inserts (the watcher's idempotency across replicas); and ``gone_epoch`` grows by exactly one when two
conditional UPDATEs race to ``gone``.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import DBAPIError, IntegrityError

from _upstream_rows import BREVO_2026_10, BREVO_2026_11, event, ref, watch, world
from openbinding_gateway.db.models import CompositionUpstreamEvent, PricingWatch, PricingWatchRef, utcnow

pytestmark = pytest.mark.asyncio


async def test_a_watch_keeps_what_it_names(pg) -> None:
    async with pg.session() as session:
        watch_id = await watch(session)
        await session.commit()
        await session.execute(update(PricingWatch).where(PricingWatch.id == watch_id).values(status="active", failures=1))
        await session.commit()
        with pytest.raises(DBAPIError, match="protected columns of pricing_watches"):
            await session.execute(update(PricingWatch).where(PricingWatch.id == watch_id).values(pricing_id="b" * 24))
        await session.rollback()


async def test_refs_are_immutable_and_stay_in_their_composition(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        watch_id = await watch(session)
        ref_id = await ref(session, w, watch_id)
        await session.commit()
        with pytest.raises(DBAPIError, match="pricing watch references are immutable"):
            await session.execute(update(PricingWatchRef).where(PricingWatchRef.id == ref_id).values(sphere_ref="x"))
        await session.rollback()
        with pytest.raises(IntegrityError, match="fk_pricing_watch_refs_version"):
            session.add(PricingWatchRef(
                organization_id=w.organization_id, composition_id=w.composition_id, version_id=w.other_version_id,
                watch_id=watch_id, subject="binding", via="from", selection={}, ref_key="k",
            ))
            await session.flush()
        await session.rollback()


async def test_an_event_names_a_version_of_its_composition(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        watch_id = await watch(session)
        await session.commit()
        with pytest.raises(IntegrityError, match="fk_upstream_events_version"):
            session.add(CompositionUpstreamEvent(
                organization_id=w.organization_id, composition_id=w.composition_id, version_id=w.other_version_id,
                watch_id=watch_id, subject="binding", category="values_changed", notify=True, old_ref="a", new_ref="b",
                diff={}, classifier="1",
            ))
            await session.flush()
        await session.rollback()
        with pytest.raises(IntegrityError, match="fk_upstream_events_resolved_by_version"):
            await event(session, w, watch_id, state="resolved", resolved_by_version_id=w.other_version_id,
                        resolved_by_id=w.user_id, resolved_at=utcnow())
        await session.rollback()


async def test_the_event_checks(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        watch_id = await watch(session)
        await session.commit()
        for values, constraint in (
            ({"subject": "offering", "state": "resolved", "resolved_by_version_id": w.versions[1],
              "resolved_by_id": w.user_id, "resolved_at": utcnow()}, "offering_never_resolved"),
            ({"state": "resolved"}, "resolved_whole"),
            ({"resolved_at": utcnow()}, "resolved"),
            ({"reviewed_at": utcnow()}, "reviewed_whole"),
            ({"category": "offering_changed"}, "offering_category"),
        ):
            with pytest.raises(IntegrityError, match=constraint):
                await event(session, w, watch_id, **values)
            await session.rollback()


async def test_the_state_machine_on_postgresql(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        watch_id = await watch(session)
        first = await event(session, w, watch_id)
        second = await event(session, w, watch_id, new="6fff00000000000000000002")
        await session.commit()

        async def move(event_id, **values) -> None:
            await session.execute(update(CompositionUpstreamEvent).where(CompositionUpstreamEvent.id == event_id)
                                  .values(**values))
            await session.commit()

        refused = "moves forward only"
        for values in ({"note": "x"}, {"reviewed_by_id": w.user_id, "reviewed_at": utcnow()}, {"state": "nowhere"}):
            with pytest.raises((DBAPIError, IntegrityError)):
                await move(first, **values)
            await session.rollback()
        with pytest.raises(DBAPIError, match="immutable but for its state"):
            await move(first, diff={"schema": "y"})
        await session.rollback()
        # open -> resolved directly (a seal before any review).
        await move(second, state="resolved", resolved_by_version_id=w.versions[1], resolved_by_id=w.user_id,
                   resolved_at=utcnow())
        # open -> reviewed with its note, once; then reviewed -> resolved keeps it.
        await move(first, state="reviewed", note="Seen", reviewed_by_id=w.user_id, reviewed_at=utcnow())
        with pytest.raises(DBAPIError, match=refused):
            await move(first, note="edited")
        await session.rollback()
        with pytest.raises(DBAPIError, match=refused):
            await move(first, state="open")
        await session.rollback()
        await move(first, state="resolved", resolved_by_version_id=w.versions[1], resolved_by_id=w.user_id,
                   resolved_at=utcnow())
        for values in ({"note": "late"}, {"state": "reviewed"}, {"resolved_by_version_id": w.versions[0]}):
            with pytest.raises(DBAPIError, match=refused):
                await move(first, **values)
            await session.rollback()
        row = await session.get(CompositionUpstreamEvent, first)
        await session.refresh(row)
        assert (row.state, row.note) == ("resolved", "Seen")


def _values(w, watch_id, subject: str = "binding") -> dict:
    return dict(
        id=uuid.uuid4(), organization_id=w.organization_id, composition_id=w.composition_id, version_id=w.versions[0],
        watch_id=watch_id, subject=subject, category="offering_changed" if subject == "offering" else "values_changed",
        tasks=[], reasons=[], notify=True, old_ref=BREVO_2026_10, new_ref=BREVO_2026_11, diff={}, classifier="1",
        state="open", note="", detected_at=utcnow(),
    )


@pytest.mark.parametrize("subject", ["binding", "offering"])
async def test_two_concurrent_inserts_of_one_event_write_one_row(pg, subject) -> None:
    async with pg.session() as setup:
        w = await world(setup)
        watch_id = await watch(setup)
        await setup.commit()
    async with pg.session() as a, pg.session() as b:
        target = ["version_id", "watch_id", "old_ref", "new_ref"] if subject == "binding" else [
            "composition_id", "watch_id", "new_ref"]

        def statement():
            return (insert(CompositionUpstreamEvent).values(**_values(w, watch_id, subject))
                    .on_conflict_do_nothing(index_elements=target, index_where=text(f"subject = '{subject}'"))
                    .returning(CompositionUpstreamEvent.id))

        first = (await a.execute(statement())).scalar_one_or_none()

        async def racing():
            found = (await b.execute(statement())).scalar_one_or_none()
            await b.commit()
            return found

        task = asyncio.create_task(racing())
        await asyncio.sleep(0.5)
        assert not task.done()  # the second waits on the unique index
        await a.commit()
        second = await task
        assert first is not None and second is None
    async with pg.session() as check:
        count = (await check.execute(select(CompositionUpstreamEvent.id).where(
            CompositionUpstreamEvent.composition_id == w.composition_id))).all()
        assert len(count) == 1


async def test_two_racing_disappearances_raise_the_epoch_once(pg) -> None:
    async with pg.session() as setup:
        watch_id = await watch(setup, status="not_found", not_found_count=1)
        await setup.commit()
    gone = text("UPDATE pricing_watches SET status = 'gone', gone_epoch = gone_epoch + 1 "
                "WHERE id = :id AND status <> 'gone' RETURNING gone_epoch")
    async with pg.session() as a, pg.session() as b:
        first = (await a.execute(gone, {"id": watch_id})).scalar_one_or_none()

        async def racing():
            found = (await b.execute(gone, {"id": watch_id})).scalar_one_or_none()
            await b.commit()
            return found

        task = asyncio.create_task(racing())
        await asyncio.sleep(0.5)
        await a.commit()
        assert first == 1 and await task is None
    async with pg.session() as check:
        row = await check.get(PricingWatch, watch_id)
        assert (row.status, row.gone_epoch) == ("gone", 1)


async def test_two_seals_racing_on_one_family_make_one_watch(pg) -> None:
    from openbinding_gateway.modules.compositions.application.watches import watch_for

    family = uuid.uuid4().hex[:24]
    async with pg.session() as a, pg.session() as b:
        first = await watch_for(a, "sphere", None, family, "public", None)

        async def racing():
            found = await watch_for(b, "sphere", None, family, "public", None)
            await b.commit()
            return found.id

        task = asyncio.create_task(racing())
        await asyncio.sleep(0.5)
        assert not task.done()  # the second insert waits on the unique watch key
        await a.commit()
        assert await task == first.id
    async with pg.session() as check:
        rows = (await check.scalars(select(PricingWatch).where(PricingWatch.pricing_id == family))).all()
        assert len(rows) == 1 and rows[0].status == "pending"

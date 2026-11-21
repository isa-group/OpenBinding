"""The F6 tables on SQLite: shapes, defaults, CHECKs, the partial uniques and the triggers (F6 A7).

SQLite enforces neither foreign keys nor row locks; ``test_upstream_pg.py`` checks those, the races and the triggers on
PostgreSQL.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, update
from sqlalchemy.exc import DBAPIError, IntegrityError

from _upstream_rows import BREVO_2026_11, attempt, event, ref, watch, world
from openbinding_gateway.db.models import (
    CompositionUpstreamEvent,
    PricingRefAttempt,
    PricingWatch,
    PricingWatchRef,
    utcnow,
)

pytestmark = pytest.mark.asyncio


async def test_a_watch_starts_pending_and_due(db_session) -> None:
    watch_id = await watch(db_session)
    await db_session.commit()
    row = await db_session.get(PricingWatch, watch_id)
    assert row.status == "pending" and row.version_order == [] and row.equivalent == []
    assert (row.not_found_count, row.failures, row.gone_epoch) == (0, 0, 0)
    assert row.next_poll_at is not None and row.observed_at is None


async def test_the_watch_checks(db_session) -> None:
    w = await world(db_session)
    for values in (
        {"status": "lost"},
        {"source_kind": "ftp"},
        {"registry": "lab"},
        {"source_kind": "registry"},
        {"failures": -1},
    ):
        with pytest.raises(IntegrityError):
            await watch(db_session, **values)
        await db_session.rollback()
    with pytest.raises(IntegrityError):  # an organization's scope names the organization
        db_session.add(PricingWatch(source_kind="sphere", pricing_id="a" * 24, scope_key="public",
                                    organization_id=w.organization_id, watch_key="k"))
        await db_session.flush()
    await db_session.rollback()


async def test_what_a_watch_names_never_changes_but_its_schedule_does(db_session) -> None:
    watch_id = await watch(db_session)
    await db_session.commit()
    await db_session.execute(update(PricingWatch).where(PricingWatch.id == watch_id).values(
        status="active", failures=2, next_poll_at=utcnow(), version_order=["a"], gone_epoch=1))
    await db_session.commit()
    for values in ({"pricing_id": "b" * 24}, {"scope_key": "registry:x"}, {"watch_key": "other"}):
        with pytest.raises(DBAPIError, match="protected columns of pricing_watches"):
            await db_session.execute(update(PricingWatch).where(PricingWatch.id == watch_id).values(**values))
        await db_session.rollback()


async def test_a_ref_is_insert_only_and_unique_per_version(db_session) -> None:
    w = await world(db_session)
    watch_id = await watch(db_session)
    ref_id = await ref(db_session, w, watch_id)
    unresolved = await ref(db_session, w, None, sphere_ref="nobody/nothing")
    await db_session.commit()
    row = await db_session.get(PricingWatchRef, unresolved)
    assert row.watch_id is None and row.tasks == []
    with pytest.raises(DBAPIError, match="pricing watch references are immutable"):
        await db_session.execute(update(PricingWatchRef).where(PricingWatchRef.id == ref_id).values(tasks=["x"]))
    await db_session.rollback()
    with pytest.raises(IntegrityError):
        await ref(db_session, w, watch_id)
    await db_session.rollback()
    with pytest.raises(IntegrityError):
        await ref(db_session, w, watch_id, pinned="c" * 24, via="manual")
    await db_session.rollback()
    await db_session.execute(delete(PricingWatchRef).where(PricingWatchRef.id == ref_id))
    await db_session.commit()


async def test_an_event_starts_open_and_its_checks_hold(db_session) -> None:
    w = await world(db_session)
    watch_id = await watch(db_session)
    event_id = await event(db_session, w, watch_id)
    await db_session.commit()
    row = await db_session.get(CompositionUpstreamEvent, event_id)
    assert row.state == "open" and row.note == "" and row.reviewed_at is None and row.detected_at is not None
    for values in (
        {"category": "worse"},
        {"category": "offering_changed"},
        {"subject": "offering", "state": "resolved", "resolved_by_version_id": w.versions[1],
         "resolved_by_id": w.user_id, "resolved_at": utcnow()},
        {"state": "resolved"},
        {"reviewed_by_id": w.user_id},
    ):
        with pytest.raises(IntegrityError):
            await event(db_session, w, watch_id, new="n" + str(len(values)) + values.get("category", "x")[:3], **values)
        await db_session.rollback()


async def test_the_partial_uniques_are_per_subject(db_session) -> None:
    w = await world(db_session)
    watch_id = await watch(db_session)
    await event(db_session, w, watch_id)
    await db_session.commit()
    with pytest.raises(IntegrityError):
        await event(db_session, w, watch_id)
    await db_session.rollback()
    await event(db_session, w, watch_id, subject="offering")
    await db_session.commit()
    with pytest.raises(IntegrityError):  # one offering event per composition, watch and new version
        await event(db_session, w, watch_id, subject="offering", version_index=1)
    await db_session.rollback()


async def test_the_state_machine(db_session) -> None:
    w = await world(db_session)
    watch_id = await watch(db_session)
    event_id = await event(db_session, w, watch_id)
    await db_session.commit()

    async def move(**values) -> None:
        await db_session.execute(update(CompositionUpstreamEvent).where(CompositionUpstreamEvent.id == event_id)
                                 .values(**values))
        await db_session.commit()

    with pytest.raises(DBAPIError, match="moves forward only"):
        await move(note="sneaky")
    await db_session.rollback()
    with pytest.raises(DBAPIError, match="immutable but for its state"):
        await move(category="binding_invalid")
    await db_session.rollback()
    await move(state="reviewed", note="Seen", reviewed_by_id=w.user_id, reviewed_at=utcnow())
    with pytest.raises(DBAPIError, match="moves forward only"):
        await move(note="again")
    await db_session.rollback()
    with pytest.raises(DBAPIError, match="moves forward only"):
        await move(state="open")
    await db_session.rollback()
    await move(state="resolved", resolved_by_version_id=w.versions[1], resolved_by_id=w.user_id, resolved_at=utcnow())
    row = await db_session.get(CompositionUpstreamEvent, event_id)
    await db_session.refresh(row)
    assert (row.state, row.note, row.reviewed_by_id) == ("resolved", "Seen", w.user_id)
    for values in ({"note": "after"}, {"state": "reviewed"}, {"resolved_at": utcnow()}):
        with pytest.raises(DBAPIError, match="moves forward only"):
            await move(**values)
        await db_session.rollback()


async def test_attempts_are_unique_per_organization_family_and_version(db_session) -> None:
    w = await world(db_session)
    await attempt(db_session, w.organization_id)
    await db_session.commit()
    with pytest.raises(IntegrityError):
        await attempt(db_session, w.organization_id)
    await db_session.rollback()
    await attempt(db_session, w.organization_id, pinned=BREVO_2026_11)
    await db_session.commit()
    row = (await db_session.execute(PricingRefAttempt.__table__.select())).first()
    assert row.failures == 0 and row.next_attempt_at is not None

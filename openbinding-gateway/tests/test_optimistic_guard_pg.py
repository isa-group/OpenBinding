"""The guarded UPDATE of ``core/revision.guard`` is atomic across two real concurrent sessions (PostgreSQL).

SQLite serialises writers and ignores row locks, so the claim ``UPDATE ... WHERE id = :id AND updated_at = :expected``
can only be shown to be the compare-and-swap it is claimed to be on a real server:

* two writers holding the same ETag: the second *waits* on the row lock (seen in ``pg_stat_activity``) and, once the
  first commits, gets 412 ``precondition_failed`` carrying the new ETag; the row keeps only the first bump;
* ``If-Match: *``: both succeed one after the other, neither gets a 412;
* a writer that rolls back after its claim leaves ``updated_at`` and the ETag as they were (and a waiting writer
  with the old tag then succeeds);
* the ETag of a timestamp read back from PostgreSQL (aware, microseconds) equals the one computed right after the write.

Needs ``TEST_DATABASE_URL`` (the ``pg`` fixture skips without it); synthetic data, no network.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from _pg_support import settle

from openbinding_gateway.core import revision
from openbinding_gateway.db.models import Organization, Project, User


async def a_project(pg) -> tuple[uuid.UUID, str]:
    """A committed project; returns its id and its ETag as a client would first read it."""
    suffix = uuid.uuid4().hex[:8]
    async with pg.session() as session:
        user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
        session.add(user)
        await session.flush()
        organization = Organization(slug=f"o{suffix}", name="Org", billing_sponsor_user_id=user.id, created_by_id=user.id)
        session.add(organization)
        await session.flush()
        project = Project(organization_id=organization.id, slug="p", name="P", created_by_id=user.id)
        session.add(project)
        await session.commit()
        await session.refresh(project)
        return project.id, revision.etag_for(project)


async def stored_tag(pg, project_id: uuid.UUID):
    """The row as the next reader sees it, on a session of its own: ``(updated_at, etag)``."""
    async with pg.session() as session:
        row = await session.get(Project, project_id)
        return row.updated_at, revision.etag_for(row)


def precondition_failed(outcome) -> HTTPException:
    assert isinstance(outcome, HTTPException), outcome
    assert outcome.status_code == 412
    assert outcome.detail["code"] == "precondition_failed"
    return outcome


async def test_the_second_writer_with_the_same_tag_waits_for_the_first_and_then_gets_412(pg):
    project_id, tag = await a_project(pg)
    original, _ = await stored_tag(pg, project_id)

    async with pg.session() as a, pg.session() as b:
        pid_a, pid_b = await pg.backend_pid(a), await pg.backend_pid(b)
        assert pid_a != pid_b
        row_a, row_b = await a.get(Project, project_id), await b.get(Project, project_id)
        assert revision.etag_for(row_a) == revision.etag_for(row_b) == tag

        await revision.guard(a, row_a, tag)  # claimed, uncommitted: a holds the row lock
        winner = row_a.updated_at
        assert winner > original
        won_tag = revision.etag_for(row_a)
        assert won_tag != tag

        waiting = asyncio.create_task(revision.guard(b, row_b, tag))
        await pg.wait_until_blocked(pid_b)  # the claim of b is waiting for the lock of a
        assert not waiting.done()
        await a.commit()
        (outcome,) = await settle(waiting)
        await b.rollback()

    failure = precondition_failed(outcome)
    assert failure.headers["ETag"] == won_tag  # the tag the loser must retry with
    updated, current = await stored_tag(pg, project_id)
    assert updated == winner and current == won_tag  # exactly the first writer's bump, nothing of the second


async def test_if_match_star_lets_both_writers_through_one_after_the_other(pg):
    project_id, tag = await a_project(pg)

    async with pg.session() as a, pg.session() as b:
        pid_b = await pg.backend_pid(b)
        row_a, row_b = await a.get(Project, project_id), await b.get(Project, project_id)

        await revision.guard(a, row_a, "*")
        first = row_a.updated_at
        waiting = asyncio.create_task(revision.guard(b, row_b, "*"))
        await pg.wait_until_blocked(pid_b)  # even without a revision to compare, the claim queues behind a
        assert not waiting.done()
        await a.commit()
        (outcome,) = await settle(waiting)
        assert outcome is None, outcome  # neither a 412 nor any other error
        await b.commit()
        second = row_b.updated_at

    updated, current = await stored_tag(pg, project_id)
    assert updated == second and current == revision.etag_for(row_b) != tag  # b's claim came last and stands
    assert second >= first


async def test_a_writer_that_rolls_back_after_its_claim_leaves_the_revision_untouched(pg):
    project_id, tag = await a_project(pg)
    original, _ = await stored_tag(pg, project_id)

    async with pg.session() as a:
        row = await a.get(Project, project_id)
        await revision.guard(a, row, tag)
        assert row.updated_at > original and revision.etag_for(row) != tag  # inside its transaction it moved
        await a.rollback()

    updated, current = await stored_tag(pg, project_id)
    assert updated == original and current == tag  # the next reader sees the old revision

    # And a writer that waited behind the one that rolled back keeps its right to the old tag.
    async with pg.session() as a, pg.session() as b:
        pid_b = await pg.backend_pid(b)
        row_a, row_b = await a.get(Project, project_id), await b.get(Project, project_id)
        await revision.guard(a, row_a, tag)
        waiting = asyncio.create_task(revision.guard(b, row_b, tag))
        await pg.wait_until_blocked(pid_b)
        await a.rollback()
        (outcome,) = await settle(waiting)
        assert outcome is None, outcome  # the row never changed: no 412
        await b.commit()

    updated, current = await stored_tag(pg, project_id)
    assert updated > original and current != tag


async def test_the_etag_of_a_value_read_back_from_postgresql_equals_the_one_computed_after_the_write(pg):
    project_id, tag = await a_project(pg)

    async with pg.session() as writer:
        row = await writer.get(Project, project_id)
        await revision.guard(writer, row, tag)
        after_write = revision.etag_for(row)
        written = row.updated_at
        await writer.commit()

    updated, read_back = await stored_tag(pg, project_id)
    assert updated.tzinfo is not None and updated.utcoffset() is not None  # PostgreSQL hands it back aware
    assert revision.normalise(updated).tzinfo == timezone.utc
    assert updated == written
    assert read_back == after_write  # the round trip through timestamptz does not change the tag
    # Microsecond precision survives: the bump is a real clock reading, and a tag derived from it is stable again.
    async with pg.session() as reader:
        again = await reader.get(Project, project_id)
        assert revision.etag_for(again) == after_write
        assert again.updated_at.microsecond == written.microsecond


async def test_a_python_timestamp_written_with_microseconds_and_an_offset_keeps_its_etag_when_read_back(pg):
    project_id, _ = await a_project(pg)
    # Never read from the database: an aware value with microseconds in a non-UTC zone, as the code may bind it.
    stamp = datetime(2031, 5, 6, 7, 8, 9, 123457, tzinfo=timezone(timedelta(hours=5, minutes=30)))

    async with pg.session() as writer:
        row = await writer.get(Project, project_id)
        row.updated_at = stamp
        expected = revision.etag_for(row)  # computed from the Python value, before any round trip
        await writer.commit()

    updated, read_back = await stored_tag(pg, project_id)
    assert updated.tzinfo is not None and updated.microsecond == 123457
    assert updated == stamp
    assert read_back == expected

    # The tag a client got from that read is accepted by the guard: no spurious 412 from the round trip.
    async with pg.session() as session:
        row = await session.get(Project, project_id)
        await revision.guard(session, row, read_back)
        assert revision.etag_for(row) != read_back
        await session.commit()

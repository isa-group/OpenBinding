"""The F6 proposal tables on SQLite: shapes, CHECKs, the one-pending partial unique and the triggers (F6 B1).

SQLite enforces neither foreign keys nor row locks; ``test_proposals_pg.py`` checks those, the composite keys and the
races on PostgreSQL.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import update
from sqlalchemy.exc import DBAPIError, IntegrityError

from _environment_rows import adoption, environment
from _proposal_rows import proposal, step, world
from openbinding_gateway.db.models import CompositionAdoption, Proposal, ProposalStep, utcnow

pytestmark = pytest.mark.asyncio


async def test_a_proposal_starts_pending_with_no_stamp(db_session) -> None:
    w = await world(db_session)
    proposal_id = await proposal(db_session, w)
    step_id = await step(db_session, proposal_id)
    await db_session.commit()
    row = await db_session.get(Proposal, proposal_id)
    assert (row.status, row.warnings, row.confirmed_at, row.completed_at, row.progressed_at) == (
        "pending", [], None, None, None)
    assert (await db_session.get(ProposalStep, step_id)).status == "pending"


async def test_the_proposal_checks(db_session) -> None:
    w = await world(db_session)
    for values in (
        {"origin": "monitor"},
        {"status": "done"},
        {"status": "superseded"},  # without the proposal that superseded it
        {"composition_id": None, "upstream_event_id": uuid.uuid4()},  # an event needs its composition
    ):
        with pytest.raises(IntegrityError):
            await proposal(db_session, w, **values)
        await db_session.rollback()


async def test_the_step_checks(db_session) -> None:
    w = await world(db_session)
    proposal_id = await proposal(db_session, w)
    await db_session.commit()
    for values in ({"ordinal": 0}, {"ordinal": 9}, {"status": "running"},
                   {"status": "done"}):  # an ended step has its finishing time
        with pytest.raises(IntegrityError):
            await step(db_session, proposal_id, **values)
        await db_session.rollback()
    await step(db_session, proposal_id)
    with pytest.raises(IntegrityError):  # one step per ordinal
        await step(db_session, proposal_id)
    await db_session.rollback()


async def test_an_author_has_one_pending_proposal_per_scope(db_session) -> None:
    w = await world(db_session)
    first = await proposal(db_session, w)
    await db_session.commit()
    with pytest.raises(IntegrityError):
        await proposal(db_session, w)
    await db_session.rollback()
    # Another scope, or the first no longer pending, is fine.
    await proposal(db_session, w, scope_key="conversation:x")
    second = await proposal(db_session, w, status="cancelled")
    await db_session.commit()
    await db_session.execute(update(Proposal).where(Proposal.id == first).values(
        status="superseded", superseded_by_id=second))
    await proposal(db_session, w)
    await db_session.commit()


async def test_what_a_proposal_proposes_never_changes(db_session) -> None:
    w = await world(db_session)
    proposal_id = await proposal(db_session, w)
    step_id = await step(db_session, proposal_id, preview="a: 1\n")
    await db_session.commit()
    for values in ({"summary": "Something else"}, {"proposed_by_id": uuid.uuid4()}, {"scope_key": "x"},
                   {"warnings": ["new"]}):
        with pytest.raises(DBAPIError, match="a proposal is immutable"):
            await db_session.execute(update(Proposal).where(Proposal.id == proposal_id).values(**values))
        await db_session.rollback()
    for values in ({"params": {"environment": "x"}}, {"base": {}}, {"preview": "b: 2\n"}, {"description": "x"},
                   {"depends_on": [1]}):
        with pytest.raises(DBAPIError, match="a proposal step is immutable"):
            await db_session.execute(update(ProposalStep).where(ProposalStep.id == step_id).values(**values))
        await db_session.rollback()


async def test_a_proposal_moves_forward_only(db_session) -> None:
    w = await world(db_session)
    proposal_id = await proposal(db_session, w)
    await db_session.commit()

    async def move(**values):
        await db_session.execute(update(Proposal).where(Proposal.id == proposal_id).values(**values))

    with pytest.raises(DBAPIError, match="a proposal moves forward only"):
        await move(status="completed")
    await db_session.rollback()
    with pytest.raises(DBAPIError, match="a proposal moves forward only"):  # confirmed_at only with the claim
        await move(confirmed_at=utcnow())
    await db_session.rollback()
    await move(status="executing", confirmed_at=utcnow(), progressed_at=utcnow())
    await move(progressed_at=utcnow())  # an execution stamps its progress
    await db_session.commit()
    with pytest.raises(DBAPIError, match="a proposal moves forward only"):
        await move(status="pending")
    await db_session.rollback()
    await move(status="partial", completed_at=utcnow())
    await db_session.commit()
    for status in ("completed", "executing", "cancelled"):
        with pytest.raises(DBAPIError, match="a proposal moves forward only"):
            await move(status=status)
        await db_session.rollback()


async def test_a_step_ends_once(db_session) -> None:
    w = await world(db_session)
    proposal_id = await proposal(db_session, w)
    step_id = await step(db_session, proposal_id)
    await db_session.commit()

    async def move(**values):
        await db_session.execute(update(ProposalStep).where(ProposalStep.id == step_id).values(**values))

    with pytest.raises(DBAPIError, match="a proposal step ends once"):
        await move(result={"version": "x"})
    await db_session.rollback()
    await move(status="done", result={"ordinal": 1}, finished_at=utcnow())
    await db_session.commit()
    for values in ({"status": "failed"}, {"result": {"ordinal": 2}}, {"error": {"code": "x"}}):
        with pytest.raises(DBAPIError, match="a proposal step ends once"):
            await move(**values)
        await db_session.rollback()


async def test_an_adoption_says_how_it_was_made(db_session) -> None:
    w = await world(db_session)
    environment_id = await environment(db_session, w)
    proposal_id = await proposal(db_session, w)
    await db_session.commit()
    for ordinal, values in enumerate((
        {"source": "chat"},
        {"source": "proposal"},  # without its proposal
        {"source": "direct", "proposal_id": proposal_id},
    ), start=1):
        with pytest.raises(IntegrityError):
            await adoption(db_session, w, environment_id, ordinal, **values)
        await db_session.rollback()
    made = await adoption(db_session, w, environment_id, 1, source="proposal", proposal_id=proposal_id)
    await db_session.commit()
    row = await db_session.get(CompositionAdoption, made)
    assert (row.source, row.proposal_id) == ("proposal", proposal_id)

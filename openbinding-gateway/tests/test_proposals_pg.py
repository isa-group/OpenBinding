"""The F6 proposal tables on PostgreSQL: what the database itself enforces (F6 B1).

The partial unique index keeps one pending proposal per author and scope under two concurrent inserts; the triggers keep
what a proposal proposes and move its status forward only, ending each step once; the composite keys keep a proposal's
event within its composition, and a CHECK covers the NULL composition a composite key skips; an adoption names its
proposal exactly when a proposal made it.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import update
from sqlalchemy.exc import DBAPIError, IntegrityError

from _environment_rows import adoption, environment
from _proposal_rows import proposal, step, world
from _upstream_rows import event, watch
from openbinding_gateway.db.models import Proposal, ProposalStep, utcnow

pytestmark = pytest.mark.asyncio


async def test_two_concurrent_pending_proposals_of_one_author_and_scope_make_one(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        await session.commit()

    async def insert() -> str:
        async with pg.session() as session:
            try:
                await proposal(session, w)
                await asyncio.sleep(0.05)
                await session.commit()
                return "inserted"
            except IntegrityError as error:
                assert "uq_proposals_one_pending" in str(error)
                await session.rollback()
                return "refused"

    assert sorted(await asyncio.gather(insert(), insert())) == ["inserted", "refused"]


async def test_a_proposal_keeps_what_it_proposes_and_moves_forward_only(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        proposal_id = await proposal(session, w, warnings=["Review this"])
        step_id = await step(session, proposal_id, preview="a: 1\n", base={"contentDigest": "sha256-x"})
        await session.commit()
        for values in ({"summary": "x"}, {"warnings": []}, {"upstream_event_id": None, "scope_key": "x"}):
            with pytest.raises(DBAPIError, match="a proposal is immutable"):
                await session.execute(update(Proposal).where(Proposal.id == proposal_id).values(**values))
            await session.rollback()
        for values in ({"params": {}}, {"base": {"contentDigest": "sha256-y"}}, {"preview": "b: 2\n"}):
            with pytest.raises(DBAPIError, match="a proposal step is immutable"):
                await session.execute(update(ProposalStep).where(ProposalStep.id == step_id).values(**values))
            await session.rollback()
        with pytest.raises(DBAPIError, match="a proposal moves forward only"):
            await session.execute(update(Proposal).where(Proposal.id == proposal_id).values(status="completed"))
        await session.rollback()
        await session.execute(update(Proposal).where(Proposal.id == proposal_id).values(
            status="executing", confirmed_at=utcnow(), progressed_at=utcnow()))
        await session.execute(update(ProposalStep).where(ProposalStep.id == step_id).values(
            status="done", result={"ordinal": 1}, finished_at=utcnow()))
        await session.execute(update(Proposal).where(Proposal.id == proposal_id).values(
            status="completed", completed_at=utcnow(), progressed_at=utcnow()))
        await session.commit()
        with pytest.raises(DBAPIError, match="a proposal step ends once"):
            await session.execute(update(ProposalStep).where(ProposalStep.id == step_id).values(
                result={"ordinal": 2}))
        await session.rollback()
        with pytest.raises(DBAPIError, match="a proposal moves forward only"):
            await session.execute(update(Proposal).where(Proposal.id == proposal_id).values(status="failed"))
        await session.rollback()


async def test_a_proposal_names_only_an_event_of_its_own_composition(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        watch_id = await watch(session)
        own = await event(session, w, watch_id)
        await session.commit()
        await proposal(session, w, upstream_event_id=own)
        await session.commit()
        with pytest.raises(IntegrityError, match="fk_proposals_upstream_event"):
            await proposal(session, w, composition_id=w.other_composition_id, upstream_event_id=own)
        await session.rollback()
        with pytest.raises(IntegrityError, match="event_composition"):
            await proposal(session, w, composition_id=None, scope_key="conversation:x", upstream_event_id=own)
        await session.rollback()
        # An organization's proposal with no composition (F7) is fine without an event.
        await proposal(session, w, composition_id=None, scope_key="conversation:x")
        await session.commit()


async def test_an_adoption_names_its_proposal_exactly_when_one_made_it(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        environment_id = await environment(session, w)
        proposal_id = await proposal(session, w)
        await session.commit()
        for values, constraint in (
            ({"source": "proposal"}, "proposal_named"),
            ({"source": "direct", "proposal_id": proposal_id}, "proposal_named"),
            ({"source": "proposal", "proposal_id": uuid.uuid4()}, "fk_composition_adoptions_proposal_id_proposals"),
        ):
            with pytest.raises(IntegrityError, match=constraint):
                await adoption(session, w, environment_id, 1, **values)
            await session.rollback()
        await adoption(session, w, environment_id, 1, source="proposal", proposal_id=proposal_id)
        await session.commit()


async def test_two_concurrent_proposals_of_one_author_leave_one_pending(pg) -> None:
    """P2 under a race: each create supersedes the pending one; the loser of the unique index retries the supersession
    once, so both answer and exactly one stays pending, superseding the other."""
    from sqlalchemy import select

    from openbinding_gateway.db.models import Composition, Organization, OrganizationRole, User
    from openbinding_gateway.modules.compositions.application import proposals

    async with pg.session() as session:
        w = await world(session)
        await environment(session, w)
        await session.commit()

    async def make(note: str):
        async with pg.session() as session:
            organization = await session.get(Organization, w.organization_id)
            composition = await session.get(Composition, w.composition_id)
            user = await session.get(User, w.user_id)
            return (await proposals.create(
                session, organization, user,
                [proposals.StepRequest("adopt", {"environment": "production", "version": "1.1.0", "note": note})],
                role=OrganizationRole.OWNER, composition=composition,
            )).id

    made = await asyncio.gather(make("a"), make("b"))
    async with pg.session() as session:
        rows = {row.id: row for row in (await session.scalars(
            select(Proposal).where(Proposal.composition_id == w.composition_id))).all()}
    assert set(rows) == set(made)
    pending = [row for row in rows.values() if row.status == "pending"]
    superseded = [row for row in rows.values() if row.status == "superseded"]
    assert len(pending) == len(superseded) == 1 and superseded[0].superseded_by_id == pending[0].id


# -- The executor's races (B4) ---------------------------------------------------------------------------------------


async def _rows(session, w):
    from openbinding_gateway.db.models import Composition, Organization, User

    return (await session.get(Organization, w.organization_id), await session.get(Composition, w.composition_id),
            await session.get(User, w.user_id))


async def _adopt_proposal(pg, w, version: str = "1.1.0") -> uuid.UUID:
    from openbinding_gateway.db.models import OrganizationRole
    from openbinding_gateway.modules.compositions.application import proposals

    async with pg.session() as session:
        organization, composition, user = await _rows(session, w)
        return (await proposals.create(
            session, organization, user, [proposals.StepRequest("adopt", {"environment": "production",
                                                                          "version": version})],
            role=OrganizationRole.OWNER, composition=composition,
        )).id


async def _outcome(work) -> str:
    from fastapi import HTTPException

    try:
        result = await work
    except HTTPException as error:
        return str(error.detail.get("code") if isinstance(error.detail, dict) else error.status_code)
    return getattr(result, "status", "ok") if result is not None else "ok"


async def _confirm(pg, w, proposal_id) -> str:
    from openbinding_gateway.db.models import OrganizationRole
    from openbinding_gateway.modules.compositions.application import proposal_executor

    async with pg.session() as session:
        organization, _, user = await _rows(session, w)
        return await _outcome(proposal_executor.confirm(session, organization, proposal_id, user,
                                                        role=OrganizationRole.OWNER))


async def _operated(pg):
    async with pg.session() as session:
        w = await world(session)
        environment_id = await environment(session, w, adopt_role="MEMBER")
        await session.commit()
    return w, environment_id


async def _adoptions(pg, environment_id) -> tuple[int, int]:
    from sqlalchemy import func, select

    from openbinding_gateway.db.models import CompositionAdoption, CompositionEnvironment

    async with pg.session() as session:
        count = int(await session.scalar(select(func.count()).select_from(CompositionAdoption).where(
            CompositionAdoption.environment_id == environment_id)) or 0)
        ordinal = (await session.get(CompositionEnvironment, environment_id)).adoption_ordinal
    return count, ordinal


async def test_two_concurrent_confirmations_run_the_proposal_once(pg) -> None:
    """P8: one 200, one 409 ``proposal_not_pending``, exactly one adoption."""
    w, environment_id = await _operated(pg)
    proposal_id = await _adopt_proposal(pg, w)
    outcomes = sorted(await asyncio.gather(_confirm(pg, w, proposal_id), _confirm(pg, w, proposal_id)))
    assert outcomes == ["completed", "proposal_not_pending"]
    assert await _adoptions(pg, environment_id) == (1, 1)


async def test_a_confirmation_racing_a_direct_adoption_changes_the_environment_once(pg) -> None:
    from openbinding_gateway.core import revision as etags
    from openbinding_gateway.db.models import CompositionEnvironment, OrganizationRole
    from openbinding_gateway.modules.compositions.application import adoption

    w, environment_id = await _operated(pg)
    proposal_id = await _adopt_proposal(pg, w)

    async def direct() -> str:
        async with pg.session() as session:
            organization, composition, user = await _rows(session, w)
            row = await session.get(CompositionEnvironment, environment_id)
            return await _outcome(adoption.adopt(
                session, organization=organization, composition=composition, environment=row,
                role=OrganizationRole.OWNER, version_ref="1.0.0", actor=user, if_match=etags.etag_for(row),
                source="direct", proposal_id=None,
            ))

    outcomes = await asyncio.gather(_confirm(pg, w, proposal_id), direct())
    assert await _adoptions(pg, environment_id) == (1, 1), outcomes
    assert outcomes in (["completed", "precondition_failed"], ["proposal_stale", "ok"], ["failed", "ok"]), outcomes


async def test_a_confirmation_racing_a_cancellation_lets_one_win(pg) -> None:
    from openbinding_gateway.db.models import Proposal, User
    from openbinding_gateway.modules.compositions.application import proposals

    w, environment_id = await _operated(pg)
    proposal_id = await _adopt_proposal(pg, w)

    async def cancel() -> str:
        async with pg.session() as session:
            row = await session.get(Proposal, proposal_id)
            return await _outcome(proposals.cancel(session, row, await session.get(User, w.user_id)))

    outcomes = await asyncio.gather(_confirm(pg, w, proposal_id), cancel())
    assert outcomes in (["completed", "proposal_not_pending"], ["proposal_not_pending", "cancelled"]), outcomes
    assert await _adoptions(pg, environment_id) == ((1, 1) if outcomes[0] == "completed" else (0, 0))


async def test_a_supersession_racing_the_confirmation_of_the_superseded_never_runs_both(pg) -> None:
    from openbinding_gateway.db.models import Proposal

    w, environment_id = await _operated(pg)
    first = await _adopt_proposal(pg, w)
    confirmed, second = await asyncio.gather(_confirm(pg, w, first), _adopt_proposal(pg, w, "1.0.0"))
    async with pg.session() as session:
        statuses = ((await session.get(Proposal, first)).status, (await session.get(Proposal, second)).status)
    assert statuses in (("completed", "pending"), ("superseded", "pending")), (confirmed, statuses)
    assert await _adoptions(pg, environment_id) == ((1, 1) if statuses[0] == "completed" else (0, 0))


async def test_a_confirmation_racing_a_composition_delete(pg) -> None:
    """The composition has an environment, so its delete is refused either way; the confirmation runs."""
    from openbinding_gateway.modules.compositions.application import delete_composition

    w, environment_id = await _operated(pg)
    proposal_id = await _adopt_proposal(pg, w)

    async def remove() -> str:
        async with pg.session() as session:
            _, composition, user = await _rows(session, w)
            return await _outcome(delete_composition(session, composition, user))

    outcomes = await asyncio.gather(_confirm(pg, w, proposal_id), remove())
    assert outcomes == ["completed", "composition_in_operation"]
    assert await _adoptions(pg, environment_id) == (1, 1)

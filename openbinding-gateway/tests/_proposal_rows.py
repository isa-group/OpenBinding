"""Rows for the F6 proposal tests, written without HTTP (SQLite and PostgreSQL alike).

Not a test module. ``proposal`` writes a ``proposals`` row of a world's composition (pending, by the world's user, on
the web, scoped to the composition) and ``step`` a ``proposal_steps`` row of it, each with the smallest valid values;
``world`` is ``_environment_rows.world``.
"""

from __future__ import annotations

import uuid

from _environment_rows import World, world  # noqa: F401 - re-exported for the tests
from openbinding_gateway.db.models import Proposal, ProposalStep


_UNSET = object()


async def proposal(session, w: World, *, user_id: uuid.UUID | None = None, composition_id=_UNSET,
                   scope_key: str | None = None, **values) -> uuid.UUID:
    """``composition_id=None`` writes an organization's proposal with no composition (F7's case)."""
    composition_id = w.composition_id if composition_id is _UNSET else composition_id
    fields = {
        "organization_id": w.organization_id, "composition_id": composition_id, "origin": "web",
        "scope_key": scope_key or f"composition:{composition_id}", "proposed_by_id": user_id or w.user_id,
        "summary": "Adopt 1.0.0 in production",
    } | values
    row = Proposal(**fields)
    session.add(row)
    await session.flush()
    return row.id


async def step(session, proposal_id: uuid.UUID, *, ordinal: int = 1, kind: str = "adopt", **values) -> uuid.UUID:
    fields = {
        "proposal_id": proposal_id, "ordinal": ordinal, "kind": kind, "description": f"Step {ordinal}",
        "params": {"environment": str(uuid.uuid4()), "version": "1.0.0"}, "base": {"environmentEtag": '"x"'},
        "destructive": False,
    } | values
    row = ProposalStep(**fields)
    session.add(row)
    await session.flush()
    return row.id

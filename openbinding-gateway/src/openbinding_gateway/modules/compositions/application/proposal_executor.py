"""Confirming a proposal and applying it step by step (F6, plan §8): SPHERE's ORBIT executor, ported.

Adapted from SPHERE (MIT, SCORELabUS/SPHERE at ``73779a8a``): ``api/src/main/services/orbit/OrbitExecutorService.ts``
(``execute``: claim, sequential steps, a dependency's failure skipping what needs it, ``COMPLETED | PARTIAL | FAILED``)
and ``api/src/main/repositories/mongoose/OrbitPlanRepository.ts`` (``claimForExecution``, ``closeInterrupted``). The
differences: a pre-flight checks every step's stored base and the confirming caller's permissions before the claim, a
step's refusal is stored as the writer's answer (status, code, message), each outcome is written in a transaction of
its own with a progress stamp, and an interrupted run is closed by lack of progress with ``adopt`` steps reconciled
from their adoptions.

:func:`confirm`, by the proposal's author only:

1. **Read phase.** A missing proposal is the 404 parity; another member's is 403 ``proposal_not_yours``; one that is not
   ``pending`` is 409 ``proposal_not_pending``. A destructive step's phrase is checked (422 ``confirmation_required`` /
   ``confirmation_mismatch``), then **permissions** with the confirming caller (P6): each step's role, and for a
   personal API key each step's own key permission (``compositions:adopt`` for ``adopt``; the route table is keyed by
   path), 403 with the proposal left ``pending``. Then the **pre-flight** (P5): every step's stored base, a seal step
   derived again (kept for its apply). A base that no longer holds makes the proposal ``stale`` (terminal) and answers
   409 ``proposal_stale`` with ``stale: [{step, kind, reason, base, current}]``; nothing else is written.
2. **Claim**: ``pending`` -> ``executing`` with ``confirmed_at`` and ``progressed_at``, conditional on the author and on
   ``pending`` (two confirmations: one runs, the other is 409); committed.
3. **Steps**, in order. Before each apply the proposal's status is read again, and the run stops when it is no longer
   ``executing`` (closed meanwhile). A step whose dependency did not end ``done`` is ``skipped``
   (``skipped_dependency``); an independent one still runs. Each apply commits by itself (a seal, an adoption); a
   refusal becomes the step's ``error`` verbatim, anything else ``internal_error`` with the correlation id. The outcome
   is written at once (the proposal's progress stamp, then the step, both conditional), and ``on_step`` is called.
   Nothing is retried and nothing committed is rolled back.
4. **Finish**: ``completed`` (all done), ``failed`` (none) or ``partial``, audited; the answer is the proposal as
   recorded.

:func:`close_interrupted` (the upstream watcher's housekeeping) closes executions with no progress for
``PROPOSAL_EXECUTION_DEADLINE_S``: an ``adopt`` step whose adoption exists is recorded ``done``; the step that was
running is ``failed`` ("check whether it was applied"), later ones ``skipped``; ``completed`` when every step is done,
``partial`` when some are, else ``failed``. Every write is conditional, so whichever of the executor and the closure writes first wins.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.exc import InvalidRequestError
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.public_errors import current_correlation_id as correlation_id
from ....db.models import (
    Composition,
    CompositionAdoption,
    Organization,
    OrganizationRole,
    Proposal,
    ProposalStep,
    User,
)
from ....jobs import clock
from ....models.errors import api_error
from ....security.apikeys import authenticated_api_key, permissions_of
from ...shared.application import audit
from ..domain import proposals as domain
from . import proposals
from .proposals import TARGET, Context

logger = logging.getLogger(__name__)

INTERRUPTED_RUNNING = "The run was interrupted during this step. Check whether it was applied before trying again."
INTERRUPTED_LATER = "Not applied: the run was interrupted before this step."

StepHook = Callable[[dict[str, Any]], Awaitable[None] | None]


@dataclass(frozen=True)
class StepRow:
    """A step as the executor reads it once: plain values, safe across the commits and rollbacks of a run."""

    id: uuid.UUID
    ordinal: int
    kind: str
    params: dict[str, Any]
    base: dict[str, Any]
    depends_on: tuple[int, ...]
    destructive: bool

    @classmethod
    def of(cls, row: ProposalStep) -> "StepRow":
        return cls(row.id, row.ordinal, row.kind, dict(row.params), dict(row.base), tuple(row.depends_on or ()),
                   row.destructive)


def _phrase(proposal: Proposal, confirmation: str | None) -> None:
    if not proposal.confirmation_phrase:
        return
    if not domain.normalise_phrase(confirmation):
        raise api_error(422, "confirmation_required",
                        f"Type “{proposal.confirmation_phrase}” to confirm this proposal.",
                        phrase=proposal.confirmation_phrase)
    if domain.normalise_phrase(confirmation) != domain.normalise_phrase(proposal.confirmation_phrase):
        raise api_error(422, "confirmation_mismatch", "The phrase typed is not this proposal's.",
                        phrase=proposal.confirmation_phrase)


def _key_check(api_key: Any, steps: list[StepRow]) -> None:
    """P6: a personal API key needs each step's own permission, as the route dependency would ask."""
    if api_key is None:
        return
    required = sorted({domain.REGISTRY[step.kind].key_permission for step in steps})
    missing = sorted(set(required) - permissions_of(api_key))
    if missing:
        raise api_error(
            status.HTTP_403_FORBIDDEN, "insufficient_api_key_permission",
            "This API key does not grant every permission the proposal's steps require.",
            required_permissions=required, missing_permissions=missing,
        )


def _error_of(error: HTTPException) -> dict[str, Any]:
    detail = error.detail if isinstance(error.detail, dict) else {"error": str(error.detail)}
    extra = {key: value for key, value in detail.items() if key not in ("code", "error")}
    out: dict[str, Any] = {"status": error.status_code, "code": str(detail.get("code") or "refused"),
                           "message": str(detail.get("error") or "")}
    if extra:
        out["detail"] = extra
    return out


async def _refresh(session: AsyncSession, row: Any) -> bool:
    """Read ``row`` again; ``False`` when it is gone (its composition or organization was deleted meanwhile)."""
    try:
        await session.refresh(row)
    except InvalidRequestError:
        return False
    return True


async def _reload(context: Context) -> None:
    """After a rollback (a refused apply), the context's rows are read again, the API key that authenticated the
    request included (a later step may read its grants); a pre-flight's derivations are dropped, since they hold rows of
    the rolled-back transaction (a seal step then derives again, held to its digest). A row deleted meanwhile stays
    expired: the next status read finds the proposal gone and the run stops."""
    session = context.session
    rows = [context.organization, context.composition, context.caller, context.proposal]
    key = authenticated_api_key(context.caller) if context.caller is not None else None
    for candidate in (context.api_key, key):
        if candidate is not None and candidate in session.sync_session:
            rows.append(candidate)
    for row in rows:
        if row is not None:
            await _refresh(session, row)
    context.derived.clear()


async def _write_outcome(session: AsyncSession, proposal_id: uuid.UUID, step: StepRow, outcome: dict[str, Any]) -> bool:
    """The step's outcome and the proposal's progress stamp, in a transaction of their own: the proposal first (the
    order every path takes), both conditional. ``False`` when the run was closed meanwhile (nothing written)."""
    now = clock.now(session)
    stamped = await session.execute(
        update(Proposal).where(Proposal.id == proposal_id, Proposal.status == "executing")
        .values(progressed_at=now).execution_options(synchronize_session=False)
    )
    if stamped.rowcount != 1:
        await session.rollback()
        return False
    ended = await session.execute(
        update(ProposalStep).where(ProposalStep.id == step.id, ProposalStep.status == "pending")
        .values(status=outcome["status"], result=outcome.get("result"), error=outcome.get("error"), finished_at=now)
        .execution_options(synchronize_session=False)
    )
    if ended.rowcount != 1:
        await session.rollback()
        return False
    await session.commit()
    return True


async def _call(hook: StepHook | None, event: dict[str, Any]) -> None:
    if hook is None:
        return
    result = hook(event)
    if result is not None:
        await result


async def confirm(
    session: AsyncSession,
    organization: Organization,
    proposal_id: str | uuid.UUID,
    caller: User,
    *,
    role: OrganizationRole,
    confirmation: str | None = None,
    api_key: Any = None,
    on_step: StepHook | None = None,
) -> Proposal:
    """Confirm the proposal ``proposal_id`` of ``organization`` as ``caller`` (its author, holding ``role`` there) and
    apply it step by step (see the module docstring). Returns the proposal as recorded."""
    row = await proposals.by_id(session, organization, proposal_id)
    if row is None:
        raise proposals.unreadable()
    if row.proposed_by_id != caller.id:
        raise proposals.not_yours()
    if row.status != "pending":
        raise proposals.not_pending(row)
    # Plain values: a refused step rolls the session back, which expires every row it holds.
    proposal_id, organization_id = row.id, row.organization_id
    composition = None if row.composition_id is None else await session.get(Composition, row.composition_id)
    steps = [StepRow.of(step) for step in await proposals.steps_of(session, row)]
    unknown = [step.kind for step in steps if step.kind not in domain.REGISTRY]
    if unknown:
        raise RuntimeError(f"proposal {row.id} has steps of unregistered kinds {unknown}")
    _phrase(row, confirmation)
    context = Context(session, organization, composition, caller, role, proposal=row, api_key=api_key)
    for step in steps:
        await domain.REGISTRY[step.kind].check_permission(context, step)
    _key_check(api_key, steps)

    # P5: the pre-flight; nothing has been written yet.
    stale: list[dict[str, Any]] = []
    for step in steps:
        for found in await domain.REGISTRY[step.kind].check_base(context, step):
            stale.append({"step": step.ordinal, "kind": step.kind, **found})
    if stale:
        await session.commit()
        marked = await session.execute(
            update(Proposal).where(Proposal.id == proposal_id, Proposal.status == "pending")
            .values(status="stale").execution_options(synchronize_session=False)
        )
        if marked.rowcount == 1:
            audit(session, caller, "composition.proposal_stale", TARGET, proposal_id, organization_id,
                  reasons=sorted({item["reason"] for item in stale}))
            await session.commit()
            raise api_error(
                status.HTTP_409_CONFLICT, "proposal_stale",
                "This proposal is out of date: what it was built on changed since it was made. Nothing was changed.",
                stale=stale,
            )
        await session.rollback()
        await session.refresh(row)
        raise proposals.not_pending(row)

    # The claim (ORBIT's claimForExecution): one confirmation runs it.
    await session.commit()
    now = clock.now(session)
    claimed = await session.execute(
        update(Proposal).where(Proposal.id == proposal_id, Proposal.proposed_by_id == caller.id, Proposal.status == "pending")
        .values(status="executing", confirmed_at=now, progressed_at=now).execution_options(synchronize_session=False)
    )
    if claimed.rowcount != 1:
        await session.rollback()
        await session.refresh(row)
        raise proposals.not_pending(row)
    audit(session, caller, "composition.proposal_confirmed", TARGET, proposal_id, organization_id,
          phrase=bool(row.confirmation_phrase))
    await session.commit()
    await _call(on_step, {"type": "started", "proposal": str(proposal_id), "total": len(steps)})

    outputs: dict[int, dict[str, Any]] = {}
    ended: dict[int, str] = {}
    for step in steps:
        current = await session.scalar(select(Proposal.status).where(Proposal.id == proposal_id)
                                       .execution_options(populate_existing=True))
        await session.commit()
        if current != "executing":
            logger.warning("proposal_run_stopped proposal=%s status=%s before_step=%s", proposal_id, current, step.ordinal)
            break
        kind = domain.REGISTRY[step.kind]
        missing = [n for n in step.depends_on if ended.get(n) != "done"]
        if missing:
            outcome: dict[str, Any] = {"status": "skipped", "error": {
                "status": 0, "code": "skipped_dependency",
                "message": f"Not applied: step {missing[0]}, which this one needs, did not complete.",
            }}
        else:
            try:
                await kind.check_deferred(context, step, outputs)
                result = await kind.apply(context, step, outputs)
                outcome = {"status": "done", "result": result}
            except HTTPException as error:
                await session.rollback()
                await _reload(context)
                outcome = {"status": "failed", "error": _error_of(error)}
            except Exception:  # noqa: BLE001 - one step's failure is reported, never raised past the run
                logger.exception("proposal_step_failed proposal=%s step=%s", proposal_id, step.ordinal)
                await session.rollback()
                await _reload(context)
                outcome = {"status": "failed", "error": {
                    "status": 500, "code": "internal_error",
                    "message": "The step failed unexpectedly; nothing more of it was applied.",
                    "detail": {"correlationId": correlation_id()},
                }}
        if not await _write_outcome(session, proposal_id, step, outcome):
            logger.warning("proposal_outcome_unwritten proposal=%s step=%s outcome=%s correlation=%s", proposal_id,
                           step.ordinal, outcome["status"], correlation_id())
            await _reload(context)
            break
        ended[step.ordinal] = outcome["status"]
        if outcome["status"] == "done":
            outputs[step.ordinal] = outcome["result"]
        await _call(on_step, {"type": "step", "ordinal": step.ordinal, **outcome})

    return await _finish(session, row, caller)


async def _finish(session: AsyncSession, row: Proposal, caller: User) -> Proposal:
    if not await _refresh(session, row):
        # Deleted with its composition or organization while it ran: what was applied stands, the proposal is gone.
        await session.rollback()
        raise proposals.unreadable()
    statuses = list((await session.scalars(select(ProposalStep.status).where(ProposalStep.proposal_id == row.id)
                                           .execution_options(populate_existing=True))).all())
    done = statuses.count("done")
    final = "completed" if done == len(statuses) else "failed" if done == 0 else "partial"
    now = clock.now(session)
    finished = await session.execute(
        update(Proposal).where(Proposal.id == row.id, Proposal.status == "executing")
        .values(status=final, completed_at=now, progressed_at=now).execution_options(synchronize_session=False)
    )
    if finished.rowcount == 1:
        audit(session, caller, "composition.proposal_finished", TARGET, row.id, row.organization_id, status=final,
              done=done, failed=statuses.count("failed"), skipped=statuses.count("skipped"))
    await session.commit()
    await session.refresh(row)
    return row


# -- Interrupted runs ------------------------------------------------------------------------------------------------


async def close_interrupted(factory: Callable[[], AsyncSession], *, deadline_s: int) -> int:
    """Close every ``executing`` proposal with no progress for ``deadline_s`` (database clock); how many were closed.
    Called by the upstream watcher's housekeeping (it starts no execution, it only ends one a person started)."""
    async with factory() as session:
        candidates = list((await session.scalars(
            select(Proposal.id).where(Proposal.status == "executing",
                                      Proposal.progressed_at < clock.before(session, deadline_s))
            .order_by(Proposal.progressed_at)
        )).all())
        await session.commit()
    closed = 0
    for proposal_id in candidates:
        async with factory() as session:
            closed += await _close_one(session, proposal_id, deadline_s)
    return closed


async def _close_one(session: AsyncSession, proposal_id: uuid.UUID, deadline_s: int) -> int:
    # The proposal first, then its steps: the order the executor writes an outcome in.
    row = await session.scalar(
        select(Proposal).where(Proposal.id == proposal_id, Proposal.status == "executing",
                               Proposal.progressed_at < clock.before(session, deadline_s))
        .with_for_update().execution_options(populate_existing=True)
    )
    if row is None:
        await session.commit()
        return 0
    steps = list((await session.scalars(
        select(ProposalStep).where(ProposalStep.proposal_id == proposal_id).order_by(ProposalStep.ordinal)
        .with_for_update().execution_options(populate_existing=True)
    )).all())
    adoptions = {adopted.environment_id: adopted for adopted in (await session.scalars(
        select(CompositionAdoption).where(CompositionAdoption.proposal_id == proposal_id)
    )).all()}
    now = clock.now(session)
    first_pending = True
    for step in steps:
        if step.status != "pending":
            continue
        values: dict[str, Any]
        reconciled = None
        if step.kind == "adopt":
            try:
                reconciled = adoptions.get(uuid.UUID(str(step.params.get("environment"))))
            except ValueError:
                reconciled = None
        if reconciled is not None:
            values = {"status": "done", "result": {
                "ordinal": reconciled.ordinal, "feedEtag": f'"{reconciled.content_digest}"', "reconciled": True,
            }}
        elif first_pending:
            first_pending = False
            values = {"status": "failed", "error": {"status": 0, "code": "interrupted", "message": INTERRUPTED_RUNNING}}
        else:
            values = {"status": "skipped", "error": {"status": 0, "code": "interrupted", "message": INTERRUPTED_LATER}}
        await session.execute(
            update(ProposalStep).where(ProposalStep.id == step.id, ProposalStep.status == "pending")
            .values(finished_at=now, **values).execution_options(synchronize_session=False)
        )
    statuses = list((await session.scalars(select(ProposalStep.status).where(ProposalStep.proposal_id == proposal_id)
                                           .execution_options(populate_existing=True))).all())
    done = statuses.count("done")
    # As the executor ends a run: every step done (the last outcome written, or an adoption reconciled) is completed.
    final = "completed" if done == len(statuses) else "partial" if done else "failed"
    await session.execute(
        update(Proposal).where(Proposal.id == proposal_id, Proposal.status == "executing")
        .values(status=final, completed_at=now, progressed_at=now).execution_options(synchronize_session=False)
    )
    author = await session.get(User, row.proposed_by_id)
    if author is not None:
        audit(session, author, "composition.proposal_finished", TARGET, proposal_id, row.organization_id,
              status=final, done=done, failed=statuses.count("failed"), skipped=statuses.count("skipped"),
              interrupted=True)
    await session.commit()
    logger.warning("proposal_interrupted_closed proposal=%s status=%s done=%s", proposal_id, final, done)
    return 1


async def executing_count(session: AsyncSession) -> int:
    from sqlalchemy import func

    return int(await session.scalar(select(func.count()).select_from(Proposal)
                                    .where(Proposal.status == "executing")) or 0)


__all__ = ["INTERRUPTED_LATER", "INTERRUPTED_RUNNING", "StepRow", "close_interrupted", "confirm", "executing_count"]

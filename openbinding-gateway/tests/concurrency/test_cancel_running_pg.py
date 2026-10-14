"""Cancelling a RUNNING job while its worker finishes it, and while the reconciler retries the cancellation, on PostgreSQL.

Needs ``TEST_DATABASE_URL`` (the ``two_sessions`` fixture skips anywhere else, and only there): the claim of a
cancellation is ``SELECT ... FOR UPDATE SKIP LOCKED`` plus a compare-and-swap, and the cancel route and the worker
meet on the job's row lock; SQLite has neither. Two sessions stand for two processes:

* a cancel and the finish of the job at once end the job in exactly one way (COMPLETED with its result and the
  cancel refused as terminal, or CANCELLED with no result), whichever order the locks are won, and a cancel that
  comes in while BIM evaluates the answer still wins;
* the ``DELETE`` of the attempt that runs a cancelled job leaves once, whether the worker's watch and the
  reconciler's sweep, or two sweeps, claim it at the same moment.

The worker's side is the real ``settle_engine_answer`` / ``CancelWatch`` and the sweep's the real
``reconciler.cancel_lost_attempts``; only BIM and the engine's HTTP side are doubles.
"""

from __future__ import annotations

import asyncio
import time
import uuid

import pytest
from sqlalchemy import select

from _pricing import pricing_catalog
from analysis_b3_b4_b6._helpers import PER_ATTEMPT_CANCELLATION, a_job, a_registration, answer
from openbinding_gateway.db.models import Job, JobEngineAttempt, JobEngineEvidence, JobState, User, UserRole
from openbinding_gateway.jobs import leases, lifecycle, reconciler
from openbinding_gateway.services import execution
from openbinding_gateway.v1 import remote

TIMEOUT_S = 30
TOKEN = "worker-token"


async def _owner(session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    session.add(user)
    await session.commit()
    return user


async def _running_job(session, owner, **extra) -> Job:
    job = await a_job(session, owner, state=JobState.RUNNING, attempt=1, lease_token=TOKEN, **extra)
    session.info[leases.lease_key(job.id)] = TOKEN
    return job


async def _cancel_route(session, job_id: uuid.UUID) -> int:
    """What ``POST /v1/jobs/{id}/cancel`` does to the row: lock it, refuse a terminal job, else request the stop."""
    job = (
        await session.execute(
            select(Job).where(Job.id == job_id).with_for_update().execution_options(populate_existing=True)
        )
    ).scalar_one()
    if job.state in lifecycle.TERMINAL_STATES:
        await session.rollback()
        return 409
    await lifecycle.request_cancellation(session, job)
    await session.commit()
    return 200


@pytest.fixture
def bim(monkeypatch) -> asyncio.Event:
    """BIM's evaluation, instant unless a test holds it: ``evaluating`` is set while it runs."""
    evaluating = asyncio.Event()
    release = asyncio.Event()
    release.set()
    evaluating.release = release  # type: ignore[attr-defined]

    async def evaluate(_document, remote_result, _optimization, _guarantees, provenance):
        evaluating.set()
        await release.wait()
        return provenance, {"termination": remote_result["termination"], "solutions": [], "provenance": provenance}

    monkeypatch.setattr(execution, "evaluate_engine_result", evaluate)
    return evaluating


async def _finish(session, job_id: uuid.UUID) -> None:
    """The worker's end of a solve: the answer is settled and the outcome committed (as ``finish_persisted_job`` does)."""
    job = await session.get(Job, job_id, populate_existing=True)
    await execution.settle_engine_answer(
        session, job, time.monotonic(), attempt=1, remote_result=answer(), document={}, optimization={},
        termination_guarantees=["FEASIBLE"], provenance={}, transport=None,
    )
    await session.commit()


async def _row(session, job_id: uuid.UUID) -> Job:
    return await session.get(Job, job_id, populate_existing=True)


async def _evidence(session, job_id: uuid.UUID) -> int:
    return len((await session.execute(select(JobEngineEvidence.id).where(JobEngineEvidence.job_id == job_id))).all())


# -- Cancel and finish ------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_cancel_that_comes_in_while_bim_evaluates_the_answer_wins(two_sessions, bim):
    first, second = two_sessions
    job = await _running_job(first, await _owner(first))
    job_id = job.id
    bim.release.clear()  # BIM is slow: the answer is kept, the lock is free, the evaluation is under way

    finishing = asyncio.create_task(_finish(first, job_id))
    await asyncio.wait_for(bim.wait(), TIMEOUT_S)
    status = await asyncio.wait_for(_cancel_route(second, job_id), TIMEOUT_S)
    bim.release.set()
    await asyncio.wait_for(finishing, TIMEOUT_S)

    assert status == 200
    job = await _row(second, job_id)
    assert job.state is JobState.CANCELLED and job.cancellation_requested is True
    assert job.result is None and job.termination is None and job.lease_token is None
    assert await _evidence(second, job_id) == 0  # the kept answer of a cancelled job is dropped


@pytest.mark.asyncio
async def test_a_cancel_after_the_job_finished_is_refused_and_changes_nothing(two_sessions, bim):
    first, second = two_sessions
    job = await _running_job(first, await _owner(first))

    await asyncio.wait_for(_finish(first, job.id), TIMEOUT_S)
    status = await asyncio.wait_for(_cancel_route(second, job.id), TIMEOUT_S)

    assert status == 409
    done = await _row(second, job.id)
    assert done.state is JobState.COMPLETED and done.cancellation_requested is False and done.result is not None


@pytest.mark.asyncio
async def test_a_cancel_before_the_answer_is_settled_wins_and_the_answer_is_discarded(two_sessions, bim):
    first, second = two_sessions
    job = await _running_job(first, await _owner(first))

    assert await asyncio.wait_for(_cancel_route(second, job.id), TIMEOUT_S) == 200
    await asyncio.wait_for(_finish(first, job.id), TIMEOUT_S)

    done = await _row(second, job.id)
    assert done.state is JobState.CANCELLED and done.result is None
    assert not bim.is_set()  # BIM was not even asked about the answer of a cancelled job


@pytest.mark.asyncio
async def test_a_cancel_and_a_finish_at_the_same_moment_end_the_job_in_exactly_one_way(two_sessions, bim):
    first, second = two_sessions
    owner = await _owner(first)
    outcomes = set()
    for _ in range(8):
        job = await _running_job(first, owner)

        statuses = await asyncio.wait_for(
            asyncio.gather(_finish(first, job.id), _cancel_route(second, job.id), return_exceptions=True), TIMEOUT_S
        )

        assert statuses[0] is None, statuses
        done = await _row(second, job.id)
        if statuses[1] == 409:
            assert done.state is JobState.COMPLETED and done.cancellation_requested is False and done.result is not None
        else:
            assert statuses[1] == 200, statuses
            assert done.state is JobState.CANCELLED and done.cancellation_requested is True and done.result is None
        outcomes.add(done.state)
        assert done.lease_token is None
        assert await _evidence(second, job.id) == 0
    assert outcomes <= {JobState.COMPLETED, JobState.CANCELLED}


# -- One DELETE ---------------------------------------------------------------------------------------------------


class Engines:
    """Records the DELETEs of every replica; each one takes a moment so that the replicas overlap."""

    def __init__(self) -> None:
        self.deleted: list[str] = []

    async def cancel(self, _registration, engine_job_id, **kwargs) -> bool:
        self.deleted.append(engine_job_id)
        await asyncio.sleep(0.2)
        if kwargs.get("on_status") is not None:
            kwargs["on_status"](200)
        return True


@pytest.fixture
def engines(monkeypatch) -> Engines:
    double = Engines()

    async def transport(_session, revision):
        return remote.RemoteRegistration(endpoint=revision.endpoint, mappings=revision.mappings, allow_internal_http=True)

    monkeypatch.setattr(execution, "cancel_remote", double.cancel)
    monkeypatch.setattr(execution, "revision_transport", transport)
    return double


async def _cancelled_running_job(session, owner, state: str):
    deployment = await a_registration(session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await _running_job(session, owner, registration=deployment, cancellation_requested=True)
    session.add(
        JobEngineAttempt(
            job_id=job.id, attempt=1, engine_job_id="engine-job-A", endpoint=deployment.endpoint, cancel_state=state
        )
    )
    await session.commit()
    context = execution.attempt_cancel_context(
        execution.registration_cancellation(deployment),
        remote.RemoteRegistration(endpoint=deployment.endpoint, mappings=deployment.mappings, allow_internal_http=True),
    )
    return job, context


async def _rows(session, job_id: uuid.UUID) -> list[tuple]:
    rows = (
        await session.execute(
            select(JobEngineAttempt.attempt, JobEngineAttempt.cancel_state, JobEngineAttempt.cancel_attempts).where(
                JobEngineAttempt.job_id == job_id
            )
        )
    ).all()
    return [tuple(row) for row in rows]


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["none", "pending"])
async def test_the_worker_and_the_sweep_claiming_the_delete_of_a_cancelled_job_send_it_once(two_sessions, engines, state):
    first, second = two_sessions
    job, context = await _cancelled_running_job(first, await _owner(first), state)
    watch = execution.CancelWatch(first, job.id, 1, context, interval_s=0.0)

    async def worker() -> str:
        try:
            await watch("engine-job-A")
        except execution.CancellationConfirmed:
            return "confirmed"
        return "waiting"

    outcome = await asyncio.wait_for(
        asyncio.gather(worker(), reconciler.cancel_lost_attempts(second), return_exceptions=True), TIMEOUT_S
    )

    assert not [item for item in outcome if isinstance(item, BaseException)], outcome
    assert engines.deleted == ["engine-job-A"]  # one claim won, the other found nothing to send
    assert await _rows(second, job.id) == [(1, "sent", 1)]
    assert (await _row(second, job.id)).state is JobState.RUNNING  # only the worker ends the job


@pytest.mark.asyncio
async def test_two_watches_of_the_same_attempt_send_the_delete_once(two_sessions, engines):
    first, second = two_sessions
    job, context = await _cancelled_running_job(first, await _owner(first), "none")
    second.info[leases.lease_key(job.id)] = TOKEN  # a redelivered worker that holds the same token
    watches = [
        execution.CancelWatch(first, job.id, 1, context, interval_s=0.0),
        execution.CancelWatch(second, job.id, 1, context, interval_s=0.0),
    ]

    outcome = await asyncio.wait_for(
        asyncio.gather(*(watch("engine-job-A") for watch in watches), return_exceptions=True), TIMEOUT_S
    )

    assert [type(item) for item in outcome if isinstance(item, BaseException)] == [execution.CancellationConfirmed]
    assert engines.deleted == ["engine-job-A"]
    assert await _rows(second, job.id) == [(1, "sent", 1)]

"""B3: a job that loses its lease while the engine still works on it.

Closed since GW-C5 (``tests/test_remote_cancel.py`` covers the rules in depth):

* the fencing: a superseded attempt cannot write its result over the attempt that
  replaced it (the lease token is the fence, ``jobs/leases.py``);
* the id of every attempt is kept (``job_engine_attempts``) and the reconciler asks
  the engine to stop the remote job of a lost attempt, best effort, when the
  registration declares the capability;
* a cancellation is not sent to an engine that never declared one.

Still open here (``xfail(strict=True)``) and documented as a limit, not fixed: a
worker whose lease was lost keeps waiting for the engine, up to ``engine_solve_timeout_s``
(``leases.beat`` returns without interrupting the solve; its result is discarded).
"""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import update

from openbinding_gateway.db.models import Job, JobState, utcnow
from openbinding_gateway.jobs import leases, reconciler
from openbinding_gateway.services import execution
from openbinding_gateway.services.engine_registry import CancellationCapability
from openbinding_gateway.v1.remote import RemoteRegistration

from ._helpers import (
    PER_ATTEMPT_CANCELLATION,
    a_job,
    a_registration,
    account_with_snapshot,
    answer,
    lose_the_worker,
    only_job,
    precondition,
    submit,
)

OPEN = pytest.mark.xfail(strict=True, raises=AssertionError)


async def test_the_late_result_of_a_superseded_attempt_cannot_overwrite_the_new_attempt(
    api_client, db_session, registration, monkeypatch, remote_stub, declared_cancellation
):
    """Closed: attempt 2 holds the lease when attempt 1's answer arrives; the answer writes nothing."""
    seen: dict = {}

    async def solve(*_args, on_remote_id=None, **_kwargs):
        await on_remote_id("engine-job-A")
        job = await only_job(db_session)
        seen["token_a"] = leases.held_token(db_session, job.id)
        # The worker is presumed dead: the lease lapses and the reconciler puts the job back.
        job.lease_until = utcnow() - timedelta(seconds=1)
        await db_session.commit()
        precondition(await reconciler.sweep_abandoned(db_session) == 0, "sweep requeues, it fails nothing")
        await db_session.commit()
        # A second worker claims it and registers its own id. Both workers share this session in the
        # test, so each one's own view of its token is put back afterwards.
        seen["token_b"] = await leases.claim_job(db_session, job.id)
        await db_session.commit()
        db_session.info[leases.lease_key(job.id)] = seen["token_b"]
        await execution.record_engine_job_id(db_session, job.id, "engine-job-B")
        db_session.info[leases.lease_key(job.id)] = seen["token_a"]
        return answer()

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await account_with_snapshot(api_client, registration)

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    precondition(seen["token_a"] != seen["token_b"] and seen["token_b"] is not None, "two distinct claims")
    assert job.state is JobState.RUNNING
    assert job.lease_token == seen["token_b"]
    assert job.attempt == 2
    assert job.result is None and job.finished_at is None
    # Only the old attempt's own remote job is asked to stop, and only by the old attempt:
    # the running attempt's id is never sent.
    assert remote_stub.cancelled == ["engine-job-A"]


async def test_requeueing_a_lost_attempt_cancels_its_remote_job(db_session, owner, remote_stub):
    """Closed: the sweep marks the lost attempt and the cancellation step, after the commit, asks the engine to stop it."""
    registration = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=registration)
    precondition(await leases.claim_job(db_session, job.id) is not None, "claimed")
    await db_session.commit()
    await execution.record_engine_job_id(db_session, job.id, "engine-job-A")
    await lose_the_worker(db_session, job)

    await reconciler.sweep_abandoned(db_session)
    await db_session.commit()
    precondition(remote_stub.cancelled == [], "the sweep itself sends nothing")
    await reconciler.cancel_lost_attempts(db_session)
    await db_session.refresh(job)

    precondition(job.state is JobState.QUEUED, "the lost job went back to the queue")
    assert remote_stub.cancelled == ["engine-job-A"]


async def test_failing_an_abandoned_job_cancels_every_lost_attempt(db_session, owner, remote_stub):
    """Closed: each attempt keeps its own id, so the first one is still known when the second is lost too."""
    registration = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=registration)
    for remote_id in ("engine-job-A", "engine-job-B"):
        precondition(await leases.claim_job(db_session, job.id) is not None, f"claimed for {remote_id}")
        await db_session.commit()
        await execution.record_engine_job_id(db_session, job.id, remote_id)
        await lose_the_worker(db_session, job)
        await reconciler.sweep_abandoned(db_session)
        await db_session.commit()
    await reconciler.cancel_lost_attempts(db_session)
    await db_session.refresh(job)

    precondition(job.state is JobState.FAILED and job.attempt == 2, "second loss fails the job")
    assert sorted(remote_stub.cancelled) == ["engine-job-A", "engine-job-B"]


@OPEN
async def test_a_worker_whose_lease_was_lost_stops_waiting_for_the_engine(
    api_client, db_session, registration, monkeypatch, remote_stub
):
    """Open, a documented limit of GW-C5: ``leases.beat`` returns when a renewal says "lost" and nothing tells
    ``solve_remote`` to stop. The worker waits up to ``engine_solve_timeout_s`` and its result is discarded."""
    monkeypatch.setattr(leases, "HEARTBEAT_S", 0.01)

    async def lost(*_args, **_kwargs):
        return False

    monkeypatch.setattr(leases, "renew_lease", lost)
    observed: dict = {}

    async def solve(*_args, on_remote_id=None, **_kwargs):
        await on_remote_id("engine-job-A")
        try:
            await asyncio.sleep(0.3)  # the engine is still working
        except asyncio.CancelledError:
            observed["interrupted"] = True
            raise
        observed["interrupted"] = False
        return answer()

    monkeypatch.setattr(execution, "solve_remote", solve)
    headers, snapshot_id = await account_with_snapshot(api_client, registration)

    await submit(api_client, headers, snapshot_id)

    precondition("interrupted" in observed, "the stub engine ran")
    assert observed["interrupted"] is True


async def test_cancellation_is_not_sent_to_an_engine_that_does_not_declare_it(db_session, owner, remote_stub):
    """Closed: the one door exists only for a registration whose capability is declared."""
    job = await a_job(db_session, owner)
    precondition(await leases.claim_job(db_session, job.id) is not None, "claimed")
    await db_session.commit()
    await execution.record_engine_job_id(db_session, job.id, "engine-job-A")
    undeclared = RemoteRegistration(
        endpoint="http://engine",
        mappings={"request": "/internal/v1/binding-problems", "job": "/internal/v1/jobs/{id}"},
    )
    await db_session.execute(update(Job).where(Job.id == job.id).values(state=JobState.FAILED))
    await db_session.commit()

    await execution.cancel_engine_attempt(
        db_session, job.id, 1, execution.attempt_cancel_context(CancellationCapability(), undeclared)
    )
    await execution.cancel_engine_attempt(db_session, job.id, 1, None)

    assert remote_stub.cancelled == []

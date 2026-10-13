"""B3 at head cd0e05f: a job that loses its lease while the engine still works on it.

Closed here: the fencing. A superseded attempt cannot write its result over the
attempt that replaced it (the lease token is the fence, ``jobs/leases.py``).

Open here (``xfail(strict=True)``, one reason each): nothing cancels the lost
attempt's remote job when the reconciler takes the job back, the id of a lost
attempt is forgotten once the next attempt records its own, a lost worker
keeps waiting for the engine, and a cancellation is sent to engines that never
declared one.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest

from openbinding_gateway.db.models import JobState, utcnow
from openbinding_gateway.jobs import leases, reconciler
from openbinding_gateway.services import execution
from openbinding_gateway.v1.remote import RemoteRegistration

from ._helpers import (
    a_job,
    account_with_snapshot,
    answer,
    lose_the_worker,
    only_job,
    precondition,
    submit,
)

OPEN = pytest.mark.xfail(strict=True, raises=AssertionError)


async def test_the_late_result_of_a_superseded_attempt_cannot_overwrite_the_new_attempt(
    api_client, db_session, registration, monkeypatch, remote_stub
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
        # A second worker claims it. Both workers share this session in the test,
        # so the first worker's own view of its token is put back afterwards.
        seen["token_b"] = await leases.claim_job(db_session, job.id)
        await db_session.commit()
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
    # Only the old attempt's own remote job is asked to stop, and only by the old attempt.
    assert remote_stub.cancelled == ["engine-job-A"]


@OPEN
async def test_requeueing_a_lost_attempt_cancels_its_remote_job(db_session, owner, remote_stub):
    """B3 open: ``jobs/reconciler.py:83`` (_requeue) never reaches the engine; a dead worker's remote job runs on."""
    job = await a_job(db_session, owner)
    precondition(await leases.claim_job(db_session, job.id) is not None, "claimed")
    await db_session.commit()
    await execution.record_engine_job_id(db_session, job.id, "engine-job-A")
    await lose_the_worker(db_session, job)

    await reconciler.sweep_abandoned(db_session)
    await db_session.commit()
    await asyncio.sleep(0)  # a best-effort cancellation scheduled by the sweep would run here
    await db_session.refresh(job)

    precondition(job.state is JobState.QUEUED, "the lost job went back to the queue")
    assert remote_stub.cancelled == ["engine-job-A"]


@OPEN
async def test_failing_an_abandoned_job_cancels_every_lost_attempt(db_session, owner, remote_stub):
    """B3 open: the second attempt overwrites ``jobs.engine_job_id`` (services/execution.py:91-96); the first id is gone."""
    job = await a_job(db_session, owner)
    for remote_id in ("engine-job-A", "engine-job-B"):
        precondition(await leases.claim_job(db_session, job.id) is not None, f"claimed for {remote_id}")
        await db_session.commit()
        await execution.record_engine_job_id(db_session, job.id, remote_id)
        await lose_the_worker(db_session, job)
        await reconciler.sweep_abandoned(db_session)
        await db_session.commit()
    await asyncio.sleep(0)
    await db_session.refresh(job)

    precondition(job.state is JobState.FAILED and job.attempt == 2, "second loss fails the job")
    assert sorted(remote_stub.cancelled) == ["engine-job-A", "engine-job-B"]


@OPEN
async def test_a_worker_whose_lease_was_lost_stops_waiting_for_the_engine(
    api_client, db_session, registration, monkeypatch, remote_stub
):
    """B3 open: ``leases.beat`` returns when a renewal says "lost" but nothing tells ``solve_remote`` to stop."""
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


@OPEN
async def test_cancellation_is_not_sent_to_an_engine_that_does_not_declare_it(remote_stub):
    """B3 open: ``cancel_engine_job`` (services/execution.py:106) sends DELETE to any engine; no capability is checked."""
    undeclared = RemoteRegistration(
        endpoint="https://engine.example",
        mappings={"request": "/internal/v1/binding-problems", "job": "/internal/v1/jobs/{id}"},
    )

    await execution.cancel_engine_job(undeclared, "engine-job-A")

    assert remote_stub.cancelled == []

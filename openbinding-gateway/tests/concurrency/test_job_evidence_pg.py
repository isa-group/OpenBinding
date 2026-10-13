"""Re-evaluating a kept engine answer, on real row locks (contract C4).

Needs PostgreSQL (``TEST_DATABASE_URL``): the ``two_sessions`` fixture skips
anywhere else, because SQLite ignores row locks. What these pin:

* two simultaneous ``POST /v1/jobs/{id}/reevaluate`` complete the job once;
* BIM is called with no row lock held, so a cancellation does not wait for it;
* a cancellation that arrives while BIM works ends the job CANCELLED, never
  COMPLETED, both for the worker and for the retry of a failed job;
* the worker commits the raw answer before BIM is asked, and releases the row.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from datetime import timedelta

import pytest
from bim_client import BimServiceError
from fastapi import HTTPException
from sqlalchemy import func, select, text

from _pricing import pricing_catalog
from openbinding_gateway.core.public_errors import JOB_FAILURES
from openbinding_gateway.db.models import AuditEvent, Job, JobEngineEvidence, JobState, User, UserRole, utcnow
from openbinding_gateway.jobs import leases
from openbinding_gateway.models.platform import JobView
from openbinding_gateway.routes import jobs as jobs_routes
from openbinding_gateway.services import execution

TIMEOUT_S = 30
MARKER = "raw-engine-marker-pg-4b7"
LOCK_ROW = text("SELECT id FROM jobs WHERE id = :id FOR UPDATE NOWAIT")


async def an_owner(session) -> User:
    owner = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    session.add(owner)
    await session.flush()
    return owner


async def a_failed_job_with_evidence(session) -> tuple[User, Job, JobEngineEvidence]:
    """A job that failed with ``bim_evaluation_failed`` and still has the engine's answer."""
    owner = await an_owner(session)
    job = Job(
        owner_id=owner.id, engine_id="random-search", engine_job_id="engine-1", service_url="http://engine",
        state=JobState.FAILED, attempt=1,
        original_request={
            "bindingProblem": {"kind": "BindingProblem"},
            "mode": {"id": "seeded", "terminationGuarantees": ["FEASIBLE"]},
        },
        provenance={},
    )
    session.add(job)
    await session.flush()
    row = JobEngineEvidence(
        id=uuid.uuid4(), job_id=job.id, attempt=1, raw_result={"termination": "FEASIBLE", "solutions": []},
        digest="sha256:" + "4" * 64, expires_at=utcnow() + timedelta(days=1),
    )
    session.add(row)
    job.result = {
        "termination": "UNKNOWN", "solutions": [], "code": "bim_evaluation_failed",
        "error": JOB_FAILURES["bim_evaluation_failed"], "provenance": {},
        "evidence": {"id": str(row.id), "digest": row.digest, "expiresAt": row.expires_at.isoformat()},
    }
    await session.commit()
    return owner, job, row


async def a_running_job(session) -> tuple[User, Job]:
    """A job claimed by this worker: the lease token is in the session, as the worker keeps it."""
    owner = await an_owner(session)
    job = Job(
        owner_id=owner.id, engine_id="random-search", engine_job_id="engine-1", service_url="http://engine",
        state=JobState.QUEUED, requested_budget_s=600.0, provenance={},
    )
    session.add(job)
    await session.commit()
    assert await leases.claim_job(session, job.id) is not None
    await session.commit()
    await session.refresh(job)
    return owner, job


async def evidence_count(session) -> int:
    return (await session.execute(select(func.count()).select_from(JobEngineEvidence))).scalar_one()


def canned(provenance):
    final = {**provenance, "engineReported": {}}
    return final, {"termination": "FEASIBLE", "solutions": [], "provenance": final}


def code_of(error: BaseException) -> str:
    assert isinstance(error, HTTPException), error
    return error.detail["code"]


async def settle(session, job: Job) -> None:
    await execution.settle_engine_answer(
        session,
        job,
        time.monotonic(),
        attempt=job.attempt,
        remote_result={"termination": "FEASIBLE", "solutions": [], "marker": MARKER},
        document={},
        optimization={},
        termination_guarantees=["FEASIBLE"],
        provenance={},
        transport=None,
        engine_job_id=None,
    )


# -- The retry of a failed job --------------------------------------------------


@pytest.mark.asyncio
async def test_of_two_simultaneous_retries_only_one_completes_the_job(two_sessions, monkeypatch):
    first, second = two_sessions
    owner, job, _row = await a_failed_job_with_evidence(first)

    async def slow(_document, _raw, _optimization, _guarantees, provenance):
        await asyncio.sleep(0.3)  # long enough for both to be evaluating at once
        return canned(provenance)

    monkeypatch.setattr(jobs_routes, "evaluate_engine_result", slow)

    outcomes = await asyncio.wait_for(
        asyncio.gather(
            jobs_routes.reevaluate_job(job.id, owner, first),
            jobs_routes.reevaluate_job(job.id, owner, second),
            return_exceptions=True,
        ),
        TIMEOUT_S,
    )
    await first.rollback()
    await second.rollback()

    views = [outcome for outcome in outcomes if isinstance(outcome, JobView)]
    refused = [outcome for outcome in outcomes if not isinstance(outcome, JobView)]
    assert len(views) == 1 and views[0].status == "completed", outcomes
    assert len(refused) == 1 and refused[0].status_code == 409 and code_of(refused[0]) == "job_not_reevaluable"
    await first.refresh(job)
    assert job.state is JobState.COMPLETED
    assert await evidence_count(first) == 0
    audited = (await first.execute(select(func.count()).select_from(AuditEvent).where(AuditEvent.action == "job.reevaluated"))).scalar_one()
    assert audited == 1


@pytest.mark.asyncio
async def test_bim_is_called_with_no_lock_on_the_job_row(two_sessions, monkeypatch):
    first, second = two_sessions
    owner, job, _row = await a_failed_job_with_evidence(first)
    seen: dict = {}

    async def watching(_document, _raw, _optimization, _guarantees, provenance):
        # NOWAIT: a lock held by the retry would raise here and the retry would answer 503.
        await second.execute(LOCK_ROW, {"id": job.id})
        await second.rollback()
        seen["free"] = True
        return canned(provenance)

    monkeypatch.setattr(jobs_routes, "evaluate_engine_result", watching)

    view = await asyncio.wait_for(jobs_routes.reevaluate_job(job.id, owner, first), TIMEOUT_S)

    assert seen == {"free": True} and view.status == "completed"


@pytest.mark.asyncio
async def test_a_cancellation_during_the_retry_never_completes_the_job(two_sessions, monkeypatch):
    first, second = two_sessions
    owner, job, _row = await a_failed_job_with_evidence(first)

    async def cancelled_meanwhile(_document, _raw, _optimization, _guarantees, provenance):
        await second.execute(
            text("UPDATE jobs SET cancellation_requested = true WHERE id = :id"), {"id": job.id}
        )
        await second.commit()
        return canned(provenance)

    monkeypatch.setattr(jobs_routes, "evaluate_engine_result", cancelled_meanwhile)

    with pytest.raises(HTTPException) as refused:
        await asyncio.wait_for(jobs_routes.reevaluate_job(job.id, owner, first), TIMEOUT_S)
    await first.rollback()

    assert refused.value.status_code == 409 and code_of(refused.value) == "cancellation_requested"
    await first.refresh(job)
    assert job.state is JobState.FAILED
    assert await evidence_count(first) == 1


# -- The worker -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_row_is_free_while_bim_works_and_a_cancellation_ends_the_job_cancelled(two_sessions, monkeypatch):
    first, second = two_sessions
    owner, job = await a_running_job(first)
    evaluating, release = asyncio.Event(), asyncio.Event()

    async def held(_document, _raw, _optimization, _guarantees, provenance):
        evaluating.set()
        await release.wait()
        return canned(provenance)

    monkeypatch.setattr(execution, "evaluate_engine_result", held)
    worker = asyncio.create_task(settle(first, job))
    await asyncio.wait_for(evaluating.wait(), TIMEOUT_S)

    # The answer is durable and visible to others, and the cancellation does not wait for BIM.
    assert await evidence_count(second) == 1
    await second.rollback()
    await asyncio.wait_for(jobs_routes.cancel_job(job.id, owner, second), TIMEOUT_S)
    await second.commit()
    release.set()
    await asyncio.wait_for(worker, TIMEOUT_S)
    await first.commit()

    await first.refresh(job)
    assert job.state is JobState.CANCELLED and job.result is None
    assert await evidence_count(first) == 0


@pytest.mark.asyncio
async def test_a_bim_failure_leaves_the_job_failed_with_its_evidence_and_no_lock(two_sessions, monkeypatch):
    first, second = two_sessions
    _owner, job = await a_running_job(first)

    async def unavailable(*_args):
        raise BimServiceError("service_unavailable", "down")

    monkeypatch.setattr(execution, "evaluate_engine_result", unavailable)

    await asyncio.wait_for(settle(first, job), TIMEOUT_S)
    await first.commit()

    await first.refresh(job)
    [row] = (await first.execute(select(JobEngineEvidence))).scalars().all()
    assert job.state is JobState.FAILED and job.result["code"] == "bim_evaluation_failed"
    assert job.result["evidence"]["id"] == str(row.id) and MARKER not in repr(job.result)
    assert row.raw_result["marker"] == MARKER and row.attempt == job.attempt
    await second.execute(LOCK_ROW, {"id": job.id})
    await second.rollback()


@pytest.mark.asyncio
async def test_a_worker_that_lost_the_lease_during_bim_deletes_its_own_evidence(two_sessions, monkeypatch):
    first, second = two_sessions
    _owner, job = await a_running_job(first)

    async def stolen(_document, _raw, _optimization, _guarantees, provenance):
        await second.execute(text("UPDATE jobs SET lease_token = 'someone-else' WHERE id = :id"), {"id": job.id})
        await second.commit()
        return canned(provenance)

    monkeypatch.setattr(execution, "evaluate_engine_result", stolen)

    await asyncio.wait_for(settle(first, job), TIMEOUT_S)

    await first.refresh(job)
    assert job.state is JobState.RUNNING and job.lease_token == "someone-else" and job.result is None
    assert await evidence_count(first) == 0

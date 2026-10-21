"""The reconciler's sweep and the cancellation of a study run, on one live job at once.

Needs PostgreSQL (``TEST_DATABASE_URL``): the ``two_sessions`` fixture skips
anywhere else, because SQLite ignores row locks. Every writer of a study run
takes its locks run, then cells, then jobs. The sweep locks jobs to decide what
to do with them and then synchronises the study cell, which locks the run: if it
kept the job lock while doing so, it and ``cancel_run`` would each wait for the
lock the other holds, and PostgreSQL would abort one of them. The sweep commits
what it wrote about the jobs before it syncs, so neither order of arrival may
deadlock.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import text

from openbinding_gateway import study_jobs
from openbinding_gateway.db.models import Job, JobState, RunState, StudyCell
from openbinding_gateway.jobs import leases, reconciler

from .test_study_cancel_pg import _states, _world

TIMEOUT_S = 30


async def _abandoned_live_job(session, world) -> Job:
    """A running job of the waiting cell whose worker is gone for the last time: the sweep fails it."""
    job = Job(
        owner_id=world.user_id, engine_id="random-search", engine_job_id="engine-2", service_url="http://engine",
        state=JobState.RUNNING, organization_id=world.organization_id, project_id=world.project_id,
        study_cell_id=world.waiting_id, lease_token="lost", attempt=leases.MAX_ATTEMPTS, requested_budget_s=60.0,
    )
    session.add(job)
    await session.flush()
    cell = await session.get(StudyCell, world.waiting_id)
    cell.job_id, cell.state = job.id, RunState.RUNNING
    job_id = job.id
    await session.execute(
        text(
            "UPDATE jobs SET lease_until = now() - interval '1 minute', claimed_at = now() - interval '1 hour' "
            "WHERE id = :id"
        ),
        {"id": job_id},
    )
    await session.commit()
    return await session.get(Job, job_id)


async def _settled(first, world, job_id) -> None:
    """The final state both orders must reach."""
    state = await _states(first, world)
    assert state.run is RunState.CANCELLED
    assert state.live_jobs == 0
    # A cancelled run launches nothing and no cell that was still open stays open.
    assert state.cells == {0: RunState.CANCELLED, 1: RunState.CANCELLED}
    job = await first.get(Job, job_id, populate_existing=True)
    assert job.state in {JobState.FAILED, JobState.CANCELLED}  # abandoned job: terminal either way


async def _run_both(sweep, cancel) -> list:
    return await asyncio.wait_for(asyncio.gather(sweep(), cancel(), return_exceptions=True), TIMEOUT_S)


@pytest.mark.asyncio
async def test_a_run_cancelled_while_the_sweep_holds_its_job_does_not_deadlock(two_sessions, monkeypatch):
    first, second = two_sessions
    world = await _world(first)
    job = await _abandoned_live_job(first, world)
    job_id = job.id
    written = asyncio.Event()
    real_fail = reconciler._fail_abandoned

    async def fail_then_linger(session, locked):
        failed = await real_fail(session, locked)
        written.set()  # the job is failed and locked, not yet committed
        await asyncio.sleep(0.5)  # long enough for the cancellation to take the run and want the job
        return failed

    monkeypatch.setattr(reconciler, "_fail_abandoned", fail_then_linger)

    async def sweep():
        failed = await reconciler.sweep_abandoned(first)
        await first.commit()
        return failed

    async def cancel():
        await written.wait()
        await study_jobs.cancel_run(second, world.run_id)
        await second.commit()

    outcome = await _run_both(sweep, cancel)

    assert outcome == [1, None], outcome
    await _settled(first, world, job_id)


@pytest.mark.asyncio
async def test_a_sweep_that_arrives_while_the_run_is_being_cancelled_does_not_deadlock(two_sessions, monkeypatch):
    first, second = two_sessions
    world = await _world(first)
    job = await _abandoned_live_job(first, world)
    job_id = job.id
    holding = asyncio.Event()
    real_lock_cells = study_jobs.lock_cells

    async def slow_lock_cells(session, run_id):
        holding.set()  # the run lock is held; the cells and the jobs are not locked yet
        await asyncio.sleep(0.5)
        return await real_lock_cells(session, run_id)

    monkeypatch.setattr(study_jobs, "lock_cells", slow_lock_cells)

    async def cancel():
        await study_jobs.cancel_run(second, world.run_id)
        await second.commit()

    async def sweep():
        await holding.wait()
        failed = await reconciler.sweep_abandoned(first)
        await first.commit()
        return failed

    outcome = await _run_both(sweep, cancel)

    assert outcome == [1, None], outcome
    await _settled(first, world, job_id)


@pytest.mark.asyncio
async def test_the_sweep_holds_no_job_lock_while_it_waits_for_the_run(two_sessions):
    """The run lock is taken by someone else for a while: the failed job must already be free to others."""
    first, second = two_sessions
    world = await _world(first)
    job = await _abandoned_live_job(first, world)
    job_id = job.id
    await study_jobs.lock_run(second, world.run_id)  # a writer of the run, mid-transaction

    sweeping = asyncio.create_task(reconciler.sweep_abandoned(first))
    await asyncio.sleep(0.5)  # the sweep has failed the job and now waits for the run

    assert not sweeping.done()
    # Another session can lock and read the job at once; and sees it already failed.
    locked = await asyncio.wait_for(
        second.execute(text("SELECT state FROM jobs WHERE id = :id FOR UPDATE NOWAIT"), {"id": job_id}), 5
    )
    assert locked.scalar_one() == JobState.FAILED.value

    await second.commit()  # releases the run
    assert await asyncio.wait_for(sweeping, TIMEOUT_S) == 1
    await first.commit()

"""A worker finishing a study cell's job while another launches the run's next cell.

Two cells of one run finish at about the same time. The worker that synced the
first one holds the run and its cells and is about to lock the account of the
run's owner to launch the next cell (``limits.lock_owner``). The other worker
is writing the outcome of the second cell's job: its lease check already
updated the job row in this transaction, so PostgreSQL runs the foreign-key
checks of the next UPDATE of that row again and takes ``KEY SHARE`` on the
owner's row and on the cell's row, in that order. When the account and the
cells were locked ``FOR UPDATE``, which conflicts with ``KEY SHARE``, the two
waited for each other: PostgreSQL killed one, and the cell of the job that was
finishing ended ``internal_error``.

Needs PostgreSQL (``TEST_DATABASE_URL``): the ``two_sessions`` fixture skips
anywhere else, because SQLite ignores row locks.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import func, select

from openbinding_gateway import study_jobs
from openbinding_gateway.db.models import (
    Job,
    JobState,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    RunState,
    Study,
    StudyCell,
    StudyRun,
    User,
    utcnow,
)
from openbinding_gateway.jobs import leases
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services.engines import engine_ref
from _problem_helpers import problem_for

TOKEN = "lease-of-the-finishing-worker"


async def _seed(session):
    """A run of three cells of one real problem.

    Cell 0 has a RUNNING job that a worker holds the lease of (it is about to
    finish). Cell 1 has a COMPLETED job its cell has not heard of yet. Cell 2
    waits to be launched.
    """
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    organization = Organization(slug=f"o{suffix}", name="Org", created_by_id=user.id)
    session.add(organization)
    await session.flush()
    session.add(OrganizationMembership(organization_id=organization.id, user_id=user.id, role=OrganizationRole.OWNER))
    await session.flush()
    upload = await problem_for(session, user, organization=organization)
    refs = {"revision_id": upload.revision.id, "compilation_id": upload.compilation.id}
    engine = {
        **engine_ref(routes._manifest("random-search"), "bim.builtin"),
        "mode": "seeded",
        "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"},
    }
    study = Study(
        organization_id=organization.id, slug="s", name="S",
        definition={"revision_ids": [str(refs["revision_id"])], "engines": [engine], "parameter_sets": [{}],
                    "seeds": [0, 1, 2]},
        definition_digest="sha256-" + "3" * 64, created_by_id=user.id,
    )
    session.add(study)
    await session.flush()
    run = StudyRun(
        study_id=study.id, run_number=1, state=RunState.RUNNING, matrix_digest="sha256-" + "4" * 64,
        definition={"apiVersion": "openbinding/study-run/v1", "problems": [], "engines": [engine],
                    "parameterSets": [{}], "seeds": [0, 1, 2]},
        definition_digest="sha256-" + "7" * 64, summary={}, created_by_id=user.id,
    )
    session.add(run)
    await session.flush()
    cells = [
        StudyCell(
            study_run_id=run.id, ordinal=ordinal, binding_case_revision_id=refs["revision_id"],
            compilation_id=refs["compilation_id"], engine_ref=engine, parameters={}, seed=ordinal,
            fingerprint=f"sha256-{ordinal}" + "6" * 63, state=RunState.QUEUED,
        )
        for ordinal in (0, 1, 2)
    ]
    session.add_all(cells)
    await session.flush()
    finishing = Job(
        owner_id=user.id, engine_id="random-search", engine_job_id="engine-0", service_url="http://engine",
        state=JobState.RUNNING, lease_token=TOKEN, lease_until=utcnow(), organization_id=organization.id,
        study_cell_id=cells[0].id, **refs,
    )
    finished = Job(
        owner_id=user.id, engine_id="random-search", engine_job_id="engine-1", service_url="http://engine",
        state=JobState.COMPLETED, result={"termination": "FEASIBLE", "solutions": []}, termination="FEASIBLE",
        finished_at=utcnow(), organization_id=organization.id, study_cell_id=cells[1].id, **refs,
    )
    session.add_all([finishing, finished])
    await session.flush()
    for cell, job in ((cells[0], finishing), (cells[1], finished)):
        cell.job_id = job.id
        cell.state = RunState.RUNNING
    await session.commit()
    return finishing.id, finished.id, cells[2].id


@pytest.mark.asyncio
async def test_a_job_finishing_while_the_next_cell_launches_does_not_deadlock(two_sessions, monkeypatch):
    finishing_session, syncing_session = two_sessions
    finishing_id, finished_id, waiting_id = await _seed(finishing_session)

    dispatched: list[str] = []

    async def dispatch(job_id, request_session=None):
        dispatched.append(job_id)

    monkeypatch.setattr(study_jobs, "dispatch_persisted_job", dispatch)

    cells_locked = asyncio.Event()
    real_launch = study_jobs.launch_study_cell

    async def launch(session, cell, user, organization):
        # ``_sync`` holds the run and every cell of it by now. Let the finishing
        # worker write its outcome before the launch locks the owner's account.
        cells_locked.set()
        await asyncio.sleep(0.5)
        return await real_launch(session, cell, user, organization)

    monkeypatch.setattr(study_jobs, "launch_study_cell", launch)

    async def sync_the_finished_cell():
        await study_jobs.sync_study_job(str(finished_id), syncing_session)
        await syncing_session.commit()

    async def finish_the_running_job():
        await cells_locked.wait()
        # What ``settle_engine_answer`` does: the lease check updates the row,
        # then the outcome is flushed in the same transaction.
        assert await leases.hold_lease(finishing_session, finishing_id, TOKEN)
        job = await finishing_session.get(Job, finishing_id)
        job.state = JobState.COMPLETED
        job.result = {"termination": "FEASIBLE", "solutions": []}
        job.termination = "FEASIBLE"
        job.lease_token = None
        job.lease_until = None
        job.finished_at = utcnow()
        await finishing_session.flush()
        await finishing_session.commit()

    await asyncio.gather(sync_the_finished_cell(), finish_the_running_job())

    reader = finishing_session
    assert await reader.scalar(
        select(Job.state).where(Job.id == finishing_id).execution_options(populate_existing=True)
    ) is JobState.COMPLETED
    launched = (await reader.execute(select(Job.id).where(Job.study_cell_id == waiting_id))).scalars().all()
    assert len(launched) == 1
    assert dispatched == [str(launched[0])]
    states = dict((await reader.execute(
        select(StudyCell.ordinal, StudyCell.state).execution_options(populate_existing=True)
    )).all())
    assert states[1] is RunState.COMPLETED
    assert states[2] in {RunState.QUEUED, RunState.RUNNING}
    assert await reader.scalar(select(func.count()).select_from(StudyRun)) == 1

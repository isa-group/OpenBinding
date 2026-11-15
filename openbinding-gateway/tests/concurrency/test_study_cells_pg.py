"""Two workers finishing jobs of one run at once launch the next cell once.

Needs PostgreSQL (``TEST_DATABASE_URL``): the ``two_sessions`` fixture skips
anywhere else, because SQLite ignores row locks and SKIP LOCKED.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import func, select

from openbinding_gateway import study_jobs
from openbinding_gateway.db.artifact_models import Artifact, ArtifactVersion
from openbinding_gateway.db.models import (
    AuditEvent,
    Blob,
    Job,
    JobState,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    ProblemCompilation,
    Project,
    RunState,
    Study,
    StudyCell,
    StudyRun,
    User,
)
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services.engines import engine_ref
from openbinding_gateway.services.job_submission import JobSubmission
from _problem_helpers import problem_for, run_refs, seed_problem_run


async def cell_refs(session, cell) -> dict:
    """The revision and compilation a job of ``cell`` names (the cell's revision and its only compilation)."""
    compilation = await session.scalar(
        select(ProblemCompilation.id).where(ProblemCompilation.revision_id == cell.binding_case_revision_id)
    )
    return {"revision_id": cell.binding_case_revision_id, "compilation_id": compilation}


async def _seed(session, prepare=None, owner_role=OrganizationRole.OWNER):
    """A run of two cells: the first has a finished job, the second waits to be launched.

    The run's owner is also a member of the organization, with ``owner_role``.

    ``prepare(session, user, organization)`` may return ``(run references, engine_ref)``: the
    revision of a real problem and the engine of the cells. The cells' columns are written at
    INSERT time because PostgreSQL's triggers reject updating them afterwards. Without it the
    revision is a seeded one (``seed_problem_run``).
    """
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    organization = Organization(slug=f"o{suffix}", name="Org", created_by_id=user.id)
    session.add(organization)
    await session.flush()
    # The creator of an organization is always a member; ``study_jobs._sync`` stops launching
    # cells for a run whose owner no longer has MEMBER access.
    session.add(OrganizationMembership(organization_id=organization.id, user_id=user.id, role=owner_role))
    project = Project(organization_id=organization.id, slug="p", name="P", created_by_id=user.id)
    session.add(project)
    await session.flush()
    blob = Blob(
        organization_id=organization.id, digest="sha256-" + "0" * 64,
        media_type="application/json", size_bytes=2, storage_uri="memory://blob", created_by_id=user.id,
    )
    artifact = Artifact(
        organization_id=organization.id, namespace="ns", name="study", display_name="Study", kind="Study",
        created_by_id=user.id,
    )
    session.add_all([blob, artifact])
    await session.flush()
    version = ArtifactVersion(
        artifact_id=artifact.id, ordinal=1, version="1.0.0", blob_id=blob.id,
        content_digest="sha256-" + "1" * 64, version_digest="sha256-" + "2" * 64,
        manifest={"kind": "Study"}, created_by_id=user.id,
    )
    session.add(version)
    await session.flush()
    engine_ref = None
    if prepare is not None:
        refs, engine_ref = await prepare(session, user, organization)
    else:
        refs = run_refs(await seed_problem_run(session, owner_id=user.id, organization_id=organization.id))
    study = Study(
        project_id=project.id, slug="s", name="S", definition_version_id=version.id, created_by_id=user.id,
    )
    session.add(study)
    await session.flush()
    run = StudyRun(
        study_id=study.id, definition_version_id=version.id, run_number=1, state=RunState.RUNNING,
        matrix_digest="sha256-" + "4" * 64, summary={}, created_by_id=user.id,
    )
    session.add(run)
    await session.flush()
    engine = engine_ref or {
        "namespace": "bim.builtin", "name": "random-search", "version": "1.0.0", "digest": "sha256-" + "5" * 64,
    }
    cells = [
        StudyCell(
            study_run_id=run.id, ordinal=ordinal, binding_case_revision_id=refs["revision_id"], engine_ref=engine,
            parameters={}, seed=ordinal, fingerprint=f"sha256-{ordinal}" + "6" * 63, state=RunState.QUEUED,
        )
        for ordinal in (0, 1)
    ]
    session.add_all(cells)
    await session.flush()
    finished = Job(
        owner_id=user.id, engine_id="random-search", engine_job_id="engine-1", service_url="http://engine",
        state=JobState.COMPLETED, organization_id=organization.id,
        study_cell_id=cells[0].id, revision_id=refs["revision_id"], compilation_id=refs["compilation_id"],
    )
    session.add(finished)
    await session.flush()
    cells[0].job_id = finished.id
    cells[0].state = RunState.RUNNING
    await session.commit()
    return finished.id, cells[1].id


@pytest.mark.asyncio
async def test_two_concurrent_syncs_launch_the_next_cell_once(two_sessions, monkeypatch):
    first, second = two_sessions
    finished_id, waiting_id = await _seed(first)
    launched: list[uuid.UUID] = []

    async def launch(session, cell, user, organization):
        launched.append(cell.id)
        await asyncio.sleep(0.2)  # long enough for the other worker to arrive
        job = Job(
            owner_id=user.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()),
            service_url="http://engine", state=JobState.QUEUED, study_cell_id=cell.id,
            organization_id=organization.id, **await cell_refs(session, cell),
        )
        session.add(job)
        await session.flush()
        cell.job_id = job.id
        await session.flush()
        return job

    monkeypatch.setattr(study_jobs, "launch_study_cell", launch)

    async def sync(session):
        await study_jobs._sync(session, finished_id)
        await session.commit()

    await asyncio.gather(sync(first), sync(second))

    assert launched == [waiting_id]
    jobs = await first.scalar(select(func.count()).select_from(Job).where(Job.study_cell_id == waiting_id))
    assert jobs == 1


@pytest.mark.asyncio
async def test_two_concurrent_syncs_of_a_demoted_owner_launch_nothing_and_fail_the_cell_once(
    two_sessions, monkeypatch
):
    first, second = two_sessions
    finished_id, waiting_id = await _seed(first)
    owner_id = await first.scalar(select(User.id))
    # The owner was demoted after the run began.
    membership = await first.scalar(
        select(OrganizationMembership).where(OrganizationMembership.user_id == owner_id)
    )
    membership.role = OrganizationRole.VIEWER
    await first.commit()
    launched: list[uuid.UUID] = []

    async def launch(session, cell, user, organization):
        launched.append(cell.id)
        raise AssertionError("a VIEWER's run must not launch a cell")

    monkeypatch.setattr(study_jobs, "launch_study_cell", launch)

    async def sync(session):
        await study_jobs._sync(session, finished_id)
        await session.commit()

    await asyncio.gather(sync(first), sync(second))

    assert launched == []
    assert await first.scalar(select(func.count()).select_from(Job).where(Job.study_cell_id == waiting_id)) == 0
    cell = await first.scalar(
        select(StudyCell).where(StudyCell.id == waiting_id).execution_options(populate_existing=True)
    )
    assert cell.state is RunState.FAILED
    assert cell.metrics["code"] == study_jobs.OWNER_ROLE_REVOKED == "owner_role_revoked"
    assert await first.scalar(select(StudyRun.state)) is RunState.PARTIAL
    audited = await first.scalar(
        select(func.count()).select_from(AuditEvent).where(AuditEvent.action == "study.run.owner_role_revoked")
    )
    assert audited == 1  # the second sync found the cell already failed


@pytest.mark.asyncio
async def test_two_sessions_launching_one_cell_create_one_job_and_one_reservation(two_sessions, monkeypatch):
    """The real ``launch_study_cell`` in two sessions at once, with the dispatcher and SPACE faked.

    The creating session pauses right after the job exists - the window the old
    mid-launch commit left open. The other one must end up with that same job.
    """
    first, second = two_sessions

    async def prepare(session, owner, organization):
        upload = await problem_for(session, owner, organization=organization)
        return {"revision_id": upload.revision.id, "compilation_id": upload.compilation.id}, {
            **engine_ref(routes._manifest("random-search"), "bim.builtin"),
            "mode": "seeded",
            "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"},
        }

    _, waiting_id = await _seed(first, prepare)
    user = (await first.execute(select(User))).scalars().one()
    user_id = user.id
    organization = (await first.execute(select(Organization))).scalars().one()
    organization_id = organization.id

    dispatched: list[str] = []

    async def dispatch(job_id, request_session=None):
        dispatched.append(job_id)

    monkeypatch.setattr(study_jobs, "dispatch_persisted_job", dispatch)

    class PausedSubmission(JobSubmission):
        async def submit(self, request):
            outcome = await super().submit(request)
            await asyncio.sleep(0.5)  # long enough for the other session to arrive
            return outcome

    monkeypatch.setattr(study_jobs, "JobSubmission", PausedSubmission)

    async def launch(session):
        mine = await session.get(StudyCell, waiting_id)
        job = await study_jobs.launch_study_cell(
            session,
            mine,
            await session.get(User, user_id),
            await session.get(Organization, organization_id),
        )
        await study_jobs.commit_launched(session)
        return job.id

    job_ids = await asyncio.gather(launch(first), launch(second))

    assert len(set(job_ids)) == 1
    jobs = await first.scalar(select(func.count()).select_from(Job).where(Job.study_cell_id == waiting_id))
    assert jobs == 1
    assert dispatched == [str(job_ids[0])]

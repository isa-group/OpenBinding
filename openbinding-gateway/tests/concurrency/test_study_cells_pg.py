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
    BindingCase,
    BindingCaseRevision,
    Blob,
    Job,
    JobState,
    Organization,
    Project,
    RunState,
    Study,
    StudyCell,
    StudyRun,
    User,
)


async def _seed(session):
    """A run of two cells: the first has a finished job, the second waits to be launched."""
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    organization = Organization(slug=f"o{suffix}", name="Org", billing_sponsor_user_id=user.id, created_by_id=user.id)
    session.add(organization)
    await session.flush()
    project = Project(organization_id=organization.id, slug="p", name="P", created_by_id=user.id)
    session.add(project)
    await session.flush()
    case = BindingCase(project_id=project.id, slug="c", name="C", created_by_id=user.id)
    blob = Blob(
        organization_id=organization.id, project_id=project.id, digest="sha256-" + "0" * 64,
        media_type="application/json", size_bytes=2, storage_uri="memory://blob",
    )
    artifact = Artifact(
        organization_id=organization.id, namespace="ns", name="study", display_name="Study", kind="Study",
        created_by_id=user.id,
    )
    session.add_all([case, blob, artifact])
    await session.flush()
    version = ArtifactVersion(
        artifact_id=artifact.id, ordinal=1, version="1.0.0", blob_id=blob.id,
        content_digest="sha256-" + "1" * 64, version_digest="sha256-" + "2" * 64,
        manifest={"kind": "Study"}, created_by_id=user.id,
    )
    revision = BindingCaseRevision(
        binding_case_id=case.id, revision=1, digest="sha256-" + "3" * 64, document={}, created_by_id=user.id,
    )
    session.add_all([version, revision])
    await session.flush()
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
    engine = {"namespace": "bim.builtin", "name": "random-search", "version": "1.0.0", "digest": "sha256-" + "5" * 64}
    cells = [
        StudyCell(
            study_run_id=run.id, ordinal=ordinal, binding_case_revision_id=revision.id, engine_ref=engine,
            parameters={}, seed=ordinal, fingerprint=f"sha256-{ordinal}" + "6" * 63, state=RunState.QUEUED,
        )
        for ordinal in (0, 1)
    ]
    session.add_all(cells)
    await session.flush()
    finished = Job(
        owner_id=user.id, engine_id="random-search", engine_job_id="engine-1", service_url="http://engine",
        state=JobState.COMPLETED, organization_id=organization.id, project_id=project.id,
        study_cell_id=cells[0].id,
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

    async def launch(session, cell, user, organization, project_id):
        launched.append(cell.id)
        await asyncio.sleep(0.2)  # long enough for the other worker to arrive
        job = Job(
            owner_id=user.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()),
            service_url="http://engine", state=JobState.QUEUED, study_cell_id=cell.id,
            organization_id=organization.id, project_id=project_id,
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

"""Follow-up of finding M1: a role lost after the work was started still stops the work.

Two paths kept running on a role that was checked once, at the start. A study run launches its next cells
when the previous one ends, as the user who started the run; and ``POST /v1/jobs/{id}/retry`` of a job with
no organization looked only at the job. A run whose owner is no longer MEMBER (demoted or removed) launches
nothing more, and a retry of a job on a snapshot shared with organizations needs MEMBER in one of them.
"""

# ruff: noqa: F811  (the ``lab`` fixture is imported, and tests name it as a parameter)
from __future__ import annotations

import uuid

from sqlalchemy import select

from _b1_helpers import gate, put_member  # noqa: F401
from bim_core.package import load_package
from openbinding_gateway import study_jobs
from openbinding_gateway.db.models import (
    AuditEvent,
    Job,
    JobState,
    RunState,
    Study,
    StudyCell,
    StudyRun,
    utcnow,
)
from test_viewer_read_only import EXAMPLE, Lab, Person, code_of, lab, no_dispatch  # noqa: F401

ACTION = "study.run.owner_role_revoked"


async def free_slots(db_session, lab: Lab) -> None:
    """Cancel the seeded queued jobs, so that a plan's concurrency limit never decides the outcome."""
    for job_id in lab.queued.values():
        (await db_session.get(Job, job_id)).state = JobState.CANCELLED
    await db_session.flush()


async def a_run(db_session, lab: Lab, owner: Person, run_number: int) -> tuple[StudyRun, StudyCell, StudyCell]:
    """A run of study ``s`` by ``owner``: one cell finished, one still waiting for it."""
    study = (await db_session.scalars(select(Study).where(Study.slug == "s"))).one()
    run = StudyRun(
        study_id=study.id, definition_version_id=study.definition_version_id, run_number=run_number,
        state=RunState.RUNNING, matrix_digest="sha256-" + "0" * 64, created_by_id=owner.id,
    )
    db_session.add(run)
    await db_session.flush()
    cells = []
    for ordinal in range(2):
        cell = StudyCell(
            study_run_id=run.id, ordinal=ordinal, binding_case_revision_id=uuid.UUID(lab.definition["case_revision_ids"][0]),
            engine_ref=dict(lab.definition["engines"][0]), parameters={"iterations": 100}, seed=ordinal,
            fingerprint=f"sha256-{run_number}-{ordinal}", state=RunState.RUNNING if ordinal == 0 else RunState.QUEUED,
        )
        db_session.add(cell)
        cells.append(cell)
    await db_session.flush()
    finished = Job(
        owner_id=owner.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="http://engine",
        state=JobState.COMPLETED, organization_id=lab.org_id, project_id=lab.project_id, study_cell_id=cells[0].id,
        original_request={}, provenance={}, result={"solutions": []}, finished_at=utcnow(),
    )
    db_session.add(finished)
    await db_session.flush()
    cells[0].job_id = finished.id
    await db_session.flush()
    return run, cells[0], cells[1]


async def audits(db_session, run: StudyRun) -> list[AuditEvent]:
    return list(
        (await db_session.scalars(select(AuditEvent).where(AuditEvent.action == ACTION, AuditEvent.target_id == run.id))).all()
    )


async def test_a_run_whose_owner_was_demoted_launches_no_more_cells_and_closes(api_client, db_session, lab):
    await free_slots(db_session, lab)
    owner = lab.people["ADMIN"]
    run, done, waiting = await a_run(db_session, lab, owner, 1)
    assert (await put_member(api_client, lab.owner_headers, lab.slug, str(owner.id), "VIEWER")).status_code == 200

    await study_jobs.sync_study_job(str(done.job_id), db_session)

    for row in (run, done, waiting):
        await db_session.refresh(row)
    assert waiting.job_id is None and waiting.state is RunState.FAILED
    assert waiting.metrics["code"] == study_jobs.OWNER_ROLE_REVOKED == "owner_role_revoked"
    assert run.state is RunState.PARTIAL and run.finished_at is not None
    (event,) = await audits(db_session, run)
    assert event.organization_id == lab.org_id and event.actor_id == owner.id
    assert event.target_type == "StudyRun"
    assert event.detail == {
        "runId": str(run.id), "ownerId": str(owner.id), "cells": 1, "code": "owner_role_revoked",
    }
    launched = await db_session.scalar(select(Job.id).where(Job.study_cell_id == waiting.id))
    assert launched is None


async def test_a_run_whose_owner_left_the_organization_launches_nothing(api_client, db_session, lab):
    await free_slots(db_session, lab)
    owner = lab.people["ADMIN"]
    run, done, waiting = await a_run(db_session, lab, owner, 1)
    removed = await api_client.delete(
        f"/v1/organizations/{lab.slug}/members/{owner.id}", headers=lab.owner_headers
    )
    assert removed.status_code in {200, 204}, removed.text

    await study_jobs.sync_study_job(str(done.job_id), db_session)

    await db_session.refresh(waiting)
    assert waiting.job_id is None and waiting.metrics["code"] == study_jobs.OWNER_ROLE_REVOKED
    assert len(await audits(db_session, run)) == 1


async def test_another_run_of_the_same_cycle_with_a_member_owner_still_launches(api_client, db_session, lab):
    await free_slots(db_session, lab)
    demoted, member = lab.people["ADMIN"], lab.people["MEMBER"]
    revoked_run, revoked_done, revoked_waiting = await a_run(db_session, lab, demoted, 1)
    kept_run, kept_done, kept_waiting = await a_run(db_session, lab, member, 2)
    assert (await put_member(api_client, lab.owner_headers, lab.slug, str(demoted.id), "VIEWER")).status_code == 200

    for done in (revoked_done, kept_done):
        await study_jobs.sync_study_job(str(done.job_id), db_session)

    for row in (revoked_run, revoked_waiting, kept_run, kept_waiting):
        await db_session.refresh(row)
    assert revoked_waiting.job_id is None and revoked_waiting.state is RunState.FAILED
    assert kept_waiting.job_id is not None and kept_waiting.state is not RunState.FAILED
    launched = await db_session.get(Job, kept_waiting.job_id)
    assert launched.owner_id == member.id and launched.study_cell_id == kept_waiting.id
    assert kept_run.state is not RunState.PARTIAL
    assert await audits(db_session, kept_run) == []
    assert len(await audits(db_session, revoked_run)) == 1


async def test_a_run_whose_owner_is_still_a_member_behaves_as_before(db_session, lab):
    await free_slots(db_session, lab)
    run, done, waiting = await a_run(db_session, lab, lab.people["MEMBER"], 1)

    await study_jobs.sync_study_job(str(done.job_id), db_session)

    await db_session.refresh(waiting)
    assert waiting.job_id is not None and waiting.metrics.get("code") != study_jobs.OWNER_ROLE_REVOKED
    assert await audits(db_session, run) == []


# -- Retry of a job with no organization on a snapshot that organizations share -----------------------


async def shared_snapshot_job(db_session, lab: Lab, person: Person) -> Job:
    """A failed job of ``person`` outside any organization, run on the author's snapshot shared through a case."""
    row = Job(
        owner_id=person.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="http://engine",
        state=JobState.FAILED, instance_snapshot_id=uuid.UUID(lab.snapshot), organization_id=None,
        original_request={}, provenance={},
    )
    db_session.add(row)
    await db_session.flush()
    return row


async def test_a_retry_on_a_shared_snapshot_is_denied_once_the_owner_was_demoted(api_client, db_session, lab):
    member = lab.people["MEMBER"]
    job = await shared_snapshot_job(db_session, lab, member)
    assert (await put_member(api_client, lab.owner_headers, lab.slug, str(member.id), "VIEWER")).status_code == 200

    denied = await api_client.post(f"/v1/jobs/{job.id}/retry", headers=member.headers)

    assert denied.status_code == 403, denied.text
    assert code_of(denied) == "insufficient_role"
    replacements = (await db_session.scalars(select(Job).where(Job.retry_of_id == job.id))).all()
    assert replacements == []


async def test_a_cancel_on_a_shared_snapshot_is_denied_once_the_owner_was_demoted(api_client, db_session, lab):
    member = lab.people["MEMBER"]
    job = await shared_snapshot_job(db_session, lab, member)
    job.state = JobState.RUNNING
    await db_session.flush()
    assert (await put_member(api_client, lab.owner_headers, lab.slug, str(member.id), "VIEWER")).status_code == 200

    denied = await api_client.post(f"/v1/jobs/{job.id}/cancel", headers=member.headers)

    assert denied.status_code == 403, denied.text
    assert code_of(denied) == "insufficient_role"
    await db_session.refresh(job)
    assert job.state == JobState.RUNNING


async def test_a_retry_on_a_shared_snapshot_is_allowed_for_a_member(api_client, db_session, lab):
    await free_slots(db_session, lab)
    member = lab.people["MEMBER"]
    job = await shared_snapshot_job(db_session, lab, member)

    allowed = await api_client.post(f"/v1/jobs/{job.id}/retry", headers=member.headers)

    assert allowed.status_code == 202, allowed.text
    assert allowed.json()["id"] != str(job.id)


async def test_a_retry_of_a_personal_job_on_the_users_own_snapshot_needs_no_role(api_client, db_session, lab):
    await free_slots(db_session, lab)
    viewer = lab.people["VIEWER"]
    own = await api_client.post(
        "/v1/instances", headers={**viewer.headers, "Content-Type": "application/vnd.bim+zip"},
        content=load_package(EXAMPLE).to_zip(),
    )
    assert own.status_code == 201, own.text
    job = Job(
        owner_id=viewer.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="http://engine",
        state=JobState.FAILED, instance_snapshot_id=uuid.UUID(own.json()["id"]), organization_id=None,
        original_request={}, provenance={},
    )
    db_session.add(job)
    await db_session.flush()

    allowed = await api_client.post(f"/v1/jobs/{job.id}/retry", headers=viewer.headers)

    assert allowed.status_code == 202, allowed.text


async def test_a_retry_of_a_job_with_no_snapshot_and_no_organization_is_unchanged(api_client, db_session, lab):
    await free_slots(db_session, lab)
    viewer = lab.people["VIEWER"]
    job = Job(
        owner_id=viewer.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="http://engine",
        state=JobState.FAILED, organization_id=None, original_request={}, provenance={},
    )
    db_session.add(job)
    await db_session.flush()

    allowed = await api_client.post(f"/v1/jobs/{job.id}/retry", headers=viewer.headers)

    assert allowed.status_code == 202, allowed.text

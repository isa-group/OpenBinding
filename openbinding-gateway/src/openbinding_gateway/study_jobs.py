"""Bridge comparative-study cells to the authoritative BIM job pipeline."""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from .db import base as db_base
from .db.models import (
    BindingCaseRevision,
    InstanceSnapshot,
    Job,
    JobState,
    Organization,
    RunState,
    StudyCell,
    StudyRun,
    User,
    utcnow,
)
from .studies import aggregate_metrics
from .v1.package import PackageError, load_package


class StudyLaunchError(RuntimeError):
    """A cell could not be converted into a valid persisted solve job."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def metrics_from_job(job: Job, cell: StudyCell) -> dict[str, Any]:
    result = job.result if isinstance(job.result, dict) else {}
    solutions = result.get("solutions") if isinstance(result.get("solutions"), list) else []
    first = solutions[0] if solutions and isinstance(solutions[0], dict) else {}
    objectives = first.get("objectives") if isinstance(first.get("objectives"), dict) else {}
    runtime = None
    if job.finished_at and job.created_at:
        runtime = max(0.0, (job.finished_at - job.created_at).total_seconds())
    return {
        "status": "completed" if job.state is JobState.COMPLETED else "failed",
        "feasible": job.state is JobState.COMPLETED and job.termination != "INFEASIBLE",
        "termination": job.termination,
        "objectives": objectives,
        "runtimeSeconds": runtime,
        "engine": (
            f"{cell.engine_ref.get('namespace')}/{cell.engine_ref.get('name')}"
            f"@{cell.engine_ref.get('version')}"
        ),
        "seed": cell.seed,
    }


def _job_request(payload: dict[str, Any]) -> Request:
    body = json.dumps(payload, separators=(",", ":")).encode()
    delivered = False

    async def receive() -> dict[str, Any]:
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/v1/jobs",
            "raw_path": b"/v1/jobs",
            "query_string": b"",
            "headers": [(b"content-type", b"application/json")],
            "client": ("study-orchestrator", 0),
            "server": ("gateway", 80),
        },
        receive,
    )


def _response_payload(response: Any) -> dict[str, Any]:
    if isinstance(response, JSONResponse):
        body = json.loads(response.body)
        if response.status_code >= 400:
            raise StudyLaunchError(
                str(body.get("title", "job_rejected")),
                str(body.get("detail", "The study cell was rejected.")),
            )
        return body
    if not isinstance(response, dict):
        raise StudyLaunchError("job_rejected", "The job pipeline returned no job identity.")
    return response


async def launch_study_cell(
    session: AsyncSession,
    cell: StudyCell,
    user: User,
    organization: Organization,
    project_id: uuid.UUID,
) -> Job:
    """Create one normal persisted job from an immutable study cell."""

    # Import lazily: the v1 router owns compilation and engine selection, while
    # the router imports the durable dispatcher that later calls us back.
    from .routes import v1

    revision = await session.get(BindingCaseRevision, cell.binding_case_revision_id)
    if revision is None or revision.source_snapshot_id is None:
        raise StudyLaunchError(
            "executable_snapshot_required",
            "Study case revisions must pin a BIM source snapshot.",
        )
    source = await session.get(InstanceSnapshot, revision.source_snapshot_id)
    if source is None:
        raise StudyLaunchError(
            "snapshot_not_found", "The BIM snapshot pinned by this case revision no longer exists."
        )
    try:
        package = load_package(source.source_archive)
        problem = await v1._compile_resolved(package, session)
    except (HTTPException, PackageError, RuntimeError) as exc:
        raise StudyLaunchError("invalid_case_revision", str(exc)) from exc

    # A project member may run a teammate's case. Persisting the same immutable
    # package for the actor keeps the existing owner-scoped snapshot contract.
    snapshot_id = await v1._persist_snapshot(package, problem, user, session)
    if snapshot_id is None:
        raise StudyLaunchError("snapshot_persistence_failed", "The BIM snapshot could not be persisted.")

    engine = dict(cell.engine_ref)
    requested_mode = engine.pop("mode", None)
    try:
        _, selected_mode, _ = await v1._engine_mode(
            engine["name"],
            requested_mode,
            cell.parameters,
            session,
            caller=user,
            namespace=engine["namespace"],
            version=engine["version"],
            manifest_digest=engine["digest"],
        )
    except (HTTPException, KeyError) as exc:
        detail = exc.detail if isinstance(exc, HTTPException) else "Invalid engine reference."
        raise StudyLaunchError("invalid_engine", str(detail)) from exc

    options = dict(cell.parameters)
    properties = selected_mode.get("optionsSchema", {}).get("properties", {})
    if isinstance(properties, dict) and "seed" in properties:
        options["seed"] = cell.seed
    payload = {
        "snapshot": snapshot_id,
        "engine": engine,
        "mode": selected_mode["id"],
        "options": options,
    }
    created = _response_payload(
        await v1.create_job(_job_request(payload), caller=user, session=session)
    )
    try:
        job_id = uuid.UUID(str(created["id"]))
    except (KeyError, ValueError) as exc:
        raise StudyLaunchError("job_rejected", "The job pipeline returned an invalid identity.") from exc
    job = await session.get(Job, job_id)
    if job is None:
        raise StudyLaunchError("job_not_persisted", "The study job was not persisted.")
    job.organization_id = organization.id
    job.project_id = project_id
    job.billing_sponsor_user_id = organization.billing_sponsor_user_id
    cell.job_id = job.id
    await session.flush()
    await sync_study_job(str(job.id), session)
    return job


async def _sync(session: AsyncSession, job_id: uuid.UUID) -> None:
    job = await session.get(Job, job_id)
    if job is None:
        return
    cell = (
        await session.execute(select(StudyCell).where(StudyCell.job_id == job.id))
    ).scalars().first()
    if cell is None:
        return
    state_map = {
        JobState.QUEUED: RunState.QUEUED,
        JobState.RUNNING: RunState.RUNNING,
        JobState.COMPLETED: RunState.COMPLETED,
        JobState.FAILED: RunState.FAILED,
        JobState.CANCELLED: RunState.CANCELLED,
    }
    cell.state = state_map[job.state]
    if job.state in {JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED}:
        cell.metrics = metrics_from_job(job, cell)

    run = await session.get(StudyRun, cell.study_run_id)
    if run is None or run.state is RunState.CANCELLED:
        await session.flush()
        return
    cells = (
        await session.execute(select(StudyCell).where(StudyCell.study_run_id == run.id))
    ).scalars().all()
    terminal = {RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED}
    if all(value.state in terminal for value in cells):
        run.state = (
            RunState.COMPLETED
            if all(value.state is RunState.COMPLETED for value in cells)
            else RunState.PARTIAL
        )
        run.finished_at = utcnow()
        run.summary = aggregate_metrics([value.metrics for value in cells])
    elif any(value.state is RunState.RUNNING for value in cells):
        run.state = RunState.RUNNING
    else:
        run.state = RunState.QUEUED
    await session.flush()


async def sync_study_job(job_id: str, session: AsyncSession | None = None) -> None:
    """Reflect a child job transition onto its cell and aggregate its run."""

    parsed = uuid.UUID(job_id)
    if session is not None:
        await _sync(session, parsed)
        return
    if not db_base.is_configured():
        raise RuntimeError("Study job synchronization requires an initialized database.")
    async with db_base.session_factory()() as owned:
        await _sync(owned, parsed)
        await owned.commit()

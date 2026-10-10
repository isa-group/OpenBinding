"""Bridge comparative-study cells to the authoritative BIM job pipeline."""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
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


ENGINE_IDENTITY_FIELDS = ("namespace", "name", "version", "digest")


def _recorded_seed(job: Job) -> tuple[bool, Any]:
    """The seed a job was asked to run with, as ``(recorded, value)``."""

    options = job.options if isinstance(job.options, dict) else {}
    if "seed" in options:
        return True, options["seed"]
    provenance = job.provenance if isinstance(job.provenance, dict) else {}
    requested = provenance.get("requestedOptions")
    if isinstance(requested, dict) and "seed" in requested:
        return True, requested["seed"]
    return False, None


async def _mode_takes_seed(
    session: AsyncSession, cell: StudyCell, user: User, job_mode: Any
) -> bool:
    """Whether the cell's engine mode accepts a seed; unknown counts as yes."""

    from .routes import v1

    reference = cell.engine_ref
    try:
        manifest = await v1._manifest_async(
            reference["name"],
            session,
            caller=user,
            namespace=reference.get("namespace"),
            version=reference.get("version"),
            manifest_digest=reference.get("digest"),
        )
    except (HTTPException, KeyError):
        return True
    wanted = reference.get("mode") or job_mode
    mode = next(
        (item for item in manifest.get("spec", {}).get("modes", []) if item.get("id") == wanted),
        None,
    )
    if mode is None:
        return True
    schema = mode.get("optionsSchema")
    properties = schema.get("properties") if isinstance(schema, dict) else None
    return not isinstance(properties, dict) or "seed" in properties


async def cell_job_mismatches(
    session: AsyncSession, cell: StudyCell, job: Job, user: User
) -> dict[str, dict[str, Any]]:
    """Which identities of a job differ from the cell it is offered as the result of.

    The keys are ``case_revision`` (the BIM package behind the cell's pinned
    case revision), ``engine`` (namespace, name, version and digest), ``mode``
    (when the cell pins one) and ``seed``. Each maps to what the cell expects
    and what the job recorded; an empty result means the job is a faithful
    execution of the cell.
    """

    provenance = job.provenance if isinstance(job.provenance, dict) else {}
    mismatches: dict[str, dict[str, Any]] = {}

    revision = await session.get(BindingCaseRevision, cell.binding_case_revision_id)
    source = (
        await session.get(InstanceSnapshot, revision.source_snapshot_id)
        if revision is not None and revision.source_snapshot_id is not None
        else None
    )
    expected_package = source.package_digest if source is not None else None
    job_package = provenance.get("packageDigest")
    if job_package is None and job.instance_snapshot_id is not None:
        snapshot = await session.get(InstanceSnapshot, job.instance_snapshot_id)
        job_package = snapshot.package_digest if snapshot is not None else None
    if expected_package is None or job_package != expected_package:
        mismatches["case_revision"] = {"cell": expected_package, "job": job_package}

    job_engine = provenance.get("engine") if isinstance(provenance.get("engine"), dict) else {}
    cell_engine = {field: cell.engine_ref.get(field) for field in ENGINE_IDENTITY_FIELDS}
    recorded_engine = {field: job_engine.get(field) for field in ENGINE_IDENTITY_FIELDS}
    if cell_engine != recorded_engine:
        mismatches["engine"] = {"cell": cell_engine, "job": recorded_engine}

    cell_mode = cell.engine_ref.get("mode")
    if cell_mode is not None and provenance.get("mode") != cell_mode:
        mismatches["mode"] = {"cell": cell_mode, "job": provenance.get("mode")}

    recorded, seed = _recorded_seed(job)
    if recorded:
        if isinstance(seed, bool) or seed != cell.seed:
            mismatches["seed"] = {"cell": cell.seed, "job": seed}
    elif await _mode_takes_seed(session, cell, user, provenance.get("mode")):
        mismatches["seed"] = {"cell": cell.seed, "job": None}
    return mismatches


def _job_request(payload: dict[str, Any], idempotency_key: str | None = None) -> Request:
    body = json.dumps(payload, separators=(",", ":")).encode()
    delivered = False

    async def receive() -> dict[str, Any]:
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    headers = [(b"content-type", b"application/json")]
    if idempotency_key is not None:
        headers.append((b"idempotency-key", idempotency_key.encode()))
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
            "headers": headers,
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

    existing = (
        await session.execute(select(Job).where(Job.study_cell_id == cell.id))
    ).scalars().first()
    if existing is not None:
        cell.job_id = existing.id
        await session.flush()
        return existing

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
        problem = await v1._snapshot_problem(source, session)
    except (HTTPException, PackageError, RuntimeError) as exc:
        raise StudyLaunchError("invalid_case_revision", str(exc)) from exc

    # A project member may run a teammate's case. Persisting the same immutable
    # package for the actor keeps the existing owner-scoped snapshot contract.
    snapshot_id = await v1._persist_snapshot(package, problem, user, session)
    if snapshot_id is None:
        raise StudyLaunchError("snapshot_persistence_failed", "The BIM snapshot could not be persisted.")

    engine = dict(cell.engine_ref)
    requested_mode = engine.pop("mode", None)
    execution_optimization = engine.pop("optimization", None)
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
        "optimization": execution_optimization,
        "options": options,
    }
    # Deterministic, so launching a cell again is a replay and not a second job.
    # A retry detaches the previous job from the cell first; each earlier launch
    # leaves its key behind, and the next one gets a numbered key.
    key = f"study-cell:{cell.id}"
    earlier = await session.scalar(
        select(func.count()).select_from(Job).where(Job.idempotency_key.startswith(key, autoescape=True))
    )
    if earlier:
        key = f"{key}:{earlier}"
    created = _response_payload(
        await v1.create_job(_job_request(payload, key), caller=user, session=session)
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
    job.study_cell_id = cell.id
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
        run_obj = await session.get(StudyRun, cell.study_run_id)
        if run_obj and run_obj.state is not RunState.CANCELLED:
            queued_cell = (
                await session.execute(
                    select(StudyCell)
                    .where(
                        StudyCell.study_run_id == run_obj.id,
                        StudyCell.job_id.is_(None),
                        StudyCell.state == RunState.QUEUED,
                    )
                    .order_by(StudyCell.ordinal)
                    .limit(1)
                    .with_for_update(skip_locked=True)
                    .execution_options(populate_existing=True)
                )
            ).scalars().first()
            # populate_existing reloads the row as the lock saw it, so a launch
            # committed by another worker meanwhile shows up in job_id here
            # (SQLite ignores the lock).
            if queued_cell is not None and queued_cell.job_id is None:
                user = await session.get(User, run_obj.created_by_id)
                org = await session.get(Organization, job.organization_id)
                if user and org and job.project_id:
                    try:
                        await launch_study_cell(session, queued_cell, user, org, job.project_id)
                    except StudyLaunchError:
                        pass

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
        identity = (run.summary or {}).get("seedScenarioDigest")
        run.summary = aggregate_metrics([value.metrics for value in cells])
        if identity is not None:
            run.summary = {**run.summary, "seedScenarioDigest": identity}
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

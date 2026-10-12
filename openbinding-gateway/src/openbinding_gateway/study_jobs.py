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
from .jobs import lifecycle
from .jobs.leases import aware
from .services.engines import engine_mode, manifest_async
from .services.snapshots import persist_snapshot, snapshot_problem
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
        # SQLite hands timestamps back naive while a fresh one is aware.
        runtime = max(0.0, (aware(job.finished_at) - aware(job.created_at)).total_seconds())
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

    reference = cell.engine_ref
    try:
        manifest = await manifest_async(
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
    """Create one normal persisted job from an immutable study cell.

    The job is written with its ``study_cell_id`` and the cell's ``job_id`` is
    set in the caller's transaction, which is neither committed nor dispatched
    here. The caller must ``commit_launched`` (or commit and then
    ``dispatch_after_commit``); an existing job of the cell is returned as is.
    """

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
        problem = await snapshot_problem(source, session)
    except (HTTPException, PackageError, RuntimeError) as exc:
        raise StudyLaunchError("invalid_case_revision", str(exc)) from exc

    # A project member may run a teammate's case. Persisting the same immutable
    # package for the actor keeps the existing owner-scoped snapshot contract.
    snapshot_id = await persist_snapshot(package, problem, user, session)
    if snapshot_id is None:
        raise StudyLaunchError("snapshot_persistence_failed", "The BIM snapshot could not be persisted.")

    engine = dict(cell.engine_ref)
    requested_mode = engine.pop("mode", None)
    execution_optimization = engine.pop("optimization", None)
    try:
        _, selected_mode, _ = await engine_mode(
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
    # What keeps a cell to one job is the unique ``study_cell_id`` on the job,
    # written by the INSERT itself. The key only makes a replay of the first
    # launch cheap; a retry detaches the previous job from the cell but that
    # job keeps its key, so the replacement goes without one.
    key: str | None = f"{v1.STUDY_CELL_KEY_PREFIX}{cell.id}"
    held = await session.scalar(
        select(Job.id).where(Job.owner_id == user.id, Job.idempotency_key == key).limit(1)
    )
    if held is not None:
        key = None

    # The job and the cell's link to it live and die together: nothing is
    # committed here, so the locks the caller holds on the cell and the account
    # last until the cell points at its job. The caller commits and then
    # dispatches (``commit_launched``).
    pending = v1.pending_launches(session)
    before = set(pending)
    savepoint = await session.begin_nested()
    rejection: StudyLaunchError | None = None
    try:
        try:
            created = _response_payload(
                await v1._create_job_core(
                    _job_request(payload, key),
                    user,
                    session,
                    commit=False,
                    dispatch=False,
                    study_cell_id=cell.id,
                )
            )
        except StudyLaunchError as exc:
            # Refused before any job existed.
            rejection = exc
        else:
            try:
                job_id = uuid.UUID(str(created["id"]))
            except (KeyError, ValueError) as exc:
                raise StudyLaunchError(
                    "job_rejected", "The job pipeline returned an invalid identity."
                ) from exc
            job = await session.get(Job, job_id)
            if job is None:
                raise StudyLaunchError("job_not_persisted", "The study job was not persisted.")
            if job.study_cell_id != cell.id:
                raise StudyLaunchError("job_not_persisted", "The study job is not linked to its cell.")
            job.organization_id = organization.id
            job.project_id = project_id
            cell.job_id = job.id
            await session.flush()
            await _sync(session, job.id)
    except BaseException:
        try:
            if savepoint.is_active:
                await savepoint.rollback()
        finally:
            v1.discard_pending_launches(session, set(pending) - before)
        raise
    await savepoint.commit()
    if rejection is not None:
        raise rejection
    return job


async def dispatch_after_commit(session: AsyncSession) -> None:
    """Queue the jobs ``launch_study_cell`` created on this session.

    Call it only once the transaction that holds them is committed: a job
    dispatched earlier can finish, or be claimed by a worker, before its cell
    points at it. In inline mode the job runs on ``session``.
    """

    from .routes import v1

    pending = v1.pending_launches(session)
    job_ids = list(pending)
    pending.clear()
    for job_id in job_ids:
        await v1.dispatch_persisted_job(str(job_id), None if db_base.is_configured() else session)


async def commit_launched(session: AsyncSession) -> None:
    """Commit the session, then dispatch the jobs launched on it.

    If the commit fails the jobs do not exist, so they are forgotten.
    """

    from .routes import v1

    try:
        await session.commit()
    except BaseException:
        v1.discard_pending_launches(session)
        raise
    await dispatch_after_commit(session)


#: Launch failures that say "not now" rather than "never": the cell stays queued.
RETRYABLE_LAUNCH_CODES = frozenset({"concurrency_limit_exceeded", "pricing_unavailable"})


def fail_cell(cell: StudyCell, error: StudyLaunchError) -> None:
    """Record that a cell can never be launched, so the cells after it are not held up."""

    cell.state = RunState.FAILED
    cell.metrics = {
        "status": "failed",
        "feasible": False,
        "code": error.code,
        "detail": error.detail,
        "engine": (
            f"{cell.engine_ref.get('namespace')}/{cell.engine_ref.get('name')}"
            f"@{cell.engine_ref.get('version')}"
        ),
        "seed": cell.seed,
    }


async def lock_run(session: AsyncSession, run_id: uuid.UUID) -> StudyRun | None:
    """Row-lock a study run and reload it as the lock saw it.

    Everything that moves a run or launches one of its cells takes this lock
    first, then the locks of the cells (``lock_cells``), then those of the jobs,
    so that two of them cannot wait for each other. The lock is held until the
    transaction ends. SQLite ignores it.
    """

    return (
        await session.execute(
            select(StudyRun)
            .where(StudyRun.id == run_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalars().first()


async def lock_cells(session: AsyncSession, run_id: uuid.UUID) -> list[StudyCell]:
    """Row-lock every cell of a run, in ordinal order, reloaded as the lock saw them."""

    return list(
        (
            await session.execute(
                select(StudyCell)
                .where(StudyCell.study_run_id == run_id)
                .order_by(StudyCell.ordinal)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalars().all()
    )


class StudyRunTerminal(RuntimeError):
    """The run is already completed or cancelled."""


async def cancel_run(session: AsyncSession, run_id: uuid.UUID) -> tuple[StudyRun, list[StudyCell]]:
    """Cancel a run, its cells and the jobs behind them. Nothing is committed.

    The run is locked first, then its cells, then their jobs: the order every
    writer of a run follows. A ``_sync`` launching the next cell holds the run
    lock until it commits, so either it finishes first and the cell it launched
    is cancelled here, or it waits for this transaction and finds the run
    cancelled, and launches nothing. Raises ``LookupError`` for a run that does
    not exist and ``StudyRunTerminal`` for one that is completed or cancelled.
    """

    run = await lock_run(session, run_id)
    if run is None:
        raise LookupError(f"Study run {run_id} not found.")
    if run.state in {RunState.COMPLETED, RunState.CANCELLED}:
        raise StudyRunTerminal(str(run_id))
    run.state = RunState.CANCELLED
    run.finished_at = utcnow()
    cells = await lock_cells(session, run.id)
    for cell in cells:
        # Locked like cancel_job: a worker finishing the job must not be overwritten.
        # A finished job never changes again, so only a live one is worth a lock.
        job = None
        if cell.job_id and await session.scalar(
            select(Job.state).where(Job.id == cell.job_id)
        ) not in lifecycle.TERMINAL_STATES:
            job = (
                await session.execute(
                    select(Job)
                    .where(Job.id == cell.job_id)
                    .with_for_update()
                    .execution_options(populate_existing=True)
                )
            ).scalars().first()
        if job is not None and job.state not in lifecycle.TERMINAL_STATES:
            # A running job is left to its worker, which sees the request and stops at its lease.
            await lifecycle.request_cancellation(session, job, sync_cell=False)
        if cell.state in {RunState.QUEUED, RunState.RUNNING}:
            cell.state = RunState.CANCELLED
    await session.flush()
    return run, cells


async def _sync(session: AsyncSession, job_id: uuid.UUID) -> None:
    job = await session.get(Job, job_id)
    if job is None:
        return
    run_id = await session.scalar(select(StudyCell.study_run_id).where(StudyCell.job_id == job.id))
    if run_id is None:
        return
    # The run first, then its cells: a cancellation or a retry holds the same
    # locks in the same order, so once we have them the run's state and the
    # cells' links are the committed ones. A cancelled run launches nothing, and
    # the aggregate below cannot overwrite a concurrent writer.
    run = await lock_run(session, run_id)
    if run is None:
        return
    cells = await lock_cells(session, run.id)
    cell = next((value for value in cells if value.job_id == job.id), None)
    if cell is None:
        return  # the cell was retried meanwhile and no longer points at this job
    state_map = {
        JobState.QUEUED: RunState.QUEUED,
        JobState.RUNNING: RunState.RUNNING,
        JobState.COMPLETED: RunState.COMPLETED,
        JobState.FAILED: RunState.FAILED,
        JobState.CANCELLED: RunState.CANCELLED,
    }
    if (
        run.state is RunState.CANCELLED
        and cell.state is RunState.CANCELLED
        and job.state is JobState.FAILED
    ):
        # cancel_run already cancelled this cell; the job it was waiting on ended
        # abandoned (swept) before its worker saw the request. It stays cancelled.
        await session.flush()
        return
    cell.state = state_map[job.state]
    if job.state in {JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED}:
        cell.metrics = metrics_from_job(job, cell)
        if run.state is not RunState.CANCELLED:
            user = await session.get(User, run.created_by_id)
            org = await session.get(Organization, job.organization_id)
            # A cell that can never launch is failed and the next one is tried,
            # so it cannot hold up the cells behind it. The cells were locked
            # and reloaded above, so a launch committed by another worker
            # meanwhile shows up in job_id here.
            if user and org and job.project_id:
                for queued_cell in cells:
                    if queued_cell.job_id is not None or queued_cell.state is not RunState.QUEUED:
                        continue
                    try:
                        # The launch commits nothing: the caller commits, then dispatches.
                        await launch_study_cell(session, queued_cell, user, org, job.project_id)
                    except StudyLaunchError as exc:
                        if exc.code in RETRYABLE_LAUNCH_CODES:
                            break  # stays queued; a later transition launches it
                        fail_cell(queued_cell, exc)
                        await session.flush()
                        continue
                    break

    if run.state is RunState.CANCELLED:
        await session.flush()
        return
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

    from .routes import v1

    parsed = uuid.UUID(job_id)
    if session is not None:
        try:
            await _sync(session, parsed)
        except BaseException:
            v1.discard_pending_launches(session)
            raise
        if v1.pending_launches(session):
            # A cell was launched: commit it with its link, and only then queue it.
            await commit_launched(session)
        return
    if not db_base.is_configured():
        raise RuntimeError("Study job synchronization requires an initialized database.")
    async with db_base.session_factory()() as owned:
        try:
            await _sync(owned, parsed)
        except BaseException:
            v1.discard_pending_launches(owned)
            raise
        await commit_launched(owned)

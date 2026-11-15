"""Comparative studies of an organization.

A study keeps its editable matrix inline (``studies.definition``). Each study run freezes a copy of it,
with the compilation every problem revision runs on, so editing the study never changes a run (D7).
"""

from __future__ import annotations

import uuid
import math
from collections.abc import Mapping

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, session_dependency
from ..collaboration import organization_by_ref, require_role
from ..core import revision
from ..core.settings import get_settings
from ..modules.plans.application import entitlement_map as ids
from ..db.models import (
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    Job,
    ProblemCompilation,
    JobState,
    Organization,
    OrganizationRole,
    RunState,
    Study,
    StudyCell,
    StudyRun,
    StudyState,
    User,
    utcnow,
)
from ..models.errors import ErrorResponse, api_error
from ..models.platform import (
    AnalyticsView,
    StudyCellResult,
    StudyCellView,
    StudyCreate,
    StudyDefinition,
    StudyRunView,
    StudyUpdate,
    StudyView,
)
from ..modules.problems.application import ir_analysis
from ..services.entitlements import EntitlementService, get_entitlements
from ..security.apikeys import ENGINE_REF_FIELDS, allows_engine
from ..services.engines import engine_mode
from ..study_jobs import (
    RETRYABLE_LAUNCH_CODES,
    StudyLaunchError,
    StudyRunTerminal,
    cancel_run,
    cell_job_mismatches,
    commit_launched,
    create_study_run,
    fail_cell,
    launch_study_cell,
    lock_run,
    metrics_from_job,
)
from ..studies import aggregate_metrics, pareto_fronts
from bim_core.canonical import digest

router = APIRouter(prefix="/v1/organizations/{org}", tags=["Studies"])


def _audit(session: AsyncSession, user: User, action: str, target, organization_id, **detail) -> None:
    session.add(AuditEvent(
        organization_id=organization_id, actor_id=user.id, action=action,
        target_type=target.__class__.__name__, target_id=getattr(target, "id", None), detail=detail,
    ))


async def _organization(
    session: AsyncSession, org: str, user: User, minimum: OrganizationRole
) -> Organization:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    await require_role(session, organization, user, minimum)
    return organization


def _study_cell_limit(caps) -> tuple[int, str] | None:
    """The cells one study run may expand to, and which limit sets it (``plan`` or ``technical``).

    The lower of the plan's ``maxStudyCells`` and ``MAX_CELLS_PER_STUDY_RUN``; the
    technical cap wins a tie. ``None`` when neither limits it.
    """
    plan = caps.limit(ids.MAX_STUDY_CELLS)
    technical = get_settings().max_cells_per_study_run
    if plan is not None and (technical is None or int(plan) < technical):
        return int(plan), "plan"
    if technical is not None:
        return technical, "technical"
    return None


def _allows_study_engine(user: User, engine: Mapping) -> bool:
    """Whether the caller may use the exact Engine revision a study engine pins.

    A study engine also carries its ``mode`` and ``optimization``; an API key grants revisions, so
    only the identity fields are checked.
    """
    return allows_engine(user, {field: engine[field] for field in ENGINE_REF_FIELDS if field in engine})


def _study_engines_allowed(user: User, definition: Mapping) -> bool:
    engines = definition.get("engines")
    return isinstance(engines, list) and bool(engines) and all(
        isinstance(engine, Mapping) and _allows_study_engine(user, engine) for engine in engines
    )


def _forbidden_engines(subject: str) -> Exception:
    return api_error(
        status.HTTP_403_FORBIDDEN,
        "api_key_engine_forbidden",
        f"This API key does not grant every exact Engine revision pinned by {subject}.",
    )


async def _study(
    session: AsyncSession, organization_id: uuid.UUID, reference: str, user: User, *, check_engines: bool = True
) -> Study:
    try:
        parsed = uuid.UUID(reference)
    except ValueError:
        parsed = None
    found = (await session.execute(select(Study).where(
        Study.organization_id == organization_id,
        Study.id == parsed if parsed else Study.slug == reference,
    ))).scalars().first()
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Study not found.")
    if check_engines and not _study_engines_allowed(user, found.definition):
        raise _forbidden_engines("the study")
    return found


def _study_view(value: Study) -> StudyView:
    return StudyView(
        id=value.id, organization_id=value.organization_id, slug=value.slug, name=value.name,
        description=value.description, definition=value.definition, definition_digest=value.definition_digest,
        state=value.state.value, archived=value.archived, created_by_id=value.created_by_id,
        created_at=value.created_at,
    )


async def _definition(
    session: AsyncSession, organization: Organization, user: User, definition: StudyDefinition
) -> dict:
    """The stored form of a study definition: revisions of ``organization``, engines with resolved mode ids.

    Checked when it is written (create or edit), so a study holds only matrices that could run when
    they were saved; each run checks its revisions again and pins their compilations.
    """
    if not all(_allows_study_engine(user, engine) for engine in definition.engines):
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "api_key_engine_forbidden",
            "This API key does not grant every exact Engine revision requested by the study.",
        )
    revision_ids = set(definition.revision_ids)
    belonging = set((await session.execute(
        select(BindingCaseRevision.id).join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
        .where(BindingCase.organization_id == organization.id, BindingCaseRevision.id.in_(revision_ids))
    )).scalars().all())
    if not revision_ids <= belonging:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "foreign_case_revision",
            "Every study revision must be a problem revision of this organization.",
        )
    cell_count = len(revision_ids) * len(definition.engines) * len(definition.parameter_sets) * len(definition.seeds)
    if len(revision_ids) > 250 or cell_count > 10_000:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "study_matrix_too_large",
            "A study may pin at most 250 problem revisions and expand to at most 10,000 cells.",
        )
    engines = []
    for engine in definition.engines:
        _, mode, _ = await engine_mode(
            engine["name"], engine.get("mode"), definition.parameter_sets[0], session, caller=user,
            namespace=engine["namespace"], version=engine["version"], manifest_digest=engine["digest"],
        )
        engines.append({**engine, "mode": mode["id"]})
    return {
        **definition.model_dump(mode="json"),
        "revision_ids": [str(value) for value in sorted(revision_ids, key=str)],
        "engines": engines,
    }


@router.get("/studies", response_model=list[StudyView], operation_id="listStudies")
async def list_studies(
    org: str, include_archived: bool = False,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[StudyView]:
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    rows = (await session.execute(
        select(Study).where(Study.organization_id == organization.id).order_by(Study.name)
    )).scalars().all()
    return [_study_view(row) for row in rows if (include_archived or not row.archived) and _study_engines_allowed(user, row.definition)]


@router.post("/studies", response_model=StudyView, status_code=201, operation_id="createStudy")
async def create_study(
    org: str, payload: StudyCreate, response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyView:
    organization = await _organization(session, org, user, OrganizationRole.MEMBER)
    definition = await _definition(session, organization, user, payload.definition)
    duplicate = await session.scalar(select(func.count(Study.id)).where(
        Study.organization_id == organization.id, Study.slug == payload.slug
    ))
    if duplicate:
        raise api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That study slug is in use.")
    value = Study(
        organization_id=organization.id, slug=payload.slug, name=payload.name, description=payload.description,
        definition=definition, definition_digest=digest(definition), state=StudyState.READY, created_by_id=user.id,
    )
    session.add(value)
    await session.flush()
    await session.refresh(value, ["updated_at"])
    revision.set_etag(response, value)
    _audit(session, user, "study.created", value, organization.id)
    return _study_view(value)


@router.get(
    "/studies/{study}", response_model=StudyView, operation_id="getStudy",
    responses=revision.ETAG_RESPONSE,
)
async def get_study(
    org: str, study: str, response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyView:
    # The ETag is the revision an edit names in If-Match.
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found = await _study(session, organization.id, study, user)
    revision.set_etag(response, found)
    return _study_view(found)


@router.patch(
    "/studies/{study}", response_model=StudyView, operation_id="updateStudy",
    responses=revision.EDIT_RESPONSES,
)
async def update_study(
    org: str, study: str, payload: StudyUpdate, response: Response,
    if_match: str | None = revision.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyView:
    # The definition can be edited at any time: every run keeps the copy it froze.
    organization = await _organization(session, org, user, OrganizationRole.MEMBER)
    found = await _study(session, organization.id, study, user)
    await revision.guard(session, found, if_match)
    if payload.definition is not None:
        definition = await _definition(session, organization, user, payload.definition)
        found.definition = definition
        found.definition_digest = digest(definition)
    if payload.archived is not None:
        found.archived = payload.archived
    if payload.name is not None:
        found.name = payload.name
    if payload.description is not None:
        found.description = payload.description
    await session.flush()
    await session.refresh(found, ["updated_at"])
    revision.set_etag(response, found)
    _audit(session, user, "study.updated", found, organization.id)
    return _study_view(found)


@router.delete("/studies/{study}", status_code=status.HTTP_204_NO_CONTENT, operation_id="deleteStudy")
async def delete_study(
    org: str, study: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    organization = await _organization(session, org, user, OrganizationRole.ADMIN)
    found = await _study(session, organization.id, study, user)
    if await session.scalar(select(StudyRun.id).where(StudyRun.study_id == found.id).limit(1)) is not None:
        raise api_error(409, 'study_history_retained', 'Set archived=true for a study with executions; historical runs cannot be deleted.')
    _audit(session, user, "study.deleted", found, organization.id)
    await session.delete(found)
    await session.flush()


@router.post("/studies/{study}/runs", response_model=StudyRunView, status_code=202, operation_id="runStudy")
async def run_study(
    org: str, study: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    plans: EntitlementService = Depends(get_entitlements),
) -> StudyRunView:
    # Freeze the study's current definition into a new run, then launch its cells one by one, each
    # committed before it is queued.
    #
    # Every distinct revision is compiled (or its compilation found) once, before the run exists, and
    # the run pins those compilations: the frozen definition names them and each cell carries one, so
    # a toolchain release while the cells launch does not mix IRs within the run (D7).
    #
    # A retryable refusal (``RETRYABLE_LAUNCH_CODES``: concurrency limit,
    # pricing unavailable) stops the loop and leaves the remaining cells queued for
    # ``study_jobs._sync`` to launch as the earlier jobs finish. When the very
    # first cell is refused there is no job whose end would trigger that, so the
    # run stays queued with nothing running until the reconciler advances it.
    # (A comment, not a docstring: a docstring would become the OpenAPI description.)
    organization = await _organization(session, org, user, OrganizationRole.MEMBER)
    found = await _study(session, organization.id, study, user)
    if found.archived:
        raise api_error(409, 'study_archived', 'Restore this study before starting another run.')
    caps = await plans.caps_or_503(user.id)
    plans.require_feature(caps, ids.STUDIES, detail="The current plan does not entitle studies.")
    definition = StudyDefinition.model_validate(found.definition)
    cell_count = len(definition.revision_ids) * len(definition.engines) * len(definition.parameter_sets) * len(definition.seeds)
    # Before the run, its cells or any job exist: a run past the cell limit or with a problem above the
    # size limit is refused whole.
    cell_limit = _study_cell_limit(caps)
    if cell_limit is not None and cell_count > cell_limit[0]:
        limit, source = cell_limit
        raise api_error(
            422,
            "study_run_too_large",
            (
                "Your plan limits how many cells one study run may expand to; reduce the matrix."
                if source == "plan"
                else "This deployment limits how many cells one study run may expand to; reduce the matrix."
            ),
            quota={
                "limit_id": ids.MAX_STUDY_CELLS, "state": "exhausted", "unit": "cell",
                "source": source, "limit": limit, "used": cell_count,
            },
        )
    run, cells = await create_study_run(session, found, organization, user)
    _audit(session, user, "study.run.created", run, organization.id,
           matrixDigest=run.matrix_digest, definitionDigest=run.definition_digest)
    for cell in cells:
        try:
            await launch_study_cell(session, cell, user, organization)
            # The cell now points at its job; only a committed job is queued.
            await commit_launched(session)
        except StudyLaunchError as exc:
            if exc.code in RETRYABLE_LAUNCH_CODES:
                # Limit reached; leave remaining cells queued to be picked up by _sync.
                cell.state = RunState.QUEUED
                break
            fail_cell(cell, exc)
    terminal = {RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED}
    if all(cell.state in terminal for cell in cells):
        run.state = (
            RunState.COMPLETED
            if all(cell.state is RunState.COMPLETED for cell in cells)
            else RunState.PARTIAL
        )
        run.finished_at = utcnow()
        run.summary = aggregate_metrics([cell.metrics for cell in cells])
    return _view(run, len(cells))


async def _run(session: AsyncSession, study_id: uuid.UUID, run_id: uuid.UUID, user: User) -> StudyRun:
    found = (await session.execute(select(StudyRun).where(StudyRun.id == run_id, StudyRun.study_id == study_id))).scalars().first()
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Study run not found.")
    if not _study_engines_allowed(user, found.definition):
        raise _forbidden_engines("this run")
    return found


def _view(run: StudyRun, cells: int) -> StudyRunView:
    return StudyRunView(
        id=run.id, study_id=run.study_id, run_number=run.run_number, state=run.state.value,
        matrix_digest=run.matrix_digest, definition=run.definition, definition_digest=run.definition_digest,
        cells=cells, summary=run.summary, created_at=run.created_at, finished_at=run.finished_at,
    )


async def _run_view(session: AsyncSession, run: StudyRun) -> StudyRunView:
    cells = int(await session.scalar(
        select(func.count(StudyCell.id)).where(StudyCell.study_run_id == run.id)
    ) or 0)
    return _view(run, cells)


def _cell_view(cell: StudyCell) -> StudyCellView:
    return StudyCellView(
        id=cell.id, study_run_id=cell.study_run_id, ordinal=cell.ordinal,
        binding_case_revision_id=cell.binding_case_revision_id, compilation_id=cell.compilation_id,
        engine_ref=cell.engine_ref, parameters=cell.parameters, seed=cell.seed,
        fingerprint=cell.fingerprint, job_id=cell.job_id, state=cell.state.value,
        metrics=cell.metrics,
    )


@router.get("/studies/{study}/runs", response_model=list[StudyRunView], operation_id="listStudyRuns")
async def list_study_runs(
    org: str, study: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[StudyRunView]:
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found_study = await _study(session, organization.id, study, user, check_engines=False)
    rows = (await session.execute(
        select(StudyRun).where(StudyRun.study_id == found_study.id).order_by(StudyRun.run_number.desc())
    )).scalars().all()
    return [await _run_view(session, row) for row in rows if _study_engines_allowed(user, row.definition)]


@router.get("/studies/{study}/runs/{run_id}", response_model=StudyRunView, operation_id="getStudyRun")
async def get_study_run(
    org: str, study: str, run_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyRunView:
    # The run with the definition it froze and that definition's digest.
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found_study = await _study(session, organization.id, study, user, check_engines=False)
    return await _run_view(session, await _run(session, found_study.id, run_id, user))


@router.get(
    "/studies/{study}/runs/{run_id}/cells",
    response_model=list[StudyCellView],
    operation_id="listStudyCells",
)
async def list_study_cells(
    org: str, study: str, run_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[StudyCellView]:
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found_study = await _study(session, organization.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    cells = (await session.execute(
        select(StudyCell).where(StudyCell.study_run_id == run.id).order_by(StudyCell.ordinal)
    )).scalars().all()
    return [_cell_view(cell) for cell in cells]


@router.get(
    "/studies/{study}/runs/{run_id}/cells/{cell_id}",
    response_model=StudyCellView,
    operation_id="getStudyCell",
)
async def get_study_cell(
    org: str, study: str, run_id: uuid.UUID, cell_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyCellView:
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found_study = await _study(session, organization.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    cell = (await session.execute(
        select(StudyCell).where(StudyCell.id == cell_id, StudyCell.study_run_id == run.id)
    )).scalars().first()
    if cell is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Study cell not found.")
    return _cell_view(cell)


@router.post("/studies/{study}/runs/{run_id}/cancel", response_model=StudyRunView, operation_id="cancelStudyRun")
async def cancel_study_run(
    org: str, study: str, run_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyRunView:
    organization = await _organization(session, org, user, OrganizationRole.MEMBER)
    found_study = await _study(session, organization.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    try:
        run, cells = await cancel_run(session, run.id)
    except LookupError as exc:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Study run not found.") from exc
    except StudyRunTerminal as exc:
        raise api_error(status.HTTP_409_CONFLICT, "terminal_run", "The study run is already terminal.") from exc
    _audit(session, user, "study.run.cancelled", run, organization.id)
    return _view(run, len(cells))


@router.post(
    "/studies/{study}/runs/{run_id}/cells/{cell_id}/result",
    operation_id="attachStudyCellResult",
    responses={
        409: {
            "model": ErrorResponse,
            "description": (
                "The job is not finished (`job_not_finished`) or completed without a result "
                "(`job_result_missing`); "
                "the job is already the result of another cell (`job_already_attached`); or the job "
                "is not an execution of this cell (`cell_job_mismatch`): its `fields` list names "
                "each of `case_revision`, `compilation` (the compilation the run pinned for the "
                "revision), `engine`, `mode` and `seed` that differ, and `details` gives the `cell` "
                "and `job` values."
            ),
        }
    },
)
async def attach_cell_result(
    org: str, study: str, run_id: uuid.UUID, cell_id: uuid.UUID,
    payload: StudyCellResult,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    # Any finished run of the study's organization can be attached, whoever launched it (D10).
    organization = await _organization(session, org, user, OrganizationRole.MEMBER)
    found_study = await _study(session, organization.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    # It rewrites the run's aggregate like _sync does, so it takes the same locks.
    run = await lock_run(session, run.id) or run
    cell = (
        await session.execute(
            select(StudyCell)
            .where(StudyCell.id == cell_id, StudyCell.study_run_id == run.id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )
    ).scalars().first()
    job = await session.get(Job, payload.job_id)
    if cell is None or job is None or job.organization_id != organization.id:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Cell or job not found.")
    if job.state not in {JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED}:
        raise api_error(status.HTTP_409_CONFLICT, "job_not_finished", "Attach a terminal job result.")
    if job.state is JobState.COMPLETED and not isinstance(job.result, dict):
        raise api_error(status.HTTP_409_CONFLICT, "job_result_missing", "The completed job has no result to attach.")
    mismatches = await cell_job_mismatches(session, cell, job, user)
    if mismatches:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "cell_job_mismatch",
            "The job is not an execution of this cell: " + ", ".join(sorted(mismatches)) + " differ.",
            fields=sorted(mismatches),
            details=mismatches,
        )
    other = await session.scalar(
        select(StudyCell.id).where(StudyCell.job_id == job.id, StudyCell.id != cell.id).limit(1)
    )
    if other is not None:
        raise api_error(status.HTTP_409_CONFLICT, "job_already_attached", "The job is already the result of another cell.")
    cell.job_id = job.id
    cell.metrics = metrics_from_job(job, cell)
    cell.state = RunState.COMPLETED if job.state is JobState.COMPLETED else RunState.FAILED
    cells = (await session.execute(select(StudyCell).where(StudyCell.study_run_id == run.id))).scalars().all()
    terminal = {RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED}
    if all(value.state in terminal for value in cells):
        run.state = RunState.COMPLETED if all(value.state is RunState.COMPLETED for value in cells) else RunState.PARTIAL
        run.finished_at = utcnow()
        run.summary = aggregate_metrics([value.metrics for value in cells])
    _audit(session, user, "study.cell.result.attached", cell, organization.id, jobId=str(job.id))
    return {"id": str(cell.id), "state": cell.state.value, "metrics": cell.metrics}


@router.post("/studies/{study}/runs/{run_id}/cells/{cell_id}/retry", operation_id="retryStudyCell")
async def retry_study_cell(
    org: str, study: str, run_id: uuid.UUID, cell_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    organization = await _organization(session, org, user, OrganizationRole.MEMBER)
    found_study = await _study(session, organization.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    # Run first, then the cell, as cancel and _sync do. A second retry of the same
    # cell waits here and then finds the replacement the first one launched: it is
    # answered with that job and ``idempotent: true`` (200), not refused with a 409.
    run = await lock_run(session, run.id)
    cell = (
        await session.execute(
            select(StudyCell)
            .where(StudyCell.id == cell_id, StudyCell.study_run_id == run.id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )
    ).scalars().first() if run is not None else None
    if cell is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Study cell not found.")
    current_job = (
        (
            await session.execute(
                select(Job).where(Job.id == cell.job_id).execution_options(populate_existing=True)
            )
        ).scalars().first()
        if cell.job_id
        else None
    )
    if (
        current_job is not None
        and current_job.retry_of_id is not None
        and cell.state not in {RunState.FAILED, RunState.CANCELLED}
    ):
        return {
            "id": str(cell.id),
            "state": cell.state.value,
            "fingerprint": cell.fingerprint,
            "jobId": str(current_job.id),
            "idempotent": True,
        }
    if cell.state not in {RunState.FAILED, RunState.CANCELLED}:
        raise api_error(status.HTTP_409_CONFLICT, "cell_not_retryable", "Only failed or cancelled cells may be retried.")
    previous_job_id = cell.job_id
    cell.state = RunState.QUEUED
    cell.job_id = None
    if current_job is not None:
        # One job per cell: the superseded job gives up its claim on the cell.
        current_job.study_cell_id = None
        await session.flush()
    cell.metrics = {}
    run.state = RunState.QUEUED
    run.finished_at = None
    try:
        replacement = await launch_study_cell(session, cell, user, organization)
    except StudyLaunchError as exc:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, exc.code, exc.detail) from exc
    replacement.retry_of_id = previous_job_id
    _audit(session, user, "study.cell.retried", cell, organization.id)
    # Commit the replacement with its link to the cell, and only then queue it.
    await commit_launched(session)
    return {
        "id": str(cell.id),
        "state": cell.state.value,
        "fingerprint": cell.fingerprint,
        "jobId": str(replacement.id),
        "idempotent": False,
    }


@router.get("/studies/{study}/runs/{run_id}/analytics", response_model=AnalyticsView, operation_id="getStudyAnalytics")
async def get_study_analytics(
    org: str, study: str, run_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> AnalyticsView:
    organization = await _organization(session, org, user, OrganizationRole.VIEWER)
    found_study = await _study(session, organization.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    cells = (await session.execute(select(StudyCell).where(StudyCell.study_run_id == run.id).order_by(StudyCell.ordinal))).scalars().all()
    metrics_data = aggregate_metrics([cell.metrics for cell in cells])
    revisions = list(dict.fromkeys(cell.binding_case_revision_id for cell in cells))
    named = (await session.execute(
        select(BindingCaseRevision.id, BindingCaseRevision.revision, BindingCase.slug)
        .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
        .where(BindingCaseRevision.id.in_(revisions))
    )).all() if revisions else []
    pareto = pareto_fronts(
        [
            {"cellId": cell.id, "jobId": cell.job_id, "revisionId": cell.binding_case_revision_id, "metrics": cell.metrics}
            for cell in cells
        ],
        {str(row.id): {"slug": row.slug, "revision": row.revision} for row in named},
    )

    # The binding space of each problem as the compilation the run pinned reads it.
    compilation_ids = list(dict.fromkeys(cell.compilation_id for cell in cells))
    binding_space_info = None
    if compilation_ids:
        rows = (await session.execute(
            select(ProblemCompilation, BindingCaseRevision, BindingCase)
            .join(BindingCaseRevision, BindingCaseRevision.id == ProblemCompilation.revision_id)
            .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
            .where(ProblemCompilation.id.in_(compilation_ids))
        )).all()
        order = {compilation_id: position for position, compilation_id in enumerate(compilation_ids)}
        rows = sorted(rows, key=lambda row: order[row[0].id])
        cases_detail = []
        total_cardinality = 1
        has_cardinality = False
        all_breakdowns = {}
        for compilation, rev, case in rows:
            analysis = compilation.analysis if "bindingSpaceBreakdown" in (compilation.analysis or {}) else ir_analysis(compilation.ir)
            breakdown = dict(analysis.get("bindingSpaceBreakdown") or {})
            if not breakdown:
                continue
            cardinality = 1
            for count in breakdown.values():
                cardinality *= int(count)
            has_cardinality = True
            total_cardinality = max(total_cardinality, cardinality)
            all_breakdowns.update(breakdown)
            log10_val = math.log10(cardinality) if cardinality > 0 else 0.0
            cases_detail.append({
                "id": str(case.id),
                "slug": case.slug,
                "name": case.name,
                "revision": rev.revision,
                "cardinality": str(cardinality),
                "log10": round(log10_val, 2),
                "tasks": len(breakdown),
                "breakdown": breakdown,
            })

        if has_cardinality:
            log10_total = math.log10(total_cardinality) if total_cardinality > 0 else 0.0
            primary_case = cases_detail[0] if cases_detail else None
            binding_space_info = {
                "cardinality": str(total_cardinality),
                "log10": round(log10_total, 2),
                "tasks": len(all_breakdowns),
                "breakdown": all_breakdowns,
                "case_slug": primary_case["slug"] if primary_case else None,
                "case_name": primary_case["name"] if primary_case else None,
                "revision": primary_case["revision"] if primary_case else None,
                "cases": cases_detail,
            }

    return AnalyticsView(**metrics_data, pareto=pareto, binding_space=binding_space_info)

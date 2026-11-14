"""Comparative studies."""

from __future__ import annotations

import uuid
import math
from collections.abc import Mapping

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, session_dependency
from ..collaboration import enforce_sponsor_capacity, organization_by_ref, require_project
from ..core import revision
from ..core.settings import get_settings
from ..domain import usage_counters
from ..db.models import (
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    BindingIRSnapshot,
    Job,
    JobState,
    Organization,
    OrganizationRole,
    Project,
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
    StudyRunView,
    StudyUpdate,
    StudyView,
)
from ..services.entitlements import EntitlementService, get_entitlements
from ..security.apikeys import allows_engine
from ..study_jobs import (
    RETRYABLE_LAUNCH_CODES,
    StudyLaunchError,
    StudyRunTerminal,
    cancel_run,
    cell_job_mismatches,
    commit_launched,
    fail_cell,
    launch_study_cell,
    lock_run,
    metrics_from_job,
    study_binding_space_refusal,
)
from ..studies import aggregate_metrics, expand_study
from bim_core.canonical import digest

router = APIRouter(prefix="/v1/organizations/{org}/projects/{project}", tags=["Studies"])


def _audit(session: AsyncSession, user: User, action: str, target, organization_id, **detail) -> None:
    session.add(AuditEvent(
        organization_id=organization_id, actor_id=user.id, action=action,
        target_type=target.__class__.__name__, target_id=getattr(target, "id", None), detail=detail,
    ))


async def _context(
    session: AsyncSession, org: str, project: str, user: User, minimum: OrganizationRole
) -> tuple[Organization, Project]:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    found_project = await require_project(session, organization, project, user, minimum)
    return organization, found_project


def _study_engines_allowed(user: User, definition: Mapping) -> bool:
    engines = definition.get("engines")
    return isinstance(engines, list) and bool(engines) and all(
        isinstance(engine, Mapping) and allows_engine(user, engine) for engine in engines
    )


async def _study(
    session: AsyncSession, project_id: uuid.UUID, reference: str, user: User, *, check_engines: bool = True
) -> Study:
    try:
        parsed = uuid.UUID(reference)
    except ValueError:
        parsed = None
    found = (await session.execute(select(Study).where(
        Study.project_id == project_id,
        Study.id == parsed if parsed else Study.slug == reference,
    ))).scalars().first()
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Study not found.")
    if check_engines and not _study_engines_allowed(user, found.definition):
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "api_key_engine_forbidden",
            "This API key does not grant every exact Engine revision pinned by the study.",
        )
    return found


def _study_view(value: Study) -> StudyView:
    return StudyView(
        id=value.id, definition_artifact_id=value.definition_version.artifact_id, definition_version_id=value.definition_version_id, project_id=value.project_id, slug=value.slug, name=value.name,
        description=value.description, definition=value.definition, state=value.state.value, archived=value.archived,
        created_by_id=value.created_by_id, created_at=value.created_at,
    )


@router.get("/studies", response_model=list[StudyView], operation_id="listStudies")
async def list_studies(
    org: str, project: str, include_archived: bool = False,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[StudyView]:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    rows = (await session.execute(select(Study).where(Study.project_id == found_project.id).order_by(Study.name))).scalars().all()
    return [_study_view(row) for row in rows if (include_archived or not row.archived) and _study_engines_allowed(user, row.definition)]


@router.post("/studies", response_model=StudyView, status_code=201, operation_id="createStudy")
async def create_study(
    org: str, project: str, payload: StudyCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    if payload.definition_version_id is not None:
        from ..artifacts import reference, resolve_version
        from ..db.models import Artifact, ArtifactVersion, ProjectArtifact
        from ..studies import definition_from_version
        version = await session.get(ArtifactVersion, payload.definition_version_id)
        if version is None:
            raise api_error(404, 'not_found', 'Study definition version not found.')
        artifact = await session.get(Artifact, version.artifact_id)
        await resolve_version(session, reference(artifact, version), user)
        if artifact.kind != 'Study':
            raise api_error(422, 'invalid_study_version', 'Select an executable Study definition.')
        if not _study_engines_allowed(user, definition_from_version(version)):
            raise api_error(403, 'api_key_engine_forbidden', 'This key does not grant the Engines pinned by the selected version.')
        sponsor = await session.get(User, organization.billing_sponsor_user_id)
        await enforce_sponsor_capacity(session, sponsor, 'studies')
        if await session.scalar(select(Study.id).where(Study.project_id == found_project.id, Study.slug == payload.slug)):
            raise api_error(409, 'slug_conflict', 'That study slug is in use.')
        value = Study(project_id=found_project.id, slug=payload.slug, name=payload.name,
                      description=payload.description, definition_version=version,
                      state=StudyState.READY, created_by_id=user.id)
        session.add(value)
        if await session.get(ProjectArtifact, (found_project.id, artifact.id)) is None:
            session.add(ProjectArtifact(project_id=found_project.id, artifact_id=artifact.id))
        await session.flush()
        _audit(session, user, 'study.created', value, organization.id)
        return _study_view(value)
    assert payload.definition is not None
    if not all(allows_engine(user, engine) for engine in payload.definition.engines):
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "api_key_engine_forbidden",
            "This API key does not grant every exact Engine revision requested by the study.",
        )
    sponsor = await session.get(User, organization.billing_sponsor_user_id)
    await enforce_sponsor_capacity(session, sponsor, "studies")
    revision_ids = set(payload.definition.case_revision_ids)
    if not revision_ids:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "empty_study_cases",
            "The study must contain at least one case revision.",
        )
    belonging = set((await session.execute(
        select(BindingCaseRevision.id).join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
        .join(Project, Project.id == BindingCase.project_id).where(Project.organization_id == organization.id)
    )).scalars().all())
    if not revision_ids <= belonging:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "foreign_case_revision", "Every study case revision must belong to this organization.")
    cell_count = (
        len(revision_ids)
        * len(payload.definition.engines)
        * len(payload.definition.parameter_sets)
        * len(payload.definition.seeds)
    )
    if len(revision_ids) > 250 or cell_count > 10_000:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "study_matrix_too_large",
            "A study may pin at most 250 cases and expand to at most 10,000 cells.",
        )
    duplicate = await session.scalar(select(func.count(Study.id)).where(Study.project_id == found_project.id, Study.slug == payload.slug))
    if duplicate:
        raise api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That study slug is in use.")
    from ..studies import seal_study_definition
    value = Study(
        project_id=found_project.id, slug=payload.slug, name=payload.name,
        description=payload.description,
        definition_version=await seal_study_definition(session, found_project, user, payload.name, {
            **payload.definition.model_dump(mode="json"),
            "case_revision_ids": [str(value) for value in sorted(revision_ids, key=str)],
        }),
        state=StudyState.READY, created_by_id=user.id,
    )
    session.add(value)
    await session.flush()
    _audit(session, user, "study.created", value, organization.id)
    return _study_view(value)


@router.patch(
    "/studies/{study}", response_model=StudyView, operation_id="updateStudy",
    responses=revision.EDIT_RESPONSES,
)
async def update_study(
    org: str, project: str, study: str, payload: StudyUpdate, response: Response,
    if_match: str | None = revision.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found = await _study(session, found_project.id, study, user)
    await revision.guard(session, found, if_match)
    if payload.definition_version_id is not None:
        from ..artifacts import resolve_version, reference
        from ..db.models import Artifact, ArtifactVersion
        version = await session.get(ArtifactVersion, payload.definition_version_id)
        if version is None or version.artifact_id != found.definition_version.artifact_id:
            raise api_error(422, 'foreign_study_version', 'Select a version of this study artifact.')
        artifact = await session.get(Artifact, version.artifact_id)
        await resolve_version(session, reference(artifact, version), user)
        if version.manifest['kind'] != 'Study':
            raise api_error(422, 'invalid_study_version', 'Only executable Study definitions can be selected.')
        from ..studies import definition_from_version
        if not _study_engines_allowed(user, definition_from_version(version)):
            raise api_error(403, 'api_key_engine_forbidden', 'This key does not grant the Engines pinned by the selected version.')
        found.definition_version = version
        await session.flush()
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
    org: str, project: str, study: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.ADMIN)
    found = await _study(session, found_project.id, study, user)
    runs = (await session.execute(
        select(StudyRun).where(StudyRun.study_id == found.id)
    )).scalars().all()
    if runs:
        raise api_error(409, 'study_history_retained', 'Set archived=true for a study with executions; historical runs cannot be deleted.')
    _audit(session, user, "study.deleted", found, organization.id)
    await session.delete(found)
    await session.flush()


@router.post("/studies/{study}/runs", response_model=StudyRunView, status_code=202, operation_id="runStudy")
async def run_study(
    org: str, project: str, study: str, definition_version_id: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    plans: EntitlementService = Depends(get_entitlements),
) -> StudyRunView:
    # Start a run and launch its cells one by one, each committed before it is queued.
    #
    # A retryable refusal (``RETRYABLE_LAUNCH_CODES``: concurrency limit,
    # pricing unavailable) stops the loop and leaves the remaining cells queued for
    # ``study_jobs._sync`` to launch as the earlier jobs finish. When the very
    # first cell is refused there is no job whose end would trigger that, so the
    # run stays queued with nothing running until the reconciler advances it.
    # (A comment, not a docstring: a docstring would become the OpenAPI description.)
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found = await _study(session, found_project.id, study, user, check_engines=False)
    if found.archived:
        raise api_error(409, 'study_archived', 'Restore this study before starting another run.')
    from ..db.models import ArtifactVersion
    from ..studies import definition_from_version
    selected_version = await session.get(ArtifactVersion, definition_version_id) if definition_version_id else found.definition_version
    if selected_version is None or selected_version.artifact_id != found.definition_version.artifact_id:
        raise api_error(422, 'foreign_study_version', 'The requested version does not belong to this study.')
    from ..artifacts import reference, resolve_version
    from ..db.models import Artifact
    selected_artifact = await session.get(Artifact, selected_version.artifact_id)
    await resolve_version(session, reference(selected_artifact, selected_version), user)
    if not _study_engines_allowed(user, definition_from_version(selected_version)):
        raise api_error(403, 'api_key_engine_forbidden', 'This key does not grant the Engines pinned by the selected version.')
    caps = await plans.caps_or_503(user.id)
    plans.require_feature(caps, "studies", detail="The current plan does not entitle studies.")
    if selected_version.manifest['kind'] != 'Study':
        raise api_error(409, 'evidence_only_study', 'This gallery contains stored evidence and is not an executable study definition.')
    definition = StudyCreate(
        slug=found.slug, name=found.name, description=found.description, definition=definition_from_version(selected_version)
    ).definition
    expanded = expand_study(definition)
    # Before the run, its cells or any job exist: a run past the cell cap or with a case above the
    # size limit is refused whole, and so is one whose period counter SPACE reports spent or unknown.
    max_cells = get_settings().max_cells_per_study_run
    if max_cells is not None and len(expanded) > max_cells:
        raise api_error(
            422,
            "study_run_too_large",
            "This deployment limits how many cells one study run may expand to; reduce the matrix.",
            quota={
                "limit_id": "maxCellsPerRun", "state": "exhausted", "unit": "cell",
                "source": "technical", "limit": max_cells, "used": len(expanded),
            },
        )
    refusal = await study_binding_space_refusal(
        session, {uuid.UUID(cell["caseRevisionId"]) for cell in expanded}, caps
    )
    if refusal is None:
        refusal = await usage_counters.usage_refusal(user.id, "studyRuns")
    if refusal is not None:
        raise api_error(refusal.status, refusal.code, refusal.detail, headers=refusal.headers or None, **refusal.extra)
    await session.execute(select(Study.id).where(Study.id == found.id).with_for_update())
    number = int(await session.scalar(select(func.max(StudyRun.run_number)).where(StudyRun.study_id == found.id)) or 0) + 1
    matrix_digest = digest([cell["fingerprint"] for cell in expanded])
    run = StudyRun(
        study_id=found.id, definition_version_id=selected_version.id, run_number=number, state=RunState.QUEUED,
        matrix_digest=matrix_digest, summary={"cells": len(expanded)}, created_by_id=user.id,
    )
    session.add(run)
    await session.flush()
    cells: list[StudyCell] = []
    for cell in expanded:
        value = StudyCell(
            study_run_id=run.id, ordinal=cell["ordinal"],
            binding_case_revision_id=uuid.UUID(cell["caseRevisionId"]),
            engine_ref=cell["engine"], parameters=cell["parameters"],
            seed=cell["seed"], fingerprint=cell["fingerprint"], state=RunState.QUEUED,
        )
        session.add(value)
        cells.append(value)
    await session.flush()
    _audit(session, user, "study.run.created", run, organization.id, matrixDigest=matrix_digest)
    for cell in cells:
        try:
            await launch_study_cell(session, cell, user, organization, found_project.id)
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
    return StudyRunView(
        id=run.id, definition_version_id=run.definition_version_id, study_id=run.study_id, run_number=run.run_number, state=run.state.value,
        matrix_digest=run.matrix_digest, cells=len(expanded), summary=run.summary,
        created_at=run.created_at, finished_at=run.finished_at,
    )


async def _run(session: AsyncSession, study_id: uuid.UUID, run_id: uuid.UUID, user: User) -> StudyRun:
    found = (await session.execute(select(StudyRun).where(StudyRun.id == run_id, StudyRun.study_id == study_id))).scalars().first()
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Study run not found.")
    from ..db.models import ArtifactVersion
    from ..studies import definition_from_version
    version = await session.get(ArtifactVersion, found.definition_version_id)
    if not _study_engines_allowed(user, definition_from_version(version)):
        raise api_error(403, 'api_key_engine_forbidden', 'This key does not grant the Engines pinned by this run.')
    return found


async def _run_view(session: AsyncSession, run: StudyRun) -> StudyRunView:
    cells = int(await session.scalar(
        select(func.count(StudyCell.id)).where(StudyCell.study_run_id == run.id)
    ) or 0)
    return StudyRunView(
        id=run.id, definition_version_id=run.definition_version_id, study_id=run.study_id, run_number=run.run_number, state=run.state.value,
        matrix_digest=run.matrix_digest, cells=cells, summary=run.summary,
        created_at=run.created_at, finished_at=run.finished_at,
    )


@router.get("/studies/{study}/runs", response_model=list[StudyRunView], operation_id="listStudyRuns")
async def list_study_runs(
    org: str, project: str, study: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[StudyRunView]:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    found_study = await _study(session, found_project.id, study, user, check_engines=False)
    rows = (await session.execute(
        select(StudyRun).where(StudyRun.study_id == found_study.id).order_by(StudyRun.run_number.desc())
    )).scalars().all()
    from ..db.models import ArtifactVersion
    from ..studies import definition_from_version
    return [await _run_view(session, row) for row in rows
            if _study_engines_allowed(user, definition_from_version(await session.get(ArtifactVersion, row.definition_version_id)))]


@router.get(
    "/studies/{study}/runs/{run_id}/cells",
    response_model=list[StudyCellView],
    operation_id="listStudyCells",
)
async def list_study_cells(
    org: str, project: str, study: str, run_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[StudyCellView]:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    found_study = await _study(session, found_project.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    cells = (await session.execute(
        select(StudyCell).where(StudyCell.study_run_id == run.id).order_by(StudyCell.ordinal)
    )).scalars().all()
    return [StudyCellView(
        id=cell.id, study_run_id=cell.study_run_id, ordinal=cell.ordinal,
        binding_case_revision_id=cell.binding_case_revision_id,
        engine_ref=cell.engine_ref, parameters=cell.parameters, seed=cell.seed,
        fingerprint=cell.fingerprint, job_id=cell.job_id, state=cell.state.value,
        metrics=cell.metrics,
    ) for cell in cells]


@router.get(
    "/studies/{study}/runs/{run_id}/cells/{cell_id}",
    response_model=StudyCellView,
    operation_id="getStudyCell",
)
async def get_study_cell(
    org: str, project: str, study: str, run_id: uuid.UUID, cell_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyCellView:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    found_study = await _study(session, found_project.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    cell = (await session.execute(
        select(StudyCell).where(StudyCell.id == cell_id, StudyCell.study_run_id == run.id)
    )).scalars().first()
    if cell is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Study cell not found.")
    return StudyCellView(
        id=cell.id, study_run_id=cell.study_run_id, ordinal=cell.ordinal,
        binding_case_revision_id=cell.binding_case_revision_id,
        engine_ref=cell.engine_ref, parameters=cell.parameters, seed=cell.seed,
        fingerprint=cell.fingerprint, job_id=cell.job_id, state=cell.state.value,
        metrics=cell.metrics,
    )


@router.post("/studies/{study}/runs/{run_id}/cancel", response_model=StudyRunView, operation_id="cancelStudyRun")
async def cancel_study_run(
    org: str, project: str, study: str, run_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyRunView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found_study = await _study(session, found_project.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    try:
        run, cells = await cancel_run(session, run.id)
    except LookupError as exc:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Study run not found.") from exc
    except StudyRunTerminal as exc:
        raise api_error(status.HTTP_409_CONFLICT, "terminal_run", "The study run is already terminal.") from exc
    _audit(session, user, "study.run.cancelled", run, organization.id)
    return StudyRunView(
        id=run.id, definition_version_id=run.definition_version_id, study_id=run.study_id, run_number=run.run_number, state=run.state.value,
        matrix_digest=run.matrix_digest, cells=len(cells), summary=run.summary,
        created_at=run.created_at, finished_at=run.finished_at,
    )


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
                "each of `case_revision`, `engine`, `mode` and `seed` that differ, and `details` "
                "gives the `cell` and `job` values."
            ),
        }
    },
)
async def attach_cell_result(
    org: str, project: str, study: str, run_id: uuid.UUID, cell_id: uuid.UUID,
    payload: StudyCellResult,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found_study = await _study(session, found_project.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    # It rewrites the run's aggregate like _sync does, so it takes the same locks.
    run = await lock_run(session, run.id) or run
    cell = (
        await session.execute(
            select(StudyCell)
            .where(StudyCell.id == cell_id, StudyCell.study_run_id == run.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalars().first()
    job = await session.get(Job, payload.job_id)
    if cell is None or job is None or job.owner_id != user.id:
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
    org: str, project: str, study: str, run_id: uuid.UUID, cell_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found_study = await _study(session, found_project.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    # Run first, then the cell, as cancel and _sync do. A second retry of the same
    # cell waits here and then finds the replacement the first one launched: it is
    # answered with that job and ``idempotent: true`` (200), not refused with a 409.
    run = await lock_run(session, run.id)
    cell = (
        await session.execute(
            select(StudyCell)
            .where(StudyCell.id == cell_id, StudyCell.study_run_id == run.id)
            .with_for_update()
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
        replacement = await launch_study_cell(
            session, cell, user, organization, found_project.id
        )
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
    org: str, project: str, study: str, run_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> AnalyticsView:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    found_study = await _study(session, found_project.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    cells = (await session.execute(select(StudyCell).where(StudyCell.study_run_id == run.id).order_by(StudyCell.ordinal))).scalars().all()
    metrics_data = aggregate_metrics([cell.metrics for cell in cells])

    case_rev_ids = list({cell.binding_case_revision_id for cell in cells if cell.binding_case_revision_id})
    if not case_rev_ids:
        from ..db.models import ArtifactVersion
        from ..studies import definition_from_version
        historical_version = await session.get(ArtifactVersion, run.definition_version_id)
        raw_ids = definition_from_version(historical_version).get("case_revision_ids", [])
        for item in raw_ids:
            try:
                case_rev_ids.append(uuid.UUID(str(item)))
            except (ValueError, TypeError):
                pass

    binding_space_info = None
    if case_rev_ids:
        case_rows = (await session.execute(
            select(BindingCaseRevision, BindingCase)
            .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
            .where(BindingCaseRevision.id.in_(case_rev_ids))
        )).all()

        cases_detail = []
        total_cardinality = 1
        has_cardinality = False
        all_breakdowns = {}
        for rev, case in case_rows:
            cardinality = None
            breakdown = {}
            if rev.source_snapshot_id:
                ir_row = (await session.execute(
                    select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == rev.source_snapshot_id)
                )).scalars().first()
                if ir_row and isinstance(ir_row.document, dict):
                    spec = ir_row.document.get("spec", {})
                    tasks = spec.get("application", {}).get("tasks", {})
                    eligibility = spec.get("eligibility", {})
                    if isinstance(tasks, dict) and isinstance(eligibility, dict):
                        breakdown = {
                            t: len(eligibility.get(t, []))
                            for t, task_info in sorted(tasks.items())
                            if isinstance(task_info, dict) and task_info.get("kind") == "service"
                        }
                        if breakdown:
                            card = 1
                            for c in breakdown.values():
                                card *= c
                            cardinality = card

            if cardinality is None and isinstance(rev.document, dict):
                spec = rev.document.get("spec", {})
                tasks = spec.get("application", {}).get("tasks", [])
                candidates = spec.get("candidates", [])
                candidate_count = len(candidates) if isinstance(candidates, list) else len(candidates.keys()) if isinstance(candidates, dict) else 1
                if isinstance(tasks, list):
                    task_names = [t.get("id", f"task_{idx}") for idx, t in enumerate(tasks) if isinstance(t, dict)]
                    breakdown = {t: max(1, candidate_count) for t in task_names}
                    cardinality = (max(1, candidate_count)) ** len(task_names) if task_names else 1
                elif isinstance(tasks, dict):
                    breakdown = {t: max(1, candidate_count) for t in tasks}
                    cardinality = (max(1, candidate_count)) ** len(tasks) if tasks else 1

            if cardinality is not None:
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

    return AnalyticsView(**metrics_data, binding_space=binding_space_info)

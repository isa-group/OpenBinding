"""Curated collections, comparative studies, reports and publications."""

from __future__ import annotations

import uuid
import re
from collections.abc import Mapping

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import space_client
from ..access import metering
from ..access.dependencies import get_current_user, session_dependency
from ..collaboration import enforce_sponsor_capacity, organization_by_ref, require_project
from ..db.models import (
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    Collection,
    CollectionItem,
    CollectionRevision,
    Job,
    JobState,
    Organization,
    OrganizationRole,
    Project,
    ProjectResource,
    ProjectResourceRevision,
    Publication,
    Report,
    ReportState,
    RunState,
    Study,
    StudyCell,
    StudyRun,
    StudyState,
    User,
    utcnow,
)
from ..models.errors import api_error
from ..models.platform import (
    AnalyticsView,
    CollectionCreate,
    CollectionItemInput,
    CollectionRevisionCreate,
    CollectionRevisionView,
    CollectionView,
    PublicationCreate,
    PublicationView,
    ReportCreate,
    ReportView,
    StudyCellResult,
    StudyCellView,
    StudyCreate,
    StudyRunView,
    StudyView,
)
from ..space_client import PricingUnavailable, get_gate
from ..security.apikeys import allows_engine
from ..study_jobs import StudyLaunchError, launch_study_cell, metrics_from_job
from ..studies import aggregate_metrics, expand_study
from ..v1.canonical import digest

router = APIRouter(prefix="/v1/organizations/{org}/projects/{project}", tags=["Studies"])
public_router = APIRouter(prefix="/v1/explore", tags=["Explore"])


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


async def _collection(session: AsyncSession, project_id: uuid.UUID, reference: str) -> Collection:
    try:
        parsed = uuid.UUID(reference)
    except ValueError:
        parsed = None
    found = (await session.execute(select(Collection).where(
        Collection.project_id == project_id,
        Collection.id == parsed if parsed else Collection.slug == reference,
    ))).scalars().first()
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Collection not found.")
    return found


def _collection_view(value: Collection) -> CollectionView:
    return CollectionView.model_validate(value, from_attributes=True)


async def _validate_collection_item(
    session: AsyncSession,
    project_id: uuid.UUID,
    item: CollectionItemInput,
) -> None:
    reference = item.target_ref
    raw_id = (
        reference.get("caseRevisionId")
        or reference.get("resourceRevisionId")
        or reference.get("jobId")
        or reference.get("reportId")
        or reference.get("id")
    )
    try:
        target_id = uuid.UUID(str(raw_id))
    except (TypeError, ValueError):
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "invalid_collection_target",
            "Every collection item must identify an immutable target revision.",
        ) from None
    actual_digest: str | None = None
    belongs = False
    if item.target_kind == "case":
        row = (
            await session.execute(
                select(BindingCaseRevision, BindingCase.project_id)
                .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
                .where(BindingCaseRevision.id == target_id)
            )
        ).first()
        if row:
            actual_digest, belongs = row[0].digest, row[1] == project_id
    elif item.target_kind == "resource":
        row = (
            await session.execute(
                select(ProjectResourceRevision, ProjectResource.project_id)
                .join(
                    ProjectResource,
                    ProjectResource.id == ProjectResourceRevision.project_resource_id,
                )
                .where(ProjectResourceRevision.id == target_id)
            )
        ).first()
        if row:
            actual_digest, belongs = row[0].digest, row[1] == project_id
    elif item.target_kind == "result":
        row = await session.get(Job, target_id)
        if row:
            actual_digest, belongs = digest(row.result or {}), row.project_id == project_id
    else:
        row = await session.get(Report, target_id)
        if row:
            actual_digest, belongs = row.digest, row.project_id == project_id
    if not belongs or actual_digest != item.target_digest:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "collection_target_mismatch",
            "The collection target must belong to this project and match its pinned digest.",
        )


@router.get("/collections", response_model=list[CollectionView], operation_id="listCollections")
async def list_collections(
    org: str, project: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[CollectionView]:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    rows = (await session.execute(select(Collection).where(Collection.project_id == found_project.id).order_by(Collection.name))).scalars().all()
    return [_collection_view(row) for row in rows]


@router.post("/collections", response_model=CollectionView, status_code=201, operation_id="createCollection")
async def create_collection(
    org: str, project: str, payload: CollectionCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CollectionView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    sponsor = await session.get(User, organization.billing_sponsor_user_id)
    await enforce_sponsor_capacity(session, sponsor, "collections")
    duplicate = await session.scalar(select(func.count(Collection.id)).where(Collection.project_id == found_project.id, Collection.slug == payload.slug))
    if duplicate:
        raise api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That collection slug is in use.")
    value = Collection(project_id=found_project.id, created_by_id=user.id, **payload.model_dump())
    session.add(value)
    await session.flush()
    _audit(session, user, "collection.created", value, organization.id)
    return _collection_view(value)


@router.get("/collections/{collection}/revisions", response_model=list[CollectionRevisionView], operation_id="listCollectionRevisions")
async def list_collection_revisions(
    org: str, project: str, collection: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[CollectionRevisionView]:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    found = await _collection(session, found_project.id, collection)
    revisions = (await session.execute(select(CollectionRevision).where(CollectionRevision.collection_id == found.id).order_by(CollectionRevision.revision))).scalars().all()
    result = []
    for revision in revisions:
        items = (await session.execute(select(CollectionItem).where(CollectionItem.collection_revision_id == revision.id).order_by(CollectionItem.position))).scalars().all()
        result.append(CollectionRevisionView(
            id=revision.id, collection_id=revision.collection_id, revision=revision.revision,
            digest=revision.digest,
            items=[CollectionItemInput(target_kind=item.target_kind, target_digest=item.target_digest, target_ref=item.target_ref) for item in items],
            created_at=revision.created_at,
        ))
    return result


@router.post("/collections/{collection}/revisions", response_model=CollectionRevisionView, status_code=201, operation_id="createCollectionRevision")
async def create_collection_revision(
    org: str, project: str, collection: str, payload: CollectionRevisionCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CollectionRevisionView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found = await _collection(session, found_project.id, collection)
    for item in payload.items:
        await _validate_collection_item(session, found_project.id, item)
    document = [item.model_dump(mode="json") for item in payload.items]
    revision_digest = digest(document)
    existing = (await session.execute(select(CollectionRevision).where(
        CollectionRevision.collection_id == found.id, CollectionRevision.digest == revision_digest
    ))).scalars().first()
    if existing is not None:
        rows = (await session.execute(select(CollectionItem).where(CollectionItem.collection_revision_id == existing.id).order_by(CollectionItem.position))).scalars().all()
        return CollectionRevisionView(
            id=existing.id, collection_id=existing.collection_id, revision=existing.revision,
            digest=existing.digest,
            items=[CollectionItemInput(target_kind=row.target_kind, target_digest=row.target_digest, target_ref=row.target_ref) for row in rows],
            created_at=existing.created_at,
        )
    await session.execute(
        select(Collection.id).where(Collection.id == found.id).with_for_update()
    )
    latest = await session.scalar(select(func.max(CollectionRevision.revision)).where(CollectionRevision.collection_id == found.id))
    revision = CollectionRevision(
        collection_id=found.id, revision=int(latest or 0) + 1,
        digest=revision_digest, created_by_id=user.id,
    )
    session.add(revision)
    await session.flush()
    for position, item in enumerate(payload.items):
        session.add(CollectionItem(
            collection_revision_id=revision.id, position=position,
            target_kind=item.target_kind, target_digest=item.target_digest,
            target_ref=item.target_ref, added_by_id=user.id,
        ))
    _audit(session, user, "collection.revision.created", revision, organization.id, digest=revision_digest)
    return CollectionRevisionView(
        id=revision.id, collection_id=revision.collection_id, revision=revision.revision,
        digest=revision.digest, items=payload.items, created_at=revision.created_at,
    )


def _study_engines_allowed(user: User, definition: Mapping) -> bool:
    engines = definition.get("engines")
    return isinstance(engines, list) and bool(engines) and all(
        isinstance(engine, Mapping) and allows_engine(user, engine) for engine in engines
    )


async def _study(
    session: AsyncSession, project_id: uuid.UUID, reference: str, user: User
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
    if not _study_engines_allowed(user, found.definition):
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "api_key_engine_forbidden",
            "This API key does not grant every exact Engine revision pinned by the study.",
        )
    return found


def _study_view(value: Study) -> StudyView:
    return StudyView(
        id=value.id, project_id=value.project_id, slug=value.slug, name=value.name,
        description=value.description, definition=value.definition, state=value.state.value,
        created_by_id=value.created_by_id, created_at=value.created_at,
    )


@router.get("/studies", response_model=list[StudyView], operation_id="listStudies")
async def list_studies(
    org: str, project: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[StudyView]:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    rows = (await session.execute(select(Study).where(Study.project_id == found_project.id).order_by(Study.name))).scalars().all()
    return [_study_view(row) for row in rows if _study_engines_allowed(user, row.definition)]


@router.post("/studies", response_model=StudyView, status_code=201, operation_id="createStudy")
async def create_study(
    org: str, project: str, payload: StudyCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    if not all(allows_engine(user, engine) for engine in payload.definition.engines):
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "api_key_engine_forbidden",
            "This API key does not grant every exact Engine revision requested by the study.",
        )
    sponsor = await session.get(User, organization.billing_sponsor_user_id)
    await enforce_sponsor_capacity(session, sponsor, "studies")
    revision_ids = set(payload.definition.case_revision_ids)
    if payload.definition.collection_revision_id is not None:
        collection_revision = (await session.execute(
            select(CollectionRevision)
            .join(Collection, Collection.id == CollectionRevision.collection_id)
            .where(
                CollectionRevision.id == payload.definition.collection_revision_id,
                Collection.project_id == found_project.id,
            )
        )).scalars().first()
        if collection_revision is None:
            raise api_error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "foreign_collection_revision",
                "The collection revision must belong to this project.",
            )
        case_items = (await session.execute(
            select(CollectionItem)
            .where(
                CollectionItem.collection_revision_id == collection_revision.id,
                CollectionItem.target_kind == "case",
            )
            .order_by(CollectionItem.position)
        )).scalars().all()
        for item in case_items:
            raw_id = (
                item.target_ref.get("caseRevisionId")
                or item.target_ref.get("case_revision_id")
                or item.target_ref.get("id")
            )
            try:
                case_revision_id = uuid.UUID(str(raw_id))
            except (TypeError, ValueError):
                raise api_error(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "invalid_collection_case",
                    "Every case item used by a study must identify an immutable case revision.",
                ) from None
            referenced = await session.get(BindingCaseRevision, case_revision_id)
            if referenced is None or referenced.digest != item.target_digest:
                raise api_error(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "collection_digest_mismatch",
                    "A case item no longer matches its pinned digest.",
                )
            revision_ids.add(case_revision_id)
    if not revision_ids:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "empty_study_cases",
            "The study or its collection must contain at least one case revision.",
        )
    belonging = set((await session.execute(
        select(BindingCaseRevision.id).join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id).where(BindingCase.project_id == found_project.id)
    )).scalars().all())
    if not revision_ids <= belonging:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "foreign_case_revision", "Every study case revision must belong to this project.")
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
    value = Study(
        project_id=found_project.id, slug=payload.slug, name=payload.name,
        description=payload.description,
        definition={
            **payload.definition.model_dump(mode="json"),
            "case_revision_ids": [str(value) for value in sorted(revision_ids, key=str)],
        },
        state=StudyState.READY, created_by_id=user.id,
    )
    session.add(value)
    await session.flush()
    _audit(session, user, "study.created", value, organization.id)
    return _study_view(value)


@router.post("/studies/{study}/runs", response_model=StudyRunView, status_code=202, operation_id="runStudy")
async def run_study(
    org: str, project: str, study: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyRunView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found = await _study(session, found_project.id, study, user)
    try:
        verdict = await get_gate().evaluate(user.id, "studies", {"studyRuns": 1})
    except PricingUnavailable as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)) from exc
    if not verdict.allowed:
        raise api_error(status.HTTP_429_TOO_MANY_REQUESTS, "quota_exhausted", verdict.reason or "Study-run quota exhausted.")
    definition = StudyCreate(
        slug=found.slug, name=found.name, description=found.description, definition=found.definition
    ).definition
    expanded = expand_study(definition)
    await session.execute(select(Study.id).where(Study.id == found.id).with_for_update())
    number = int(await session.scalar(select(func.max(StudyRun.run_number)).where(StudyRun.study_id == found.id)) or 0) + 1
    matrix_digest = digest([cell["fingerprint"] for cell in expanded])
    run = StudyRun(
        study_id=found.id, run_number=number, state=RunState.QUEUED,
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
    await get_gate().adjust_usage(user.id, {"studyRuns": 1})
    _audit(session, user, "study.run.created", run, organization.id, matrixDigest=matrix_digest)
    for cell in cells:
        try:
            await launch_study_cell(session, cell, user, organization, found_project.id)
        except StudyLaunchError as exc:
            cell.state = RunState.FAILED
            cell.metrics = {
                "status": "failed",
                "feasible": False,
                "code": exc.code,
                "detail": exc.detail,
                "engine": (
                    f"{cell.engine_ref.get('namespace')}/{cell.engine_ref.get('name')}"
                    f"@{cell.engine_ref.get('version')}"
                ),
                "seed": cell.seed,
            }
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
        id=run.id, study_id=run.study_id, run_number=run.run_number, state=run.state.value,
        matrix_digest=run.matrix_digest, cells=len(expanded), summary=run.summary,
        created_at=run.created_at, finished_at=run.finished_at,
    )


async def _run(session: AsyncSession, study_id: uuid.UUID, run_id: uuid.UUID) -> StudyRun:
    found = (await session.execute(select(StudyRun).where(StudyRun.id == run_id, StudyRun.study_id == study_id))).scalars().first()
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Study run not found.")
    return found


async def _run_view(session: AsyncSession, run: StudyRun) -> StudyRunView:
    cells = int(await session.scalar(
        select(func.count(StudyCell.id)).where(StudyCell.study_run_id == run.id)
    ) or 0)
    return StudyRunView(
        id=run.id, study_id=run.study_id, run_number=run.run_number, state=run.state.value,
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
    found_study = await _study(session, found_project.id, study, user)
    rows = (await session.execute(
        select(StudyRun).where(StudyRun.study_id == found_study.id).order_by(StudyRun.run_number.desc())
    )).scalars().all()
    return [await _run_view(session, row) for row in rows]


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
    found_study = await _study(session, found_project.id, study, user)
    run = await _run(session, found_study.id, run_id)
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


@router.post("/studies/{study}/runs/{run_id}/cancel", response_model=StudyRunView, operation_id="cancelStudyRun")
async def cancel_study_run(
    org: str, project: str, study: str, run_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyRunView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found_study = await _study(session, found_project.id, study, user)
    run = await _run(session, found_study.id, run_id)
    if run.state in {RunState.COMPLETED, RunState.CANCELLED}:
        raise api_error(status.HTTP_409_CONFLICT, "terminal_run", "The study run is already terminal.")
    run.state = RunState.CANCELLED
    run.finished_at = utcnow()
    cells = (await session.execute(select(StudyCell).where(StudyCell.study_run_id == run.id))).scalars().all()
    for cell in cells:
        job = await session.get(Job, cell.job_id) if cell.job_id else None
        if job is not None and job.state not in {JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED}:
            job.cancellation_requested = True
            if job.state is JobState.QUEUED:
                job.state = JobState.CANCELLED
                job.finished_at = utcnow()
                await metering.settle(space_client.get_gate(), session, job.id, solver_seconds=0)
        if cell.state in {RunState.QUEUED, RunState.RUNNING}:
            cell.state = RunState.CANCELLED
    _audit(session, user, "study.run.cancelled", run, organization.id)
    return StudyRunView(
        id=run.id, study_id=run.study_id, run_number=run.run_number, state=run.state.value,
        matrix_digest=run.matrix_digest, cells=len(cells), summary=run.summary,
        created_at=run.created_at, finished_at=run.finished_at,
    )


@router.post("/studies/{study}/runs/{run_id}/cells/{cell_id}/result", operation_id="attachStudyCellResult")
async def attach_cell_result(
    org: str, project: str, study: str, run_id: uuid.UUID, cell_id: uuid.UUID,
    payload: StudyCellResult,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found_study = await _study(session, found_project.id, study, user)
    run = await _run(session, found_study.id, run_id)
    cell = (await session.execute(select(StudyCell).where(StudyCell.id == cell_id, StudyCell.study_run_id == run.id))).scalars().first()
    job = await session.get(Job, payload.job_id)
    if cell is None or job is None or job.owner_id != user.id:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Cell or job not found.")
    if job.state not in {JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED}:
        raise api_error(status.HTTP_409_CONFLICT, "job_not_finished", "Attach a terminal job result.")
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
    found_study = await _study(session, found_project.id, study, user)
    run = await _run(session, found_study.id, run_id)
    cell = (await session.execute(select(StudyCell).where(StudyCell.id == cell_id, StudyCell.study_run_id == run.id))).scalars().first()
    if cell is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Study cell not found.")
    current_job = await session.get(Job, cell.job_id) if cell.job_id else None
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
    found_study = await _study(session, found_project.id, study, user)
    run = await _run(session, found_study.id, run_id)
    cells = (await session.execute(select(StudyCell).where(StudyCell.study_run_id == run.id).order_by(StudyCell.ordinal))).scalars().all()
    return AnalyticsView(**aggregate_metrics([cell.metrics for cell in cells]))


def _report_view(value: Report) -> ReportView:
    return ReportView(
        id=value.id, project_id=value.project_id, study_run_id=value.study_run_id,
        slug=value.slug, title=value.title, document=value.document, digest=value.digest,
        state=value.state.value, created_at=value.created_at,
    )


def _exact_digest(value: object) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"sha256-[0-9a-f]{64}", value))


async def _validate_report_provenance(
    value: Report,
    project_id: uuid.UUID,
    provenance: object,
    session: AsyncSession,
) -> None:
    """Require enough immutable identity to reproduce a frozen report."""

    if not isinstance(provenance, dict):
        provenance = {}
    required = {
        "study",
        "datasets",
        "software",
        "bimVersion",
        "engineRevisions",
        "parameters",
    }
    if not required <= set(provenance):
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "incomplete_provenance",
            "Frozen reports require study, datasets, software, bimVersion, engineRevisions and parameters provenance.",
        )
    if not isinstance(provenance["bimVersion"], str) or not provenance["bimVersion"].strip():
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_provenance", "bimVersion must be a non-empty version string.")
    engines = provenance["engineRevisions"]
    if not isinstance(engines, list) or not engines or not all(
        _exact_digest(item) or (
            isinstance(item, dict)
            and isinstance(item.get("name"), str)
            and isinstance(item.get("version"), str)
            and _exact_digest(item.get("digest"))
        )
        for item in engines
    ):
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_provenance", "engineRevisions must identify one or more immutable engine digests.")
    if not isinstance(provenance["parameters"], dict):
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_provenance", "parameters must be an object.")
    datasets = provenance["datasets"]
    if not isinstance(datasets, list) or not datasets or not all(
        isinstance(item, dict)
        and isinstance(item.get("reference"), str)
        and bool(item["reference"].strip())
        and _exact_digest(item.get("digest"))
        for item in datasets
    ):
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_provenance", "datasets must contain reproducible reference and sha256 digest pairs.")
    software = provenance["software"]
    if not isinstance(software, list) or not software or not all(
        isinstance(item, dict)
        and all(isinstance(item.get(key), str) and item[key].strip() for key in ("name", "version"))
        and _exact_digest(item.get("digest"))
        for item in software
    ):
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_provenance", "software must identify name, version and sha256 digest.")

    study = provenance["study"]
    if not isinstance(study, dict):
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_provenance", "study must be an object.")
    if value.study_run_id is not None:
        run = await session.get(StudyRun, value.study_run_id)
        linked_project_id = await session.scalar(
            select(Study.project_id).where(Study.id == run.study_id)
        ) if run is not None else None
        if (
            run is None
            or linked_project_id != project_id
            or study.get("runId") != str(run.id)
            or study.get("matrixDigest") != run.matrix_digest
        ):
            raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "study_provenance_mismatch", "study.runId and study.matrixDigest must match the linked run in this project.")
    elif not (
        isinstance(study.get("reference"), str)
        and bool(study["reference"].strip())
        and _exact_digest(study.get("digest"))
    ):
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_provenance", "A report without a linked run must provide study.reference and study.digest.")


@router.get("/reports", response_model=list[ReportView], operation_id="listReports")
async def list_reports(
    org: str, project: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[ReportView]:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    rows = (await session.execute(
        select(Report).where(Report.project_id == found_project.id).order_by(Report.created_at.desc())
    )).scalars().all()
    return [_report_view(row) for row in rows]


@router.post("/reports", response_model=ReportView, status_code=201, operation_id="createReport")
async def create_report(
    org: str, project: str, payload: ReportCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ReportView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    if payload.study_run_id is not None:
        linked_project_id = await session.scalar(
            select(Study.project_id)
            .join(StudyRun, StudyRun.study_id == Study.id)
            .where(StudyRun.id == payload.study_run_id)
        )
        if linked_project_id != found_project.id:
            raise api_error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "foreign_study_run",
                "A report may only reference a study run from the same project.",
            )
    duplicate = await session.scalar(
        select(func.count(Report.id)).where(
            Report.project_id == found_project.id, Report.slug == payload.slug
        )
    )
    if duplicate:
        raise api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That report slug is in use.")
    value = Report(
        project_id=found_project.id, study_run_id=payload.study_run_id,
        slug=payload.slug, title=payload.title, document=payload.document,
        digest=digest(payload.document), state=ReportState.DRAFT, created_by_id=user.id,
    )
    session.add(value)
    await session.flush()
    _audit(session, user, "report.created", value, organization.id)
    return _report_view(value)


@router.post("/reports/{report}/freeze", response_model=ReportView, operation_id="freezeReport")
async def freeze_report(
    org: str, project: str, report: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ReportView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    try:
        parsed = uuid.UUID(report)
    except ValueError:
        parsed = None
    value = (await session.execute(select(Report).where(
        Report.project_id == found_project.id,
        Report.id == parsed if parsed else Report.slug == report,
    ))).scalars().first()
    if value is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Report not found.")
    provenance = value.document.get("provenance") if isinstance(value.document, dict) else None
    await _validate_report_provenance(value, found_project.id, provenance, session)
    value.state = ReportState.FROZEN
    value.digest = digest(value.document)
    _audit(session, user, "report.frozen", value, organization.id, digest=value.digest)
    return _report_view(value)


@router.post("/publications", response_model=PublicationView, status_code=201, operation_id="publishReport")
async def publish_report(
    org: str, project: str, payload: PublicationCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> PublicationView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.ADMIN)
    report = await session.get(Report, payload.report_id)
    if report is None or report.project_id != found_project.id:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Report not found.")
    if report.state is not ReportState.FROZEN:
        raise api_error(status.HTTP_409_CONFLICT, "report_not_frozen", "Freeze a report before publishing it.")
    duplicate = await session.scalar(
        select(func.count(Publication.id)).where(
            (Publication.project_id == found_project.id) & (Publication.slug == payload.slug)
            | (Publication.report_id == report.id)
        )
    )
    if duplicate:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "publication_conflict",
            "That slug is in use or the report is already published.",
        )
    value = Publication(
        project_id=found_project.id, report_id=report.id, slug=payload.slug,
        citation=payload.citation, published_by_id=user.id,
    )
    session.add(value)
    await session.flush()
    _audit(session, user, "publication.created", value, organization.id, reportDigest=report.digest)
    return PublicationView.model_validate(value, from_attributes=True)


@router.get("/publications", response_model=list[PublicationView], operation_id="listProjectPublications")
async def list_project_publications(
    org: str, project: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[PublicationView]:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    rows = (await session.execute(
        select(Publication)
        .where(Publication.project_id == found_project.id)
        .order_by(Publication.published_at.desc())
    )).scalars().all()
    return [PublicationView.model_validate(row, from_attributes=True) for row in rows]


@public_router.get("/projects", operation_id="explorePublicProjects")
async def explore_projects(
    response: Response,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[dict]:
    response.headers["Cache-Control"] = "public, max-age=60, stale-while-revalidate=300"
    rows = (await session.execute(
        select(Project, Organization).join(Organization, Organization.id == Project.organization_id).where(Project.visibility == "public").order_by(Project.updated_at.desc())
    )).all()
    return [{
        "organization": {"slug": organization.slug, "name": organization.name},
        "project": {"slug": project.slug, "name": project.name, "description": project.description},
    } for project, organization in rows]


@public_router.get("/publications", operation_id="explorePublications")
async def explore_publications(
    response: Response,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[dict]:
    response.headers["Cache-Control"] = "public, max-age=60, stale-while-revalidate=300"
    rows = (await session.execute(
        select(Publication, Report, Project, Organization)
        .join(Report, Report.id == Publication.report_id)
        .join(Project, Project.id == Publication.project_id)
        .join(Organization, Organization.id == Project.organization_id)
        .where(Project.visibility == "public")
        .order_by(Publication.published_at.desc())
    )).all()
    return [{
        "slug": publication.slug, "citation": publication.citation,
        "report": {"title": report.title, "digest": report.digest},
        "project": project.slug, "organization": organization.slug,
        "publishedAt": publication.published_at,
    } for publication, report, project, organization in rows]

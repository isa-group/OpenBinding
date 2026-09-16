"""Curated collections, comparative studies, reports and publications."""

from __future__ import annotations

import uuid
import re
import math
from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import space_client
from ..access import metering
from ..access.dependencies import get_current_user, session_dependency
from ..collaboration import enforce_sponsor_capacity, organization_by_ref, require_project
from ..db.models import (
    Artifact,
    ArtifactVersion,
    ProjectArtifact,
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    BindingIRSnapshot,
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
    CollectionUpdate,
    CollectionView,
    PublicationCreate,
    PublicationView,
    ReportCreate,
    ReportUpdate,
    ReportView,
    StudyCellResult,
    StudyCellView,
    StudyCreate,
    StudyRunView,
    StudyUpdate,
    StudyView,
)
from ..space_client import PricingUnavailable, get_gate
from ..security.apikeys import allows_engine
from ..study_jobs import StudyLaunchError, launch_study_cell, metrics_from_job
from ..studies import aggregate_metrics, expand_study
from ..v1.canonical import canonical_json, digest
from ..artifacts import store_blob, version_content
from ..models.artifacts import CollectionArtifactContent, ArtifactRef
import json

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


async def _collection(session: AsyncSession, project_id: uuid.UUID, reference: str) -> Artifact:
    try:
        parsed = uuid.UUID(reference)
    except ValueError:
        parsed = None
    found = (await session.execute(select(Artifact).join(ProjectArtifact).where(
        ProjectArtifact.project_id == project_id, Artifact.kind == "Collection",
        Artifact.id == parsed if parsed else Artifact.name == reference))).scalars().first()
    if found is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Collection not found.")
    return found


def _collection_view(value: Artifact, project_id: uuid.UUID) -> CollectionView:
    return CollectionView(id=value.id, project_id=project_id, slug=value.name,
        name=value.display_name, description=value.description,
        created_by_id=value.created_by_id, created_at=value.created_at)


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
        row = (await session.execute(select(ArtifactVersion, ProjectArtifact.project_id)
            .join(ProjectArtifact, ProjectArtifact.artifact_id == ArtifactVersion.artifact_id)
            .where(ArtifactVersion.id == target_id))).first()
        if row:
            actual_digest, belongs = row[0].content_digest, row[1] == project_id
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
    rows = (await session.scalars(select(Artifact).join(ProjectArtifact)
        .where(ProjectArtifact.project_id == found_project.id, Artifact.kind == "Collection")
        .order_by(Artifact.display_name))).all()
    return [_collection_view(row, found_project.id) for row in rows]


@router.post("/collections", response_model=CollectionView, status_code=201, operation_id="createCollection")
async def create_collection(
    org: str, project: str, payload: CollectionCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CollectionView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    sponsor = await session.get(User, organization.billing_sponsor_user_id)
    await enforce_sponsor_capacity(session, sponsor, "collections")
    duplicate = await session.scalar(select(Artifact.id).where(Artifact.organization_id == organization.id,
        Artifact.name == payload.slug, Artifact.kind == "Collection"))
    if duplicate:
        raise api_error(status.HTTP_409_CONFLICT, "slug_conflict", "That collection slug is in use.")
    value = Artifact(organization_id=organization.id, namespace=str(organization.id), name=payload.slug,
        display_name=payload.name, description=payload.description, kind="Collection", created_by_id=user.id)
    session.add(value)
    await session.flush()
    session.add(ProjectArtifact(project_id=found_project.id, artifact_id=value.id))
    await session.flush()
    _audit(session, user, "collection.created", value, organization.id)
    return _collection_view(value, found_project.id)


@router.get("/collections/{collection}/revisions", response_model=list[CollectionRevisionView], operation_id="listCollectionRevisions")
async def list_collection_revisions(
    org: str, project: str, collection: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[CollectionRevisionView]:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    found = await _collection(session, found_project.id, collection)
    revisions = (await session.scalars(select(ArtifactVersion).where(
        ArtifactVersion.artifact_id == found.id).order_by(ArtifactVersion.ordinal))).all()
    result = []
    for revision in revisions:
        content, _ = await version_content(session, revision)
        members = CollectionArtifactContent.model_validate(json.loads(content)).members
        items = [CollectionItemInput(target_kind="case" if hasattr(item, "caseRevisionId") else "resource",
            target_digest=(item.compositionDigest if hasattr(item, "compositionDigest") else item.versionDigest),
            target_ref=(item.model_dump(mode="json"))) for item in members]
        result.append(CollectionRevisionView(
            id=revision.id, collection_id=found.id, revision=revision.ordinal,
            digest=revision.content_digest, items=items,
            created_at=revision.created_at,
        ))
    return result


@router.get(
    "/collections/{collection}/revisions/{revision}",
    response_model=CollectionRevisionView,
    operation_id="getCollectionRevision",
)
async def get_collection_revision(
    org: str,
    project: str,
    collection: str,
    revision: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CollectionRevisionView:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    found = await _collection(session, found_project.id, collection)

    rev_row = None
    if revision.isdigit():
        rev_row = await session.scalar(select(ArtifactVersion).where(
            ArtifactVersion.artifact_id == found.id, ArtifactVersion.ordinal == int(revision)))
    if rev_row is None:
        try:
            parsed_uuid = uuid.UUID(revision)
            rev_row = await session.scalar(select(ArtifactVersion).where(
                ArtifactVersion.artifact_id == found.id, ArtifactVersion.id == parsed_uuid))
        except ValueError:
            pass
    if rev_row is None and revision.startswith("sha256-"):
        rev_row = await session.scalar(select(ArtifactVersion).where(
            ArtifactVersion.artifact_id == found.id, ArtifactVersion.content_digest == revision))

    if rev_row is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Collection revision not found.")

    content, _ = await version_content(session, rev_row)
    members = CollectionArtifactContent.model_validate(json.loads(content)).members
    items = [CollectionItemInput(target_kind="case" if hasattr(item, "caseRevisionId") else "resource",
        target_digest=(item.compositionDigest if hasattr(item, "compositionDigest") else item.versionDigest),
        target_ref=item.model_dump(mode="json")) for item in members]

    return CollectionRevisionView(
        id=rev_row.id,
        collection_id=found.id, revision=rev_row.ordinal, digest=rev_row.content_digest, items=items,
        created_at=rev_row.created_at,
    )


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
    members = []
    for item in payload.items:
        if item.target_kind == "case":
            members.append({"caseRevisionId": item.target_ref.get("caseRevisionId"), "compositionDigest": item.target_digest})
        elif item.target_kind == "resource":
            version = await session.get(ArtifactVersion, uuid.UUID(str(item.target_ref.get("resourceRevisionId") or item.target_ref.get("id"))))
            artifact = await session.get(Artifact, version.artifact_id) if version else None
            if artifact is None:
                raise api_error(422, "invalid_collection_target", "Resource version not found.")
            members.append({"namespace": artifact.namespace, "name": artifact.name,
                            "version": version.version, "versionDigest": version.version_digest})
        else:
            raise api_error(422, "unsupported_collection_target", "Only case and resource artifact members are supported by the versioned collection library.")
    document = {"apiVersion": "openbinding/collection/v1", "members": members}
    revision_digest = digest(document)
    existing = await session.scalar(select(ArtifactVersion).where(
        ArtifactVersion.artifact_id == found.id, ArtifactVersion.content_digest == revision_digest))
    if existing is not None:
        return CollectionRevisionView(
            id=existing.id, collection_id=found.id, revision=existing.ordinal, digest=existing.content_digest,
            items=payload.items,
            created_at=existing.created_at,
        )
    await session.execute(select(Artifact.id).where(Artifact.id == found.id).with_for_update())
    latest = await session.scalar(select(func.max(ArtifactVersion.ordinal)).where(ArtifactVersion.artifact_id == found.id))
    content = canonical_json(document)
    blob = await store_blob(session, found, user, content, "application/json")
    ordinal = int(latest or 0) + 1
    manifest = {"apiVersion": "openbinding/artifact/v1", "kind": "Collection",
        "identity": {"namespace": found.namespace, "name": found.name, "version": str(ordinal)},
        "contentDigest": revision_digest, "mediaType": "application/json", "contracts": [], "dependencies": []}
    revision = ArtifactVersion(artifact_id=found.id, ordinal=ordinal, version=str(ordinal), blob_id=blob.id,
        content_digest=revision_digest, version_digest=digest(manifest), manifest=manifest, created_by_id=user.id)
    session.add(revision)
    await session.flush()
    _audit(session, user, "collection.revision.created", revision, organization.id, digest=revision_digest)
    return CollectionRevisionView(id=revision.id, collection_id=found.id, revision=revision.ordinal,
        digest=revision.content_digest, items=payload.items, created_at=revision.created_at)


@router.get(
    "/collections/{collection}",
    response_model=CollectionView,
    operation_id="getCollection",
)
async def get_collection(
    org: str,
    project: str,
    collection: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CollectionView:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    found = await _collection(session, found_project.id, collection)
    return _collection_view(found, found_project.id)


@router.patch("/collections/{collection}", response_model=CollectionView, operation_id="updateCollection")
async def update_collection(
    org: str, project: str, collection: str, payload: CollectionUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CollectionView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found = await _collection(session, found_project.id, collection)
    if payload.name is not None:
        found.display_name = payload.name
    if payload.description is not None:
        found.description = payload.description
    await session.flush()
    _audit(session, user, "collection.updated", found, organization.id)
    return _collection_view(found, found_project.id)


@router.delete("/collections/{collection}", status_code=status.HTTP_204_NO_CONTENT, operation_id="deleteCollection")
async def delete_collection(
    org: str, project: str, collection: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.ADMIN)
    found = await _collection(session, found_project.id, collection)
    _audit(session, user, "collection.deleted", found, organization.id)
    await session.execute(delete(ProjectArtifact).where(ProjectArtifact.project_id == found_project.id,
        ProjectArtifact.artifact_id == found.id))
    await session.flush()


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
    if payload.definition.collection_version_id is not None:
        from ..artifacts import can_read, version_content
        from ..db.models import Artifact, ArtifactVersion
        from ..models.artifacts import CollectionArtifactContent, CaseRevisionRef
        from ..v1.package import strict_json_loads
        version = await session.get(ArtifactVersion, payload.definition.collection_version_id)
        artifact = await session.get(Artifact, version.artifact_id) if version else None
        if artifact is None or artifact.kind != 'Collection' or not await can_read(session, artifact, user, version):
            raise api_error(422, 'unavailable_collection', 'Choose an accessible sealed Collection version.')
        collection = CollectionArtifactContent.model_validate(strict_json_loads((await version_content(session, version))[0]))
        revision_ids.update(member.caseRevisionId for member in collection.members if isinstance(member, CaseRevisionRef))
    if not revision_ids:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "empty_study_cases",
            "The study or its collection must contain at least one case revision.",
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


@router.patch("/studies/{study}", response_model=StudyView, operation_id="updateStudy")
async def update_study(
    org: str, project: str, study: str, payload: StudyUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found = await _study(session, found_project.id, study, user)
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
) -> StudyRunView:
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
    try:
        verdict = await get_gate().evaluate(user.id, "studies", {"studyRuns": 1})
    except PricingUnavailable as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)) from exc
    if not verdict.allowed:
        if verdict.limit is not None:
            if verdict.limit.limit_id == "concurrentJobs":
                raise api_error(
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    "concurrency_limit_exceeded",
                    verdict.reason or "Concurrency limit exceeded.",
                    headers={"Retry-After": "15"},
                    concurrency={"limit_id": "concurrentJobs", "limit": verdict.limit.limit, "used": verdict.limit.used},
                )
            else:
                raise api_error(
                    status.HTTP_402_PAYMENT_REQUIRED,
                    "quota_exceeded",
                    verdict.reason or "Study-run quota exhausted.",
                    quota={
                        "limit_id": verdict.limit.limit_id,
                        "limit": verdict.limit.limit,
                        "used": verdict.limit.used,
                        "unit": verdict.limit.unit,
                        "renews_at": verdict.limit.renews_at,
                    },
                )
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "feature_not_entitled",
            verdict.reason or "The current plan does not entitle studies.",
        )
    if selected_version.manifest['kind'] != 'Study':
        raise api_error(409, 'evidence_only_study', 'This gallery contains stored evidence and is not an executable study definition.')
    definition = StudyCreate(
        slug=found.slug, name=found.name, description=found.description, definition=definition_from_version(selected_version)
    ).definition
    expanded = expand_study(definition)
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
    await get_gate().adjust_usage(user.id, {"studyRuns": 1})
    _audit(session, user, "study.run.created", run, organization.id, matrixDigest=matrix_digest)
    for cell in cells:
        try:
            await launch_study_cell(session, cell, user, organization, found_project.id)
        except StudyLaunchError as exc:
            if exc.code in {"quota_exhausted", "concurrency_limit_exceeded"}:
                # Concurrency limit reached; leave remaining cells queued to be picked up by _sync.
                cell.state = RunState.QUEUED
                break
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


async def _require_mutable_evidence(session, run):
    from ..db.models import ArtifactEvidence
    if await session.scalar(select(ArtifactEvidence.version_id).where(ArtifactEvidence.study_run_id == run.id).limit(1)):
        raise api_error(409, 'sealed_evidence', 'This run is evidence of a sealed report. Start a new run to change its results.')


@router.post("/studies/{study}/runs/{run_id}/cancel", response_model=StudyRunView, operation_id="cancelStudyRun")
async def cancel_study_run(
    org: str, project: str, study: str, run_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> StudyRunView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    found_study = await _study(session, found_project.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    await _require_mutable_evidence(session, run)
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
        id=run.id, definition_version_id=run.definition_version_id, study_id=run.study_id, run_number=run.run_number, state=run.state.value,
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
    found_study = await _study(session, found_project.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    await _require_mutable_evidence(session, run)
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
    found_study = await _study(session, found_project.id, study, user, check_engines=False)
    run = await _run(session, found_study.id, run_id, user)
    await _require_mutable_evidence(session, run)
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


def _report_view(value: Report) -> ReportView:
    return ReportView(
        id=value.id, project_id=value.project_id, study_run_id=value.study_run_id,
        artifact_id=value.artifact_id, version_id=value.version_id, draft_id=value.draft_id,
        draft_revision=value.draft.revision if value.draft and not value.draft.sealed_version_id else None,
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


@router.get("/reports/{report}", response_model=ReportView, operation_id="getReport")
async def get_report(
    org: str, project: str, report: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ReportView:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
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
    return _report_view(value)


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
    from ..reports import create_report_context
    value = await create_report_context(session, found_project, user, slug=payload.slug,
        title=payload.title, document=payload.document, study_run_id=payload.study_run_id)
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
    from ..reports import seal_report
    await seal_report(session, value, user)
    _audit(session, user, "report.frozen", value, organization.id, digest=value.digest)
    return _report_view(value)


@router.post("/reports/{report}/drafts", response_model=ReportView, operation_id="createReportDraft")
async def create_report_draft(org: str, project: str, report: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function")) -> ReportView:
    _, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    try:
        identity = uuid.UUID(report)
    except ValueError:
        identity = None
    value = await session.scalar(select(Report).where(Report.project_id == found_project.id,
        Report.id == identity if identity else Report.slug == report))
    if value is None:
        raise api_error(404, 'not_found', 'Report not found.')
    from ..reports import new_report_draft
    await new_report_draft(session, value, user)
    return _report_view(value)


@router.patch("/reports/{report}", response_model=ReportView, operation_id="updateReport")
async def update_report(
    org: str, project: str, report: str, payload: ReportUpdate,
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
    from ..db.models import Artifact
    await session.execute(select(Artifact.id).where(Artifact.id == value.artifact_id).with_for_update())
    await session.refresh(value)
    if value.state is ReportState.FROZEN:
        raise api_error(status.HTTP_409_CONFLICT, "report_frozen", "Frozen reports are immutable and cannot be modified.")
    if payload.title is not None:
        value.title = payload.title
    if payload.document is not None:
        await session.refresh(value.draft, with_for_update=True)
        if value.draft.sealed_version_id or payload.draft_revision is None or payload.draft_revision != value.draft.revision:
            raise api_error(409, 'draft_conflict', 'Supply the current draft_revision before editing this report.')
        value.draft.payload = {**value.draft.payload, 'content': payload.document}
        value.draft.revision += 1
    await session.flush()
    _audit(session, user, "report.updated", value, organization.id)
    return _report_view(value)


@router.delete("/reports/{report}", status_code=status.HTTP_204_NO_CONTENT, operation_id="deleteReport")
async def delete_report(
    org: str, project: str, report: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.ADMIN)
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
    from ..db.models import ArtifactVersion
    if await session.scalar(select(ArtifactVersion.id).where(ArtifactVersion.artifact_id == value.artifact_id).limit(1)):
        raise api_error(409, 'report_history_retained', 'Sealed report history cannot be deleted; archive the library artifact.')
    _audit(session, user, "report.deleted", value, organization.id)
    await session.delete(value)
    await session.flush()


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
    from ..db.models import ArtifactVersion
    version = await session.get(ArtifactVersion, payload.version_id or report.version_id)
    if version is None or version.artifact_id != report.artifact_id:
        raise api_error(422, 'foreign_report_version', 'Select a sealed version of this report.')
    duplicate = await session.scalar(
        select(func.count(Publication.id)).where(
            (Publication.project_id == found_project.id) & (Publication.slug == payload.slug)
            | ((Publication.report_id == report.id) & (Publication.version_id == version.id))
        )
    )
    if duplicate:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "publication_conflict",
            "That slug is in use or the report is already published.",
        )
    from .library import publish_version
    from ..models.artifacts import PublishVersion
    citation = {'title': report.title, **payload.citation}
    await publish_version(report.artifact_id, version.id, PublishVersion(citation=citation), user, session)
    value = Publication(
        project_id=found_project.id, report_id=report.id, version_id=version.id, slug=payload.slug,
        citation=citation, published_by_id=user.id,
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


@router.delete("/publications/{publication}", status_code=status.HTTP_204_NO_CONTENT, operation_id="deletePublication")
async def delete_publication(
    org: str, project: str, publication: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.ADMIN)
    try:
        parsed = uuid.UUID(publication)
    except ValueError:
        parsed = None
    value = (await session.execute(select(Publication).where(
        Publication.project_id == found_project.id,
        Publication.id == parsed if parsed else Publication.slug == publication,
    ))).scalars().first()
    if value is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Publication not found.")
    from .library import withdraw_version
    await withdraw_version(value.version.artifact_id, value.version_id, user, session)
    _audit(session, user, "publication.withdrawn", value, organization.id)
    value.withdrawn = True
    await session.flush()


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
        .where(Project.visibility == "public", Publication.withdrawn.is_(False))
        .order_by(Publication.published_at.desc())
    )).all()
    return [{
        "slug": publication.slug, "citation": publication.citation,
        "report": {"title": publication.citation.get("title", report.title), "digest": publication.version.content_digest, "version_id": str(publication.version_id)},
        "project": project.slug, "organization": organization.slug,
        "publishedAt": publication.published_at,
    } for publication, report, project, organization in rows]


@public_router.get("/engines", operation_id="exploreEngines")
async def explore_engines(
    response: Response,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "public, max-age=60, stale-while-revalidate=300"
    from .v1 import _available_engine_documents, _engine_ref

    engines = []
    for document, namespace in await _available_engine_documents(session, caller=None):
        reference = _engine_ref(document, namespace)
        engines.append(
            {
                "id": reference["name"],
                "name": reference["name"],
                "namespace": reference["namespace"],
                "version": reference["version"],
                "digest": reference["digest"],
                "ref": reference,
                "modes": document.get("spec", {}).get("modes", []),
            }
        )
    return {"engines": engines}

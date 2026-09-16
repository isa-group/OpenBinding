"""Content-addressed artifacts and portable project packages."""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import os
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Literal

import yaml
from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, session_dependency
from ..collaboration import organization_by_ref, require_project
from ..core.settings import Settings, get_settings
from ..db.models import (
    Blob,
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    InstanceSnapshot, BindingIRSnapshot, Artifact, ArtifactVersion, ArtifactDraft, ArtifactDependency, CaseArtifact, ProjectArtifact,
    Collection,
    CollectionItem,
    CollectionRevision,
    Job,
    JobState,
    Organization,
    OrganizationRole,
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
    Visibility,
)
from ..models.errors import api_error
from ..models.platform import BlobView
from ..v1.canonical import CanonicalizationError, digest, digest_bytes
from ..v1.package import PackageError, strict_json_loads

router = APIRouter(prefix="/v1/organizations/{org}/projects/{project}", tags=["Artifacts"])


def _portable_objects(container: dict, key: str, path: str) -> list[dict]:
    value = container.get(key, [])
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "invalid_portable_package",
            f"{path}.{key} must be an array of objects.",
        )
    return value


def _validate_portable_shape(package: dict) -> None:
    """Reject malformed nested declarations before any rows are written."""

    for declaration in _portable_objects(package, "cases", "package"):
        _portable_objects(declaration, "revisions", "case")
    for declaration in _portable_objects(package, "resources", "package"):
        _portable_objects(declaration, "revisions", "resource")
    for declaration in _portable_objects(package, "collections", "package"):
        for revision in _portable_objects(declaration, "revisions", "collection"):
            _portable_objects(revision, "items", "collection revision")
    for declaration in _portable_objects(package, "studies", "package"):
        if not isinstance(declaration.get("definition", {}), dict):
            raise api_error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "invalid_portable_package",
                "study.definition must be an object.",
            )
        for run in _portable_objects(declaration, "runs", "study"):
            for cell in _portable_objects(run, "cells", "study run"):
                if cell.get("job") is not None and not isinstance(cell["job"], dict):
                    raise api_error(
                        status.HTTP_422_UNPROCESSABLE_ENTITY,
                        "invalid_portable_package",
                        "study cell.job must be an object or null.",
                    )
    _portable_objects(package, "reports", "package")
    _portable_objects(package, "publications", "package")
    _portable_objects(package, "artifacts", "package")
    from pydantic import ValidationError
    from ..models.artifacts import ArtifactRef, ArtifactManifest, ArtifactUse
    try:
        for job in _portable_objects(package, 'evidenceJobs', 'package'):
            uuid.UUID(job.get('id', ''))
            if not isinstance(job.get('engineId'), str) or not job['engineId']:
                raise ValueError('Job evidence requires an engine identifier.')
            if job.get('state') not in {'completed', 'failed', 'cancelled'}:
                raise ValueError('Job evidence must be terminal.')
        for report in package.get('reports', []):
            if report.get('state') == 'frozen':
                ArtifactRef.model_validate(report.get('versionRef'))
        for publication in package.get('publications', []):
            ArtifactRef.model_validate(publication.get('versionRef'))
            if not isinstance(publication.get('slug'), str) or not publication['slug']:
                raise ValueError('A publication requires a slug.')
            if not isinstance(publication.get('withdrawn', False), bool):
                raise ValueError('Publication withdrawal must be boolean.')
        for study in package.get('studies', []):
            ArtifactRef.model_validate(study.get('definitionRef'))
            for run in study.get('runs', []):
                ArtifactRef.model_validate(run.get('definitionRef'))
        for entry in _portable_objects(package, 'projectArtifacts', 'package'):
            ArtifactRef.model_validate(entry)
        for entry in _portable_objects(package, 'library', 'package'):
            ref = ArtifactRef.model_validate(entry.get('ref'))
            manifest = ArtifactManifest.model_validate(entry.get('manifest'))
            if manifest.identity.model_dump() != ref.model_dump(exclude={'versionDigest'}):
                raise ValueError('Artifact address differs from its version manifest.')
            if not isinstance(entry.get('contentBase64'), str):
                raise ValueError('Artifact content must be base64 encoded text.')
        for case in package.get('cases', []):
            for revision in case.get('revisions', []):
                for use in _portable_objects(revision, 'resources', 'case revision'):
                    ArtifactUse.model_validate(use)
        snapshots = package.get('snapshots', {})
        if not isinstance(snapshots, dict) or any(not isinstance(entry, dict) for entry in snapshots.values()):
            raise ValueError('Snapshot closure must be an object of snapshot records.')
    except (ValidationError, ValueError, TypeError, AttributeError) as exc:
        raise api_error(422, 'invalid_portable_package', str(exc)) from exc


async def _context(session, org, project, user, minimum):
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    found_project = await require_project(session, organization, project, user, minimum)
    return organization, found_project


def _artifact_view(value: Blob) -> BlobView:
    return BlobView.model_validate(value, from_attributes=True)


def _artifact_path(settings: Settings, digest_value: str) -> Path:
    hexadecimal = digest_value.removeprefix("sha256-")
    return Path(settings.artifact_root) / hexadecimal[:2] / hexadecimal[2:4] / hexadecimal


async def _storage_limit(session: AsyncSession, organization: Organization, incoming: int) -> None:
    sponsor = await session.get(User, organization.billing_sponsor_user_id)
    await session.execute(select(User.id).where(User.id == sponsor.id).with_for_update())
    from ..space_client import PricingUnavailable, get_gate
    try:
        caps = await get_gate().caps(sponsor.id)
    except PricingUnavailable as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)) from exc
    storage_limit = caps.limit("storageBytes")
    if storage_limit is None:
        return
    used = int(await session.scalar(
        select(func.coalesce(func.sum(Blob.size_bytes), 0))
        .join(Organization, Organization.id == Blob.organization_id)
        .where(Organization.billing_sponsor_user_id == sponsor.id)
    ) or 0)
    limit = int(storage_limit)
    if used + incoming > limit:
        raise api_error(
            status.HTTP_402_PAYMENT_REQUIRED, "storage_quota_exceeded",
            "The sponsor storage allowance would be exceeded.",
            quota={"limit_id": "storageBytes", "limit": limit, "used": used},
        )


async def _payload_limit(user: User) -> int:
    """Return the actor's per-request ceiling, capped by the platform maximum."""

    from ..space_client import PricingUnavailable, get_gate

    try:
        caps = await get_gate().caps(user.id)
    except PricingUnavailable as exc:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)
        ) from exc
    limit = caps.limit("maxPayloadBytes")
    return 512 * 1024 * 1024 if limit is None else min(512 * 1024 * 1024, int(limit))


@router.get("/blobs", response_model=list[BlobView], operation_id="listBlobs")
async def list_artifacts(
    org: str, project: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[BlobView]:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    rows = (await session.execute(select(Blob).where(Blob.project_id == found_project.id).order_by(Blob.created_at.desc()))).scalars().all()
    return [_artifact_view(row) for row in rows]


@router.post("/blobs", response_model=BlobView, status_code=201, operation_id="uploadBlob")
async def upload_artifact(
    org: str,
    project: str,
    request: Request,
    public: bool = Query(default=False),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> BlobView:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    try:
        declared = int(request.headers.get("content-length", "0") or 0)
    except ValueError:
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            "invalid_content_length",
            "Content-Length must be an integer.",
        ) from None
    if declared < 0:
        raise api_error(status.HTTP_400_BAD_REQUEST, "invalid_content_length", "Content-Length cannot be negative.")
    payload_limit = await _payload_limit(user)
    if declared > payload_limit:
        raise api_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "artifact_too_large",
            "The artifact exceeds this account's per-request payload limit.",
        )
    await _storage_limit(session, organization, declared)
    root = Path(settings.artifact_root)
    root.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    size = 0
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=root, delete=False) as handle:
            temporary = Path(handle.name)
            async for chunk in request.stream():
                size += len(chunk)
                if size > payload_limit:
                    raise api_error(
                        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        "artifact_too_large",
                        "The artifact exceeds this account's per-request payload limit.",
                    )
                hasher.update(chunk)
                handle.write(chunk)
        await _storage_limit(session, organization, size)
        digest_value = f"sha256-{hasher.hexdigest()}"
        destination = _artifact_path(settings, digest_value)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            temporary.unlink(missing_ok=True)
        else:
            os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    existing = (await session.execute(select(Blob).where(
        Blob.project_id == found_project.id, Blob.digest == digest_value
    ))).scalars().first()
    if existing is not None:
        return _artifact_view(existing)
    value = Blob(
        organization_id=organization.id, project_id=found_project.id,
        digest=digest_value, media_type=request.headers.get("content-type", "application/octet-stream"),
        size_bytes=size, storage_uri=str(destination), public=public,
        created_by_id=user.id,
    )
    session.add(value)
    await session.flush()
    session.add(AuditEvent(
        organization_id=organization.id, actor_id=user.id, action="artifact.uploaded",
        target_type="Blob", target_id=value.id, detail={"digest": digest_value, "public": public},
    ))
    return _artifact_view(value)


@router.get(
    "/blobs/{digest_value}",
    operation_id="downloadBlob",
    response_class=FileResponse,
    responses={200: {"content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}}},
)
async def download_artifact(
    org: str, project: str, digest_value: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    artifact = (await session.execute(select(Blob).where(
        Blob.project_id == found_project.id, Blob.digest == digest_value
    ))).scalars().first()
    if artifact is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Blob not found.")
    storage_path = Path(artifact.storage_uri)
    if not storage_path.is_file():
        storage_path = _artifact_path(get_settings(), artifact.digest)
        if not storage_path.is_file():
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Blob not found.")
    return FileResponse(
        str(storage_path), media_type=artifact.media_type,
        headers={"ETag": f'"{artifact.digest}"', "Cache-Control": "no-store"},
    )


@router.delete("/blobs/{digest_value}", status_code=status.HTTP_204_NO_CONTENT, operation_id="deleteBlob")
async def delete_artifact(
    org: str, project: str, digest_value: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.ADMIN)
    artifact = (await session.execute(select(Blob).where(
        Blob.project_id == found_project.id, Blob.digest == digest_value
    ))).scalars().first()
    if artifact is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Blob not found.")
    storage_path = Path(artifact.storage_uri)
    session.add(AuditEvent(
        organization_id=organization.id, actor_id=user.id, action="artifact.deleted",
        target_type="Blob", target_id=artifact.id, detail={"digest": digest_value},
    ))
    await session.delete(artifact)
    await session.flush()
    remaining = await session.scalar(select(func.count(Blob.id)).where(Blob.storage_uri == str(storage_path)))
    if not remaining and storage_path.is_file():
        try:
            storage_path.unlink()
        except OSError:
            pass

@router.get(
    "/package",
    operation_id="exportProjectPackage",
    response_class=StreamingResponse,
    responses={200: {"content": {
        "application/zip": {"schema": {"type": "string", "format": "binary"}},
        "application/json": {"schema": {"type": "object"}},
        "application/yaml": {"schema": {"type": "string"}},
    }}},
)
async def export_project_package(
    org: str, project: str,
    format: Literal["zip", "json", "yaml"] = Query(default="zip"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    organization, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    cases = (await session.execute(select(BindingCase).where(BindingCase.project_id == found_project.id))).scalars().all()
    case_ids = [case.id for case in cases]
    revisions = (await session.execute(select(BindingCaseRevision).where(BindingCaseRevision.binding_case_id.in_(case_ids)))).scalars().all() if case_ids else []
    # Project resources are now backed by the organization artifact library.
    # Keep the legacy package shape while serializing the common identities and
    # sealed versions, so exports do not lose reusable BIM inputs.
    case_used_artifact_ids = set(await session.scalars(select(CaseArtifact.version_id)
        .join(BindingCaseRevision, BindingCaseRevision.id == CaseArtifact.revision_id)
        .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
        .where(BindingCase.project_id == found_project.id)))
    case_used_artifact_ids = set(await session.scalars(select(ArtifactVersion.artifact_id)
        .where(ArtifactVersion.id.in_(case_used_artifact_ids)))) if case_used_artifact_ids else set()
    resources = (await session.scalars(select(Artifact).join(ProjectArtifact)
        .where(ProjectArtifact.project_id == found_project.id,
               Artifact.id.not_in(case_used_artifact_ids),
               Artifact.kind.not_in({"Application", "CandidateCatalog", "ConstraintSet",
                                     "ExecutionConfiguration", "AnalysisConfiguration",
                                     "Collection", "Study", "Report", "BindingDecision"}))
        .order_by(Artifact.name))).all()
    resource_revisions = (await session.scalars(select(ArtifactVersion)
        .where(ArtifactVersion.artifact_id.in_([resource.id for resource in resources]))
        .order_by(ArtifactVersion.ordinal))).all() if resources else []
    collections = (await session.scalars(select(Artifact).join(ProjectArtifact)
        .where(ProjectArtifact.project_id == found_project.id, Artifact.kind == "Collection")
        .order_by(Artifact.name))).all()
    collection_revisions = (await session.scalars(select(ArtifactVersion)
        .where(ArtifactVersion.artifact_id.in_([collection.id for collection in collections]))
        .order_by(ArtifactVersion.ordinal))).all() if collections else []
    studies = (await session.execute(select(Study).where(Study.project_id == found_project.id))).scalars().all()
    study_ids = [study.id for study in studies]
    runs = (await session.execute(select(StudyRun).where(StudyRun.study_id.in_(study_ids)))).scalars().all() if study_ids else []
    run_ids = [run.id for run in runs]
    cells = (await session.execute(select(StudyCell).where(StudyCell.study_run_id.in_(run_ids)))).scalars().all() if run_ids else []
    job_ids = [cell.job_id for cell in cells if cell.job_id]
    jobs = (await session.execute(select(Job).where(Job.id.in_(job_ids)))).scalars().all() if job_ids else []
    reports = (await session.execute(select(Report).where(Report.project_id == found_project.id))).scalars().all()
    publications = (await session.execute(select(Publication).where(Publication.project_id == found_project.id))).scalars().all()
    from ..db.models import ArtifactEvidence
    report_versions = {report.version_id for report in reports if report.version_id} | {publication.version_id for publication in publications}
    report_versions.update(await session.scalars(select(ArtifactVersion.id).join(ProjectArtifact,
        ProjectArtifact.artifact_id == ArtifactVersion.artifact_id).where(ProjectArtifact.project_id == found_project.id)))
    evidence = (await session.scalars(select(ArtifactEvidence).where(ArtifactEvidence.version_id.in_(report_versions)))).all()
    evidence_run_ids = {item.study_run_id for item in evidence if item.study_run_id}
    evidence_job_ids = {item.job_id for item in evidence if item.job_id}
    runs = list({run.id: run for run in [*runs, *(await session.scalars(select(StudyRun).where(StudyRun.id.in_(evidence_run_ids)))).all()]} .values())
    studies = list({study.id: study for study in [*studies, *(await session.scalars(select(Study).where(Study.id.in_({run.study_id for run in runs})))).all()]} .values())
    cells = (await session.scalars(select(StudyCell).where(StudyCell.study_run_id.in_({run.id for run in runs})))).all()
    jobs = (await session.scalars(select(Job).where(Job.id.in_(evidence_job_ids | {cell.job_id for cell in cells if cell.job_id})))).all()
    artifacts = (await session.execute(select(Blob).where(Blob.project_id == found_project.id))).scalars().all()
    revisions_by_case: dict[str, list[BindingCaseRevision]] = {}
    for revision in revisions:
        revisions_by_case.setdefault(str(revision.binding_case_id), []).append(revision)
    revisions_by_resource: dict[str, list[ArtifactVersion]] = {}
    for revision in resource_revisions:
        revisions_by_resource.setdefault(str(revision.artifact_id), []).append(revision)
    revisions_by_collection: dict[str, list[ArtifactVersion]] = {}
    for revision in collection_revisions:
        revisions_by_collection.setdefault(str(revision.artifact_id), []).append(revision)
    runs_by_study: dict[str, list[StudyRun]] = {}
    for run in runs:
        runs_by_study.setdefault(str(run.study_id), []).append(run)
    cells_by_run: dict[str, list[StudyCell]] = {}
    for cell in cells:
        cells_by_run.setdefault(str(cell.study_run_id), []).append(cell)
    jobs_by_id = {job.id: job for job in jobs}

    def timestamp(value) -> str | None:
        return value.isoformat() if value else None

    from ..artifacts import can_read, reference, version_content, resolve_version
    snapshots = {}
    case_uses = {}
    version_ids = {study.definition_version_id for study in studies} | {run.definition_version_id for run in runs}
    version_ids.update(report.version_id for report in reports if report.version_id)
    version_ids.update(publication.version_id for publication in publications)
    version_ids.update(job.configuration_version_id for job in jobs if job.configuration_version_id)
    definition_refs = {}
    for version_id in version_ids:
        version = await session.get(ArtifactVersion, version_id)
        artifact = await session.get(Artifact, version.artifact_id)
        definition_refs[version_id] = reference(artifact, version)
    project_artifact_refs = []
    associated = (await session.execute(select(Artifact, ArtifactVersion)
        .join(ProjectArtifact, ProjectArtifact.artifact_id == Artifact.id)
        .join(ArtifactVersion, ArtifactVersion.artifact_id == Artifact.id)
        .where(ProjectArtifact.project_id == found_project.id)
        .order_by(Artifact.namespace, Artifact.name, ArtifactVersion.ordinal))).all()
    for artifact, version in associated:
        if await can_read(session, artifact, user, version):
            project_artifact_refs.append(reference(artifact, version))
            version_ids.add(version.id)
    # Scientific definitions can consume cases owned by another project. Expand
    # both edge types before serializing so their snapshots and resource bytes
    # participate in the same verified closure.
    from ..db.models import ArtifactCaseReference
    closure_versions = set()
    closure_revisions = {revision.id: revision for revision in revisions}
    pending_versions = set(version_ids)
    pending_revisions = set(closure_revisions)
    while pending_versions or pending_revisions:
        while pending_revisions:
            revision_id = pending_revisions.pop()
            resource_versions = set(await session.scalars(select(CaseArtifact.version_id).where(CaseArtifact.revision_id == revision_id)))
            pending_versions.update(resource_versions - closure_versions)
        if not pending_versions:
            break
        version_id = pending_versions.pop()
        if version_id in closure_versions:
            continue
        version = await session.get(ArtifactVersion, version_id)
        artifact = await session.get(Artifact, version.artifact_id)
        await resolve_version(session, reference(artifact, version), user)
        closure_versions.add(version_id)
        pending_versions.update(set(await session.scalars(select(ArtifactDependency.dependency_id).where(ArtifactDependency.version_id == version_id))) - closure_versions)
        for revision_id in await session.scalars(select(ArtifactCaseReference.case_revision_id).where(ArtifactCaseReference.version_id == version_id)):
            if revision_id not in closure_revisions:
                closure_revisions[revision_id] = await session.get(BindingCaseRevision, revision_id)
                pending_revisions.add(revision_id)
    version_ids.update(closure_versions)
    revisions = list(closure_revisions.values())
    cases_by_id = {case.id: case for case in cases}
    revisions_by_case = {}
    for revision in revisions:
        if revision.binding_case_id not in cases_by_id:
            cases_by_id[revision.binding_case_id] = await session.get(BindingCase, revision.binding_case_id)
        revisions_by_case.setdefault(str(revision.binding_case_id), []).append(revision)
    cases = list(cases_by_id.values())
    for revision in revisions:
        links = (await session.scalars(select(CaseArtifact).where(CaseArtifact.revision_id == revision.id))).all()
        case_uses[str(revision.id)] = []
        for link in links:
            version = await session.get(ArtifactVersion, link.version_id)
            artifact = await session.get(Artifact, version.artifact_id)
            await resolve_version(session, reference(artifact, version), user)
            version_ids.add(version.id)
            case_uses[str(revision.id)].append(dict(role=link.role, alias=link.alias,
                artifact=reference(artifact, version), bindings=link.bindings))
        if revision.source_snapshot_id:
            snapshot = await session.get(InstanceSnapshot, revision.source_snapshot_id)
            ir = await session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))
            if not ir or digest_bytes(snapshot.source_archive) != snapshot.package_digest:
                raise api_error(409, 'snapshot_integrity', 'Cannot export incomplete or corrupt historical inputs.')
            snapshots[str(snapshot.id)] = dict(archive=base64.b64encode(snapshot.source_archive).decode(),
                packageDigest=snapshot.package_digest, compilationDigest=snapshot.compilation_digest,
                irDigest=ir.ir_digest, ir=ir.document)
    def portable_job(job):
        return dict(id=str(job.id), engineId=job.engine_id, state=job.state.value,
            configurationRef=definition_refs.get(job.configuration_version_id),
            request=job.original_request, options=job.options, result=job.result,
            termination=job.termination, provenance=job.provenance,
            createdAt=timestamp(job.created_at), finishedAt=timestamp(job.finished_at))

    library = []
    visited = set()
    async def include_version(identity):
        if identity in visited:
            return
        visited.add(identity)
        version = await session.get(ArtifactVersion, identity)
        artifact = await session.get(Artifact, version.artifact_id)
        await resolve_version(session, reference(artifact, version), user)
        for target in await session.scalars(select(ArtifactDependency.dependency_id).where(ArtifactDependency.version_id == identity)):
            await include_version(target)
        content, _ = await version_content(session, version)
        library.append(dict(ref=reference(artifact, version), manifest=version.manifest,
            displayName=artifact.display_name, description=artifact.description,
            contentBase64=base64.b64encode(content).decode()))
    for identity in sorted(version_ids, key=str):
        await include_version(identity)

    legacy_resources = []
    for resource in resources:
        serialized_revisions = []
        for version in sorted(revisions_by_resource.get(str(resource.id), []), key=lambda value: value.ordinal):
            content, media_type = await version_content(session, version)
            try:
                document = json.loads(content.decode()) if media_type == "application/json" else {"content": content.decode()}
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise api_error(409, "content_integrity", "Cannot export invalid resource content.") from exc
            serialized_revisions.append({"id": str(version.id), "revision": version.ordinal,
                "digest": version.content_digest, "document": document,
                "createdAt": timestamp(version.created_at)})
        legacy_resources.append({"id": str(resource.id), "slug": resource.name,
            "name": resource.display_name, "description": resource.description,
            "kind": resource.kind, "revisions": serialized_revisions})
    legacy_collections = []
    for collection in collections:
        serialized_revisions = []
        for version in sorted(revisions_by_collection.get(str(collection.id), []), key=lambda value: value.ordinal):
            content, _ = await version_content(session, version)
            document = json.loads(content.decode())
            items = []
            for member in document.get("members", []):
                if "caseRevisionId" in member:
                    items.append({"kind": "case", "digest": member.get("compositionDigest"),
                                  "ref": {"caseRevisionId": member.get("caseRevisionId")}})
                else:
                    items.append({"kind": "resource", "digest": member.get("versionDigest"), "ref": member})
            # The legacy envelope retains its historical ordered-item digest;
            # the authoritative versionDigest remains in the common library.
            legacy_digest_items = [{"target_kind": item["kind"], "target_digest": item["digest"],
                                    "target_ref": item["ref"]} for item in items]
            serialized_revisions.append({"id": str(version.id), "revision": version.ordinal,
                "digest": digest(legacy_digest_items), "items": items})
        legacy_collections.append({"id": str(collection.id), "slug": collection.name,
            "name": collection.display_name, "description": collection.description,
            "revisions": serialized_revisions})

    package = {
        "apiVersion": "openbinding.dev/package/v1",
        "snapshots": snapshots,
        "library": library,
        "projectArtifacts": project_artifact_refs,
        "organization": {"slug": organization.slug, "name": organization.name},
        "project": {"slug": found_project.slug, "name": found_project.name, "description": found_project.description, "visibility": found_project.visibility.value},
        "cases": [{
            "id": str(case.id), "slug": case.slug, "name": case.name,
            "description": case.description,
            "revisions": [{
                "id": str(item.id), "revision": item.revision, "digest": item.digest,
                "document": item.document, "createdAt": timestamp(item.created_at),
                "snapshotId": str(item.source_snapshot_id) if item.source_snapshot_id else None,
                "resources": case_uses[str(item.id)],
            } for item in sorted(revisions_by_case.get(str(case.id), []), key=lambda value: value.revision)],
        } for case in cases],
        "resources": legacy_resources,
        "collections": legacy_collections,
        "studies": [{
            "id": str(study.id), "slug": study.slug, "name": study.name,
            "description": study.description, "definition": study.definition, "archived": study.archived,
            "definitionRef": definition_refs[study.definition_version_id],
            "state": study.state.value,
            "runs": [{
                "id": str(run.id), "number": run.run_number, "state": run.state.value,
                "definitionRef": definition_refs[run.definition_version_id],
                "matrixDigest": run.matrix_digest, "summary": run.summary,
                "createdAt": timestamp(run.created_at), "finishedAt": timestamp(run.finished_at),
                "cells": [{
                    "id": str(cell.id), "ordinal": cell.ordinal,
                    "caseRevisionId": str(cell.binding_case_revision_id),
                    "engine": cell.engine_ref, "parameters": cell.parameters,
                    "seed": cell.seed, "fingerprint": cell.fingerprint,
                    "state": cell.state.value, "metrics": cell.metrics,
                    "job": portable_job(jobs_by_id[cell.job_id]) if cell.job_id in jobs_by_id else None,
                } for cell in sorted(cells_by_run.get(str(run.id), []), key=lambda value: value.ordinal)],
            } for run in sorted(runs_by_study.get(str(study.id), []), key=lambda value: value.run_number)],
        } for study in studies],
        "evidenceJobs": [portable_job(job) for job in jobs if job.id in evidence_job_ids],
        "reports": [{
            "id": str(report.id), "studyRunId": str(report.study_run_id) if report.study_run_id else None,
            "slug": report.slug, "title": report.title, "document": report.document,
            "digest": report.digest, "state": report.state.value,
            "versionRef": definition_refs.get(report.version_id),
        } for report in reports],
        "publications": [{
            "slug": publication.slug, "reportId": str(publication.report_id), "versionRef": definition_refs[publication.version_id], "withdrawn": publication.withdrawn,
            "citation": publication.citation, "publishedAt": timestamp(publication.published_at),
        } for publication in publications],
        "artifacts": [{
            "digest": item.digest, "mediaType": item.media_type, "size": item.size_bytes,
            "public": item.public, "expiresAt": timestamp(item.expires_at),
            **(
                {"contentBase64": base64.b64encode(Path(item.storage_uri).read_bytes()).decode()}
                if format != "zip" and Path(item.storage_uri).is_file()
                else {"path": f"artifacts/{item.digest}"}
            ),
        } for item in artifacts],
    }
    package["packageDigest"] = digest(package)
    if format == "json":
        return JSONResponse(package, headers={"ETag": f'"{package["packageDigest"]}"', "Cache-Control": "no-store"})
    if format == "yaml":
        return Response(
            yaml.safe_dump(package, sort_keys=False, allow_unicode=True),
            media_type="application/yaml",
            headers={"ETag": f'"{package["packageDigest"]}"', "Cache-Control": "no-store"},
        )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        serialized = json.dumps(package, sort_keys=True, indent=2)
        archive.writestr("package.json", serialized)
        archive.writestr("manifest.json", serialized)
        for artifact in artifacts:
            path = Path(artifact.storage_uri)
            if path.is_file():
                archive.write(path, f"artifacts/{artifact.digest}")
    output.seek(0)
    return StreamingResponse(
        output, media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{found_project.slug}.openbinding.zip"',
            "ETag": f'"{package["packageDigest"]}"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/package", operation_id="importProjectPackage")
async def import_project_package(
    org: str, project: str, request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Import a ZIP, JSON or YAML package after checking every immutable digest."""

    organization, found_project = await _context(session, org, project, user, OrganizationRole.MEMBER)
    payload = await request.body()
    if len(payload) > 128 * 1024 * 1024:
        raise api_error(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "package_too_large", "Portable packages are limited to 128 MB compressed.")
    archive: zipfile.ZipFile | None = None
    try:
        content_type = request.headers.get("content-type", "").casefold()
        if payload.startswith(b"PK\x03\x04"):
            archive = zipfile.ZipFile(io.BytesIO(payload))
            members = archive.infolist()
            if len(members) > 10_000 or sum(item.file_size for item in members) > 512 * 1024 * 1024:
                raise ValueError("expanded package is too large")
            if any(item.filename.startswith(("/", "\\")) or ".." in Path(item.filename).parts for item in members):
                raise ValueError("unsafe archive path")
            filename = "package.json" if "package.json" in archive.namelist() else "manifest.json"
            package = strict_json_loads(archive.read(filename))
        elif "yaml" in content_type:
            package = yaml.safe_load(payload)
        elif "json" in content_type:
            package = strict_json_loads(payload)
        else:
            try:
                package = strict_json_loads(payload)
            except PackageError:
                package = yaml.safe_load(payload)
    except (zipfile.BadZipFile, KeyError, PackageError, yaml.YAMLError, ValueError) as exc:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_portable_package", str(exc)) from exc
    if not isinstance(package, dict) or package.get("apiVersion") != "openbinding.dev/package/v1":
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "unsupported_package", "Only openbinding.dev/package/v1 is supported.")
    expected_package_digest = package.get("packageDigest")
    unsigned = dict(package)
    unsigned.pop("packageDigest", None)
    try:
        actual_package_digest = digest(unsigned)
    except CanonicalizationError as exc:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "invalid_portable_package",
            str(exc),
        ) from exc
    if not isinstance(expected_package_digest, str) or expected_package_digest != actual_package_digest:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "checksum_mismatch",
            "The package manifest digest does not match its content.",
        )
    _validate_portable_shape(package)

    counts = {
        "cases": 0, "caseRevisions": 0, "resources": 0, "resourceRevisions": 0,
        "collections": 0, "collectionRevisions": 0, "studies": 0, "studyRuns": 0,
        "studyCells": 0, "reports": 0, "publications": 0, "artifacts": 0,
    }
    from ..artifacts import case_composition_digest, reference, resolve_version, seal_draft
    from ..models.artifacts import ArtifactRef, DraftContent
    from ..routes.v1 import _compile_resolved, _persist_snapshot
    from ..v1.package import load_package
    from fastapi import HTTPException
    async def import_library_entry(entry) -> bool:
        ref = ArtifactRef.model_validate(entry.get('ref'))
        manifest = entry.get('manifest', {})
        try:
            content = base64.b64decode(entry['contentBase64'], validate=True)
        except (KeyError, ValueError) as exc:
            raise api_error(422, 'invalid_portable_package', 'Invalid artifact bytes.') from exc
        if digest(manifest) != ref.versionDigest or digest_bytes(content) != manifest.get('contentDigest'):
            raise api_error(422, 'checksum_mismatch', 'Artifact manifest or bytes are corrupt.')
        try:
            await resolve_version(session, ref, user)
            return True
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
        for evidence in manifest.get('evidence', []):
            model = StudyRun if evidence['kind'] == 'StudyRun' else Job
            if await session.get(model, uuid.UUID(evidence['id'])) is None:
                return False
        if ref.namespace != str(organization.id):
            raise api_error(409, 'external_namespace_unavailable', 'Resolve external versions from their owning organization before importing; an archive does not grant namespace ownership.')
        document = strict_json_loads(content) if manifest['mediaType'] == 'application/json' else content.decode('utf-8')
        for dependency in manifest.get('dependencies', []):
            try:
                await resolve_version(session, ArtifactRef.model_validate(dependency), user)
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                return False
        if manifest['kind'] in {'Study', 'Collection'}:
            from pydantic import ValidationError
            from ..models.artifacts import CaseRevisionRef, StudyArtifactContent, CollectionArtifactContent
            try:
                targets = (StudyArtifactContent.model_validate(document).cases if manifest['kind'] == 'Study'
                           else CollectionArtifactContent.model_validate(document).members)
            except ValidationError as exc:
                raise api_error(422, 'invalid_artifact_content', str(exc)) from exc
            for target in targets:
                if isinstance(target, CaseRevisionRef) and await session.get(BindingCaseRevision, target.caseRevisionId) is None:
                    return False
        artifact = await session.scalar(select(Artifact).where(Artifact.namespace == ref.namespace, Artifact.name == ref.name))
        if artifact is None:
            artifact = Artifact(organization_id=organization.id, namespace=ref.namespace, name=ref.name,
                display_name=entry.get('displayName', ref.name), description=entry.get('description', ''),
                kind=manifest['kind'], created_by_id=user.id)
            session.add(artifact)
            await session.flush()
        draft = ArtifactDraft(artifact_id=artifact.id, created_by_id=user.id,
            payload=DraftContent(content=document, media_type=manifest['mediaType'], contracts=manifest['contracts'],
                dependencies=manifest['dependencies']).model_dump(mode='json'))
        session.add(draft)
        await session.flush()
        restored = await seal_draft(session, artifact, draft, 1, ref.version, user)
        if restored.version_digest != ref.versionDigest:
            raise api_error(409, 'version_conflict', 'Imported version differs from its original sealed manifest.')
        return True

    pending_library = list(_portable_objects(package, 'library', 'package'))
    async def import_available_library():
        while pending_library:
            remaining = []
            for entry in pending_library:
                if not await import_library_entry(entry):
                    remaining.append(entry)
            if len(remaining) == len(pending_library):
                break
            pending_library[:] = remaining
    await import_available_library()
    snapshot_map = {}
    if not isinstance(package.get('snapshots', {}), dict):
        raise api_error(422, 'invalid_portable_package', 'Snapshots must be an object.')
    for source_id, entry in package.get('snapshots', {}).items():
        try:
            archive_bytes = base64.b64decode(entry['archive'], validate=True)
            source = load_package(archive_bytes)
        except (KeyError, ValueError, PackageError) as exc:
            raise api_error(422, 'invalid_portable_package', 'Invalid snapshot archive.') from exc
        if digest_bytes(archive_bytes) != entry.get('packageDigest'):
            raise api_error(422, 'checksum_mismatch', 'Snapshot archive digest mismatch.')
        problem = await _compile_resolved(source, session, user)
        if problem.digest != entry.get('irDigest') or problem.document != entry.get('ir'):
            raise api_error(409, 'toolchain_mismatch', 'The exact original compilation is not available.')
        restored_id = await _persist_snapshot(source, problem, user, session)
        snapshot = await session.get(InstanceSnapshot, uuid.UUID(restored_id))
        if snapshot.compilation_digest != entry.get('compilationDigest'):
            raise api_error(409, 'toolchain_mismatch', 'The original snapshot toolchain is not installed.')
        snapshot_map[source_id] = snapshot

    case_map: dict[str, BindingCase] = {}
    case_revision_map: dict[str, BindingCaseRevision] = {}
    for declaration in package.get("cases", []):
        if not isinstance(declaration, dict) or not all(isinstance(declaration.get(key), str) for key in ("id", "slug", "name")):
            raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_portable_package", "Malformed case declaration.")
        existing = (await session.execute(select(BindingCase).where(
            BindingCase.project_id == found_project.id, BindingCase.slug == declaration["slug"]
        ))).scalars().first()
        if existing is None:
            existing = BindingCase(
                project_id=found_project.id, slug=declaration["slug"], name=declaration["name"],
                description=str(declaration.get("description", "")), created_by_id=user.id,
            )
            session.add(existing)
            await session.flush()
            counts["cases"] += 1
        case_map[declaration["id"]] = existing
        for revision_data in sorted(declaration.get("revisions", []), key=lambda item: item.get("revision", 0)):
            document = revision_data.get("document")
            snapshot = snapshot_map.get(revision_data.get('snapshotId'))
            if revision_data.get('snapshotId') and snapshot is None:
                raise api_error(422, 'missing_snapshot', 'A case snapshot is missing from the closure.')
            resources = revision_data.get('resources', [])
            if not isinstance(document, dict) or revision_data.get("digest") != case_composition_digest(document, snapshot, resources):
                raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "checksum_mismatch", "A case revision digest does not match its complete composition.")
            revision = (await session.execute(select(BindingCaseRevision).where(
                BindingCaseRevision.binding_case_id == existing.id,
                BindingCaseRevision.digest == revision_data["digest"],
            ))).scalars().first()
            if revision is None:
                latest = int(await session.scalar(select(func.max(BindingCaseRevision.revision)).where(
                    BindingCaseRevision.binding_case_id == existing.id
                )) or 0)
                original_revision_id = uuid.UUID(revision_data['id'])
                original_revision = await session.get(BindingCaseRevision, original_revision_id)
                if original_revision is not None and original_revision.digest != revision_data['digest']:
                    raise api_error(409, 'case_identity_conflict', 'An existing case revision has a different composition.')
                revision = BindingCaseRevision(
                    id=uuid.uuid4() if original_revision is not None else original_revision_id,
                    binding_case_id=existing.id, revision=latest + 1,
                    digest=revision_data["digest"], document=document, created_by_id=user.id,
                    source_snapshot_id=snapshot.id if snapshot else None,
                )
                session.add(revision)
                await session.flush()
                for use in resources:
                    _, version = await resolve_version(session, use['artifact'], user)
                    session.add(CaseArtifact(revision_id=revision.id, role=use['role'], alias=use['alias'],
                        version_id=version.id, bindings=use.get('bindings', {})))
                counts["caseRevisions"] += 1
            case_revision_map[str(revision_data.get("id"))] = revision

    await import_available_library()
    if any(entry['manifest']['kind'] != 'Report' for entry in pending_library):
        raise api_error(422, 'incomplete_artifact_closure', 'The package is missing exact case revisions or artifact dependencies.')

    # The legacy ``resources`` envelope is only an index for clients that have
    # not adopted ``library`` yet. Exact bytes and versions were already
    # imported above; associate their artifact identities instead of creating
    # a second ProjectResource authority.
    resource_revision_map: dict[str, ArtifactVersion] = {}
    for declaration in package.get("resources", []):
        if not isinstance(declaration, dict) or not all(isinstance(declaration.get(key), str) for key in ("id", "slug", "name")):
            raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_portable_package", "Malformed resource declaration.")
        counts["resources"] += 1
        for revision_data in declaration.get("revisions", []):
            try:
                version = await session.get(ArtifactVersion, uuid.UUID(str(revision_data.get("id"))))
            except (TypeError, ValueError):
                version = None
            if version is None:
                raise api_error(422, "incomplete_artifact_closure", "A resource version is missing from the library closure.")
            resource_revision_map[str(revision_data.get("id"))] = version
            counts["resourceRevisions"] += 1

    def remap_ref(reference: dict) -> dict:
        result = dict(reference)
        for key in ("caseRevisionId", "case_revision_id", "id"):
            source_id = str(result.get(key, ""))
            if source_id in case_revision_map:
                result[key] = str(case_revision_map[source_id].id)
        for key in ("resourceRevisionId", "resource_revision_id"):
            source_id = str(result.get(key, ""))
            if source_id in resource_revision_map:
                result[key] = str(resource_revision_map[source_id].id)
        return result

    # Collections follow the same rule: their sealed ArtifactVersion was
    # imported from ``library``; the old envelope is validated and counted but
    # never materialized into specialized revision tables.
    for declaration in package.get("collections", []):
        if not isinstance(declaration, dict):
            raise api_error(422, "invalid_portable_package", "Malformed collection declaration.")
        counts["collections"] += 1
        for revision_data in declaration.get("revisions", []):
            try:
                version = await session.get(ArtifactVersion, uuid.UUID(str(revision_data.get("id"))))
            except (TypeError, ValueError):
                version = None
            if version is None:
                raise api_error(422, "incomplete_artifact_closure", "A collection version is missing from the library closure.")
            counts["collectionRevisions"] += 1

    study_map: dict[str, Study] = {}
    run_map: dict[str, StudyRun] = {}

    async def imported_configuration(job_data):
        declared = job_data.get('configurationRef')
        provenance_ref = (job_data.get('provenance') or {}).get('configuration')
        if declared != provenance_ref:
            raise api_error(422, 'configuration_mismatch', 'Job configuration must match its recorded provenance.')
        if not declared:
            return None
        from pydantic import ValidationError
        try:
            ref = ArtifactRef.model_validate(declared)
        except ValidationError as exc:
            raise api_error(422, 'invalid_configuration', str(exc)) from exc
        artifact, version = await resolve_version(session, ref, user)
        if artifact.kind != 'ExecutionConfiguration':
            raise api_error(422, 'invalid_configuration', 'Job configuration must be an ExecutionConfiguration version.')
        return version
    for declaration in package.get("studies", []):
        _, definition_version = await resolve_version(session, ArtifactRef.model_validate(declaration.get('definitionRef')), user)
        from ..studies import definition_from_version
        if declaration.get('definition') != definition_from_version(definition_version):
            raise api_error(422, 'study_definition_mismatch', 'The projected study definition differs from its sealed version.')
        study = (await session.execute(select(Study).where(
            Study.project_id == found_project.id, Study.slug == declaration.get("slug")
        ))).scalars().first()
        if study is None:
            study = Study(
                project_id=found_project.id, slug=declaration["slug"], name=declaration["name"],
                description=str(declaration.get("description", "")),
                definition_version=definition_version, archived=bool(declaration.get('archived', False)),
                state=StudyState(declaration.get("state", "ready")), created_by_id=user.id,
            )
            session.add(study)
            await session.flush()
            counts["studies"] += 1
        study_map[str(declaration.get("id"))] = study
        for run_data in sorted(declaration.get("runs", []), key=lambda item: item.get("number", 0)):
            _, run_definition = await resolve_version(session, ArtifactRef.model_validate(run_data.get('definitionRef')), user)
            if run_definition.artifact_id != definition_version.artifact_id:
                raise api_error(422, 'foreign_study_version', 'A run must pin a version of its study artifact.')
            from ..studies import definition_from_version, expand_study
            from ..models.platform import StudyDefinition
            expected_cells = expand_study(StudyDefinition.model_validate(definition_from_version(run_definition)))
            actual_cells = sorted(run_data.get('cells', []), key=lambda item: item.get('ordinal', 0))
            if len(expected_cells) != len(actual_cells) or run_data.get('matrixDigest') != digest([cell['fingerprint'] for cell in expected_cells]):
                raise api_error(422, 'study_matrix_mismatch', 'The imported matrix must match its exact study definition.')
            for expected, actual in zip(expected_cells, actual_cells):
                if any(actual.get(key) != value for key, value in expected.items()):
                    raise api_error(422, 'study_cell_mismatch', 'An imported cell differs from its sealed study definition.')
            run = (await session.execute(select(StudyRun).where(
                StudyRun.study_id == study.id, StudyRun.definition_version_id == run_definition.id, StudyRun.matrix_digest == run_data.get("matrixDigest")
            ))).scalars().first()
            if run is None:
                next_number = int(await session.scalar(select(func.max(StudyRun.run_number)).where(
                    StudyRun.study_id == study.id
                )) or 0) + 1
                run_state = str(run_data.get("state", "completed"))
                if run_state in {"queued", "running"}:
                    run_state = "cancelled"
                original_run_id = uuid.UUID(run_data['id'])
                original_run = await session.get(StudyRun, original_run_id)
                if original_run is not None and (original_run.matrix_digest != run_data['matrixDigest'] or original_run.definition_version_id != run_definition.id):
                    raise api_error(409, 'run_identity_conflict', 'An existing run differs from the imported definition or matrix.')
                run = StudyRun(
                    id=uuid.uuid4() if original_run else original_run_id,
                    study_id=study.id, definition_version_id=run_definition.id, run_number=next_number, state=RunState(run_state),
                    matrix_digest=run_data["matrixDigest"], summary=run_data.get("summary") or {},
                    created_by_id=user.id,
                )
                session.add(run)
                await session.flush()
                counts["studyRuns"] += 1
                for cell_data in sorted(run_data.get("cells", []), key=lambda item: item.get("ordinal", 0)):
                    case_revision = await session.get(BindingCaseRevision, uuid.UUID(cell_data["caseRevisionId"]))
                    if case_revision is None:
                        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_portable_package", "A study cell references an unknown case revision.")
                    imported_job = None
                    job_data = cell_data.get("job")
                    if isinstance(job_data, dict):
                        configuration_version = await imported_configuration(job_data)
                        job_state = str(job_data.get("state", "completed"))
                        if job_state in {"queued", "running"}:
                            job_state = "cancelled"
                        original_job_id = uuid.UUID(job_data['id'])
                        imported_job = await session.get(Job, original_job_id)
                        if imported_job is not None:
                            if (imported_job.owner_id != user.id and imported_job.organization_id != organization.id) or any(
                                digest(getattr(imported_job, column)) != digest(job_data.get(key))
                                for column, key in [('result', 'result'), ('original_request', 'request'), ('provenance', 'provenance')]
                            ):
                                raise api_error(409, 'job_identity_conflict', 'The imported job conflicts with existing evidence.')
                        else:
                            imported_job = Job(
                                configuration_version_id=configuration_version.id if configuration_version else None,
                                id=original_job_id, owner_id=user.id, engine_id=str(job_data.get("engineId", "imported")),
                                engine_job_id=f"imported-{job_data.get('id', uuid.uuid4().hex)}",
                                service_url="package://imported", state=JobState(job_state),
                                original_request=job_data.get("request"), options=job_data.get("options"),
                                result=job_data.get("result"), termination=job_data.get("termination"),
                                provenance=job_data.get("provenance"), metered=True,
                                concurrency_released=True, organization_id=organization.id,
                                project_id=found_project.id,
                                billing_sponsor_user_id=organization.billing_sponsor_user_id,
                            )
                            session.add(imported_job)
                            await session.flush()
                    cell_state = str(cell_data.get("state", "completed"))
                    if cell_state in {"queued", "running"}:
                        cell_state = "cancelled"
                    session.add(StudyCell(
                        study_run_id=run.id, ordinal=int(cell_data.get("ordinal", 0)),
                        binding_case_revision_id=case_revision.id,
                        engine_ref=cell_data.get("engine") or {}, parameters=cell_data.get("parameters") or {},
                        seed=int(cell_data.get("seed", 0)), fingerprint=cell_data["fingerprint"],
                        job_id=imported_job.id if imported_job else None,
                        state=RunState(cell_state), metrics=cell_data.get("metrics") or {},
                    ))
                    counts["studyCells"] += 1
            run_map[str(run_data.get("id"))] = run

    for job_data in _portable_objects(package, 'evidenceJobs', 'package'):
        configuration_version = await imported_configuration(job_data)
        identity = uuid.UUID(job_data['id'])
        existing_job = await session.get(Job, identity)
        if existing_job is not None:
            if (existing_job.owner_id != user.id and existing_job.organization_id != organization.id) or any(digest(getattr(existing_job, column)) != digest(job_data.get(key)) for column, key in [('result', 'result'), ('original_request', 'request'), ('provenance', 'provenance')]):
                raise api_error(409, 'evidence_identity_conflict', 'The imported job evidence collides with inaccessible or different results.')
            continue
        if job_data.get('state') not in {'completed', 'failed', 'cancelled'}:
            raise api_error(422, 'nonterminal_evidence', 'Only terminal job evidence can be imported.')
        session.add(Job(id=identity, owner_id=user.id, engine_id=job_data['engineId'],
            configuration_version_id=configuration_version.id if configuration_version else None,
            engine_job_id='imported-' + str(identity), service_url='package://imported', state=JobState(job_data['state']),
            original_request=job_data.get('request'), options=job_data.get('options'), result=job_data.get('result'),
            termination=job_data.get('termination'), provenance=job_data.get('provenance'), metered=True,
            concurrency_released=True, organization_id=organization.id, project_id=found_project.id,
            billing_sponsor_user_id=organization.billing_sponsor_user_id))
    await session.flush()
    await import_available_library()
    if pending_library:
        raise api_error(422, 'incomplete_evidence_closure', 'Report versions require all their exact terminal sources.')
    for entry in _portable_objects(package, 'projectArtifacts', 'package'):
        artifact, version = await resolve_version(session, ArtifactRef.model_validate(entry), user)
        if artifact.organization_id != organization.id:
            from ..db.models import ArtifactPublication
            if await session.get(ArtifactPublication, version.id) is None:
                raise api_error(422, 'private_dependency', 'Another organization can only consume public artifacts.')
        if await session.get(ProjectArtifact, (found_project.id, artifact.id)) is None:
            session.add(ProjectArtifact(project_id=found_project.id, artifact_id=artifact.id))
            await session.flush()

    report_map: dict[str, Report] = {}
    for declaration in package.get("reports", []):
        document = declaration.get("document")
        if not isinstance(document, dict) or declaration.get("digest") != digest(document):
            raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "checksum_mismatch", "A report digest does not match its document.")
        report = (await session.execute(select(Report).where(
            Report.project_id == found_project.id, Report.slug == declaration.get("slug")
        ))).scalars().first()
        if report is None:
            source_run = declaration.get("studyRunId")
            if declaration.get('state') == 'frozen':
                artifact, version = await resolve_version(session, ArtifactRef.model_validate(declaration.get('versionRef')), user)
                if artifact.kind != 'Report' or version.content_digest != declaration['digest']:
                    raise api_error(422, 'report_version_mismatch', 'The report must match its exact library version.')
                report = Report(project_id=found_project.id, artifact_id=artifact.id, version=version,
                    study_run_id=uuid.UUID(source_run) if source_run else None,
                    slug=declaration['slug'], title=declaration['title'],
                    state=ReportState.FROZEN, created_by_id=user.id)
                session.add(report)
                await session.flush()
            else:
                from ..reports import create_report_context
                report = await create_report_context(session, found_project, user, slug=declaration['slug'],
                    title=declaration['title'], document=document,
                    study_run_id=run_map[str(source_run)].id if str(source_run) in run_map else None)
            counts["reports"] += 1
        report_map[str(declaration.get("id"))] = report

    for declaration in package.get("publications", []):
        report = report_map.get(str(declaration.get("reportId")))
        if report is None or report.state is not ReportState.FROZEN:
            raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_portable_package", "A publication requires an imported frozen report.")
        _, publication_version = await resolve_version(session, ArtifactRef.model_validate(declaration.get('versionRef')), user)
        if publication_version.artifact_id != report.artifact_id:
            raise api_error(422, 'foreign_report_version', 'A publication must identify a version of its report.')
        # A portable citation is not authority to expose private library content.
        # Publication is a separate explicit operation with closure checks.
        from ..db.models import ArtifactPublication
        public_version = await session.get(ArtifactPublication, publication_version.id)
        if public_version is None:
            raise api_error(409, 'unpublished_import', 'Publish the exact report version before importing its public citation.')
        if public_version.withdrawn and not declaration.get('withdrawn', False):
            raise api_error(409, 'publication_withdrawn', 'An import cannot restore a withdrawn publication.')
        exists = await session.scalar(select(func.count(Publication.id)).where(
            (Publication.project_id == found_project.id) & (Publication.slug == declaration.get("slug"))
            | ((Publication.report_id == report.id) & (Publication.version_id == publication_version.id))
        ))
        if not exists:
            session.add(Publication(
                project_id=found_project.id, report_id=report.id, version_id=publication_version.id,
                withdrawn=bool(declaration.get("withdrawn", False)), slug=declaration["slug"],
                citation=declaration.get("citation") or {}, published_by_id=user.id,
            ))
            counts["publications"] += 1

    for declaration in package.get("artifacts", []):
        try:
            content = (
                archive.read(declaration["path"])
                if archive is not None and declaration.get("path")
                else base64.b64decode(declaration["contentBase64"], validate=True)
            )
        except (KeyError, ValueError, binascii.Error) as exc:
            raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_portable_package", "An artifact body is missing or malformed.") from exc
        artifact_digest = f"sha256-{hashlib.sha256(content).hexdigest()}"
        if declaration.get("digest") != artifact_digest or declaration.get("size") != len(content):
            raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "checksum_mismatch", "An artifact digest or size does not match its content.")
        existing = (await session.execute(select(Blob).where(
            Blob.project_id == found_project.id, Blob.digest == artifact_digest
        ))).scalars().first()
        if existing is not None:
            continue
        await _storage_limit(session, organization, len(content))
        destination = _artifact_path(settings, artifact_digest)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            with tempfile.NamedTemporaryFile(dir=Path(settings.artifact_root), delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(content)
            os.replace(temporary, destination)
        session.add(Blob(
            organization_id=organization.id, project_id=found_project.id,
            digest=artifact_digest, media_type=str(declaration.get("mediaType", "application/octet-stream")),
            size_bytes=len(content), storage_uri=str(destination),
            public=bool(declaration.get("public")) and found_project.visibility is Visibility.PUBLIC,
            created_by_id=user.id,
        ))
        counts["artifacts"] += 1

    session.add(AuditEvent(
        organization_id=organization.id, actor_id=user.id, action="project.package.imported",
        target_type="Project", target_id=found_project.id,
        detail={**counts, "packageDigest": expected_package_digest},
    ))
    return {"imported": counts, "packageDigest": expected_package_digest}

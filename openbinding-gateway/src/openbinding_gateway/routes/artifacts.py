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
    Artifact,
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
    Visibility,
)
from ..models.errors import api_error
from ..models.platform import ArtifactView
from ..v1.canonical import CanonicalizationError, digest
from ..v1.package import PackageError, strict_json_loads

router = APIRouter(prefix="/v1/organizations/{org}/projects/{project}", tags=["Artifacts"])
public_router = APIRouter(prefix="/v1/public", tags=["Explore"])


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


async def _context(session, org, project, user, minimum):
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    found_project = await require_project(session, organization, project, user, minimum)
    return organization, found_project


def _artifact_view(value: Artifact) -> ArtifactView:
    return ArtifactView.model_validate(value, from_attributes=True)


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
        select(func.coalesce(func.sum(Artifact.size_bytes), 0))
        .join(Organization, Organization.id == Artifact.organization_id)
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


@router.get("/artifacts", response_model=list[ArtifactView], operation_id="listArtifacts")
async def list_artifacts(
    org: str, project: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[ArtifactView]:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    rows = (await session.execute(select(Artifact).where(Artifact.project_id == found_project.id).order_by(Artifact.created_at.desc()))).scalars().all()
    return [_artifact_view(row) for row in rows]


@router.post("/artifacts", response_model=ArtifactView, status_code=201, operation_id="uploadArtifact")
async def upload_artifact(
    org: str,
    project: str,
    request: Request,
    public: bool = Query(default=False),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> ArtifactView:
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
    existing = (await session.execute(select(Artifact).where(
        Artifact.project_id == found_project.id, Artifact.digest == digest_value
    ))).scalars().first()
    if existing is not None:
        return _artifact_view(existing)
    value = Artifact(
        organization_id=organization.id, project_id=found_project.id,
        digest=digest_value, media_type=request.headers.get("content-type", "application/octet-stream"),
        size_bytes=size, storage_uri=str(destination), public=public,
        created_by_id=user.id,
    )
    session.add(value)
    await session.flush()
    session.add(AuditEvent(
        organization_id=organization.id, actor_id=user.id, action="artifact.uploaded",
        target_type="Artifact", target_id=value.id, detail={"digest": digest_value, "public": public},
    ))
    return _artifact_view(value)


@router.get(
    "/artifacts/{digest_value}",
    operation_id="downloadArtifact",
    response_class=FileResponse,
    responses={200: {"content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}}},
)
async def download_artifact(
    org: str, project: str, digest_value: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    _, found_project = await _context(session, org, project, user, OrganizationRole.VIEWER)
    artifact = (await session.execute(select(Artifact).where(
        Artifact.project_id == found_project.id, Artifact.digest == digest_value
    ))).scalars().first()
    if artifact is None or not Path(artifact.storage_uri).is_file():
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Artifact not found.")
    return FileResponse(
        artifact.storage_uri, media_type=artifact.media_type,
        headers={"ETag": f'"{artifact.digest}"', "Cache-Control": "no-store"},
    )


@public_router.get(
    "/artifacts/{digest_value}",
    operation_id="downloadPublicArtifact",
    response_class=FileResponse,
    responses={200: {"content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}}},
)
async def download_public_artifact(
    digest_value: str,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    artifact = (await session.execute(select(Artifact).where(
        Artifact.digest == digest_value, Artifact.public.is_(True)
    ).join(
        Project, Project.id == Artifact.project_id
    ).where(
        Project.visibility == Visibility.PUBLIC
    ))).scalars().first()
    if artifact is None or not Path(artifact.storage_uri).is_file():
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Public artifact not found.")
    return FileResponse(
        artifact.storage_uri, media_type=artifact.media_type,
        headers={
            "ETag": f'"{artifact.digest}"',
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


def _immutable_json(document: dict, digest_value: str) -> Response:
    return JSONResponse(
        document,
        headers={
            "ETag": f'"{digest_value}"',
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


@public_router.get(
    "/case-revisions/{digest_value}",
    operation_id="getPublicCaseRevision",
    responses={200: {"content": {"application/json": {"schema": {"type": "object"}}}}},
)
async def public_case_revision(
    digest_value: str,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    row = (
        await session.execute(
            select(BindingCaseRevision)
            .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
            .join(Project, Project.id == BindingCase.project_id)
            .where(BindingCaseRevision.digest == digest_value, Project.visibility == "public")
        )
    ).scalars().first()
    if row is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Public case revision not found.")
    return _immutable_json(row.document, row.digest)


@public_router.get(
    "/resource-revisions/{digest_value}",
    operation_id="getPublicProjectResourceRevision",
    responses={200: {"content": {"application/json": {"schema": {"type": "object"}}}}},
)
async def public_project_resource_revision(
    digest_value: str,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    row = (
        await session.execute(
            select(ProjectResourceRevision)
            .join(ProjectResource, ProjectResource.id == ProjectResourceRevision.project_resource_id)
            .join(Project, Project.id == ProjectResource.project_id)
            .where(ProjectResourceRevision.digest == digest_value, Project.visibility == "public")
        )
    ).scalars().first()
    if row is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Public resource revision not found.")
    return _immutable_json(row.document, row.digest)


@public_router.get(
    "/reports/{digest_value}",
    operation_id="getPublishedReportByDigest",
    responses={200: {"content": {"application/json": {"schema": {"type": "object"}}}}},
)
async def published_report_by_digest(
    digest_value: str,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    row = (
        await session.execute(
            select(Report)
            .join(Publication, Publication.report_id == Report.id)
            .join(Project, Project.id == Publication.project_id)
            .where(Report.digest == digest_value, Project.visibility == "public")
        )
    ).scalars().first()
    if row is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Published report not found.")
    return _immutable_json(row.document, row.digest)


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
    resources = (await session.execute(select(ProjectResource).where(ProjectResource.project_id == found_project.id))).scalars().all()
    resource_ids = [resource.id for resource in resources]
    resource_revisions = (await session.execute(select(ProjectResourceRevision).where(ProjectResourceRevision.project_resource_id.in_(resource_ids)))).scalars().all() if resource_ids else []
    collections = (await session.execute(select(Collection).where(Collection.project_id == found_project.id))).scalars().all()
    collection_ids = [collection.id for collection in collections]
    collection_revisions = (await session.execute(select(CollectionRevision).where(CollectionRevision.collection_id.in_(collection_ids)))).scalars().all() if collection_ids else []
    collection_revision_ids = [revision.id for revision in collection_revisions]
    collection_items = (await session.execute(select(CollectionItem).where(CollectionItem.collection_revision_id.in_(collection_revision_ids)))).scalars().all() if collection_revision_ids else []
    studies = (await session.execute(select(Study).where(Study.project_id == found_project.id))).scalars().all()
    study_ids = [study.id for study in studies]
    runs = (await session.execute(select(StudyRun).where(StudyRun.study_id.in_(study_ids)))).scalars().all() if study_ids else []
    run_ids = [run.id for run in runs]
    cells = (await session.execute(select(StudyCell).where(StudyCell.study_run_id.in_(run_ids)))).scalars().all() if run_ids else []
    job_ids = [cell.job_id for cell in cells if cell.job_id]
    jobs = (await session.execute(select(Job).where(Job.id.in_(job_ids)))).scalars().all() if job_ids else []
    reports = (await session.execute(select(Report).where(Report.project_id == found_project.id))).scalars().all()
    publications = (await session.execute(select(Publication).where(Publication.project_id == found_project.id))).scalars().all()
    artifacts = (await session.execute(select(Artifact).where(Artifact.project_id == found_project.id))).scalars().all()
    revisions_by_case: dict[str, list[BindingCaseRevision]] = {}
    for revision in revisions:
        revisions_by_case.setdefault(str(revision.binding_case_id), []).append(revision)
    revisions_by_resource: dict[str, list[ProjectResourceRevision]] = {}
    for revision in resource_revisions:
        revisions_by_resource.setdefault(str(revision.project_resource_id), []).append(revision)
    revisions_by_collection: dict[str, list[CollectionRevision]] = {}
    for revision in collection_revisions:
        revisions_by_collection.setdefault(str(revision.collection_id), []).append(revision)
    items_by_revision: dict[str, list[CollectionItem]] = {}
    for item in collection_items:
        items_by_revision.setdefault(str(item.collection_revision_id), []).append(item)
    runs_by_study: dict[str, list[StudyRun]] = {}
    for run in runs:
        runs_by_study.setdefault(str(run.study_id), []).append(run)
    cells_by_run: dict[str, list[StudyCell]] = {}
    for cell in cells:
        cells_by_run.setdefault(str(cell.study_run_id), []).append(cell)
    jobs_by_id = {job.id: job for job in jobs}

    def timestamp(value) -> str | None:
        return value.isoformat() if value else None

    package = {
        "apiVersion": "openbinding.dev/package/v1",
        "organization": {"slug": organization.slug, "name": organization.name},
        "project": {"slug": found_project.slug, "name": found_project.name, "description": found_project.description, "visibility": found_project.visibility.value},
        "cases": [{
            "id": str(case.id), "slug": case.slug, "name": case.name,
            "description": case.description,
            "revisions": [{
                "id": str(item.id), "revision": item.revision, "digest": item.digest,
                "document": item.document, "createdAt": timestamp(item.created_at),
            } for item in sorted(revisions_by_case.get(str(case.id), []), key=lambda value: value.revision)],
        } for case in cases],
        "resources": [{
            "id": str(resource.id), "slug": resource.slug, "name": resource.name,
            "description": resource.description, "kind": resource.kind,
            "revisions": [{
                "id": str(item.id), "revision": item.revision, "digest": item.digest,
                "document": item.document, "createdAt": timestamp(item.created_at),
            } for item in sorted(revisions_by_resource.get(str(resource.id), []), key=lambda value: value.revision)],
        } for resource in resources],
        "collections": [{
            "id": str(collection.id), "slug": collection.slug, "name": collection.name,
            "description": collection.description,
            "revisions": [{
                "id": str(revision.id), "revision": revision.revision,
                "digest": revision.digest,
                "items": [{
                    "kind": item.target_kind, "digest": item.target_digest,
                    "ref": item.target_ref,
                } for item in sorted(items_by_revision.get(str(revision.id), []), key=lambda value: value.position)],
            } for revision in sorted(revisions_by_collection.get(str(collection.id), []), key=lambda value: value.revision)],
        } for collection in collections],
        "studies": [{
            "id": str(study.id), "slug": study.slug, "name": study.name,
            "description": study.description, "definition": study.definition,
            "state": study.state.value,
            "runs": [{
                "id": str(run.id), "number": run.run_number, "state": run.state.value,
                "matrixDigest": run.matrix_digest, "summary": run.summary,
                "createdAt": timestamp(run.created_at), "finishedAt": timestamp(run.finished_at),
                "cells": [{
                    "id": str(cell.id), "ordinal": cell.ordinal,
                    "caseRevisionId": str(cell.binding_case_revision_id),
                    "engine": cell.engine_ref, "parameters": cell.parameters,
                    "seed": cell.seed, "fingerprint": cell.fingerprint,
                    "state": cell.state.value, "metrics": cell.metrics,
                    "job": ({
                        "id": str(jobs_by_id[cell.job_id].id),
                        "engineId": jobs_by_id[cell.job_id].engine_id,
                        "state": jobs_by_id[cell.job_id].state.value,
                        "request": jobs_by_id[cell.job_id].original_request,
                        "options": jobs_by_id[cell.job_id].options,
                        "result": jobs_by_id[cell.job_id].result,
                        "termination": jobs_by_id[cell.job_id].termination,
                        "provenance": jobs_by_id[cell.job_id].provenance,
                        "createdAt": timestamp(jobs_by_id[cell.job_id].created_at),
                        "finishedAt": timestamp(jobs_by_id[cell.job_id].finished_at),
                    } if cell.job_id in jobs_by_id else None),
                } for cell in sorted(cells_by_run.get(str(run.id), []), key=lambda value: value.ordinal)],
            } for run in sorted(runs_by_study.get(str(study.id), []), key=lambda value: value.run_number)],
        } for study in studies],
        "reports": [{
            "id": str(report.id), "studyRunId": str(report.study_run_id) if report.study_run_id else None,
            "slug": report.slug, "title": report.title, "document": report.document,
            "digest": report.digest, "state": report.state.value,
        } for report in reports],
        "publications": [{
            "slug": publication.slug, "reportId": str(publication.report_id),
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
            if not isinstance(document, dict) or revision_data.get("digest") != digest(document):
                raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "checksum_mismatch", "A case revision digest does not match its document.")
            revision = (await session.execute(select(BindingCaseRevision).where(
                BindingCaseRevision.binding_case_id == existing.id,
                BindingCaseRevision.digest == revision_data["digest"],
            ))).scalars().first()
            if revision is None:
                latest = int(await session.scalar(select(func.max(BindingCaseRevision.revision)).where(
                    BindingCaseRevision.binding_case_id == existing.id
                )) or 0)
                revision = BindingCaseRevision(
                    binding_case_id=existing.id, revision=latest + 1,
                    digest=revision_data["digest"], document=document, created_by_id=user.id,
                )
                session.add(revision)
                await session.flush()
                counts["caseRevisions"] += 1
            case_revision_map[str(revision_data.get("id"))] = revision

    resource_map: dict[str, ProjectResource] = {}
    resource_revision_map: dict[str, ProjectResourceRevision] = {}
    for declaration in package.get("resources", []):
        if not isinstance(declaration, dict) or not all(isinstance(declaration.get(key), str) for key in ("id", "slug", "name")):
            raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_portable_package", "Malformed resource declaration.")
        resource = (await session.execute(select(ProjectResource).where(
            ProjectResource.project_id == found_project.id, ProjectResource.slug == declaration["slug"]
        ))).scalars().first()
        if resource is None:
            resource = ProjectResource(
                project_id=found_project.id, slug=declaration["slug"], name=declaration["name"],
                description=str(declaration.get("description", "")),
                kind=str(declaration.get("kind", "bim-resource")), created_by_id=user.id,
            )
            session.add(resource)
            await session.flush()
            counts["resources"] += 1
        resource_map[declaration["id"]] = resource
        for revision_data in sorted(declaration.get("revisions", []), key=lambda item: item.get("revision", 0)):
            document = revision_data.get("document")
            if not isinstance(document, dict) or revision_data.get("digest") != digest(document):
                raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "checksum_mismatch", "A resource revision digest does not match its document.")
            revision = (await session.execute(select(ProjectResourceRevision).where(
                ProjectResourceRevision.project_resource_id == resource.id,
                ProjectResourceRevision.digest == revision_data["digest"],
            ))).scalars().first()
            if revision is None:
                latest = int(await session.scalar(select(func.max(ProjectResourceRevision.revision)).where(
                    ProjectResourceRevision.project_resource_id == resource.id
                )) or 0)
                revision = ProjectResourceRevision(
                    project_resource_id=resource.id, revision=latest + 1,
                    digest=revision_data["digest"], document=document, created_by_id=user.id,
                )
                session.add(revision)
                await session.flush()
                counts["resourceRevisions"] += 1
            resource_revision_map[str(revision_data.get("id"))] = revision

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

    collection_revision_map: dict[str, CollectionRevision] = {}
    for declaration in package.get("collections", []):
        collection = (await session.execute(select(Collection).where(
            Collection.project_id == found_project.id, Collection.slug == declaration.get("slug")
        ))).scalars().first()
        if collection is None:
            collection = Collection(
                project_id=found_project.id, slug=declaration["slug"], name=declaration["name"],
                description=str(declaration.get("description", "")), created_by_id=user.id,
            )
            session.add(collection)
            await session.flush()
            counts["collections"] += 1
        for revision_data in sorted(declaration.get("revisions", []), key=lambda item: item.get("revision", 0)):
            raw_items = [{
                "target_kind": item.get("kind"), "target_digest": item.get("digest"),
                "target_ref": item.get("ref") or {},
            } for item in revision_data.get("items", [])]
            if revision_data.get("digest") != digest(raw_items):
                raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "checksum_mismatch", "A collection revision digest does not match its ordered items.")
            normalized_items = [
                {**item, "target_ref": remap_ref(item["target_ref"])} for item in raw_items
            ]
            revision_digest = digest(normalized_items)
            revision = (await session.execute(select(CollectionRevision).where(
                CollectionRevision.collection_id == collection.id,
                CollectionRevision.digest == revision_digest,
            ))).scalars().first()
            if revision is None:
                latest = int(await session.scalar(select(func.max(CollectionRevision.revision)).where(
                    CollectionRevision.collection_id == collection.id
                )) or 0)
                revision = CollectionRevision(
                    collection_id=collection.id, revision=latest + 1,
                    digest=revision_digest, created_by_id=user.id,
                )
                session.add(revision)
                await session.flush()
                for position, item in enumerate(normalized_items):
                    session.add(CollectionItem(
                        collection_revision_id=revision.id, position=position,
                        target_kind=item["target_kind"], target_digest=item["target_digest"],
                        target_ref=item["target_ref"], added_by_id=user.id,
                    ))
                counts["collectionRevisions"] += 1
            collection_revision_map[str(revision_data.get("id"))] = revision

    study_map: dict[str, Study] = {}
    run_map: dict[str, StudyRun] = {}
    for declaration in package.get("studies", []):
        definition = dict(declaration.get("definition") or {})
        definition["case_revision_ids"] = [
            str(case_revision_map[str(source)].id)
            for source in definition.get("case_revision_ids", [])
            if str(source) in case_revision_map
        ]
        source_collection = definition.get("collection_revision_id")
        if source_collection:
            mapped = collection_revision_map.get(str(source_collection))
            definition["collection_revision_id"] = str(mapped.id) if mapped else None
        study = (await session.execute(select(Study).where(
            Study.project_id == found_project.id, Study.slug == declaration.get("slug")
        ))).scalars().first()
        if study is None:
            study = Study(
                project_id=found_project.id, slug=declaration["slug"], name=declaration["name"],
                description=str(declaration.get("description", "")), definition=definition,
                state=StudyState(declaration.get("state", "ready")), created_by_id=user.id,
            )
            session.add(study)
            await session.flush()
            counts["studies"] += 1
        study_map[str(declaration.get("id"))] = study
        for run_data in sorted(declaration.get("runs", []), key=lambda item: item.get("number", 0)):
            run = (await session.execute(select(StudyRun).where(
                StudyRun.study_id == study.id, StudyRun.matrix_digest == run_data.get("matrixDigest")
            ))).scalars().first()
            if run is None:
                next_number = int(await session.scalar(select(func.max(StudyRun.run_number)).where(
                    StudyRun.study_id == study.id
                )) or 0) + 1
                run_state = str(run_data.get("state", "completed"))
                if run_state in {"queued", "running"}:
                    run_state = "cancelled"
                run = StudyRun(
                    study_id=study.id, run_number=next_number, state=RunState(run_state),
                    matrix_digest=run_data["matrixDigest"], summary=run_data.get("summary") or {},
                    created_by_id=user.id,
                )
                session.add(run)
                await session.flush()
                counts["studyRuns"] += 1
                for cell_data in sorted(run_data.get("cells", []), key=lambda item: item.get("ordinal", 0)):
                    case_revision = case_revision_map.get(str(cell_data.get("caseRevisionId")))
                    if case_revision is None:
                        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_portable_package", "A study cell references an unknown case revision.")
                    imported_job = None
                    job_data = cell_data.get("job")
                    if isinstance(job_data, dict):
                        job_state = str(job_data.get("state", "completed"))
                        if job_state in {"queued", "running"}:
                            job_state = "cancelled"
                        imported_job = Job(
                            owner_id=user.id, engine_id=str(job_data.get("engineId", "imported")),
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
            report = Report(
                project_id=found_project.id,
                study_run_id=run_map[str(source_run)].id if str(source_run) in run_map else None,
                slug=declaration["slug"], title=declaration["title"], document=document,
                digest=declaration["digest"], state=ReportState(declaration.get("state", "draft")),
                created_by_id=user.id,
            )
            session.add(report)
            await session.flush()
            counts["reports"] += 1
        report_map[str(declaration.get("id"))] = report

    for declaration in package.get("publications", []):
        report = report_map.get(str(declaration.get("reportId")))
        if report is None or report.state is not ReportState.FROZEN:
            raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_portable_package", "A publication requires an imported frozen report.")
        exists = await session.scalar(select(func.count(Publication.id)).where(
            (Publication.project_id == found_project.id) & (Publication.slug == declaration.get("slug"))
            | (Publication.report_id == report.id)
        ))
        if not exists:
            session.add(Publication(
                project_id=found_project.id, report_id=report.id, slug=declaration["slug"],
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
        existing = (await session.execute(select(Artifact).where(
            Artifact.project_id == found_project.id, Artifact.digest == artifact_digest
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
        session.add(Artifact(
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

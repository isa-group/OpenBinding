"""Organization artifact library, read-only: versions are sealed by the internal services.

Since M9.6 no route creates, renames, drafts, seals, publishes or withdraws a library artifact, and the project
library association is gone (design.md §2.1 rows 16 to 28), so none of them is routed or documented.
"""
# [impl->req~collaboration-artifacts-library-read-only~1]
# [impl->req~gateway-api-removed-operations-not-routed~1]
# [impl->req~gateway-api-removed-operations-not-documented~1]
from __future__ import annotations

import re
import uuid
import json
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, get_optional_user, session_dependency
from ..artifacts import (artifact_view, can_read, owned_artifact, reference, resolve_version, version_content,
    version_view)
from ..collaboration import organization_by_ref, require_role
from ..db.models import (Artifact, ArtifactDependency, ArtifactPublication, ArtifactVersion, ArtifactCaseReference,
    BindingCase, BindingCaseRevision, Project, Visibility, CaseArtifact, OrganizationRole, User)
from ..models.artifacts import ArtifactRef, ArtifactView, ArtifactVersionView, PublishVersion
from ..models.errors import api_error

router = APIRouter(prefix='/v1', tags=['Artifact library'])


def _safe_filename(value: str) -> str:
    """A download name made of ``[A-Za-z0-9._-]`` only; anything else becomes ``_``."""
    return re.sub(r'[^A-Za-z0-9._-]', '_', value) or 'download'


async def _version(session, artifact_id, version_id, user):
    artifact = await session.get(Artifact, artifact_id)
    version = await session.get(ArtifactVersion, version_id)
    if artifact is None or version is None or version.artifact_id != artifact.id or not await can_read(session, artifact, user, version):
        raise api_error(404, 'not_found', 'Artifact version not found.')
    return await resolve_version(session, reference(artifact, version), user)


@router.get('/organizations/{org}/library', response_model=list[ArtifactView])
async def list_artifacts(org: str, kind: str | None = None, q: str = '',
    include_public: bool = False, user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope='function')) -> list[dict]:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(404, 'not_found', 'Organization not found.')
    await require_role(session, organization, user, OrganizationRole.VIEWER)
    query = select(Artifact).where(Artifact.archived.is_(False))
    if include_public:
        published = select(ArtifactVersion.artifact_id).join(ArtifactPublication).where(ArtifactPublication.withdrawn.is_(False))
        query = query.where(or_(Artifact.organization_id == organization.id, Artifact.id.in_(published)))
    else:
        query = query.where(Artifact.organization_id == organization.id)
    if kind:
        query = query.where(Artifact.kind == kind)
    if q:
        query = query.where(Artifact.display_name.ilike('%' + q.replace('%', '\\%').replace('_', '\\_') + '%', escape='\\'))
    rows = (await session.scalars(query.order_by(Artifact.display_name))).all()
    return [artifact_view(row) for row in rows if await can_read(session, row, user)]


@router.get('/artifacts/{artifact_id}/versions', response_model=list[ArtifactVersionView])
async def list_versions(artifact_id: uuid.UUID, user: User | None = Depends(get_optional_user),
    session: AsyncSession = Depends(session_dependency, scope='function')) -> list[dict]:
    artifact = await session.get(Artifact, artifact_id)
    if artifact is None or not await can_read(session, artifact, user):
        raise api_error(404, 'not_found', 'Artifact not found.')
    versions = (await session.scalars(select(ArtifactVersion).where(ArtifactVersion.artifact_id == artifact.id)
        .order_by(ArtifactVersion.ordinal.desc()))).all()
    return [version_view(artifact, version, await session.get(ArtifactPublication, version.id))
            for version in versions if await can_read(session, artifact, user, version)]


@router.get('/artifacts/{artifact_id}/versions/{version_id}/content', response_class=Response,
    responses={200: {'description': 'Verified original bytes; Content-Type is the sealed manifest mediaType.',
        'content': {'application/octet-stream': {'schema': {'type': 'string', 'format': 'binary'}}}}})
async def get_content(artifact_id: uuid.UUID, version_id: uuid.UUID,
    user: User | None = Depends(get_optional_user), session: AsyncSession = Depends(session_dependency, scope='function')) -> Response:
    _, version = await _version(session, artifact_id, version_id, user)
    content, media_type = await version_content(session, version)
    public = await session.get(ArtifactPublication, version.id) is not None
    # The media type comes from the sealed manifest and is chosen by the uploader: the bytes are never rendered
    # inline in the origin of the SPA, whatever they claim to be.
    return Response(content, media_type=media_type, headers={'ETag': '"' + version.content_digest + '"',
        'Cache-Control': 'public, max-age=31536000, immutable' if public else 'private, no-store',
        'Content-Disposition': f'attachment; filename="{_safe_filename(version.content_digest)}"',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox"})


@router.post('/artifacts/resolve', response_model=ArtifactVersionView)
async def resolve_artifact(payload: ArtifactRef, user: User | None = Depends(get_optional_user),
    session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    artifact, version = await resolve_version(session, payload, user)
    return version_view(artifact, version, await session.get(ArtifactPublication, version.id))


# Not routed since M9.6 (design.md §7): no operation makes a version public. The development seeder
# (tools/seed_dev.py) still publishes its demonstration inputs through this function.
async def publish_version(artifact_id: uuid.UUID, version_id: uuid.UUID, payload: PublishVersion,
    user: User, session: AsyncSession) -> dict:
    await owned_artifact(session, artifact_id, user, OrganizationRole.ADMIN)
    artifact, version = await _version(session, artifact_id, version_id, user)
    if artifact.kind in {'Study', 'ExecutionConfiguration'}:
        from ..services.engines import manifest_async
        content = json.loads((await version_content(session, version))[0])
        for engine in content['engines'] if artifact.kind == 'Study' else [content['engine']]:
            try:
                await manifest_async(engine['name'], session, namespace=engine['namespace'],
                    version=engine['version'], manifest_digest=engine['digest'])
            except HTTPException as exc:
                raise api_error(422, 'private_engine_dependency', 'Publish the exact Engine contract before publishing this version.') from exc
    if artifact.kind == 'Report':
        from ..db.models import ArtifactEvidence, Job, StudyRun
        for evidence in await session.scalars(select(ArtifactEvidence).where(ArtifactEvidence.version_id == version.id)):
            if evidence.study_run_id:
                study_version = await session.scalar(select(StudyRun.definition_version_id).where(StudyRun.id == evidence.study_run_id))
                if await session.get(ArtifactPublication, study_version) is None:
                    raise api_error(422, 'private_evidence', 'Publish the exact study definition before publishing its report.')
            if evidence.job_id:
                job_project = await session.scalar(select(Project.visibility).join(Job, Job.project_id == Project.id).where(Job.id == evidence.job_id))
                if job_project != Visibility.PUBLIC:
                    raise api_error(422, 'private_evidence', 'Job evidence must belong to a public project before report publication.')
    targets = (await session.scalars(select(ArtifactDependency.dependency_id).where(ArtifactDependency.version_id == version.id))).all()
    for target in targets:
        if await session.get(ArtifactPublication, target) is None:
            raise api_error(422, 'private_dependency', 'Publish all fixed dependencies before publishing this version.')
    for case_id in await session.scalars(select(ArtifactCaseReference.case_revision_id)
                                        .where(ArtifactCaseReference.version_id == version.id)):
        visibility = await session.scalar(select(Project.visibility)
            .join(BindingCase, BindingCase.project_id == Project.id)
            .join(BindingCaseRevision, BindingCaseRevision.binding_case_id == BindingCase.id)
            .where(BindingCaseRevision.id == case_id))
        resources = (await session.scalars(select(CaseArtifact.version_id)
            .where(CaseArtifact.revision_id == case_id))).all()
        if visibility != Visibility.PUBLIC or not resources:
            raise api_error(422, 'private_case_dependency', 'Referenced cases require a public project and a closed artifact composition.')
        for resource_id in resources:
            if await session.get(ArtifactPublication, resource_id) is None:
                raise api_error(422, 'private_case_dependency', 'Publish every resource consumed by the referenced cases first.')
    publication = await session.get(ArtifactPublication, version.id)
    if publication is None:
        publication = ArtifactPublication(version_id=version.id, citation=payload.citation, published_by_id=user.id)
        session.add(publication)
    elif publication.withdrawn:
        raise api_error(409, 'publication_withdrawn', 'Publish a new version to supersede a withdrawn edition.')
    await session.flush()
    return version_view(artifact, version, publication)


async def withdraw_version(artifact_id: uuid.UUID, version_id: uuid.UUID, user: User, session: AsyncSession) -> dict:
    """Withdraw a public version; used by the kept ``DELETE .../publications/{publication}`` (not routed itself)."""
    await owned_artifact(session, artifact_id, user, OrganizationRole.ADMIN)
    artifact, version = await _version(session, artifact_id, version_id, user)
    publication = await session.get(ArtifactPublication, version.id)
    if publication is None:
        raise api_error(404, 'not_found', 'Publication not found.')
    publication.withdrawn = True
    await session.flush()
    return version_view(artifact, version, publication)

"""Organization artifact library; sealing and public publication are independent."""
from __future__ import annotations

import uuid
import json
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import delete, select, update, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, get_optional_user, session_dependency
from ..artifacts import (artifact_boundary_allows, artifact_view, can_read, owned_artifact, reference, resolve_version,
    seal_draft, validate_content, version_content, version_view)
from ..collaboration import organization_by_ref, require_role, require_project
from ..db.models import (Artifact, ArtifactDependency, ArtifactDraft, ArtifactPublication,
    ArtifactVersion, ArtifactCaseReference, BindingCase, BindingCaseRevision, Project, Visibility, CaseArtifact, OrganizationRole, ProjectArtifact, User)
from ..models.artifacts import (ArtifactCreate, ArtifactRef, ArtifactUpdate, DraftCreate,
    DraftUpdate, PublishVersion, SealDraft, ArtifactView, ArtifactVersionView, ArtifactDraftView, DraftRevisionView)
from ..models.errors import api_error

router = APIRouter(prefix='/v1', tags=['Artifact library'])


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


@router.post('/organizations/{org}/library', status_code=201, response_model=ArtifactView)
async def create_artifact(org: str, payload: ArtifactCreate, user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(404, 'not_found', 'Organization not found.')
    await require_role(session, organization, user, OrganizationRole.MEMBER)
    if not await artifact_boundary_allows(session, organization.id, user, payload.name):
        raise api_error(403, 'api_key_boundary', 'The API key boundary excludes this organization artifact.')
    if 'pricing' in payload.kind.casefold():
        raise api_error(422, 'operational_pricing_only', 'Only the platform operational pricing is supported, through SPHERE.')
    # Namespace is independent of editable organization slugs and display names.
    row = Artifact(organization_id=organization.id, namespace=str(organization.id),
        created_by_id=user.id, **payload.model_dump())
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError as exc:
        raise api_error(409, 'artifact_exists', 'This artifact name already exists in the organization.') from exc
    return artifact_view(row)


@router.get('/artifacts/{artifact_id}', response_model=ArtifactView)
async def get_artifact(artifact_id: uuid.UUID, user: User | None = Depends(get_optional_user),
    session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    row = await session.get(Artifact, artifact_id)
    if row is None or not await can_read(session, row, user):
        raise api_error(404, 'not_found', 'Artifact not found.')
    return artifact_view(row)


@router.patch('/artifacts/{artifact_id}', response_model=ArtifactView)
async def edit_artifact(artifact_id: uuid.UUID, payload: ArtifactUpdate, user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    row = await owned_artifact(session, artifact_id, user)
    for key, value in payload.model_dump(exclude_none=True).items():
        setattr(row, key, value)
    await session.flush()
    return artifact_view(row)


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


@router.get('/artifacts/{artifact_id}/versions/{version_id}', response_model=ArtifactVersionView)
async def get_version(artifact_id: uuid.UUID, version_id: uuid.UUID,
    user: User | None = Depends(get_optional_user), session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    artifact, version = await _version(session, artifact_id, version_id, user)
    return version_view(artifact, version, await session.get(ArtifactPublication, version.id))


@router.get('/artifacts/{artifact_id}/versions/{version_id}/content', response_class=Response,
    responses={200: {'description': 'Verified original bytes; Content-Type is the sealed manifest mediaType.',
        'content': {'application/octet-stream': {'schema': {'type': 'string', 'format': 'binary'}}}}})
async def get_content(artifact_id: uuid.UUID, version_id: uuid.UUID,
    user: User | None = Depends(get_optional_user), session: AsyncSession = Depends(session_dependency, scope='function')) -> Response:
    _, version = await _version(session, artifact_id, version_id, user)
    content, media_type = await version_content(session, version)
    public = await session.get(ArtifactPublication, version.id) is not None
    return Response(content, media_type=media_type, headers={'ETag': '"' + version.content_digest + '"',
        'Cache-Control': 'public, max-age=31536000, immutable' if public else 'private, no-store'})


@router.post('/artifacts/resolve', response_model=ArtifactVersionView)
async def resolve_artifact(payload: ArtifactRef, user: User | None = Depends(get_optional_user),
    session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    artifact, version = await resolve_version(session, payload, user)
    return version_view(artifact, version, await session.get(ArtifactPublication, version.id))


@router.get('/artifacts/{artifact_id}/drafts', response_model=list[ArtifactDraftView])
async def list_drafts(artifact_id: uuid.UUID, user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope='function')) -> list[dict]:
    await owned_artifact(session, artifact_id, user)
    rows = (await session.scalars(select(ArtifactDraft).where(ArtifactDraft.artifact_id == artifact_id,
        ArtifactDraft.sealed_version_id.is_(None)).order_by(ArtifactDraft.updated_at.desc()))).all()
    return [dict(id=row.id, revision=row.revision, payload=row.payload, based_on_id=row.based_on_id) for row in rows]


@router.post('/artifacts/{artifact_id}/drafts', status_code=201, response_model=ArtifactDraftView)
async def create_draft(artifact_id: uuid.UUID, payload: DraftCreate, user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    await owned_artifact(session, artifact_id, user)
    if payload.based_on_id:
        version = await session.get(ArtifactVersion, payload.based_on_id)
        source = await session.get(Artifact, version.artifact_id) if version else None
        if not source or not await can_read(session, source, user, version):
            raise api_error(404, 'not_found', 'Origin version not found.')
    row = ArtifactDraft(artifact_id=artifact_id, payload=payload.model_dump(mode='json', exclude={'based_on_id'}),
        based_on_id=payload.based_on_id, created_by_id=user.id)
    session.add(row)
    await session.flush()
    return dict(id=row.id, revision=row.revision, payload=row.payload, based_on_id=row.based_on_id)


@router.put('/artifacts/{artifact_id}/drafts/{draft_id}', response_model=DraftRevisionView)
async def edit_draft(artifact_id: uuid.UUID, draft_id: uuid.UUID, payload: DraftUpdate,
    user: User = Depends(get_current_user), session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    await owned_artifact(session, artifact_id, user)
    await session.execute(select(Artifact.id).where(Artifact.id == artifact_id).with_for_update())
    changed = await session.execute(update(ArtifactDraft).where(ArtifactDraft.id == draft_id,
        ArtifactDraft.artifact_id == artifact_id, ArtifactDraft.revision == payload.revision,
        ArtifactDraft.sealed_version_id.is_(None)).values(revision=payload.revision + 1,
        payload=payload.model_dump(mode='json', exclude={'revision'})))
    if not changed.rowcount:
        raise api_error(409, 'draft_conflict', 'The draft changed or has already been sealed.')
    return dict(id=draft_id, revision=payload.revision + 1)


@router.post('/artifacts/{artifact_id}/drafts/{draft_id}/seal', status_code=201, response_model=ArtifactVersionView)
async def release_draft(artifact_id: uuid.UUID, draft_id: uuid.UUID, payload: SealDraft,
    user: User = Depends(get_current_user), session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    artifact = await owned_artifact(session, artifact_id, user)
    draft = await session.get(ArtifactDraft, draft_id)
    if draft is None or draft.artifact_id != artifact.id:
        raise api_error(404, 'not_found', 'Draft not found.')
    try:
        async with session.begin_nested():
            version = await seal_draft(session, artifact, draft, payload.revision, payload.version, user)
    except IntegrityError as exc:
        raise api_error(409, 'version_conflict', 'Concurrent version creation; reload the artifact.') from exc
    return version_view(artifact, version, await session.get(ArtifactPublication, version.id))


@router.post('/artifacts/{artifact_id}/versions/{version_id}/publish', response_model=ArtifactVersionView)
async def publish_version(artifact_id: uuid.UUID, version_id: uuid.UUID, payload: PublishVersion,
    user: User = Depends(get_current_user), session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    await owned_artifact(session, artifact_id, user, OrganizationRole.ADMIN)
    artifact, version = await _version(session, artifact_id, version_id, user)
    if artifact.kind in {'Study', 'ExecutionConfiguration'}:
        from .v1 import _manifest_async
        content = json.loads((await version_content(session, version))[0])
        for engine in content['engines'] if artifact.kind == 'Study' else [content['engine']]:
            try:
                await _manifest_async(engine['name'], session, namespace=engine['namespace'],
                    version=engine['version'], manifest_digest=engine['digest'])
            except HTTPException as exc:
                raise api_error(422, 'private_engine_dependency', 'Publish the exact Engine contract before publishing this version.') from exc
    if artifact.kind == 'Report':
        from ..db.models import ArtifactEvidence, Job, StudyRun, Study
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


@router.post('/artifacts/{artifact_id}/versions/{version_id}/withdraw', response_model=ArtifactVersionView)
async def withdraw_version(artifact_id: uuid.UUID, version_id: uuid.UUID,
    user: User = Depends(get_current_user), session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    await owned_artifact(session, artifact_id, user, OrganizationRole.ADMIN)
    artifact, version = await _version(session, artifact_id, version_id, user)
    publication = await session.get(ArtifactPublication, version.id)
    if publication is None:
        raise api_error(404, 'not_found', 'Publication not found.')
    publication.withdrawn = True
    await session.flush()
    return version_view(artifact, version, publication)


@router.put('/organizations/{org}/projects/{project}/library/{artifact_id}')
async def associate_artifact(org: str, project: str, artifact_id: uuid.UUID,
    user: User = Depends(get_current_user), session: AsyncSession = Depends(session_dependency, scope='function')) -> dict:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(404, 'not_found', 'Organization not found.')
    target = await require_project(session, organization, project, user, OrganizationRole.MEMBER)
    artifact = await session.get(Artifact, artifact_id)
    if artifact is None or not await can_read(session, artifact, user):
        raise api_error(404, 'not_found', 'Artifact not found.')
    if artifact.organization_id != organization.id and not await can_read(session, artifact, None):
        raise api_error(422, 'private_dependency', 'Another organization can only consume public artifacts.')
    await session.execute(select(Artifact.id).where(Artifact.id == artifact.id).with_for_update())
    if await session.get(ProjectArtifact, (target.id, artifact.id)) is None:
        session.add(ProjectArtifact(project_id=target.id, artifact_id=artifact.id))
        await session.flush()
    return dict(project_id=target.id, artifact_id=artifact.id)


@router.get('/organizations/{org}/projects/{project}/library', response_model=list[ArtifactView])
async def project_artifacts(org: str, project: str, user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope='function')) -> list[dict]:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(404, 'not_found', 'Organization not found.')
    target = await require_project(session, organization, project, user, OrganizationRole.VIEWER)
    rows = (await session.scalars(select(Artifact).join(ProjectArtifact)
        .where(ProjectArtifact.project_id == target.id).order_by(Artifact.display_name))).all()
    return [artifact_view(row) for row in rows if await can_read(session, row, user)]


@router.delete('/organizations/{org}/projects/{project}/library/{artifact_id}', status_code=204)
async def dissociate_artifact(org: str, project: str, artifact_id: uuid.UUID,
    user: User = Depends(get_current_user), session: AsyncSession = Depends(session_dependency, scope='function')) -> Response:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(404, 'not_found', 'Organization not found.')
    target = await require_project(session, organization, project, user, OrganizationRole.MEMBER)
    await session.execute(delete(ProjectArtifact).where(ProjectArtifact.project_id == target.id,
        ProjectArtifact.artifact_id == artifact_id))
    return Response(status_code=204)

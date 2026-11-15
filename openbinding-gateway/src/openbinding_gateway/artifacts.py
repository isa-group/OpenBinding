"""One editorial authority for organization resources and exact dependencies."""
from __future__ import annotations

import uuid
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .collaboration import effective_role, require_role
from .db.models import (Artifact, ArtifactDependency, ArtifactDraft, ArtifactPublication,
    ArtifactVersion, AuditEvent, Blob, Organization, OrganizationRole, User)
from .models.artifacts import ArtifactRef, DraftContent, StudyArtifactContent
from .models.errors import api_error
from .security.apikeys import authenticated_api_key, boundary_of
from .integrations import bim
from .integrations.bim_host import (XmlResource, dialect_type_matches, dialect_xml_type_matches,
    resource_schema_diagnostics)
from bim_core import PackageError
from bim_core.canonical import canonical_json, digest, digest_bytes


def reference(artifact: Artifact, version: ArtifactVersion) -> dict:
    return dict(namespace=artifact.namespace, name=artifact.name,
                version=version.version, versionDigest=version.version_digest)


def contract_reference(manifest: dict) -> dict:
    return {**{key: manifest['metadata'][key] for key in ('namespace', 'name', 'version')},
            'digest': digest(manifest)}


def artifact_view(row: Artifact) -> dict:
    return {key: getattr(row, key) for key in ('id', 'organization_id', 'namespace', 'name',
        'display_name', 'kind', 'description', 'labels', 'archived', 'created_at')}


def version_view(artifact: Artifact, version: ArtifactVersion, publication=None) -> dict:
    return dict(id=version.id, artifact_id=artifact.id, ordinal=version.ordinal,
        ref=reference(artifact, version), contentDigest=version.content_digest,
        manifest=version.manifest, based_on_id=version.based_on_id,
        created_at=version.created_at, public=publication is not None,
        withdrawn=bool(publication and publication.withdrawn))


async def artifact_boundary_allows(session: AsyncSession, organization_id: uuid.UUID,
                                   user: User | None, name: str | None = None) -> bool:
    key = authenticated_api_key(user)
    boundary = boundary_of(key) if key is not None else None
    if boundary is None:
        return True
    # Library authority belongs to the organization, not to one project.
    if not boundary or 'projects' in boundary:
        return False
    if 'organizations' in boundary:
        organization = await session.get(Organization, organization_id)
        if not organization or not {str(organization_id), organization.slug} & boundary['organizations']:
            return False
    return name is None or 'slugs' not in boundary or name in boundary['slugs']


async def can_read(session: AsyncSession, artifact: Artifact, user: User | None,
                   version: ArtifactVersion | None = None) -> bool:
    if not await artifact_boundary_allows(session, artifact.organization_id, user, artifact.name):
        return False
    if user and await effective_role(session, artifact.organization_id, user):
        return True
    query = select(ArtifactPublication.version_id).join(ArtifactVersion).where(
        ArtifactVersion.artifact_id == artifact.id)
    if version:
        query = query.where(ArtifactVersion.id == version.id)
    else:
        query = query.where(ArtifactPublication.withdrawn.is_(False))
    return await session.scalar(query.limit(1)) is not None


async def owned_artifact(session: AsyncSession, identity: uuid.UUID, user: User,
                         minimum=OrganizationRole.MEMBER) -> Artifact:
    row = await session.get(Artifact, identity)
    if row is None or not await artifact_boundary_allows(session, row.organization_id, user, row.name) or not await effective_role(session, row.organization_id, user):
        raise api_error(404, 'not_found', 'Artifact not found.')
    await require_role(session, await session.get(Organization, row.organization_id), user, minimum)
    return row


async def resolve_version(session: AsyncSession, ref: ArtifactRef | dict,
                          user: User | None) -> tuple[Artifact, ArtifactVersion]:
    ref = ref if isinstance(ref, ArtifactRef) else ArtifactRef.model_validate(ref)
    found = (await session.execute(select(Artifact, ArtifactVersion).join(
        ArtifactVersion, ArtifactVersion.artifact_id == Artifact.id).where(
        Artifact.namespace == ref.namespace, Artifact.name == ref.name,
        ArtifactVersion.version == ref.version,
        ArtifactVersion.version_digest == ref.versionDigest))).first()
    if found is None or not await can_read(session, found[0], user, found[1]):
        raise api_error(404, 'not_found', 'Artifact version not found.')
    if digest(found[1].manifest) != found[1].version_digest:
        raise api_error(409, 'version_integrity', 'Stored version manifest does not match its digest.')
    return found[0], found[1]


async def version_content(session: AsyncSession, version: ArtifactVersion) -> tuple[bytes, str]:
    return verified_version_content(version, await session.get(Blob, version.blob_id))


def verified_version_content(version: ArtifactVersion, blob: Blob | None) -> tuple[bytes, str]:
    if digest(version.manifest) != version.version_digest or version.manifest.get('contentDigest') != version.content_digest:
        raise api_error(409, 'version_integrity', 'Version content identity differs from its sealed manifest.')
    try:
        content = Path(blob.storage_uri).read_bytes() if blob else b''
    except OSError as exc:
        raise api_error(409, 'content_unavailable', 'Version content is unavailable.') from exc
    if not blob or digest_bytes(content) != version.content_digest:
        raise api_error(409, 'content_integrity', 'Version content does not match its digest.')
    return content, version.manifest["mediaType"]


def validate_content(kind: str, payload: DraftContent) -> tuple[bytes, list[dict]]:
    """Validate standalone syntax; composition validates contextual references."""
    contracts = []
    if payload.media_type == 'application/json':
        if not isinstance(payload.content, dict):
            raise api_error(422, 'invalid_content', 'JSON content must be an object.')
        document = payload.content
        if kind in {'Dataset', 'Study', 'BindingDecision',
                    'ExecutionConfiguration', 'AnalysisConfiguration'}:
            if kind != 'Dataset' and not document:
                raise api_error(422, 'invalid_content', f'{kind} content cannot be empty.')
            if kind == 'Study':
                from pydantic import ValidationError
                try:
                    StudyArtifactContent.model_validate(document).definition()
                except (ValidationError, ValueError) as exc:
                    raise api_error(422, 'invalid_content', str(exc)) from exc
            if kind == 'ExecutionConfiguration':
                if set(document) - {'engine', 'registration', 'mode', 'options'} or not isinstance(document.get('options', {}), dict):
                    raise api_error(422, 'invalid_configuration', 'Execution configuration has unknown fields or invalid options.')
                if not isinstance(document.get('engine'), dict) or not isinstance(document.get('mode'), str):
                    raise api_error(422, 'invalid_configuration', 'Execution configuration requires an exact engine and mode.')
        elif kind in {'Profile', 'Dialect', 'Engine', 'EngineRegistration'}:
            from .services.engines import schema_diagnostics
            errors = schema_diagnostics(document, kind)
            if document.get('kind') != kind or errors:
                raise api_error(422, 'invalid_contract', str(errors or 'Contract kind mismatch.'))
            if kind in {'Profile', 'Dialect'}:
                installed = bim.profile_manifests() if kind == 'Profile' else bim.dialect_manifests()
                if not any(digest(item) == digest(document) for item in installed):
                    raise api_error(422, 'contract_not_installed', 'An exact trusted adapter must already be installed.')
        else:
            if document.get('kind') != kind:
                raise api_error(422, 'kind_mismatch', 'The content kind must match the artifact type.')
            matches = dialect_type_matches(bim.dialect_manifests(), document.get('apiVersion'), kind, payload.media_type)
            if payload.contracts:
                matches = [pair for pair in matches if contract_reference(pair[0]) in payload.contracts]
            if len(matches) != 1:
                raise api_error(422, 'resource_contract', 'Select exactly one installed Dialect for this resource.')
            errors = resource_schema_diagnostics(document, document.get('apiVersion'), kind, payload.media_type, 'content', [matches[0][0]])
            if errors:
                raise api_error(422, 'invalid_resource', str([error.as_dict() for error in errors]))
            contracts = [contract_reference(matches[0][0])]
        content = canonical_json(document)
    else:
        if not isinstance(payload.content, str):
            raise api_error(422, 'invalid_content', 'Text/XML content must be a string.')
        content = payload.content.replace('\r\n', '\n').replace('\r', '\n').encode()
        if kind != 'Dataset':
            package = XmlResource(content)
            try:
                root = package.root()
                namespace, name = root.tag[1:].split('}', 1) if root.tag.startswith('{') else ('', root.tag)
                matches = dialect_xml_type_matches(bim.dialect_manifests(), namespace, name, payload.media_type)
                matches = [pair for pair in matches if pair[1]['kind'] == kind]
                if payload.contracts:
                    matches = [pair for pair in matches if contract_reference(pair[0]) in payload.contracts]
                if len(matches) != 1 or matches[0][0]['spec']['adapter']['id'] != 'bim-bpmn':
                    raise api_error(422, 'resource_contract', 'Select an installed XML validator.')
                package.validate_bpmn()
                contracts = [contract_reference(matches[0][0])]
            except (PackageError, ValueError) as exc:
                raise api_error(422, 'invalid_resource', str(exc)) from exc
    if len(content) > bim.package_limits()['max_expanded_bytes']:
        raise api_error(413, 'content_too_large', 'Resource exceeds the package content limit.')
    if payload.contracts and payload.contracts != contracts:
        raise api_error(422, 'contract_mismatch', 'Declared contracts do not match the validated resource.')
    return content, contracts


async def store_blob(session: AsyncSession, artifact: Artifact, user: User, content: bytes, media_type: str) -> Blob:
    """Keep ``content`` for the artifact's organization (``modules.shared`` blob storage)."""
    from .modules.shared.application import put_row, write_file

    return await put_row(session, artifact.organization_id, write_file(content), media_type, user.id)


async def seal_draft(session: AsyncSession, artifact: Artifact, draft: ArtifactDraft,
                     revision: int, label: str | None, user: User) -> ArtifactVersion:
    # Lock the identity before assigning either label or ordinal.
    await session.execute(select(Artifact.id).where(Artifact.id == artifact.id).with_for_update())
    await session.refresh(draft)
    if draft.revision != revision:
        raise api_error(409, 'draft_conflict', 'The draft changed; reload before sealing.')
    if draft.sealed_version_id:
        existing = await session.get(ArtifactVersion, draft.sealed_version_id)
        if label is not None and label != existing.version:
            raise api_error(409, 'draft_sealed', 'This draft has already been sealed.')
        return existing
    if artifact.archived:
        raise api_error(409, 'artifact_archived', 'Archived artifacts cannot receive new versions.')
    payload = DraftContent.model_validate(draft.payload)
    content, contracts = validate_content(artifact.kind, payload)
    dependencies = [await resolve_version(session, ref, user) for ref in payload.dependencies]
    if len({version.id for _, version in dependencies}) != len(dependencies):
        raise api_error(422, 'duplicate_dependency', 'Dependencies must be unique.')
    # Private references must remain readable to the whole owning organization.
    for dependency, version in dependencies:
        if dependency.organization_id != artifact.organization_id and not await session.get(ArtifactPublication, version.id):
            raise api_error(422, 'private_dependency', 'Cross-organization dependencies must be public.')
    case_references = []
    if artifact.kind == 'Study':
        from .db.models import BindingCase, BindingCaseRevision
        members = StudyArtifactContent.model_validate(payload.content).cases
        for position, member in enumerate(members):
            row = (await session.execute(select(BindingCaseRevision, BindingCase.organization_id)
                .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
                .where(BindingCaseRevision.id == member.caseRevisionId))).first()
            if row is None or row[1] != artifact.organization_id:
                raise api_error(422, 'foreign_case_revision', f'Member {position} must be a problem revision in this organization.')
            if row[0].package_digest != member.compositionDigest:
                raise api_error(422, 'case_digest_mismatch', f'Member {position} differs from the exact problem revision.')
            case_references.append((position, member.caseRevisionId))
        from .services.engines import engine_mode
        definition = StudyArtifactContent.model_validate(payload.content)
        for engine in definition.engines:
            for parameters in definition.parameter_sets:
                await engine_mode(engine['name'], engine.get('mode'), parameters, session,
                    caller=user, namespace=engine['namespace'], version=engine['version'], manifest_digest=engine['digest'])
    if artifact.kind == 'ExecutionConfiguration':
        from .services.engines import engine_mode
        engine = payload.content['engine']
        if set(engine) != {'namespace', 'name', 'version', 'digest'}:
            raise api_error(422, 'invalid_configuration', 'Engine reference must be exact.')
        await engine_mode(engine['name'], payload.content['mode'], payload.content.get('options', {}),
            session, caller=user, namespace=engine['namespace'], version=engine['version'], manifest_digest=engine['digest'])
    ordinal = int(await session.scalar(select(func.max(ArtifactVersion.ordinal)).where(
        ArtifactVersion.artifact_id == artifact.id)) or 0) + 1
    label = label or str(ordinal)
    manifest = dict(apiVersion='openbinding/artifact/v1', kind=artifact.kind,
        identity=dict(namespace=artifact.namespace, name=artifact.name, version=label),
        contentDigest=digest_bytes(content), mediaType=payload.media_type, contracts=contracts,
        evidence=[],
        dependencies=sorted([reference(a, v) for a, v in dependencies], key=lambda item: (item['namespace'], item['name'], item['version'])))
    existing = await session.scalar(select(ArtifactVersion).where(ArtifactVersion.artifact_id == artifact.id, ArtifactVersion.version == label))
    if existing:
        if existing.version_digest != digest(manifest):
            raise api_error(409, 'immutable_version', 'Version label already identifies different content.')
        draft.sealed_version_id = existing.id
        return existing
    blob = await store_blob(session, artifact, user, content, payload.media_type)
    version = ArtifactVersion(artifact_id=artifact.id, ordinal=ordinal, version=label, blob_id=blob.id, blob=blob,
        content_digest=blob.digest, version_digest=digest(manifest), manifest=manifest,
        based_on_id=draft.based_on_id, created_by_id=user.id)
    session.add(version)
    await session.flush()
    from .db.models import ArtifactCaseReference
    for position, case_revision_id in case_references:
        session.add(ArtifactCaseReference(version_id=version.id, position=position, case_revision_id=case_revision_id))
    for _, target in dependencies:
        session.add(ArtifactDependency(version_id=version.id, dependency_id=target.id))
    draft.sealed_version_id = version.id
    session.add(AuditEvent(organization_id=artifact.organization_id, actor_id=user.id,
        action='artifact.version.sealed', target_type='ArtifactVersion', target_id=version.id,
        detail={'ref': reference(artifact, version)}))
    await session.flush()
    return version

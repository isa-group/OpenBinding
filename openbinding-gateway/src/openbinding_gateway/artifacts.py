"""One editorial authority for organization resources and exact dependencies."""
from __future__ import annotations

import os
import tempfile
import uuid
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .collaboration import effective_role, require_role
from .core.settings import get_settings
from .db.models import (Artifact, ArtifactDependency, ArtifactDraft, ArtifactPublication,
    ArtifactVersion, AuditEvent, Blob, Organization, OrganizationRole, User)
from .models.artifacts import ArtifactRef, DraftContent, CaseRevisionRef, StudyArtifactContent, CollectionArtifactContent
from .models.errors import api_error
from .security.apikeys import authenticated_api_key, boundary_of
from .v1.canonical import canonical_json, digest, digest_bytes
from .v1.compiler import (_dialect_type_matches, _dialect_xml_type_matches,
    _resource_schema_diagnostics, installed_dialect_manifests, installed_profile_manifests)
from .v1.package import InstancePackage, MAX_EXPANDED, PackageError, strict_json_loads


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
        if kind in {'Dataset', 'Report', 'Collection', 'Study', 'BindingDecision',
                    'ExecutionConfiguration', 'AnalysisConfiguration'}:
            if kind != 'Dataset' and not document:
                raise api_error(422, 'invalid_content', f'{kind} content cannot be empty.')
            if kind in {'Study', 'Collection'}:
                from pydantic import ValidationError
                try:
                    if kind == 'Study':
                        StudyArtifactContent.model_validate(document).definition()
                    else:
                        collection = CollectionArtifactContent.model_validate(document)
                        if len({digest(item.model_dump(mode='json')) for item in collection.members}) != len(collection.members):
                            raise ValueError('Collection members must be unique.')
                except (ValidationError, ValueError) as exc:
                    raise api_error(422, 'invalid_content', str(exc)) from exc
            if kind == 'ExecutionConfiguration':
                if set(document) - {'engine', 'registration', 'mode', 'options'} or not isinstance(document.get('options', {}), dict):
                    raise api_error(422, 'invalid_configuration', 'Execution configuration has unknown fields or invalid options.')
                if not isinstance(document.get('engine'), dict) or not isinstance(document.get('mode'), str):
                    raise api_error(422, 'invalid_configuration', 'Execution configuration requires an exact engine and mode.')
        elif kind in {'Profile', 'Dialect', 'Engine', 'EngineRegistration'}:
            from .routes.v1 import _schema_diagnostics
            errors = _schema_diagnostics(document, kind)
            if document.get('kind') != kind or errors:
                raise api_error(422, 'invalid_contract', str(errors or 'Contract kind mismatch.'))
            if kind in {'Profile', 'Dialect'}:
                installed = installed_profile_manifests() if kind == 'Profile' else installed_dialect_manifests()
                if not any(digest(item) == digest(document) for item in installed):
                    raise api_error(422, 'contract_not_installed', 'An exact trusted adapter must already be installed.')
        else:
            if document.get('kind') != kind:
                raise api_error(422, 'kind_mismatch', 'The content kind must match the artifact type.')
            matches = _dialect_type_matches(installed_dialect_manifests(), document.get('apiVersion'), kind, payload.media_type)
            if payload.contracts:
                matches = [pair for pair in matches if contract_reference(pair[0]) in payload.contracts]
            if len(matches) != 1:
                raise api_error(422, 'resource_contract', 'Select exactly one installed Dialect for this resource.')
            errors = _resource_schema_diagnostics(document, document.get('apiVersion'), kind, payload.media_type, 'content', [matches[0][0]])
            if errors:
                raise api_error(422, 'invalid_resource', str([error.as_dict() for error in errors]))
            contracts = [contract_reference(matches[0][0])]
        content = canonical_json(document)
    else:
        if not isinstance(payload.content, str):
            raise api_error(422, 'invalid_content', 'Text/XML content must be a string.')
        content = payload.content.replace('\r\n', '\n').replace('\r', '\n').encode()
        if kind != 'Dataset':
            package = InstancePackage({'instance.json': b'{}', 'resource.xml': content})
            try:
                root = package.xml_root('resource.xml')
                namespace, name = root.tag[1:].split('}', 1) if root.tag.startswith('{') else ('', root.tag)
                matches = _dialect_xml_type_matches(installed_dialect_manifests(), namespace, name, payload.media_type)
                matches = [pair for pair in matches if pair[1]['kind'] == kind]
                if payload.contracts:
                    matches = [pair for pair in matches if contract_reference(pair[0]) in payload.contracts]
                if len(matches) != 1 or matches[0][0]['spec']['adapter']['id'] != 'bim-bpmn':
                    raise api_error(422, 'resource_contract', 'Select an installed XML validator.')
                package.xml('resource.xml')
                contracts = [contract_reference(matches[0][0])]
            except (PackageError, ValueError) as exc:
                raise api_error(422, 'invalid_resource', str(exc)) from exc
    if len(content) > MAX_EXPANDED:
        raise api_error(413, 'content_too_large', 'Resource exceeds the package content limit.')
    if payload.contracts and payload.contracts != contracts:
        raise api_error(422, 'contract_mismatch', 'Declared contracts do not match the validated resource.')
    return content, contracts


async def store_blob(session: AsyncSession, artifact: Artifact, user: User, content: bytes, media_type: str) -> Blob:
    from .routes.artifacts import _artifact_path, _storage_limit
    hash_value = digest_bytes(content)
    organization = await session.get(Organization, artifact.organization_id)
    await session.execute(select(User.id).where(User.id == organization.billing_sponsor_user_id).with_for_update())
    row = await session.scalar(select(Blob).where(Blob.organization_id == artifact.organization_id,
        Blob.project_id.is_(None), Blob.digest == hash_value))
    if row:
        return row
    await _storage_limit(session, organization, len(content))
    destination = _artifact_path(get_settings(), hash_value)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if digest_bytes(destination.read_bytes()) != hash_value:
            raise api_error(409, 'content_integrity', 'Existing blob is corrupt.')
    else:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(content)
            os.replace(temporary, destination)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
    row = Blob(organization_id=artifact.organization_id, project_id=None, digest=hash_value,
        media_type=media_type, size_bytes=len(content), storage_uri=str(destination), created_by_id=user.id)
    session.add(row)
    await session.flush()
    return row


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
    report_sources = []
    if artifact.kind == 'Report':
        from .reports import report_evidence
        report_sources = await report_evidence(session, artifact, payload.content, user)
        report_sources = sorted({(source.get("study_run_id"), source.get("job_id")): source for source in report_sources}.values(), key=lambda source: str(source.get("study_run_id") or source["job_id"]))
    for source in report_sources:
        if source.get('study_run_id'):
            from .db.models import StudyRun
            run = await session.get(StudyRun, source['study_run_id'])
            target = await session.get(ArtifactVersion, run.definition_version_id)
            if target.id not in {version.id for _, version in dependencies}:
                dependencies.append((await session.get(Artifact, target.artifact_id), target))
    case_references = []
    if artifact.kind in {'Study', 'Collection'}:
        from .db.models import BindingCase, BindingCaseRevision, Project
        members = (StudyArtifactContent.model_validate(payload.content).cases if artifact.kind == 'Study'
                   else CollectionArtifactContent.model_validate(payload.content).members)
        for position, member in enumerate(members):
            if isinstance(member, ArtifactRef):
                if member not in payload.dependencies:
                    raise api_error(422, 'missing_dependency', f'Member {position} must also be an exact fixed dependency.')
                continue
            row = (await session.execute(select(BindingCaseRevision, Project.organization_id)
                .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
                .join(Project, Project.id == BindingCase.project_id)
                .where(BindingCaseRevision.id == member.caseRevisionId))).first()
            if row is None or row[1] != artifact.organization_id:
                raise api_error(422, 'foreign_case_revision', f'Member {position} must be a case revision in this organization.')
            if row[0].digest != member.compositionDigest:
                raise api_error(422, 'case_digest_mismatch', f'Member {position} differs from the exact case composition.')
            if artifact.kind == 'Study' and row[0].source_snapshot_id is None:
                raise api_error(422, 'case_not_executable', f'Member {position} has no materialized snapshot.')
            case_references.append((position, member.caseRevisionId))
        if artifact.kind == 'Study':
            from .routes.v1 import _engine_mode
            definition = StudyArtifactContent.model_validate(payload.content)
            if definition.collection:
                if definition.collection not in payload.dependencies:
                    raise api_error(422, 'missing_dependency', 'The source collection must be an exact fixed dependency.')
                collection_artifact, collection_version = await resolve_version(session, definition.collection, user)
                if collection_artifact.kind != 'Collection':
                    raise api_error(422, 'invalid_collection', 'A study collection must reference a Collection version.')
                from .v1.package import strict_json_loads
                collection = CollectionArtifactContent.model_validate(strict_json_loads((await version_content(session, collection_version))[0]))
                if any(member not in definition.cases for member in collection.members if isinstance(member, CaseRevisionRef)):
                    raise api_error(422, 'collection_case_mismatch', 'The study must include every exact case from its source collection.')
            for engine in definition.engines:
                for parameters in definition.parameter_sets:
                    await _engine_mode(engine['name'], engine.get('mode'), parameters, session,
                        caller=user, namespace=engine['namespace'], version=engine['version'], manifest_digest=engine['digest'])
    if artifact.kind == 'ExecutionConfiguration':
        from .routes.v1 import _engine_mode
        engine = payload.content['engine']
        if set(engine) != {'namespace', 'name', 'version', 'digest'}:
            raise api_error(422, 'invalid_configuration', 'Engine reference must be exact.')
        await _engine_mode(engine['name'], payload.content['mode'], payload.content.get('options', {}),
            session, caller=user, namespace=engine['namespace'], version=engine['version'], manifest_digest=engine['digest'])
    ordinal = int(await session.scalar(select(func.max(ArtifactVersion.ordinal)).where(
        ArtifactVersion.artifact_id == artifact.id)) or 0) + 1
    label = label or str(ordinal)
    manifest = dict(apiVersion='openbinding/artifact/v1', kind=artifact.kind,
        identity=dict(namespace=artifact.namespace, name=artifact.name, version=label),
        contentDigest=digest_bytes(content), mediaType=payload.media_type, contracts=contracts,
        evidence=[{'kind': 'StudyRun' if source.get('study_run_id') else 'Job',
                   'id': str(source.get('study_run_id') or source['job_id']), 'digest': source['digest']} for source in report_sources],
        dependencies=sorted([reference(a, v) for a, v in dependencies], key=lambda item: (item['namespace'], item['name'], item['version'])))
    existing = await session.scalar(select(ArtifactVersion).where(ArtifactVersion.artifact_id == artifact.id, ArtifactVersion.version == label))
    if existing:
        if existing.version_digest != digest(manifest):
            raise api_error(409, 'immutable_version', 'Version label already identifies different content.')
        draft.sealed_version_id = existing.id
        if artifact.kind == 'Report':
            from .reports import adopt_sealed_report_draft
            await adopt_sealed_report_draft(session, draft, existing)
        return existing
    blob = await store_blob(session, artifact, user, content, payload.media_type)
    version = ArtifactVersion(artifact_id=artifact.id, ordinal=ordinal, version=label, blob_id=blob.id, blob=blob,
        content_digest=blob.digest, version_digest=digest(manifest), manifest=manifest,
        based_on_id=draft.based_on_id, created_by_id=user.id)
    session.add(version)
    await session.flush()
    from .db.models import ArtifactCaseReference, ArtifactEvidence
    for position, source in enumerate(report_sources):
        session.add(ArtifactEvidence(version_id=version.id, position=position, **source))
    for position, case_revision_id in case_references:
        session.add(ArtifactCaseReference(version_id=version.id, position=position, case_revision_id=case_revision_id))
    for _, target in dependencies:
        session.add(ArtifactDependency(version_id=version.id, dependency_id=target.id))
    draft.sealed_version_id = version.id
    if artifact.kind == 'Report':
        from .reports import adopt_sealed_report_draft
        await adopt_sealed_report_draft(session, draft, version)
    session.add(AuditEvent(organization_id=artifact.organization_id, actor_id=user.id,
        action='artifact.version.sealed', target_type='ArtifactVersion', target_id=version.id,
        detail={'ref': reference(artifact, version)}))
    await session.flush()
    return version


async def materialize_case(session, user, organization, document, uses):
    """Build a closed BIM archive from refs, never from a second editable copy."""
    from copy import deepcopy
    from .routes.v1 import _compile_resolved, _persist_snapshot
    from .v1.compiler import manifest_id
    if document.get('kind') != 'Instance' or document.get('apiVersion') != 'bim/v1':
        raise api_error(422, 'instance_required', 'A case composition requires a BIM Instance index.')
    root = deepcopy(document)
    if not isinstance(root.get('spec'), dict):
        raise api_error(422, 'invalid_composition', 'The Instance spec must be an object.')
    spec = root['spec']
    spec['resources'] = {}
    spec.pop('bindings', None)
    source_spec = deepcopy(spec)
    source_spec['resources'] = {}
    files = {}
    rows = []
    aliases = set()
    used_contracts = []
    for use in uses:
        if use.alias in aliases:
            raise api_error(422, 'duplicate_alias', 'Resource aliases are package-wide unique.')
        aliases.add(use.alias)
        artifact, version = await resolve_version(session, use.artifact, user)
        if artifact.organization_id != organization.id and await session.get(ArtifactPublication, version.id) is None:
            raise api_error(422, 'private_dependency', 'Only public resources can cross organization boundaries.')
        content, media_type = await version_content(session, version)
        suffix = '.json' if media_type == 'application/json' else '.bpmn' if media_type == 'application/vnd.omg.bpmn+xml' else '.xml'
        path = use.alias + suffix
        files[path] = content
        spec['resources'].setdefault(use.role, {})[use.alias] = path
        source_spec['resources'].setdefault(use.role, {})[use.alias] = reference(artifact, version)
        if use.bindings:
            spec.setdefault('bindings', {})[use.alias] = use.bindings
            source_spec.setdefault('bindings', {})[use.alias] = use.bindings
        used_contracts.extend(version.manifest['contracts'])
        rows.append((use, version))
    if any(target not in aliases for use in uses for target in use.bindings.values()):
        raise api_error(422, 'unknown_alias', 'Every binding target must exist in the composition.')
    if 'contracts' not in spec:
        profiles = [item for item in installed_profile_manifests() if manifest_id(item) == spec.get('profile')]
        if len(profiles) != 1:
            raise api_error(422, 'profile_selection_required', 'Select an exact installed Profile version.')
        dialects = [item for item in installed_dialect_manifests() if spec['profile'] in item['spec']['compatibleProfiles']]
        # Explicit resource contracts choose one revision of each family.
        families = {}
        for item in dialects:
            key = manifest_id(item)
            families.setdefault(key, []).append(item)
        selected = []
        for family, options in families.items():
            pinned = [item for item in options if contract_reference(item) in used_contracts]
            if len(pinned) == 1:
                selected.append(pinned[0])
            elif len(options) == 1:
                selected.append(options[0])
            else:
                raise api_error(422, 'dialect_selection_required', f'Select an exact Dialect for {family}.')
        spec['contracts'] = dict(profile=contract_reference(profiles[0]), dialects=[contract_reference(item) for item in selected])
    if any(contract not in spec['contracts']['dialects'] for contract in used_contracts):
        raise api_error(422, 'contract_mismatch', 'The composition must select the exact contracts of every resource version.')
    source_spec['contracts'] = spec['contracts']
    root['spec'] = spec
    files['instance.json'] = canonical_json(root)
    package = InstancePackage(files)
    problem = await _compile_resolved(package, session)
    snapshot_id = await _persist_snapshot(package, problem, user, session)
    source = {**root, 'spec': source_spec}
    return source, uuid.UUID(snapshot_id), rows


def case_composition_digest(document: dict, snapshot, resources: list[dict]) -> str:
    return digest({"document": document,
        "packageDigest": snapshot.package_digest if snapshot else None,
        "resourceDigests": snapshot.resource_digests if snapshot else {},
        "resources": sorted(resources, key=lambda item: (item['role'], item['alias']))})

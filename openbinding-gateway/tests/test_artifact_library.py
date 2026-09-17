"""The artifact lifecycle must preserve private releases and shared identities."""
import pytest
from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.exc import DBAPIError

from openbinding_gateway.artifacts import reference, resolve_version, seal_draft, version_content
from openbinding_gateway.db.models import Artifact, ArtifactDraft, ArtifactVersion, Organization, OrganizationMembership, OrganizationRole, User
from openbinding_gateway.models.artifacts import DraftContent


@pytest.mark.asyncio
async def test_sealed_versions_are_private_exact_and_sql_immutable(db_session, tmp_path, monkeypatch):
    from openbinding_gateway.core.settings import get_settings
    monkeypatch.setattr(get_settings(), 'artifact_root', str(tmp_path))
    user = User(username='artifact-owner', email='artifact-owner@example.org', password_hash='unused', plan_cache='RESEARCH')
    db_session.add(user)
    await db_session.flush()
    org = Organization(slug='artifact-team', name='Artifact team', billing_sponsor_user_id=user.id, created_by_id=user.id)
    db_session.add(org)
    await db_session.flush()
    db_session.add(OrganizationMembership(organization_id=org.id, user_id=user.id, role=OrganizationRole.OWNER))
    artifact = Artifact(organization_id=org.id, namespace=str(org.id), name='shared-data',
        display_name='Shared data', kind='Dataset', created_by_id=user.id)
    db_session.add(artifact)
    await db_session.flush()
    draft = ArtifactDraft(artifact_id=artifact.id, payload=DraftContent(content={'value': 1}).model_dump(), created_by_id=user.id)
    db_session.add(draft)
    await db_session.flush()
    v1 = await seal_draft(db_session, artifact, draft, 1, '1', user)
    original_ref = reference(artifact, v1)
    from types import SimpleNamespace
    from openbinding_gateway.artifacts import owned_artifact
    for boundary in ({'organizations': ['another-team']}, {'projects': ['one-project']}, {'slugs': ['other-data']}):
        user._authenticated_api_key = SimpleNamespace(grants={'boundary': boundary})
        with pytest.raises(HTTPException) as denied:
            await resolve_version(db_session, original_ref, user)
        assert denied.value.status_code == 404
        with pytest.raises(HTTPException) as denied:
            await owned_artifact(db_session, artifact.id, user)
        assert denied.value.status_code == 404
    for organization_ref in (str(org.id), org.slug):
        user._authenticated_api_key = SimpleNamespace(grants={'boundary': {'organizations': [organization_ref]}})
        assert (await resolve_version(db_session, original_ref, user))[1].id == v1.id
    del user._authenticated_api_key
    assert (await resolve_version(db_session, original_ref, user))[1].id == v1.id
    with pytest.raises(HTTPException) as error:
        await resolve_version(db_session, original_ref, None)
    assert error.value.status_code == 404
    assert (await seal_draft(db_session, artifact, draft, 1, '1', user)).id == v1.id
    artifact.display_name = 'Renamed without changing identity'
    await db_session.flush()
    assert reference(artifact, v1) == original_ref
    assert (await version_content(db_session, v1))[0] == b'{"value":1}'
    draft2 = ArtifactDraft(artifact_id=artifact.id, payload=DraftContent(content={'value': 2}).model_dump(), based_on_id=v1.id, created_by_id=user.id)
    db_session.add(draft2)
    await db_session.flush()
    with pytest.raises(HTTPException) as error:
        await seal_draft(db_session, artifact, draft2, 1, '1', user)
    assert error.value.status_code == 409
    v2 = await seal_draft(db_session, artifact, draft2, 1, '2', user)
    assert v2.ordinal == 2 and v2.content_digest != v1.content_digest
    assert (await version_content(db_session, v1))[0] == b'{"value":1}'
    for model, identity, values in [(Artifact, artifact.id, {'name': 'another-identity'}),
                                     (ArtifactDraft, draft.id, {'revision': 2})]:
        with pytest.raises(DBAPIError):
            async with db_session.begin_nested():
                await db_session.execute(update(model).where(model.id == identity).values(**values))
    with pytest.raises(DBAPIError):
        async with db_session.begin_nested():
            await db_session.execute(update(ArtifactVersion).where(ArtifactVersion.id == v1.id).values(version='changed'))


@pytest.mark.asyncio
async def test_case_composition_closes_exact_resources_without_copying_authority(db_session, tmp_path, monkeypatch):
    import json
    from copy import deepcopy
    from openbinding_gateway.artifacts import materialize_case
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db.models import InstanceSnapshot
    from openbinding_gateway.models.artifacts import ArtifactUse
    from test_bim_v1_language_final import base_package

    monkeypatch.setattr(get_settings(), 'artifact_root', str(tmp_path))
    user = User(username='composer', email='composer@example.org', password_hash='unused', plan_cache='RESEARCH')
    db_session.add(user)
    await db_session.flush()
    org = Organization(slug='composers', name='Composers', billing_sponsor_user_id=user.id, created_by_id=user.id)
    db_session.add(org)
    await db_session.flush()
    db_session.add(OrganizationMembership(organization_id=org.id, user_id=user.id, role=OrganizationRole.OWNER))
    package = base_package()
    root = package.instance()
    uses = []
    for role, resources in root['spec']['resources'].items():
        for alias, path in resources.items():
            document = json.loads(package.files[path])
            artifact = Artifact(organization_id=org.id, namespace=str(org.id), name=alias,
                display_name=alias, kind=document['kind'], created_by_id=user.id)
            db_session.add(artifact)
            await db_session.flush()
            draft = ArtifactDraft(artifact_id=artifact.id, payload=DraftContent(content=document).model_dump(), created_by_id=user.id)
            db_session.add(draft)
            await db_session.flush()
            version = await seal_draft(db_session, artifact, draft, 1, None, user)
            uses.append(ArtifactUse(role=role, alias=alias, artifact=reference(artifact, version)))
    source, snapshot_id, rows = await materialize_case(db_session, user, org, root, uses)
    assert all(isinstance(target, dict) and 'versionDigest' in target
               for resources in source['spec']['resources'].values() for target in resources.values())
    assert (await materialize_case(db_session, user, org, root, uses))[1] == snapshot_id
    snapshot = await db_session.get(InstanceSnapshot, snapshot_id)
    original_digest = snapshot.package_digest
    use, version = next((use, version) for use, version in rows if use.alias == 'cat-a')
    artifact = await db_session.get(Artifact, version.artifact_id)
    document = json.loads((await version_content(db_session, version))[0])
    document['spec']['candidates']['c1']['features']['latency'] += 1
    draft = ArtifactDraft(artifact_id=artifact.id, payload=DraftContent(content=document).model_dump(), created_by_id=user.id)
    db_session.add(draft)
    await db_session.flush()
    changed = await seal_draft(db_session, artifact, draft, 1, None, user)
    updated_uses = [ArtifactUse.model_validate({**item.model_dump(), 'artifact': reference(artifact, changed)}) if item.alias == use.alias else item for item in uses]
    # Validate the portable type instead of relying on unchecked model_copy data.
    updated_uses = [ArtifactUse.model_validate(item.model_dump()) for item in updated_uses]
    _, changed_id, _ = await materialize_case(db_session, user, org, deepcopy(root), updated_uses)
    assert changed_id != snapshot_id
    assert (await db_session.get(InstanceSnapshot, snapshot_id)).package_digest == original_digest

    # Scientific artifact versions pin the composition, not the mutable case title.
    from sqlalchemy import select
    from openbinding_gateway.db.models import ArtifactCaseReference, BindingCase, BindingCaseRevision, Project
    from openbinding_gateway.artifacts import case_composition_digest
    from openbinding_gateway.routes.v1 import _engine_ref, _manifest
    project = Project(organization_id=org.id, slug='experiment', name='Experiment', created_by_id=user.id)
    db_session.add(project)
    await db_session.flush()
    case = BindingCase(project_id=project.id, slug='case', name='Case', created_by_id=user.id)
    db_session.add(case)
    await db_session.flush()
    revision = BindingCaseRevision(binding_case_id=case.id, revision=1, document=source,
        digest=case_composition_digest(source, snapshot, [use.model_dump(mode='json') for use in uses]), source_snapshot_id=snapshot.id, created_by_id=user.id)
    db_session.add(revision)
    await db_session.flush()
    case_ref = {'caseRevisionId': str(revision.id), 'compositionDigest': revision.digest}
    for kind, content in [('Study', {'apiVersion': 'openbinding/study/v1', 'cases': [case_ref], 'engines': [{**_engine_ref(_manifest('random-search')), 'mode': 'seeded'}]}),
                          ('Collection', {'apiVersion': 'openbinding/collection/v1', 'members': [case_ref]})]:
        identity = Artifact(organization_id=org.id, namespace=str(org.id), name=kind.lower(),
            display_name=kind, kind=kind, created_by_id=user.id)
        db_session.add(identity)
        await db_session.flush()
        draft = ArtifactDraft(artifact_id=identity.id, payload=DraftContent(content=content).model_dump(), created_by_id=user.id)
        db_session.add(draft)
        await db_session.flush()
        sealed = await seal_draft(db_session, identity, draft, 1, '1', user)
        links = (await db_session.scalars(select(ArtifactCaseReference).where(ArtifactCaseReference.version_id == sealed.id))).all()
        assert [(link.position, link.case_revision_id) for link in links] == [(0, revision.id)]
        from openbinding_gateway.routes.library import publish_version
        from openbinding_gateway.models.artifacts import PublishVersion
        with pytest.raises(HTTPException) as publication_error:
            await publish_version(identity.id, sealed.id, PublishVersion(), user, db_session)
        assert publication_error.value.status_code == 422
        with pytest.raises(DBAPIError):
            async with db_session.begin_nested():
                await db_session.execute(update(ArtifactCaseReference).where(ArtifactCaseReference.version_id == sealed.id).values(position=9))
        invalid = deepcopy(content)
        invalid['cases' if kind == 'Study' else 'members'][0]['compositionDigest'] = 'sha256-' + '0' * 64
        wrong = ArtifactDraft(artifact_id=identity.id, payload=DraftContent(content=invalid).model_dump(), created_by_id=user.id)
        db_session.add(wrong)
        await db_session.flush()
        with pytest.raises(HTTPException) as rejected:
            await seal_draft(db_session, identity, wrong, 1, '2', user)
        assert rejected.value.status_code == 422
        assert (await version_content(db_session, sealed))[0] != b''


@pytest.mark.asyncio
@pytest.mark.parametrize('operation', ['seal_same_draft', 'seal_conflicting_label', 'edit_same_revision'])
async def test_postgresql_concurrent_editorial_operations(db_session, operation):
    """Independent committed connections, rather than sequential calls in one transaction."""
    import asyncio
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from openbinding_gateway.models.artifacts import DraftUpdate
    from openbinding_gateway.routes.library import edit_draft

    if db_session.bind.dialect.name != 'postgresql':
        pytest.skip('Row-lock concurrency requires PostgreSQL.')
    user = User(username='concurrent-owner', email='concurrent@example.org', password_hash='unused', plan_cache='RESEARCH')
    db_session.add(user)
    await db_session.flush()
    org = Organization(slug='concurrent-team', name='Concurrent team', billing_sponsor_user_id=user.id, created_by_id=user.id)
    db_session.add(org)
    await db_session.flush()
    db_session.add(OrganizationMembership(organization_id=org.id, user_id=user.id, role=OrganizationRole.OWNER))
    artifact = Artifact(organization_id=org.id, namespace=str(org.id), name='concurrent-data',
        display_name='Concurrent data', kind='Dataset', created_by_id=user.id)
    db_session.add(artifact)
    await db_session.flush()
    drafts = [ArtifactDraft(artifact_id=artifact.id, payload=DraftContent(content={'value': n}).model_dump(), created_by_id=user.id) for n in (1, 2)]
    db_session.add_all(drafts)
    await db_session.commit()
    identities = [draft.id for draft in drafts]
    artifact_id, user_id = artifact.id, user.id
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    barrier = asyncio.Barrier(2)

    async def contender(index):
        async with factory() as session:
            caller = await session.get(User, user_id)
            identity = await session.get(Artifact, artifact_id)
            draft_id = identities[index] if operation == 'seal_conflicting_label' else identities[0]
            draft = await session.get(ArtifactDraft, draft_id)
            await barrier.wait()
            try:
                if operation == 'edit_same_revision':
                    result = await edit_draft(artifact_id, draft_id,
                        DraftUpdate(content={'winner': index}, revision=1), caller, session)
                    result = result['revision']
                else:
                    result = (await seal_draft(session, identity, draft, 1, 'release', caller)).id
                await session.commit()
                return 200, result
            except HTTPException as exc:
                await session.rollback()
                return exc.status_code, None

    outcomes = await asyncio.wait_for(asyncio.gather(contender(0), contender(1)), timeout=20)
    if operation == 'seal_same_draft':
        assert outcomes[0] == outcomes[1]
        assert outcomes[0][0] == 200
    else:
        assert sorted(code for code, _ in outcomes) == [200, 409]
    db_session.expire_all()
    versions = (await db_session.scalars(select(ArtifactVersion).where(ArtifactVersion.artifact_id == artifact_id))).all()
    assert len(versions) == (0 if operation == 'edit_same_revision' else 1)
    if operation == 'edit_same_revision':
        assert (await db_session.get(ArtifactDraft, identities[0])).revision == 2

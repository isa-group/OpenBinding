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
    org = Organization(slug='artifact-team', name='Artifact team', created_by_id=user.id)
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
async def test_a_study_version_pins_problem_revisions_by_their_package_digest(db_session):
    from copy import deepcopy
    from sqlalchemy import select
    from _problem_helpers import problem_for
    from openbinding_gateway.db.models import ArtifactCaseReference
    from openbinding_gateway.services.engines import engine_ref as _engine_ref
    from openbinding_gateway.services.engines import manifest as _manifest

    user = User(username='composer', email='composer@example.org', password_hash='unused', plan_cache='RESEARCH')
    db_session.add(user)
    await db_session.flush()
    org = Organization(slug='composers', name='Composers', created_by_id=user.id)
    db_session.add(org)
    await db_session.flush()
    db_session.add(OrganizationMembership(organization_id=org.id, user_id=user.id, role=OrganizationRole.OWNER))
    await db_session.flush()
    revision = (await problem_for(db_session, user, organization=org)).revision

    # Scientific artifact versions pin the problem revision by its package digest, not the mutable problem title.
    case_ref = {'caseRevisionId': str(revision.id), 'compositionDigest': revision.package_digest}
    for kind, content in [('Study', {'apiVersion': 'openbinding/study/v1', 'cases': [case_ref], 'engines': [{**_engine_ref(_manifest('random-search')), 'mode': 'seeded',
                                                                                                              'optimization': {'type': 'SINGLE', 'scalarization': 'weighted-sum'}}]})]:
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
        # No operation publishes a version since M9.6 (design.md §7), so the publication refusal of a
        # private case reference is no longer reachable here.
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
@pytest.mark.parametrize('operation', ['seal_same_draft', 'seal_conflicting_label'])
async def test_postgresql_concurrent_editorial_operations(db_session, operation):
    """Independent committed connections, rather than sequential calls in one transaction.

    The draft edit route is removed since M9.6; the internal seal stays.
    """
    import asyncio
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker

    if db_session.bind.dialect.name != 'postgresql':
        pytest.skip('Row-lock concurrency requires PostgreSQL.')
    user = User(username='concurrent-owner', email='concurrent@example.org', password_hash='unused', plan_cache='RESEARCH')
    db_session.add(user)
    await db_session.flush()
    org = Organization(slug='concurrent-team', name='Concurrent team', created_by_id=user.id)
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
    assert len(versions) == 1

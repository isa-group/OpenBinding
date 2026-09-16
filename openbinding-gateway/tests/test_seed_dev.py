"""Tests for the development database seeder tools/seed_dev.py."""

from __future__ import annotations

# ruff: noqa: E402

import sys
from pathlib import Path

import pytest
from sqlalchemy import select

_tools_dir = str(Path(__file__).resolve().parents[1] / "tools")
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

from openbinding_gateway.db.models import Artifact, ArtifactVersion, ApiKey, EngineRegistrationRevision, EngineRevision, Job, JobState, User, UserRole
from openbinding_gateway.db.platform_models import (
    Blob,
    AuditEvent,
    Collection,
    Notification,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    Publication,
    Report,
    Visibility,
)
from openbinding_gateway.security.passwords import verify_password
from seed_dev import (
    DEV_PASSWORD,
    _deterministic_zip,
    clean_existing_data,
    ensure_artifacts,
    ensure_cases_and_collections,
    ensure_engine_revisions,
    ensure_notifications_and_audit,
    ensure_organizations,
    ensure_project_resources,
    ensure_projects,
    ensure_reports_and_publications,
    ensure_standalone_jobs,
    ensure_users,
    load_and_persist_snapshots,
)


def test_seed_zip_is_byte_for_byte_deterministic():
    entries = [("README.md", "seed"), ("data.json", b"{}")]
    assert _deterministic_zip(entries) == _deterministic_zip(entries)


async def test_live_report_seed_upgrades_drafts_and_preserves_two_editions(
    api_client, db_session, registration, monkeypatch
):
    from test_studies_platform import _headers, EXAMPLE
    from _pricing import fake_pricing_gate, largest_plan
    from openbinding_gateway import space_client
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.routes import v1 as routes
    from openbinding_gateway.db.models import Project, InstanceSnapshot, Study, StudyRun
    from openbinding_gateway.v1.package import load_package
    import uuid

    async def solve(*args, **kwargs):
        return {'termination': 'FEASIBLE', 'solutions': [{'decision': {'kind': 'binding', 'binding': {
            't1': {'resource': 'catalog', 'id': 'c1a'}, 't2': {'resource': 'catalog', 'id': 'c2a'},
            't3': {'resource': 'catalog', 'id': 'c3a'}}}}]}

    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    try:
        monkeypatch.setattr(get_settings(), 'job_dispatch_mode', 'inline')
        monkeypatch.setattr(routes, 'solve_remote', solve)
        headers = await _headers(api_client, registration)
        profile = (await api_client.get('/v1/users/me', headers=headers)).json()
        user = await db_session.get(User, uuid.UUID(profile['id']))
        gate.plans[user.id] = largest_plan()
        await api_client.post('/v1/organizations', headers=headers, json={'slug': 'seed-live', 'name': 'Seed live'})
        response = await api_client.post('/v1/organizations/seed-live/projects', headers=headers,
            json={'slug': 'benchmark', 'name': 'Benchmark', 'visibility': 'public'})
        project = await db_session.get(Project, uuid.UUID(response.json()['id']))
        await ensure_reports_and_publications(db_session, project, user, [])
        package = load_package(EXAMPLE)
        response = await api_client.post('/v1/instances', headers={**headers, 'Content-Type': 'application/vnd.bim+zip'}, content=package.to_zip())
        snapshot = await db_session.get(InstanceSnapshot, uuid.UUID(response.json()['id']))
        cases = await ensure_cases_and_collections(db_session, project, user, {'01_simple_seq': (package, snapshot)})
        base = '/v1/organizations/seed-live/projects/benchmark'
        response = await api_client.post(base + '/studies', headers=headers, json={
            'slug': 'benchmark', 'name': 'Benchmark', 'definition': {
                'case_revision_ids': [str(cases['simple-seq'][1].id)],
                'engines': [{**routes._engine_ref(routes._manifest('random-search')), 'mode': 'seeded'}],
                'parameter_sets': [{'iterations': 1}], 'seeds': [1]}})
        assert response.status_code == 201, response.text
        study = await db_session.get(Study, uuid.UUID(response.json()['id']))
        response = await api_client.post(base + '/studies/benchmark/runs', headers=headers)
        assert response.status_code == 202, response.text
        run = await db_session.get(StudyRun, uuid.UUID(response.json()['id']))
        await ensure_reports_and_publications(db_session, project, user, [(study, run)])
        report = await db_session.scalar(select(Report).where(Report.project_id == project.id, Report.slug == 'qos-placement-2026-report'))
        versions = (await db_session.scalars(select(ArtifactVersion).where(ArtifactVersion.artifact_id == report.artifact_id))).all()
        assert len(versions) == 2
        original = {version.id: version.version_digest for version in versions}
        await ensure_reports_and_publications(db_session, project, user, [(study, run)])
        versions = (await db_session.scalars(select(ArtifactVersion).where(ArtifactVersion.artifact_id == report.artifact_id))).all()
        assert {version.id: version.version_digest for version in versions} == original
        publications = (await db_session.scalars(select(Publication).where(Publication.report_id == report.id).order_by(Publication.slug))).all()
        assert len(publications) == 2
        assert [publication.withdrawn for publication in publications] == [True, False]
        assert len({publication.version_id for publication in publications}) == 2
    finally:
        space_client.set_gate(previous)


@pytest.mark.asyncio
async def test_seed_dev_lifecycle(db_session):
    """Verify that seed_dev creates the full hierarchy and cleans it up properly."""
    # 1. Ensure users
    users = await ensure_users(db_session)
    assert len(users) == 7
    assert "admin" in users
    assert "alice" in users
    assert "bob" in users
    assert users["admin"].role == UserRole.ADMIN
    assert users["alice"].role == UserRole.USER
    assert verify_password(DEV_PASSWORD, users["alice"].password_hash)

    # Check API keys
    api_keys = (await db_session.execute(select(ApiKey))).scalars().all()
    assert len(api_keys) == 7

    # 2. Ensure organizations
    orgs = await ensure_organizations(db_session, users)
    assert len(orgs) == 5
    assert "score-group" in orgs
    assert "score-ai" in orgs
    assert "acme-cloud" in orgs

    # Verify hierarchy
    assert orgs["score-ai"].parent_id == orgs["score-group"].id
    assert orgs["score-edge"].parent_id == orgs["score-group"].id
    assert orgs["acme-cloud"].parent_id == orgs["acme-corp"].id

    # Verify memberships
    memberships = (await db_session.execute(select(OrganizationMembership))).scalars().all()
    assert len(memberships) >= 15

    alice_score_ai = (
        await db_session.execute(
            select(OrganizationMembership).where(
                OrganizationMembership.organization_id == orgs["score-ai"].id,
                OrganizationMembership.user_id == users["alice"].id,
            )
        )
    ).scalar_one()
    assert alice_score_ai.role == OrganizationRole.OWNER

    # 3. Ensure projects
    projects = await ensure_projects(db_session, orgs, users)
    assert len(projects) == 5
    assert "score-ai/qos-placement" in projects
    assert projects["score-ai/qos-placement"].visibility == Visibility.PUBLIC
    assert projects["score-ai/smart-orchestration"].visibility == Visibility.PRIVATE

    # 4. Snapshots & Cases
    repo_root = Path(__file__).resolve().parents[2]
    examples_dir = repo_root / "examples"
    snapshots = await load_and_persist_snapshots(db_session, users["alice"], examples_dir)

    qos_proj = projects["score-ai/qos-placement"]
    case_map = await ensure_cases_and_collections(db_session, qos_proj, users["alice"], snapshots)
    if "simple-seq" in case_map:
        case, rev = case_map["simple-seq"]
        assert case.slug == "simple-seq"
        assert rev.source_snapshot_id is not None

        collections = (await db_session.execute(select(Collection))).scalars().all()
        assert len(collections) >= 1

    # Engine Revisions & Registrations
    engs = await ensure_engine_revisions(db_session, users["admin"])
    assert len(engs) >= 2
    db_engs = (await db_session.execute(select(EngineRevision))).scalars().all()
    assert len(db_engs) >= 2
    db_regs = (await db_session.execute(select(EngineRegistrationRevision))).scalars().all()
    assert len(db_regs) >= 2

    # Without a real input snapshot, the seeder must not manufacture solver jobs.
    jobs = await ensure_standalone_jobs(db_session, orgs["score-ai"], qos_proj, users["alice"], all_states=True)
    assert jobs == []
    assert not (await db_session.scalars(select(Job))).all()

    # 5. Reports & Publications
    await ensure_reports_and_publications(db_session, qos_proj, users["alice"], [])
    reports = (await db_session.execute(select(Report))).scalars().all()
    assert len(reports) >= 2
    frozen_reports = [r for r in reports if r.state.value == "frozen"]
    assert frozen_reports == []  # No fabricated terminal evidence when studies were not executed.

    pubs = (await db_session.execute(select(Publication))).scalars().all()
    assert pubs == []

    # 6. Reusable Project Resources & Revisions
    res_map = await ensure_project_resources(db_session, projects, users)
    assert len(res_map) >= 3
    assert "01_simple_seq-catalog" in res_map
    cat_res, cat_revs = res_map["01_simple_seq-catalog"]
    assert cat_res.kind == "CandidateCatalog"
    assert len(cat_revs) == 2
    before_versions = len((await db_session.scalars(select(ArtifactVersion))).all())
    await ensure_project_resources(db_session, projects, users)
    assert len((await db_session.scalars(select(ArtifactVersion))).all()) == before_versions
    from openbinding_gateway.db.models import ProjectArtifact, BindingCase, BindingCaseRevision, CaseArtifact
    from openbinding_gateway.artifacts import can_read
    config = await db_session.scalar(select(Artifact).where(Artifact.name == 'shared-seeded-search'))
    assert config.kind == 'ExecutionConfiguration'
    assert len((await db_session.scalars(select(ProjectArtifact).where(ProjectArtifact.artifact_id == config.id))).all()) == 2
    assert not await can_read(db_session, config, users['elena'])
    public_case = await db_session.scalar(select(BindingCase).where(BindingCase.slug == 'public-library-experiment'))
    assert public_case.project_id == projects['acme-cloud/stock-trading-pipeline'].id
    consumed = (await db_session.scalars(select(CaseArtifact.version_id)
        .join(BindingCaseRevision, BindingCaseRevision.id == CaseArtifact.revision_id)
        .where(BindingCaseRevision.binding_case_id == public_case.id))).all()
    assert cat_revs[0].id in consumed
    assert cat_revs[1].id not in consumed
    db_resources = (await db_session.execute(select(Artifact))).scalars().all()
    assert len(db_resources) >= 3
    db_revs = (await db_session.execute(select(ArtifactVersion))).scalars().all()
    assert len(db_revs) >= 4

    # 7. Artifacts
    artifacts = await ensure_artifacts(db_session, orgs, projects, users)
    assert len(artifacts) >= 3
    for art in artifacts:
        assert art.digest.startswith("sha256-")
        assert art.size_bytes > 0
    db_artifacts = (await db_session.execute(select(Blob))).scalars().all()
    assert len(db_artifacts) >= 3

    # 8. Notifications & Audit
    await ensure_notifications_and_audit(db_session, orgs, projects, users)
    notifs = (await db_session.execute(select(Notification))).scalars().all()
    assert len(notifs) >= 4

    audits = (await db_session.execute(select(AuditEvent))).scalars().all()
    assert len(audits) >= 6

    # 9. Idempotency test (calling again does not crash or duplicate orgs)
    users_again = await ensure_users(db_session)
    assert len(users_again) == 7
    orgs_again = await ensure_organizations(db_session, users)
    assert len(orgs_again) == 5

    # 10. Reset test
    await clean_existing_data(db_session)

    # Verify that clean deleted the seeded orgs, artifacts, resources, and non-admin users
    remaining_engs = (await db_session.execute(select(EngineRevision))).scalars().all()
    assert len(remaining_engs) == 0

    remaining_regs = (await db_session.execute(select(EngineRegistrationRevision))).scalars().all()
    assert len(remaining_regs) == 0

    remaining_artifacts = (await db_session.execute(select(Blob))).scalars().all()
    assert len(remaining_artifacts) == 0

    remaining_resources = (await db_session.execute(select(Artifact))).scalars().all()
    assert len(remaining_resources) == 0

    remaining_revisions = (await db_session.execute(select(ArtifactVersion))).scalars().all()
    assert len(remaining_revisions) == 0

    remaining_orgs = (await db_session.execute(select(Organization))).scalars().all()
    assert len(remaining_orgs) == 0

    remaining_users = (await db_session.execute(select(User))).scalars().all()
    # Only admin should remain
    assert all(u.username == "admin" for u in remaining_users)

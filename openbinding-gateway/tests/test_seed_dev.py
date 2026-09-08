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

from openbinding_gateway.db.models import ApiKey, EngineRegistrationRevision, EngineRevision, Job, JobState, User, UserRole
from openbinding_gateway.db.platform_models import (
    Artifact,
    AuditEvent,
    Collection,
    Notification,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    ProjectResource,
    ProjectResourceRevision,
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

    # Standalone jobs with all 4 states
    jobs = await ensure_standalone_jobs(db_session, orgs["score-ai"], qos_proj, users["alice"], all_states=True)
    assert len(jobs) == 4
    job_states = {j.state for j in jobs}
    assert job_states == {JobState.COMPLETED, JobState.RUNNING, JobState.QUEUED, JobState.FAILED}
    db_jobs = (await db_session.execute(select(Job))).scalars().all()
    assert len(db_jobs) >= 4

    # 5. Reports & Publications
    await ensure_reports_and_publications(db_session, qos_proj, users["alice"], [])
    reports = (await db_session.execute(select(Report))).scalars().all()
    assert len(reports) >= 2
    frozen_reports = [r for r in reports if r.state.value == "frozen"]
    assert len(frozen_reports) == 1

    pubs = (await db_session.execute(select(Publication))).scalars().all()
    assert len(pubs) == 1
    assert pubs[0].slug == "qos-placement-paper"

    # 6. Reusable Project Resources & Revisions
    res_map = await ensure_project_resources(db_session, projects, users)
    assert len(res_map) >= 3
    assert "qos-placement/standard-candidate-catalog" in res_map
    cat_res, cat_revs = res_map["qos-placement/standard-candidate-catalog"]
    assert cat_res.kind == "CandidateCatalog"
    assert len(cat_revs) == 2
    db_resources = (await db_session.execute(select(ProjectResource))).scalars().all()
    assert len(db_resources) >= 3
    db_revs = (await db_session.execute(select(ProjectResourceRevision))).scalars().all()
    assert len(db_revs) >= 4

    # 7. Artifacts
    artifacts = await ensure_artifacts(db_session, orgs, projects, users)
    assert len(artifacts) >= 3
    for art in artifacts:
        assert art.digest.startswith("sha256-")
        assert art.size_bytes > 0
    db_artifacts = (await db_session.execute(select(Artifact))).scalars().all()
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

    remaining_artifacts = (await db_session.execute(select(Artifact))).scalars().all()
    assert len(remaining_artifacts) == 0

    remaining_resources = (await db_session.execute(select(ProjectResource))).scalars().all()
    assert len(remaining_resources) == 0

    remaining_revisions = (await db_session.execute(select(ProjectResourceRevision))).scalars().all()
    assert len(remaining_revisions) == 0

    remaining_orgs = (await db_session.execute(select(Organization))).scalars().all()
    assert len(remaining_orgs) == 0

    remaining_users = (await db_session.execute(select(User))).scalars().all()
    # Only admin should remain
    assert all(u.username == "admin" for u in remaining_users)

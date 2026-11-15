"""Tests for the development database seeder tools/seed_dev.py."""

from __future__ import annotations

# ruff: noqa: E402

import sys

import pytest
from _paths import GATEWAY_ROOT
from _repo import REPO_ROOT
from sqlalchemy import select, text

_tools_dir = str(GATEWAY_ROOT / "tools")
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

from openbinding_gateway.db.models import Artifact, ArtifactVersion, ApiKey, EngineRegistrationRevision, EngineRevision, Job, User, UserRole
from openbinding_gateway.db.platform_models import (
    AuditEvent,
    BindingCase,
    Notification,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    Visibility,
)
from openbinding_gateway.security.passwords import verify_password
from seed_dev import (
    DEV_PASSWORD,
    clean_existing_data,
    ensure_cases,
    ensure_engine_revisions,
    ensure_notifications_and_audit,
    ensure_organizations,
    ensure_projects,
    ensure_standalone_jobs,
    ensure_users,
)


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

    # 4. Problems of the organization, uploaded from the demo packages
    examples_dir = REPO_ROOT / "examples"
    qos_proj = projects["score-ai/qos-placement"]
    case_map = await ensure_cases(db_session, orgs["score-ai"], users["alice"], examples_dir)
    case, rev = case_map["simple-seq"]
    assert case.slug == "simple-seq" and case.organization_id == orgs["score-ai"].id
    assert rev.revision == 1 and rev.package_digest.startswith("sha256-")
    again = await ensure_cases(db_session, orgs["score-ai"], users["alice"], examples_dir)
    assert again["simple-seq"][1].id == rev.id
    assert len((await db_session.scalars(select(BindingCase))).all()) == len(case_map)

    # Engine Revisions & Registrations
    engs = await ensure_engine_revisions(db_session, users["admin"])
    assert len(engs) >= 2
    db_engs = (await db_session.execute(select(EngineRevision))).scalars().all()
    assert len(db_engs) >= 2
    db_regs = (await db_session.execute(select(EngineRegistrationRevision))).scalars().all()
    assert len(db_regs) >= 2

    # Without a problem revision, the seeder must not manufacture solver jobs.
    jobs = await ensure_standalone_jobs(db_session, orgs["score-ai"], qos_proj, users["alice"], all_states=True)
    assert jobs == []
    assert not (await db_session.scalars(select(Job))).all()

    # 7. Notifications & Audit
    await ensure_notifications_and_audit(db_session, orgs, projects, users)
    notifs = (await db_session.execute(select(Notification))).scalars().all()
    assert len(notifs) >= 4

    audits = (await db_session.execute(select(AuditEvent))).scalars().all()
    assert len(audits) >= 4

    # 8. Idempotency test (calling again does not crash or duplicate orgs)
    users_again = await ensure_users(db_session)
    assert len(users_again) == 7
    orgs_again = await ensure_organizations(db_session, users)
    assert len(orgs_again) == 5

    # 9. Reset test. A table of an older baseline, unknown to the models, goes too.
    await db_session.execute(text("CREATE TABLE reports (id INTEGER PRIMARY KEY)"))
    await db_session.commit()
    await clean_existing_data(db_session)
    tables = (await db_session.execute(text("SELECT name FROM sqlite_master WHERE type = 'table'"))).scalars().all()
    assert "reports" not in tables and "alembic_version" in tables

    # Verify that clean deleted the seeded orgs, artifacts, resources, and non-admin users
    remaining_engs = (await db_session.execute(select(EngineRevision))).scalars().all()
    assert len(remaining_engs) == 0

    remaining_regs = (await db_session.execute(select(EngineRegistrationRevision))).scalars().all()
    assert len(remaining_regs) == 0

    remaining_problems = (await db_session.execute(select(BindingCase))).scalars().all()
    assert len(remaining_problems) == 0

    remaining_resources = (await db_session.execute(select(Artifact))).scalars().all()
    assert len(remaining_resources) == 0

    remaining_revisions = (await db_session.execute(select(ArtifactVersion))).scalars().all()
    assert len(remaining_revisions) == 0

    remaining_orgs = (await db_session.execute(select(Organization))).scalars().all()
    assert len(remaining_orgs) == 0

    remaining_users = (await db_session.execute(select(User))).scalars().all()
    # Only admin should remain
    assert all(u.username == "admin" for u in remaining_users)

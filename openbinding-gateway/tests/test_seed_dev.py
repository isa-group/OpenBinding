"""Tests for the development database seeder tools/seed_dev.py."""

from __future__ import annotations

# ruff: noqa: E402

import sys

import pytest
from _paths import GATEWAY_ROOT
from _repo import REPO_ROOT
from sqlalchemy import func, select, text

_tools_dir = str(GATEWAY_ROOT / "tools")
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

from openbinding_gateway.db.models import (
    ApiKey,
    Composition,
    CompositionDerivation,
    CompositionEvaluation,
    CompositionVersion,
    EngineRegistrationRevision,
    EngineRevision,
    Job,
    JobState,
    ProblemCompilation,
    Study,
    User,
    UserRole,
)
from openbinding_gateway.db.platform_models import (
    AuditEvent,
    BindingCase,
    Notification,
    Organization,
    OrganizationMembership,
    OrganizationRole,
)
from openbinding_gateway.security.passwords import verify_password
from seed_dev import (
    DEV_PASSWORD,
    clean_existing_data,
    ensure_cases,
    ensure_compositions,
    ensure_engine_revisions,
    ensure_notifications_and_audit,
    ensure_organizations,
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

    # 3. Problems of the organization, uploaded from the demo packages
    examples_dir = REPO_ROOT / "examples"
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
    jobs = await ensure_standalone_jobs(db_session, orgs["score-ai"], users["alice"], all_states=True)
    assert jobs == []
    assert not (await db_session.scalars(select(Job))).all()

    # 4. Notifications & Audit
    await ensure_notifications_and_audit(db_session, orgs, users)
    notifs = (await db_session.execute(select(Notification))).scalars().all()
    assert len(notifs) >= 4

    audits = (await db_session.execute(select(AuditEvent))).scalars().all()
    assert len(audits) >= 4

    # 5. Idempotency test (calling again does not crash or duplicate orgs)
    users_again = await ensure_users(db_session)
    assert len(users_again) == 7
    orgs_again = await ensure_organizations(db_session, users)
    assert len(orgs_again) == 5

    # 6. Reset test. A table of an older baseline, unknown to the models, goes too.
    await db_session.execute(text("CREATE TABLE reports (id INTEGER PRIMARY KEY)"))
    await db_session.commit()
    await clean_existing_data(db_session)
    tables = (await db_session.execute(text("SELECT name FROM sqlite_master WHERE type = 'table'"))).scalars().all()
    assert "reports" not in tables and "alembic_version" in tables

    # Verify that clean deleted the seeded orgs, problems, studies and non-admin users
    remaining_engs = (await db_session.execute(select(EngineRevision))).scalars().all()
    assert len(remaining_engs) == 0

    remaining_regs = (await db_session.execute(select(EngineRegistrationRevision))).scalars().all()
    assert len(remaining_regs) == 0

    remaining_problems = (await db_session.execute(select(BindingCase))).scalars().all()
    assert len(remaining_problems) == 0

    remaining_studies = (await db_session.execute(select(Study))).scalars().all()
    assert len(remaining_studies) == 0

    remaining_orgs = (await db_session.execute(select(Organization))).scalars().all()
    assert len(remaining_orgs) == 0

    remaining_users = (await db_session.execute(select(User))).scalars().all()
    # Only admin should remain
    assert all(u.username == "admin" for u in remaining_users)


async def _count(db_session, model) -> int:
    return int(await db_session.scalar(select(func.count()).select_from(model)) or 0)


@pytest.mark.asyncio
async def test_seed_dev_compositions_are_derived_and_declared_once(db_session):
    """``simple-seq`` derives from the seeded run of its problem, gets a second version from a binding and is
    public; ``tomatometer-sketch`` is declared and private; seeding again stores nothing new."""
    users = await ensure_users(db_session)
    orgs = await ensure_organizations(db_session, users)
    organization, alice = orgs["score-ai"], users["alice"]
    case_map = await ensure_cases(db_session, organization, alice, REPO_ROOT / "examples")
    _, revision = case_map["simple-seq"]
    compilation = await db_session.scalar(select(ProblemCompilation).where(ProblemCompilation.revision_id == revision.id))
    # A run of simple-seq as the seed's engines leave it: completed, its solution the demo's binding.
    binding = {task: {"resource": "catalog", "id": candidate} for task, candidate in (("t1", "c1a"), ("t2", "c2a"), ("t3", "c3a"))}
    run = Job(
        created_by_id=alice.id, engine_id="random-search", engine_job_id="seed-run", service_url="http://engine",
        state=JobState.COMPLETED, termination="FEASIBLE",
        result={"solutions": [{"decision": {"kind": "binding", "binding": binding}, "features": {}}]},
        organization_id=organization.id, revision_id=revision.id, compilation_id=compilation.id, provenance={},
    )
    db_session.add(run)
    await db_session.commit()

    sealed = await ensure_compositions(db_session, organization, alice, case_map, [run])

    assert [version.label for version in sealed] == ["1.0.0", "1.1.0", "0.1.0"]
    visibility = dict((await db_session.execute(select(Composition.slug, Composition.visibility))).all())
    assert visibility == {"simple-seq": "public", "tomatometer-sketch": "private"}
    counts = [await _count(db_session, model) for model in (CompositionVersion, CompositionEvaluation, CompositionDerivation)]
    assert counts == [3, 3, 2]
    from_run = await db_session.scalar(select(CompositionDerivation).where(CompositionDerivation.job_id.is_not(None)))
    assert from_run.job_id == run.id and from_run.point == 0
    derived, second, declared = sealed
    assert derived.values_status.value == "verified" and derived.evidence_job_id == run.id
    # 1.1.0 binds t1 to its other candidate, from a binding of the same revision.
    assert second.values_status.value == "verified" and second.evidence_job_id is None
    assert "candidate: c1a" in derived.content and "candidate: c1b" in second.content
    assert declared.values_status.value == "declared" and declared.offering == {"sphere": "isa/tomatometer"}
    assert "  login:\n    local: true\n" in declared.content

    again = await ensure_compositions(db_session, organization, alice, case_map, [run])

    assert [version.id for version in again] == [version.id for version in sealed]
    assert [await _count(db_session, model) for model in (Composition, CompositionVersion, CompositionEvaluation, CompositionDerivation)] == [2, 3, 3, 2]

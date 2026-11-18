"""Deleting an organization on PostgreSQL, where the RESTRICT foreign keys hold (F0b B8).

The subtree goes in one transaction and in an order the foreign keys accept: studies, run presets, compositions,
compilations, revisions, problems and blob rows of each organization, then the organizations below it, then the organization. A run
anywhere in the subtree answers 409 ``historical_references`` and deletes nothing, also when it is written while
the delete runs: the subtree's studies, problems and organizations are locked before the check. SQLite enforces no
foreign key and takes no row lock, so only this file shows the order and the locking are right.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from _problem_helpers import problem_for, run_refs, seed_problem_run
from openbinding_gateway.db.models import (
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    Blob,
    Composition,
    Job,
    JobState,
    Organization,
    OrganizationInvitationCode,
    OrganizationMembership,
    PricingSnapshot,
    ProblemCompilation,
    RunPreset,
    Study,
    StudyRun,
    User,
    utcnow,
)
from openbinding_gateway.modules.plans.application import DEFAULT_ENDPOINT, Credential, snapshot_url, snapshot_version
from openbinding_gateway.routes.organizations import delete_organization

pytestmark = pytest.mark.asyncio


async def _user(session) -> User:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    return user


async def _child(session, parent: Organization, user: User) -> Organization:
    child = Organization(slug=f"c-{uuid.uuid4().hex[:8]}", name="Child", parent_id=parent.id, created_by_id=user.id)
    session.add(child)
    await session.flush()
    return child


async def _count(session, model, *conditions) -> int:
    return int(await session.scalar(select(func.count()).select_from(model).where(*conditions)) or 0)


async def test_an_organization_is_deleted_with_its_subtree_in_an_order_the_foreign_keys_accept(two_sessions):
    session, reader = two_sessions
    user = await _user(session)
    upload = await problem_for(session, user)
    organization = await session.get(Organization, upload.problem.organization_id)
    child = await _child(session, organization, user)
    in_child = await problem_for(session, user, organization=child)
    session.add_all([
        Study(
            organization_id=organization.id, slug="s", name="S", created_by_id=user.id,
            definition={"revision_ids": [str(upload.revision.id)]}, definition_digest="sha256-" + "d" * 64,
        ),
        OrganizationInvitationCode(
            organization_id=organization.id, code=uuid.uuid4().hex[:16], created_by_id=user.id,
            expires_at=utcnow() + timedelta(days=1),
        ),
        AuditEvent(organization_id=child.id, actor_id=user.id, action="problem.created", target_type="BindingCase", detail={}),
    ])
    await session.commit()
    ids = [organization.id, child.id]
    revisions = [upload.revision.id, in_child.revision.id]

    await delete_organization(org=organization.slug, user=user, session=session)
    await session.commit()

    assert await _count(reader, Organization, Organization.id.in_(ids)) == 0
    assert await _count(reader, BindingCase, BindingCase.organization_id.in_(ids)) == 0
    assert await _count(reader, BindingCaseRevision, BindingCaseRevision.id.in_(revisions)) == 0
    assert await _count(reader, ProblemCompilation, ProblemCompilation.revision_id.in_(revisions)) == 0
    assert await _count(reader, Study, Study.organization_id.in_(ids)) == 0
    assert await _count(reader, Blob, Blob.organization_id.in_(ids)) == 0
    assert await _count(reader, OrganizationMembership, OrganizationMembership.organization_id.in_(ids)) == 0
    assert await _count(reader, OrganizationInvitationCode, OrganizationInvitationCode.organization_id.in_(ids)) == 0
    assert await _count(reader, AuditEvent, AuditEvent.organization_id.in_(ids)) == 0
    assert await reader.get(User, user.id) is not None


async def test_an_organization_with_compositions_and_no_runs_is_deleted_with_them(two_sessions):
    session, reader = two_sessions
    user = await _user(session)
    upload = await problem_for(session, user)
    organization = await session.get(Organization, upload.problem.organization_id)
    child = await _child(session, organization, user)
    session.add_all([
        Composition(organization_id=organization.id, slug="checkout", name="Checkout", created_by_id=user.id),
        Composition(organization_id=organization.id, slug="archived", name="Old", archived=True, created_by_id=user.id),
        Composition(organization_id=child.id, slug="checkout", name="Checkout", created_by_id=user.id),
    ])
    await session.commit()
    ids, slug = [organization.id, child.id], organization.slug
    assert await _count(reader, Composition, Composition.organization_id.in_(ids)) == 3

    await delete_organization(org=slug, user=user, session=session)
    await session.commit()

    assert await _count(reader, Composition, Composition.organization_id.in_(ids)) == 0
    assert await _count(reader, Organization, Organization.id.in_(ids)) == 0
    assert await _count(reader, BindingCase, BindingCase.organization_id.in_(ids)) == 0
    assert await reader.get(User, user.id) is not None


async def test_an_organization_is_deleted_with_its_run_presets(two_sessions):
    session, reader = two_sessions
    user = await _user(session)
    upload = await problem_for(session, user)
    organization = await session.get(Organization, upload.problem.organization_id)
    child = await _child(session, organization, user)
    session.add_all([
        RunPreset(organization_id=where, slug="quick", name="Quick", engine="random-search", mode="seeded",
                  options={"seed": 1}, optimization={"type": "SINGLE", "scalarization": "weighted-sum"},
                  created_by_id=user.id)
        for where in (organization.id, child.id)
    ])
    await session.commit()
    ids, slug = [organization.id, child.id], organization.slug
    assert await _count(reader, RunPreset, RunPreset.organization_id.in_(ids)) == 2

    await delete_organization(org=slug, user=user, session=session)
    await session.commit()

    assert await _count(reader, RunPreset, RunPreset.organization_id.in_(ids)) == 0
    assert await _count(reader, Organization, Organization.id.in_(ids)) == 0
    assert await reader.get(User, user.id) is not None


async def test_a_run_below_the_organization_keeps_everything(two_sessions):
    session, reader = two_sessions
    user = await _user(session)
    upload = await problem_for(session, user)
    organization = await session.get(Organization, upload.problem.organization_id)
    child = await _child(session, organization, user)
    seeded = await seed_problem_run(session, created_by_id=user.id, organization_id=child.id)
    session.add(Job(
        created_by_id=user.id, engine_id="random-search", engine_job_id="", service_url="http://engine",
        state=JobState.COMPLETED, **run_refs(seeded),
    ))
    await session.commit()
    # The rollback below expires the loaded rows: keep their ids.
    ids, slug, problem_id = [organization.id, child.id], organization.slug, upload.problem.id

    with pytest.raises(HTTPException) as refused:
        await delete_organization(org=slug, user=user, session=session)
    await session.rollback()

    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "historical_references"
    assert await _count(reader, Organization, Organization.id.in_(ids)) == 2
    assert await _count(reader, BindingCase, BindingCase.id == problem_id) == 1


async def _delete_while_held(session, holder, slug, user) -> HTTPException:
    """Start the delete while ``holder`` has an uncommitted write in the subtree, then commit that write."""
    deleting = asyncio.create_task(delete_organization(org=slug, user=user, session=session))
    await asyncio.sleep(0.5)  # long enough for the delete to reach the lock the holder keeps
    assert not deleting.done(), "the delete must wait for the concurrent write"
    await holder.commit()
    with pytest.raises(HTTPException) as refused:
        await asyncio.wait_for(deleting, 20)
    await session.rollback()
    return refused.value


async def test_a_run_written_while_the_delete_starts_is_seen_by_the_check(two_sessions):
    session, writer = two_sessions
    user = await _user(session)
    upload = await problem_for(session, user)
    organization = await session.get(Organization, upload.problem.organization_id)
    seeded = await seed_problem_run(session, created_by_id=user.id, organization_id=organization.id)
    await session.commit()
    ids, slug = [organization.id], organization.slug
    # The insert holds a key-share lock on the organization until it commits, as createRun's does.
    writer.add(Job(
        created_by_id=user.id, engine_id="random-search", engine_job_id="", service_url="http://engine",
        state=JobState.QUEUED, **run_refs(seeded),
    ))
    await writer.flush()

    refused = await _delete_while_held(session, writer, slug, user)

    assert refused.status_code == 409
    assert refused.detail["code"] == "historical_references"
    assert await _count(writer, Organization, Organization.id.in_(ids)) == 1


async def test_a_study_run_started_while_the_delete_starts_is_seen_by_the_check(two_sessions):
    session, writer = two_sessions
    user = await _user(session)
    upload = await problem_for(session, user)
    organization = await session.get(Organization, upload.problem.organization_id)
    study = Study(
        organization_id=organization.id, slug="s", name="S", created_by_id=user.id,
        definition={"revision_ids": [str(upload.revision.id)]}, definition_digest="sha256-" + "d" * 64,
    )
    session.add(study)
    await session.commit()
    ids, slug, study_id = [organization.id], organization.slug, study.id
    # A study-run start locks its study, then inserts the run (study_jobs.create_study_run).
    await writer.execute(select(Study.id).where(Study.id == study_id).with_for_update())
    writer.add(StudyRun(
        study_id=study_id, run_number=1, matrix_digest="sha256-" + "m" * 64, definition={},
        definition_digest="sha256-" + "f" * 64, summary={}, created_by_id=user.id,
    ))
    await writer.flush()

    refused = await _delete_while_held(session, writer, slug, user)

    assert refused.status_code == 409
    assert refused.detail["code"] == "historical_references"
    assert await _count(writer, Study, Study.id == study_id) == 1
    assert await _count(writer, Organization, Organization.id.in_(ids)) == 1


async def test_a_run_the_check_misses_is_caught_by_the_foreign_key_with_the_same_409(two_sessions, monkeypatch):
    session, _ = two_sessions
    user = await _user(session)
    upload = await problem_for(session, user)
    organization = await session.get(Organization, upload.problem.organization_id)
    seeded = await seed_problem_run(session, created_by_id=user.id, organization_id=organization.id)
    session.add(Job(
        created_by_id=user.id, engine_id="random-search", engine_job_id="", service_url="http://engine",
        state=JobState.COMPLETED, **run_refs(seeded),
    ))
    await session.commit()
    slug = organization.slug
    original_scalar = session.scalar

    async def history_unseen(statement, *args, **kwargs):
        text = str(statement)
        if "FROM jobs" in text or "FROM study_runs" in text:
            return None
        return await original_scalar(statement, *args, **kwargs)

    monkeypatch.setattr(session, "scalar", history_unseen)
    with pytest.raises(HTTPException) as refused:
        await delete_organization(org=slug, user=user, session=session)
    await session.rollback()

    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "historical_references"


async def test_an_organization_that_read_a_private_pricing_and_a_url_is_deleted(two_sessions, sphere):
    """Its own snapshots go with it (no false historical_references); the public one stays for everyone."""
    session, reader = two_sessions
    user = await _user(session)
    upload = await problem_for(session, user)
    organization = await session.get(Organization, upload.problem.organization_id)
    mailgun, version, private = "6ade364540e55445692b0eda", "6ade36454b2b5b01c587db3d", "6b0000000000000000000003"
    key = "sk-" + "c" * 64
    sphere.private(mailgun, private, b"saasName: Private\n", credential=key)
    sphere.add_host("pricings.example", "93.184.216.34")
    sphere.serve("/offering.yml", b"saasName: A\n", {"content-type": "application/yaml"})
    await session.commit()
    public = (await snapshot_version(session, organization.id, DEFAULT_ENDPOINT, mailgun, version)).snapshot.id
    await snapshot_version(session, organization.id, DEFAULT_ENDPOINT, mailgun, private, Credential(str(organization.id), key))
    await snapshot_url(session, organization.id, "https://pricings.example/offering.yml", actor_id=user.id)
    ids, slug = [organization.id], organization.slug
    assert await _count(reader, PricingSnapshot, PricingSnapshot.organization_id.in_(ids)) == 2

    await delete_organization(org=slug, user=user, session=session)
    await session.commit()

    assert await _count(reader, Organization, Organization.id.in_(ids)) == 0
    assert await _count(reader, PricingSnapshot, PricingSnapshot.organization_id.in_(ids)) == 0
    assert await reader.get(PricingSnapshot, public) is not None

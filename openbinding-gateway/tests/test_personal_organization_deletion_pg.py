"""Deleting an account deletes its personal organization whole, on PostgreSQL's real foreign keys (F5-D D2).

SQLite enforces no foreign key in the suite, so this is the only check that the cascade reaches everything and that
nothing outside the organization stops it.

Needs ``TEST_DATABASE_URL`` (the ``pg`` fixture skips without it); synthetic data, no network.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import update
from sqlalchemy.exc import DBAPIError

from openbinding_gateway.db.models import Organization, User, utcnow
from openbinding_gateway.services.organizations import ensure_personal_organization

pytestmark = pytest.mark.asyncio


async def a_user(session) -> User:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="FREE")
    session.add(user)
    await session.flush()
    return user


async def test_the_personal_organization_is_deleted_whole_by_the_real_foreign_keys(pg) -> None:
    """Everything a personal organization can hold goes with it on PostgreSQL, its runs, study runs and feed keys
    included, and no foreign key from outside it stops the delete (a fork keeps only a snapshot of its source)."""
    import hashlib

    from sqlalchemy import func, select

    from _environment_rows import operated
    from _problem_helpers import run_refs, seed_problem_run
    from openbinding_gateway.db.models import (
        AuditEvent,
        BindingCase,
        Composition,
        CompositionDerivation,
        CompositionEnvironment,
        CompositionEnvironmentKey,
        CompositionVersion,
        DerivationSource,
        Job,
        JobEngineAttempt,
        JobState,
        OrganizationInvitationCode,
        OrganizationMembership,
        OrganizationRole,
        Study,
        StudyCell,
        StudyRun,
        ValuesStatus,
    )
    from openbinding_gateway.db.platform_models import RunState
    from openbinding_gateway.routes.organizations import delete_personal_organization

    async with pg.session() as session:
        user = await a_user(session)
        friend = await a_user(session)
        personal = await ensure_personal_organization(session, user)
        session.add(OrganizationMembership(organization_id=personal.id, user_id=friend.id, role=OrganizationRole.MEMBER))
        session.add(OrganizationInvitationCode(organization_id=personal.id, code=uuid.uuid4().hex[:16], created_by_id=user.id, use_count=0))
        seeded = await seed_problem_run(session, created_by_id=user.id, organization_id=personal.id)
        job = Job(created_by_id=user.id, engine_id="random-search", engine_job_id="e-1", service_url="inline",
                  state=JobState.COMPLETED, original_request={}, options={}, provenance={}, **run_refs(seeded))
        session.add(job)
        await session.flush()
        session.add(JobEngineAttempt(job_id=job.id, attempt=1, engine_job_id="e-1", endpoint="http://engine"))
        study = Study(organization_id=personal.id, slug="s", name="S", definition={}, definition_digest="sha256-x",
                      created_by_id=user.id)
        session.add(study)
        await session.flush()
        study_run = StudyRun(study_id=study.id, run_number=1, state=RunState.COMPLETED, matrix_digest="m",
                             definition={}, definition_digest="d", created_by_id=user.id)
        session.add(study_run)
        await session.flush()
        session.add(StudyCell(study_run_id=study_run.id, ordinal=1, binding_case_revision_id=seeded["revision_id"],
                              compilation_id=seeded["compilation_id"], engine_ref={}, seed=1, fingerprint="f",
                              state=RunState.COMPLETED, job_id=job.id))
        linked = Composition(organization_id=personal.id, slug="linked", name="Linked", created_by_id=user.id,
                             visibility="public")
        session.add(linked)
        await session.flush()
        content = 'syntaxVersion: "1.0"\ncomposition: linked\nversion: 1.0.0\n'
        version = CompositionVersion(
            composition_id=linked.id, ordinal=1, label="1.0.0", syntax_version="1.0", values_status=ValuesStatus.VERIFIED,
            content=content, content_digest="sha256-" + hashlib.sha256(content.encode()).hexdigest(),
            size_bytes=len(content), analytics={}, created_by_id=user.id, revision_id=seeded["revision_id"],
            linked_compilation_id=seeded["compilation_id"], evidence_job_id=job.id,
        )
        session.add(version)
        await session.flush()
        session.add(CompositionDerivation(
            version_id=version.id, source=DerivationSource.RUN, revision_id=seeded["revision_id"],
            compilation_id=seeded["compilation_id"], job_id=job.id, binding={}, binding_digest="b", provenance={},
            created_by_id=user.id,
        ))
        await session.commit()
        operated_composition = Composition(organization_id=personal.id, slug="op", name="Op", created_by_id=user.id)
        session.add(operated_composition)
        await session.flush()
        await operated(session, personal.id, operated_composition.id, user.id)
        # A team organization's fork of the public composition: a snapshot of where it came from, no reference.
        team = Organization(slug=f"team-{uuid.uuid4().hex[:6]}", name="Team", created_by_id=friend.id)
        session.add(team)
        await session.flush()
        fork = Composition(organization_id=team.id, slug="linked", name="Linked", created_by_id=friend.id)
        session.add(fork)
        await session.flush()
        fork_content = 'syntaxVersion: "1.0"\ncomposition: linked\nversion: 1.0.0\n'
        session.add(CompositionVersion(
            composition_id=fork.id, ordinal=1, label="1.0.0", syntax_version="1.0", values_status=ValuesStatus.DECLARED,
            content=fork_content, content_digest="sha256-" + hashlib.sha256(b"fork").hexdigest(),
            size_bytes=len(fork_content), analytics={}, created_by_id=friend.id,
            forked_from={"compositionId": str(linked.id), "organizationSlug": personal.slug, "label": "1.0.0"},
        ))
        await session.commit()
        personal_id, team_id, user_id = personal.id, team.id, user.id

        # While the account lives its study runs are history: the triggers refuse.
        with pytest.raises(DBAPIError, match="history is retained"):
            await delete_personal_organization(session, await session.get(Organization, personal_id))
        await session.rollback()
        # Pseudonymised first, as DELETE /v1/users/me does, the organization goes whole.
        await session.execute(update(User).where(User.id == user_id).values(deleted_at=utcnow()))
        await delete_personal_organization(session, await session.get(Organization, personal_id))
        await session.commit()

        assert await session.get(Organization, personal_id) is None
        for model, column in (
            (Composition, Composition.organization_id), (CompositionEnvironment, CompositionEnvironment.organization_id),
            (BindingCase, BindingCase.organization_id), (Job, Job.organization_id), (Study, Study.organization_id),
            (OrganizationMembership, OrganizationMembership.organization_id), (AuditEvent, AuditEvent.organization_id),
            (OrganizationInvitationCode, OrganizationInvitationCode.organization_id),
        ):
            assert await session.scalar(select(func.count()).select_from(model).where(column == personal_id)) == 0, model
        for model in (StudyRun, StudyCell, JobEngineAttempt, CompositionDerivation, CompositionEnvironmentKey):
            assert await session.scalar(select(func.count()).select_from(model)) == 0, model
        # The fork stays whole in its organization.
        assert await session.scalar(
            select(func.count()).select_from(CompositionVersion).join(Composition).where(Composition.organization_id == team_id)
        ) == 1


async def test_no_run_can_be_added_while_the_deletion_holds_the_organization(pg) -> None:
    """The deletion locks the personal organization before it counts its runs, until it commits: a run inserted
    meanwhile (by a member, or by a key of the account not yet revoked) waits, then finds the organization gone."""
    import asyncio

    from sqlalchemy import func, select
    from sqlalchemy.exc import IntegrityError

    from _problem_helpers import run_refs, seed_problem_run
    from openbinding_gateway.db.models import Job, JobState
    from openbinding_gateway.routes.organizations import delete_personal_organization, lock_personal_organization
    from openbinding_gateway.routes.users import _stop_personal_runs

    async with pg.session() as setup:
        user = await a_user(setup)
        personal = await ensure_personal_organization(setup, user)
        seeded = await seed_problem_run(setup, created_by_id=user.id, organization_id=personal.id)
        await setup.commit()
        user_id, personal_id, refs = user.id, personal.id, run_refs(seeded)

    async with pg.session() as deleting, pg.session() as launching:
        await lock_personal_organization(deleting, await deleting.get(Organization, personal_id))
        assert await _stop_personal_runs(deleting, personal_id) == 0

        async def launch() -> None:
            launching.add(Job(created_by_id=user_id, engine_id="random-search", engine_job_id="late", service_url="inline",
                              state=JobState.QUEUED, original_request={}, options={}, provenance={}, **refs))
            await launching.commit()

        late = asyncio.create_task(launch())
        await asyncio.sleep(1.0)
        assert not late.done(), "a run was added to an organization being deleted"

        await deleting.execute(update(User).where(User.id == user_id).values(deleted_at=utcnow()))
        await delete_personal_organization(deleting, await deleting.get(Organization, personal_id))
        await deleting.commit()
        with pytest.raises(IntegrityError):
            await late
        await launching.rollback()

    async with pg.session() as check:
        assert await check.get(Organization, personal_id) is None
        assert await check.scalar(select(func.count()).select_from(Job).where(Job.organization_id == personal_id)) == 0

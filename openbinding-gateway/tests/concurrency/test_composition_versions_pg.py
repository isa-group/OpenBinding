"""Sealing composition versions on PostgreSQL: triggers, RESTRICT foreign keys and the composition row lock (F1 B9).

A version and its evaluations are insert only. Seals of one composition are serialised by its row lock, so two at
once get consecutive ordinals, and the same meaning sealed twice is one version. A problem that a version links is
kept (409 ``problem_has_compositions``), and a seal that loses a race with the problem's delete is refused with a
located ``c2y_problem_not_found``, never a 500. An organization with versions and no runs is deleted with them, and
the admin purge keeps the runs that versions cite as evidence.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import DBAPIError

from _composition_helpers import bim_binding, document_for, finished_run, linked_problem
from openbinding_gateway.composition import text
from openbinding_gateway.composition.document import Evidence
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import (
    BindingCase,
    Composition,
    CompositionEvaluation,
    CompositionVersion,
    Job,
    Organization,
    User,
    utcnow,
)
from openbinding_gateway.modules.compositions.application import assess, persist
from openbinding_gateway.modules.problems.application import delete_problem
from openbinding_gateway.routes.admin import MaintenancePurgeRequest, purge_expired_data
from openbinding_gateway.routes.organizations import delete_organization

pytestmark = pytest.mark.asyncio

SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}
DECLARED = """\
syntaxVersion: "1.0"
composition: shop
version: 9.0.0
kind: application
workflow:
  seq: [t1, t2]
binding:
  t1: {candidate: c1a}
  t2: {local: true}
values:
  latency: {value: 30, unit: ms}
"""


async def _user(session) -> User:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    return user


async def _linked(session):
    """A problem of a new organization (its OWNER a new user) and an empty composition ``shop`` there."""
    user = await _user(session)
    linked = await linked_problem(session, user)
    composition = Composition(organization_id=linked.organization.id, slug="shop", name="Shop", created_by_id=user.id)
    session.add(composition)
    await session.commit()
    return user, linked, composition.id


async def _seal(session, organization_id, user_id, composition_id, source: str):
    """``source`` read, assessed and sealed in ``session``: the whole pipeline but HTTP."""
    organization = await session.get(Organization, organization_id)
    user = await session.get(User, user_id)
    composition = await session.get(Composition, composition_id)
    reading = text.read(source)
    assert reading.document is not None, reading.diagnostics
    assessment = await assess(session, organization, reading.document, caller=user, source=source)
    assert assessment.valid, assessment.diagnostics
    return await persist(session, composition, assessment, actor=user)


async def _count(session, model, *conditions) -> int:
    return int(await session.scalar(select(func.count()).select_from(model).where(*conditions)) or 0)


async def test_a_version_and_an_evaluation_cannot_be_updated(two_sessions):
    session, _ = two_sessions
    user, linked, composition_id = await _linked(session)
    sealed = await _seal(session, linked.organization.id, user.id, composition_id, document_for(linked, SIMPLE_BINDING))
    version_id = sealed.version.id

    with pytest.raises(DBAPIError, match="composition_versions rows are sealed and immutable"):
        await session.execute(update(CompositionVersion).where(CompositionVersion.id == version_id).values(label="2.0.0"))
    await session.rollback()
    with pytest.raises(DBAPIError, match="composition_evaluations rows are sealed and immutable"):
        await session.execute(
            update(CompositionEvaluation).where(CompositionEvaluation.version_id == version_id).values(diagnostics=[])
        )
    await session.rollback()
    assert await session.scalar(select(CompositionVersion.label).where(CompositionVersion.id == version_id)) == "1.0.0"


async def test_concurrent_seals_of_one_composition_get_consecutive_ordinals(two_sessions):
    first, second = two_sessions
    user, linked, composition_id = await _linked(first)
    org = linked.organization.id
    source = document_for(linked, SIMPLE_BINDING)

    sealed = await asyncio.gather(
        _seal(first, org, user.id, composition_id, source),
        _seal(second, org, user.id, composition_id, DECLARED),
    )

    assert sorted(item.version.ordinal for item in sealed) == [1, 2]
    assert all(item.created for item in sealed)
    assert await _count(first, CompositionVersion, CompositionVersion.composition_id == composition_id) == 2


async def test_the_same_meaning_sealed_twice_at_once_is_one_version(two_sessions):
    first, second = two_sessions
    user, linked, composition_id = await _linked(first)
    org = linked.organization.id
    source = document_for(linked, SIMPLE_BINDING)

    sealed = await asyncio.gather(
        _seal(first, org, user.id, composition_id, source),
        _seal(second, org, user.id, composition_id, source),
    )

    assert sorted(item.created for item in sealed) == [False, True]
    assert sealed[0].version.id == sealed[1].version.id
    assert sealed[0].evaluation.id == sealed[1].evaluation.id
    assert await _count(first, CompositionVersion) == 1 and await _count(first, CompositionEvaluation) == 1


async def test_a_linked_problem_is_kept(two_sessions):
    session, reader = two_sessions
    user, linked, composition_id = await _linked(session)
    await _seal(session, linked.organization.id, user.id, composition_id, document_for(linked, SIMPLE_BINDING))
    problem_id = linked.upload.problem.id

    problem = await session.get(BindingCase, problem_id)
    with pytest.raises(HTTPException) as refused:
        await delete_problem(session, problem, user)
    await session.rollback()

    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "problem_has_compositions"
    assert await reader.get(BindingCase, problem_id) is not None


async def test_a_seal_committed_after_the_delete_checked_is_caught_by_the_foreign_key(two_sessions, monkeypatch):
    first, second = two_sessions
    user, linked, composition_id = await _linked(first)
    org, problem_id = linked.organization.id, linked.upload.problem.id
    source = document_for(linked, SIMPLE_BINDING)

    original_scalar = first.scalar
    checks = 0

    async def scalar_then_seal(statement, *args, **kwargs):
        nonlocal checks
        value = await original_scalar(statement, *args, **kwargs)
        checks += 1
        if checks == 4:  # the evaluations check (runs, study cells, versions, evaluations, derivations): seal one now
            await _seal(second, org, user.id, composition_id, source)
        return value

    monkeypatch.setattr(first, "scalar", scalar_then_seal)
    problem = await first.get(BindingCase, problem_id)
    with pytest.raises(HTTPException) as caught:
        await delete_problem(first, problem, await first.get(User, user.id))
    await first.rollback()

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "problem_has_compositions"
    assert await second.scalar(select(BindingCase.id).where(BindingCase.id == problem_id)) is not None


async def test_a_seal_that_loses_the_race_with_the_problems_delete_is_refused_located(two_sessions):
    first, second = two_sessions
    user, linked, composition_id = await _linked(first)
    org, problem_id = linked.organization.id, linked.upload.problem.id
    source = document_for(linked, SIMPLE_BINDING)
    organization = await second.get(Organization, org)
    composition = await second.get(Composition, composition_id)
    caller = await second.get(User, user.id)
    reading = text.read(source)
    assessment = await assess(second, organization, reading.document, caller=caller, source=source)
    assert assessment.valid
    await second.commit()

    # The delete runs to its last statement and holds its locks; the seal then waits on the foreign key.
    await delete_problem(first, await first.get(BindingCase, problem_id), await first.get(User, user.id))
    sealing = asyncio.create_task(persist(second, composition, assessment, actor=caller))
    await asyncio.sleep(0.5)
    assert not sealing.done()
    await first.commit()

    with pytest.raises(HTTPException) as refused:
        await sealing
    await second.rollback()

    assert refused.value.status_code == 422
    assert refused.value.detail["code"] == "composition_invalid"
    (diagnostic,) = refused.value.detail["diagnostics"]
    assert (diagnostic["code"], diagnostic["path"]) == ("c2y_problem_not_found", "problem.ref")
    assert await _count(first, CompositionVersion) == 0


async def test_an_organization_with_versions_and_no_runs_is_deleted_with_them(two_sessions):
    session, reader = two_sessions
    user, linked, composition_id = await _linked(session)
    org = linked.organization.id
    await _seal(session, org, user.id, composition_id, document_for(linked, SIMPLE_BINDING))
    await _seal(session, org, user.id, composition_id, DECLARED)
    slug = linked.organization.slug

    await delete_organization(org=slug, user=await session.get(User, user.id), session=session)
    await session.commit()

    assert await _count(reader, CompositionVersion) == 0 and await _count(reader, CompositionEvaluation) == 0
    assert await _count(reader, Composition) == 0
    assert await _count(reader, Organization, Organization.id == org) == 0


async def test_the_purge_keeps_the_runs_versions_cite(two_sessions):
    session, reader = two_sessions
    user, linked, composition_id = await _linked(session)
    org = linked.organization.id
    binding = bim_binding(linked, SIMPLE_BINDING)
    cited = await finished_run(session, linked, [binding])
    unnamed = await finished_run(session, linked, [binding])
    long_ago = utcnow() - timedelta(days=400)
    for job in (cited, unnamed):
        job.finished_at = long_ago
    await session.commit()
    cited_id, unnamed_id = cited.id, unnamed.id
    source = document_for(linked, SIMPLE_BINDING, evidence=Evidence(run=str(cited_id)))
    sealed = await _seal(session, org, user.id, composition_id, source)
    assert sealed.version.evidence_job_id == cited_id
    admin = await session.get(User, user.id)

    purged = await purge_expired_data(
        MaintenancePurgeRequest(confirmation="PURGE EXPIRED"), administrator=admin, session=session,
        settings=get_settings(),
    )
    await session.commit()

    assert purged["jobs"] == 1
    assert await reader.get(Job, cited_id) is not None
    assert await reader.get(Job, unnamed_id) is None

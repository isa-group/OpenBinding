"""Derivation edges on PostgreSQL: the trigger, the RESTRICT foreign keys and the admin purge (F1 B12).

A derivation edge is insert only. The run and the compilation it names are kept while it names them, and so is
the version it belongs to; the admin purge keeps the runs derivations name. Deleting a composition, or an
organization with no runs, takes its derivations with it.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import DBAPIError, IntegrityError

from _composition_helpers import bim_binding, finished_run, linked_problem
from openbinding_gateway.composition import text
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import (
    Composition,
    CompositionDerivation,
    CompositionEvaluation,
    CompositionVersion,
    DerivationSource,
    Job,
    Organization,
    ProblemCompilation,
    User,
    utcnow,
)
from openbinding_gateway.modules.compositions.application import (
    assess,
    delete_composition,
    derive_version,
    persist,
)
from openbinding_gateway.routes.admin import MaintenancePurgeRequest, purge_expired_data
from openbinding_gateway.routes.organizations import delete_organization

pytestmark = pytest.mark.asyncio

SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}
DECLARED = """\
syntaxVersion: "1.0"
composition: shop
version: {label}
kind: application
workflow:
  seq: [t1, t2]
binding:
  t1: {{candidate: c1a}}
  t2: {{local: true}}
values:
  latency: {{value: 30, unit: ms}}
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
    return user, linked, composition


async def _derive(session, user, linked, composition, **source):
    """A derivation through the whole pipeline but HTTP, stored."""
    derived = await derive_version(
        session, linked.organization, composition, caller=user, label=source.pop("label", "1.0.0"), **source,
    )
    return await persist(session, composition, derived.assessment, actor=user, derivation=derived.derivation)


async def _declared(session, user, linked, composition, label: str):
    """A declared version (no derivation of its own) of ``composition``."""
    organization = await session.get(Organization, linked.organization.id)
    source = DECLARED.format(label=label)
    reading = text.read(source)
    assert reading.document is not None, reading.diagnostics
    assessment = await assess(session, organization, reading.document, caller=user, source=source)
    return await persist(session, composition, assessment, actor=user)


def _edge(version_id, compilation, owner: uuid.UUID, *, job_id=None) -> CompositionDerivation:
    """A derivation edge written by hand: only what the foreign keys see matters here."""
    return CompositionDerivation(
        version_id=version_id,
        source=DerivationSource.RUN if job_id is not None else DerivationSource.BINDING,
        revision_id=compilation.revision_id,
        compilation_id=compilation.id,
        job_id=job_id,
        binding={},
        binding_digest="sha256-" + "0" * 64,
        provenance={},
        created_by_id=owner,
    )


async def _count(session, model, *conditions) -> int:
    return int(await session.scalar(select(func.count()).select_from(model).where(*conditions)) or 0)


async def test_a_derivation_cannot_be_updated_and_keeps_its_version(two_sessions):
    session, _ = two_sessions
    user, linked, composition = await _linked(session)
    run = await finished_run(session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    sealed = await _derive(session, user, linked, composition, run=run.id, point=0)
    assert sealed.created and sealed.derivation is not None
    assert sealed.derivation.job_id == run.id and sealed.version.evidence_job_id == run.id
    edge_id, version_id = sealed.derivation.id, sealed.version.id
    # The same binding derived again is the same version and the same edge.
    again = await _derive(session, user, linked, composition, run=run.id, point=0)
    assert not again.created and again.version.id == version_id and again.derivation.id == edge_id

    with pytest.raises(DBAPIError, match="composition_derivations rows are sealed and immutable"):
        await session.execute(update(CompositionDerivation).where(CompositionDerivation.id == edge_id).values(point=1))
    await session.rollback()
    await session.execute(delete(CompositionEvaluation).where(CompositionEvaluation.version_id == version_id))
    with pytest.raises(IntegrityError):
        await session.execute(delete(CompositionVersion).where(CompositionVersion.id == version_id))
    await session.rollback()
    assert await _count(session, CompositionDerivation) == 1


async def test_the_run_and_the_compilation_a_derivation_names_are_kept(two_sessions):
    session, reader = two_sessions
    user, linked, composition = await _linked(session)
    first = await _declared(session, user, linked, composition, "1.0.0")
    second = await _declared(session, user, linked, composition, "2.0.0")
    other = await linked_problem(session, user)  # a compilation no run and no version names
    run = await finished_run(session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    compilation = await session.get(ProblemCompilation, other.compilation.id)
    linked_compilation = await session.get(ProblemCompilation, linked.compilation.id)
    session.add(_edge(first.version.id, compilation, user.id))
    session.add(_edge(second.version.id, linked_compilation, user.id, job_id=run.id))
    await session.commit()
    run_id, compilation_id = run.id, compilation.id

    with pytest.raises(IntegrityError):
        await session.execute(delete(Job).where(Job.id == run_id))
    await session.rollback()
    with pytest.raises(IntegrityError):
        await session.execute(delete(ProblemCompilation).where(ProblemCompilation.id == compilation_id))
    await session.rollback()

    assert await reader.get(Job, run_id) is not None
    assert await reader.get(ProblemCompilation, compilation_id) is not None


async def test_the_purge_keeps_the_runs_derivations_name(two_sessions):
    session, reader = two_sessions
    user, linked, composition = await _linked(session)
    declared = await _declared(session, user, linked, composition, "1.0.0")
    binding = bim_binding(linked, SIMPLE_BINDING)
    named = await finished_run(session, linked, [binding])
    unnamed = await finished_run(session, linked, [binding])
    long_ago = utcnow() - timedelta(days=400)
    for job in (named, unnamed):
        job.finished_at = long_ago
    linked_compilation = await session.get(ProblemCompilation, linked.compilation.id)
    # Named by a derivation only: the version it belongs to cites no run as evidence.
    session.add(_edge(declared.version.id, linked_compilation, user.id, job_id=named.id))
    await session.commit()
    named_id, unnamed_id = named.id, unnamed.id
    admin = await session.get(User, user.id)

    purged = await purge_expired_data(
        MaintenancePurgeRequest(confirmation="PURGE EXPIRED"), administrator=admin, session=session,
        settings=get_settings(),
    )
    await session.commit()

    assert purged["jobs"] == 1
    assert await reader.get(Job, named_id) is not None
    assert await reader.get(Job, unnamed_id) is None


async def test_deleting_a_composition_or_an_organization_takes_its_derivations(two_sessions):
    session, reader = two_sessions
    user, linked, composition = await _linked(session)
    org = linked.organization.id
    await _derive(session, user, linked, composition, revision=f"{linked.upload.problem.slug}@1", binding=SIMPLE_BINDING)
    other = Composition(organization_id=org, slug="other", name="Other", created_by_id=user.id)
    session.add(other)
    await session.commit()
    await _derive(
        session, user, linked, other, revision=f"{linked.upload.problem.slug}@1", binding=SIMPLE_BINDING, label="2.0.0",
    )
    assert await _count(reader, CompositionDerivation) == 2

    await delete_composition(session, await session.get(Composition, composition.id), await session.get(User, user.id))
    await session.commit()
    assert await _count(reader, CompositionDerivation) == 1

    await delete_organization(org=linked.organization.slug, user=await session.get(User, user.id), session=session)
    await session.commit()
    assert await _count(reader, CompositionDerivation) == 0 and await _count(reader, CompositionVersion) == 0
    assert await _count(reader, Organization, Organization.id == org) == 0

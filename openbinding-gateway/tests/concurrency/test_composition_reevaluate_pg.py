"""Re-evaluating one composition version twice at once on PostgreSQL (F1 B11).

Re-evaluation is two-phase like a seal: the assessment runs with no lock, then one short transaction locks the
composition and inserts through ``seal.insert_evaluation``, which re-selects and inserts in a savepoint. Two
re-evaluations of one version by one toolchain release therefore store exactly one row: one is created, the
other answers it, and neither is a 500.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import func, select

from _composition_helpers import OTHER_COMPILER, OtherToolchain, document_for, linked_problem
from openbinding_gateway.composition import text
from openbinding_gateway.db.models import (
    Composition,
    CompositionEvaluation,
    CompositionVersion,
    Organization,
    User,
)
from openbinding_gateway.integrations import bim
from openbinding_gateway.modules.compositions.application import assess, persist, reevaluate

pytestmark = pytest.mark.asyncio

SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}


async def _sealed(session):
    """A linked version of a composition ``shop`` of a new organization, sealed by the real toolchain."""
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    linked = await linked_problem(session, user)
    composition = Composition(organization_id=linked.organization.id, slug="shop", name="Shop", created_by_id=user.id)
    session.add(composition)
    await session.commit()
    source = document_for(linked, SIMPLE_BINDING)
    document = text.parse(source)
    assessment = await assess(session, linked.organization, document, caller=user, source=source)
    assert assessment.valid, assessment.diagnostics
    sealed = await persist(session, composition, assessment, actor=user)
    return user.id, linked.organization.id, composition.id, sealed.version.id


async def _reevaluate(session, user_id, organization_id, composition_id, version_id):
    user = await session.get(User, user_id)
    organization = await session.get(Organization, organization_id)
    composition = await session.get(Composition, composition_id)
    version = await session.get(CompositionVersion, version_id)
    return await reevaluate(session, organization, composition, version, actor=user)


async def test_two_re_evaluations_at_once_store_one_evaluation(two_sessions):
    first, second = two_sessions
    user_id, organization_id, composition_id, version_id = await _sealed(first)

    with bim.bim_override(OtherToolchain(bim.get_bim())):
        outcomes = await asyncio.gather(
            _reevaluate(first, user_id, organization_id, composition_id, version_id),
            _reevaluate(second, user_id, organization_id, composition_id, version_id),
        )

    assert sorted(item.created for item in outcomes) == [False, True]
    assert outcomes[0].evaluation.id == outcomes[1].evaluation.id
    assert outcomes[0].evaluation.basis_key == OTHER_COMPILER
    rows = (await first.scalars(
        select(CompositionEvaluation.basis_key).where(CompositionEvaluation.version_id == version_id)
    )).all()
    assert int(await first.scalar(
        select(func.count()).select_from(CompositionEvaluation).where(CompositionEvaluation.version_id == version_id)
    ) or 0) == 2
    assert rows.count(OTHER_COMPILER) == 1

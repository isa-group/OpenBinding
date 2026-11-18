"""The offering version recorded per evaluation, on PostgreSQL: written with the row, refused to every UPDATE, and a
foreign key to the snapshot it read.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import update
from sqlalchemy.exc import DBAPIError

from openbinding_gateway.composition import text
from openbinding_gateway.db.models import Composition, CompositionEvaluation, Organization, PricingSnapshot, User
from openbinding_gateway.modules.compositions.application import assess, offering, persist

pytestmark = pytest.mark.asyncio

DECLARED = """\
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: workflow
workflow:
  seq: [t1, t2]
binding:
  t1: {candidate: c1a}
  t2: {local: true}
values:
  latency: {value: 30, unit: ms}
offering: {sphere: sphere/tomatometer}
"""


async def _shop(session):
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    organization = Organization(slug=f"o-{suffix}", name="O", created_by_id=user.id)
    session.add(organization)
    await session.flush()
    composition = Composition(organization_id=organization.id, slug="shop", name="Shop", created_by_id=user.id)
    session.add(composition)
    await session.commit()
    return user.id, organization.id, composition.id


async def test_the_offering_columns_are_written_once(pg, sphere) -> None:
    offering.clear_failures()
    async with pg.session() as session:
        user_id, organization_id, composition_id = await _shop(session)
        organization = await session.get(Organization, organization_id)
        user = await session.get(User, user_id)
        reading = text.read(DECLARED)
        assessment = await assess(session, organization, reading.document, caller=user, source=DECLARED)
        assessment = await offering.with_offering(session, organization, assessment, user, source=DECLARED,
                                                  composition_id=composition_id)
        sealed = await persist(session, await session.get(Composition, composition_id), assessment, actor=user)
        evaluation_id = sealed.evaluation.id
        row = await session.get(CompositionEvaluation, evaluation_id)
        assert row.offering_status == "read" and row.offering_snapshot_id is not None
        assert await session.get(PricingSnapshot, row.offering_snapshot_id) is not None
        for values in ({"offering_status": "unreadable"}, {"offering_snapshot_id": None}):
            with pytest.raises(DBAPIError, match="composition_evaluations rows are sealed and immutable"):
                await session.execute(
                    update(CompositionEvaluation).where(CompositionEvaluation.id == evaluation_id).values(**values)
                )
            await session.rollback()

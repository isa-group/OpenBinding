"""Pricing snapshots on PostgreSQL: one row for one version under concurrent reads, and the guards that hold
for every SQL writer (UPDATE refused, DELETE refused for shared rows, allowed for an organization's own).

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import DBAPIError

from openbinding_gateway.db.models import Organization, PricingSnapshot, User
from openbinding_gateway.modules.plans.application import DEFAULT_ENDPOINT, snapshot_url, snapshot_version
from sphere_recorded import RecordedSphere

pytestmark = pytest.mark.asyncio

MAILGUN, VERSION = "6ade364540e55445692b0eda", "6ade36454b2b5b01c587db3d"


async def _org(session) -> tuple[User, Organization]:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    organization = Organization(slug=f"o-{suffix}", name="O", created_by_id=user.id)
    session.add(organization)
    await session.commit()
    return user, organization


async def test_two_concurrent_reads_of_one_version_end_with_one_row(pg, sphere: RecordedSphere) -> None:
    first, second = pg.session(), pg.session()
    try:
        _, a = await _org(first)
        _, b = await _org(second)
        one, two = await asyncio.gather(
            snapshot_version(first, a.id, DEFAULT_ENDPOINT, MAILGUN, VERSION),
            snapshot_version(second, b.id, DEFAULT_ENDPOINT, MAILGUN, VERSION),
        )
        assert one.snapshot.id == two.snapshot.id
        async with pg.session() as reader:
            assert await reader.scalar(select(func.count()).select_from(PricingSnapshot)) == 1
    finally:
        await first.close()
        await second.close()


async def test_the_guards_hold_on_postgresql(pg, sphere: RecordedSphere) -> None:
    sphere.add_host("pricings.example", "93.184.216.34")
    sphere.serve("/offering.yml", b"saasName: A\n", {"content-type": "application/yaml"})
    async with pg.session() as session:
        user, organization = await _org(session)
        public = (await snapshot_version(session, organization.id, DEFAULT_ENDPOINT, MAILGUN, VERSION)).snapshot.id
        own = (await snapshot_url(session, organization.id, "https://pricings.example/offering.yml",
                                  actor_id=user.id)).snapshot.id
        for statement in (
            update(PricingSnapshot).where(PricingSnapshot.id == public).values(title="x"),
            update(PricingSnapshot).where(PricingSnapshot.id == own).values(title="x"),
            delete(PricingSnapshot).where(PricingSnapshot.id == public),
        ):
            with pytest.raises(DBAPIError):
                await session.execute(statement)
            await session.rollback()
        await session.execute(delete(PricingSnapshot).where(PricingSnapshot.id == own))
        await session.commit()
        assert await session.get(PricingSnapshot, public) is not None

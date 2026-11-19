"""Composition templates on PostgreSQL: concurrent instantiations of one slug (F4 B2).

Two instantiations of the FMS template under the same slugs: one makes the problem and the composition, the other
is refused 409 ``slug_conflict``, and one problem exists. An instantiation racing a manual create of the same
composition slug never leaves a composition without its version, and never answers an ``IntegrityError``.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from openbinding_gateway.db.models import (
    BindingCase,
    Composition,
    CompositionVersion,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    User,
)
from openbinding_gateway.modules.compositions.application import create_composition
from openbinding_gateway.modules.compositions.application import templates

pytestmark = pytest.mark.asyncio


async def _member(pg) -> tuple[uuid.UUID, uuid.UUID]:
    async with pg.session() as session:
        suffix = uuid.uuid4().hex[:8]
        user = User(username=f"u{suffix}", email=f"u{suffix}@example.org", password_hash="x", plan_cache="FREE")
        session.add(user)
        await session.flush()
        organization = Organization(slug=f"o-{suffix}", name="O", created_by_id=user.id)
        session.add(organization)
        await session.flush()
        session.add(OrganizationMembership(organization_id=organization.id, user_id=user.id, role=OrganizationRole.OWNER))
        await session.commit()
        return user.id, organization.id


async def _instantiate(pg, user_id, organization_id) -> tuple[int, str | None]:
    async with pg.session() as session:
        organization = await session.get(Organization, organization_id)
        actor = await session.get(User, user_id)
        await asyncio.sleep(0)
        try:
            await templates.instantiate(session, organization, actor, "fms")
        except HTTPException as exc:
            await session.rollback()
            return exc.status_code, exc.detail.get("code") if isinstance(exc.detail, dict) else None
        return 201, None


async def _counts(pg, organization_id) -> tuple[int, int, int]:
    async with pg.session() as session:
        problems = await session.scalar(
            select(func.count()).select_from(BindingCase).where(BindingCase.organization_id == organization_id))
        compositions = await session.scalar(
            select(func.count()).select_from(Composition).where(Composition.organization_id == organization_id))
        versions = await session.scalar(
            select(func.count()).select_from(CompositionVersion).join(Composition)
            .where(Composition.organization_id == organization_id))
        return int(problems), int(compositions), int(versions)


async def test_two_instantiations_of_one_slug(pg) -> None:
    user_id, organization_id = await _member(pg)

    results = await asyncio.gather(_instantiate(pg, user_id, organization_id), _instantiate(pg, user_id, organization_id))

    assert sorted(status for status, _ in results) == [201, 409], results
    assert next(code for status, code in results if status == 409) == "slug_conflict"
    assert await _counts(pg, organization_id) == (1, 1, 1)


async def test_an_instantiation_racing_a_manual_create_of_its_slug(pg) -> None:
    user_id, organization_id = await _member(pg)

    async def manual() -> tuple[int, str | None]:
        async with pg.session() as session:
            organization = await session.get(Organization, organization_id)
            actor = await session.get(User, user_id)
            try:
                await create_composition(session, organization, actor, slug="fms", name="Mine")
                await session.commit()
            except HTTPException as exc:
                await session.rollback()
                return exc.status_code, exc.detail.get("code")
            return 201, None

    made, created = await asyncio.gather(_instantiate(pg, user_id, organization_id), manual())

    problems, compositions, versions = await _counts(pg, organization_id)
    assert compositions == 1, (made, created)
    if made[0] == 201:
        # The template won: the manual create found the slug taken.
        assert created == (409, "slug_conflict") and (problems, versions) == (1, 1)
    else:
        # The manual create won: before the template wrote anything (409), or after its problem (502, kept).
        assert created[0] == 201 and versions == 0
        assert made in {(409, "slug_conflict"), (502, "template_incomplete")}, made
        assert problems == (1 if made[0] == 502 else 0)

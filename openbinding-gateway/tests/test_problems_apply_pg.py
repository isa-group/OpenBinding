"""SPHERE applies racing on PostgreSQL: the base is checked under the problem lock, so no concurrent save is lost.

- two applies of **different** recipes on one base: one revision, and one ``409 revision_moved``;
- two applies of **one** recipe: one revision and one set of value origins, both answered with it;
- an upload committed between an apply's preview and its insert: the upload's revision survives, the apply is 409.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import asyncio
import copy
import json
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from _problem_helpers import package_bytes
from _repo import REPO_ROOT
from openbinding_gateway.db.models import (
    BindingCaseRevision,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    ProblemValueOrigin,
    User,
)
from openbinding_gateway.modules.problems.application import create_problem
from openbinding_gateway.modules.problems.application import problems as problems_module
from openbinding_gateway.modules.problems.application.sphere import apply, expand
from problems._sphere_helpers import base_archive

pytestmark = pytest.mark.asyncio

EMAIL = json.loads((REPO_ROOT / "examples" / "tomatometer" / "email-recipe.json").read_text())


def _other(monthly: int) -> dict:
    recipe = copy.deepcopy(EMAIL)
    recipe["demand"]["monthlyEmails"]["value"] = monthly
    return recipe


async def _setup(session) -> tuple[uuid.UUID, uuid.UUID, str]:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    organization = Organization(slug=f"o-{suffix}", name="O", created_by_id=user.id)
    session.add(organization)
    await session.flush()
    session.add(OrganizationMembership(organization_id=organization.id, user_id=user.id, role=OrganizationRole.OWNER))
    await session.flush()
    await create_problem(session, organization, base_archive(), user, slug="tomatometer-email")
    await session.commit()
    return organization.id, user.id, "tomatometer-email"


async def _preview(session, organization_id, user_id, slug, recipe) -> str:
    organization = await session.get(Organization, organization_id)
    user = await session.get(User, user_id)
    preview = await expand(session, organization, slug, recipe, 1, user)
    assert preview.view["valid"], preview.view["diagnostics"]
    return preview.view["packageDigest"]


async def _apply(session, organization_id, user_id, slug, recipe, digest):
    organization = await session.get(Organization, organization_id)
    user = await session.get(User, user_id)
    try:
        upload = await apply(session, organization, slug, recipe, 1, digest, user)
        await session.commit()
        return upload
    except HTTPException as exc:
        await session.rollback()
        return exc


async def _revisions(pg, organization_id) -> list[int]:
    from openbinding_gateway.db.models import BindingCase

    async with pg.session() as reader:
        rows = await reader.scalars(
            select(BindingCaseRevision.revision)
            .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
            .where(BindingCase.organization_id == organization_id)
            .order_by(BindingCaseRevision.revision)
        )
        return list(rows)


async def test_two_applies_of_different_recipes_on_one_base(pg, sphere) -> None:
    async with pg.session() as session:
        organization_id, user_id, slug = await _setup(session)
        first, second = _other(40000), _other(45000)
        digests = [await _preview(session, organization_id, user_id, slug, r) for r in (first, second)]
    one, two = pg.session(), pg.session()
    try:
        results = await asyncio.gather(
            _apply(one, organization_id, user_id, slug, first, digests[0]),
            _apply(two, organization_id, user_id, slug, second, digests[1]),
        )
    finally:
        await one.close()
        await two.close()
    refused = [r for r in results if isinstance(r, HTTPException)]
    stored = [r for r in results if not isinstance(r, HTTPException)]
    assert len(refused) == 1 and len(stored) == 1, results
    assert refused[0].status_code == 409 and refused[0].detail["code"] == "revision_moved"
    assert stored[0].created and stored[0].revision.revision == 2
    assert await _revisions(pg, organization_id) == [1, 2]


async def test_two_applies_of_one_recipe_store_one_revision_and_one_set_of_origins(pg, sphere) -> None:
    async with pg.session() as session:
        organization_id, user_id, slug = await _setup(session)
        digest = await _preview(session, organization_id, user_id, slug, EMAIL)
    one, two = pg.session(), pg.session()
    try:
        results = await asyncio.gather(
            _apply(one, organization_id, user_id, slug, EMAIL, digest),
            _apply(two, organization_id, user_id, slug, EMAIL, digest),
        )
    finally:
        await one.close()
        await two.close()
    assert not any(isinstance(r, HTTPException) for r in results), results
    assert {r.revision.id for r in results} == {results[0].revision.id}
    assert sorted(r.created for r in results) == [False, True]
    async with pg.session() as reader:
        rows = await reader.scalar(select(func.count()).select_from(ProblemValueOrigin)
                                   .where(ProblemValueOrigin.revision_id == results[0].revision.id))
        revisions = await reader.scalar(select(func.count()).select_from(BindingCaseRevision)
                                        .where(BindingCaseRevision.binding_case_id == results[0].problem.id))
        assert rows and revisions == 2


async def test_an_upload_between_preview_and_insert_survives(pg, sphere, monkeypatch) -> None:
    async with pg.session() as session:
        organization_id, user_id, slug = await _setup(session)
        digest = await _preview(session, organization_id, user_id, slug, EMAIL)
    real = problems_module._lock_account
    uploaded = {}

    async def upload_first(session, actor_id):
        monkeypatch.setattr(problems_module, "_lock_account", real)
        async with pg.session() as other:
            problem = await problems_module.problem_by_ref(other, organization_id, slug)
            user = await other.get(User, user_id)
            uploaded["revision"] = (await problems_module.add_revision(
                other, problem, package_bytes(REPO_ROOT / "examples" / "demo" / "01_simple_seq"), user,
            )).revision.revision
        await real(session, actor_id)

    monkeypatch.setattr(problems_module, "_lock_account", upload_first)
    async with pg.session() as session:
        result = await _apply(session, organization_id, user_id, slug, EMAIL, digest)
    assert isinstance(result, HTTPException) and result.status_code == 409
    assert result.detail["code"] == "revision_moved" and result.detail["latest"] == 2
    assert uploaded["revision"] == 2
    assert await _revisions(pg, organization_id) == [1, 2]

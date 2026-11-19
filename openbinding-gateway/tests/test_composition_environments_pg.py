"""Composition environments, adoptions and feed keys on PostgreSQL: the rules the database itself enforces.

Composite foreign keys keep an environment within its composition's organization, an adopted version within the
environment's composition and an adoption's pinned evaluation within its version; the triggers keep what names an
environment, the adoption history and a feed key's secret; a revoked key stays revoked.

Needs PostgreSQL (``TEST_DATABASE_URL``).
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.exc import DBAPIError, IntegrityError

from _environment_rows import adoption, environment, key, world
from openbinding_gateway.db.models import (
    CompositionAdoption,
    CompositionEnvironment,
    CompositionEnvironmentKey,
    Organization,
    utcnow,
)

pytestmark = pytest.mark.asyncio


async def test_an_environment_belongs_to_its_compositions_organization(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        other = Organization(slug=f"x-{uuid.uuid4().hex[:6]}", name="X", created_by_id=w.user_id)
        session.add(other)
        await session.commit()
        with pytest.raises(IntegrityError, match="fk_composition_environments_composition"):
            session.add(CompositionEnvironment(
                organization_id=other.id, composition_id=w.composition_id, slug="p", name="P",
                created_by_id=w.user_id,
            ))
            await session.flush()
        await session.rollback()


async def test_the_version_in_effect_is_one_of_the_compositions(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        with pytest.raises(IntegrityError, match="fk_composition_environments_adopted_version"):
            await environment(session, w, adopted_version_id=w.other_version_id, adoption_ordinal=1)
        await session.rollback()
        environment_id = await environment(session, w, adopted_version_id=w.versions[0], adoption_ordinal=1)
        await session.commit()
        with pytest.raises(IntegrityError, match="ck_composition_environments_adopted_whole"):
            await session.execute(
                update(CompositionEnvironment).where(CompositionEnvironment.id == environment_id)
                .values(adoption_ordinal=0)
            )
        await session.rollback()


async def test_an_adoption_names_a_version_and_an_evaluation_of_its_composition(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        environment_id = await environment(session, w)
        await session.commit()
        bad = [
            ({"version_id": w.other_version_id, "evaluation_id": w.other_evaluation_id},
             "fk_composition_adoptions_version"),
            ({"evaluation_id": w.evaluations[1]}, "fk_composition_adoptions_evaluation"),
            ({"previous_version_id": w.other_version_id}, "fk_composition_adoptions_previous_version"),
        ]
        for values, constraint in bad:
            row = dict(
                environment_id=environment_id, ordinal=1, composition_id=w.composition_id,
                version_id=w.versions[0], evaluation_id=w.evaluations[0], content_digest="d", actor_id=w.user_id,
            )
            row.update(values)
            with pytest.raises(IntegrityError, match=constraint):
                session.add(CompositionAdoption(**row))
                await session.flush()
            await session.rollback()
        await adoption(session, w, environment_id, 1)
        await session.commit()
        with pytest.raises(IntegrityError, match="uq_composition_adoptions_environment_ordinal"):
            await adoption(session, w, environment_id, 1, version_index=1)
        await session.rollback()
        with pytest.raises(IntegrityError, match="ck_composition_adoptions_ordinal_positive"):
            await adoption(session, w, environment_id, 0)
        await session.rollback()


async def test_adoptions_are_immutable_and_deleted_only_on_purpose(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        environment_id = await environment(session, w)
        adoption_id = await adoption(session, w, environment_id, 1)
        await session.commit()
        for values in ({"note": "x"}, {"ordinal": 7}, {"content_digest": "y"}):
            with pytest.raises(DBAPIError, match="composition adoptions are history and immutable"):
                await session.execute(
                    update(CompositionAdoption).where(CompositionAdoption.id == adoption_id).values(**values)
                )
            await session.rollback()
        # An environment with history cannot go before its history does (RESTRICT).
        with pytest.raises(IntegrityError):
            await session.execute(delete(CompositionEnvironment).where(CompositionEnvironment.id == environment_id))
        await session.rollback()
        await session.execute(delete(CompositionAdoption).where(CompositionAdoption.environment_id == environment_id))
        await session.execute(delete(CompositionEnvironment).where(CompositionEnvironment.id == environment_id))
        await session.commit()


async def test_what_names_an_environment_is_protected(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        environment_id = await environment(session, w)
        await session.commit()
        for values in (
            {"slug": "renamed"}, {"organization_id": uuid.uuid4()}, {"composition_id": w.other_composition_id},
            {"created_by_id": uuid.uuid4()}, {"created_at": utcnow()},
        ):
            with pytest.raises(DBAPIError, match="protected columns of composition_environments"):
                await session.execute(
                    update(CompositionEnvironment).where(CompositionEnvironment.id == environment_id).values(**values)
                )
            await session.rollback()
        await session.execute(
            update(CompositionEnvironment).where(CompositionEnvironment.id == environment_id)
            .values(name="P", description="d", adopt_role="MEMBER", expected_users=5, operator_id=w.user_id)
        )
        await session.commit()


async def test_the_environment_checks_hold(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        for values, constraint in (
            ({"adopt_role": "OWNER"}, "ck_composition_environments_adopt_role"),
            ({"expected_users": 0}, "ck_composition_environments_expected_users"),
            ({"adoption_ordinal": 2}, "ck_composition_environments_adopted_whole"),
        ):
            with pytest.raises(IntegrityError, match=constraint):
                await environment(session, w, **values)
            await session.rollback()
        await environment(session, w)
        await session.commit()
        with pytest.raises(IntegrityError, match="uq_composition_environments_composition_slug"):
            await environment(session, w)
        await session.rollback()


async def test_a_feed_key_is_protected_and_stays_revoked(pg) -> None:
    async with pg.session() as session:
        w = await world(session)
        environment_id = await environment(session, w)
        key_id = await key(session, w, environment_id, prefix="obe_00aa11bb")
        await session.commit()
        for values in (
            {"secret_hash": "f" * 64}, {"prefix": "obe_ffffffff"}, {"created_by_id": uuid.uuid4()},
            {"environment_id": uuid.uuid4()}, {"created_at": utcnow()},
        ):
            with pytest.raises(DBAPIError, match="protected columns of composition_environment_keys"):
                await session.execute(
                    update(CompositionEnvironmentKey).where(CompositionEnvironmentKey.id == key_id).values(**values)
                )
            await session.rollback()
        with pytest.raises(IntegrityError):
            await key(session, w, environment_id, prefix="obe_00aa11bb")
        await session.rollback()
        now = utcnow()
        await session.execute(
            update(CompositionEnvironmentKey).where(CompositionEnvironmentKey.id == key_id)
            .values(last_used_at=now, revoked_at=now, revoked_by_id=w.user_id)
        )
        await session.commit()
        for values in ({"revoked_at": None}, {"revoked_by_id": None}, {"revoked_at": utcnow()}):
            with pytest.raises(DBAPIError, match="a revoked feed key stays revoked"):
                await session.execute(
                    update(CompositionEnvironmentKey).where(CompositionEnvironmentKey.id == key_id).values(**values)
                )
            await session.rollback()
        await session.execute(
            update(CompositionEnvironmentKey).where(CompositionEnvironmentKey.id == key_id).values(label="old")
        )
        await session.commit()
        assert (await session.scalar(
            select(CompositionEnvironmentKey.revoked_at).where(CompositionEnvironmentKey.id == key_id)
        )) is not None

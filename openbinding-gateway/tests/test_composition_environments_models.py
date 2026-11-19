"""The composition environment tables on SQLite: shapes, defaults, CHECKs, uniques and the triggers (F4 A2).

SQLite enforces neither foreign keys nor row locks; ``test_composition_environments_pg.py`` checks those.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, inspect, update
from sqlalchemy.exc import DBAPIError, IntegrityError

from _environment_rows import adoption, environment, key, world
from openbinding_gateway.db.models import (
    CompositionAdoption,
    CompositionEnvironment,
    CompositionEnvironmentKey,
    utcnow,
)
from openbinding_gateway.modules.compositions.domain.environments import (
    ENVIRONMENT_SLUG,
    MAX_LIVE_FEED_KEYS,
    AdoptRole,
)

pytestmark = pytest.mark.asyncio


async def test_an_environment_starts_with_nothing_adopted_and_admin_adopting(db_session) -> None:
    w = await world(db_session)
    environment_id = await environment(db_session, w)
    await db_session.commit()
    row = await db_session.get(CompositionEnvironment, environment_id)
    assert row.adopt_role == "ADMIN" and row.adoption_ordinal == 0 and row.adopted_version_id is None
    assert row.description == "" and row.expected_users is None and row.operator_id is None
    assert row.created_at is not None and row.updated_at is not None


async def test_the_environment_checks(db_session) -> None:
    w = await world(db_session)
    for values in (
        {"adopt_role": "VIEWER"},
        {"expected_users": 0},
        {"expected_users": 1_000_000_001},
        {"adoption_ordinal": 1},
        {"adopted_version_id": w.versions[0]},
        {"adoption_ordinal": -1},
    ):
        with pytest.raises(IntegrityError):
            await environment(db_session, w, **values)
        await db_session.rollback()
    await environment(db_session, w, expected_users=1, adopt_role="MEMBER")
    await environment(db_session, w, slug="staging", adoption_ordinal=1, adopted_version_id=w.versions[0])
    await db_session.commit()


async def test_the_slug_is_unique_per_composition(db_session) -> None:
    w = await world(db_session)
    await environment(db_session, w)
    await db_session.commit()
    with pytest.raises(IntegrityError):
        await environment(db_session, w)
    await db_session.rollback()


async def test_what_names_an_environment_never_changes(db_session) -> None:
    w = await world(db_session)
    environment_id = await environment(db_session, w)
    await db_session.commit()
    for values in ({"slug": "renamed"}, {"composition_id": w.other_composition_id}, {"created_at": utcnow()}):
        with pytest.raises(DBAPIError, match="protected columns of composition_environments"):
            await db_session.execute(
                update(CompositionEnvironment).where(CompositionEnvironment.id == environment_id).values(**values)
            )
        await db_session.rollback()
    await db_session.execute(
        update(CompositionEnvironment).where(CompositionEnvironment.id == environment_id)
        .values(name="Prod", description="d", expected_users=1000, adopt_role="MEMBER")
    )
    await db_session.commit()


async def test_adoptions_are_insert_only_and_numbered_once(db_session) -> None:
    w = await world(db_session)
    environment_id = await environment(db_session, w)
    adoption_id = await adoption(db_session, w, environment_id, 1)
    await db_session.commit()
    row = await db_session.get(CompositionAdoption, adoption_id)
    assert row.note == "" and row.previous_version_id is None
    with pytest.raises(DBAPIError, match="composition adoptions are history and immutable"):
        await db_session.execute(
            update(CompositionAdoption).where(CompositionAdoption.id == adoption_id).values(note="changed")
        )
    await db_session.rollback()
    with pytest.raises(IntegrityError):
        await adoption(db_session, w, environment_id, 1, version_index=1)
    await db_session.rollback()
    with pytest.raises(IntegrityError):
        await adoption(db_session, w, environment_id, 0)
    await db_session.rollback()
    # Deletion is left to the delete paths (an environment's or an organization's).
    await db_session.execute(delete(CompositionAdoption).where(CompositionAdoption.id == adoption_id))
    await db_session.commit()


async def test_a_feed_key_keeps_its_secret_and_stays_revoked(db_session) -> None:
    w = await world(db_session)
    environment_id = await environment(db_session, w)
    key_id = await key(db_session, w, environment_id, prefix="obe_0a1b2c3d")
    await db_session.commit()
    row = await db_session.get(CompositionEnvironmentKey, key_id)
    assert row.label == "" and row.revoked_at is None and row.last_used_at is None
    for values in ({"secret_hash": "1" * 64}, {"prefix": "obe_ffffffff"}, {"environment_id": w.composition_id}):
        with pytest.raises(DBAPIError, match="protected columns of composition_environment_keys"):
            await db_session.execute(
                update(CompositionEnvironmentKey).where(CompositionEnvironmentKey.id == key_id).values(**values)
            )
        await db_session.rollback()
    with pytest.raises(IntegrityError):
        await key(db_session, w, environment_id, prefix="obe_0a1b2c3d")
    await db_session.rollback()
    revoked = utcnow()
    await db_session.execute(
        update(CompositionEnvironmentKey).where(CompositionEnvironmentKey.id == key_id)
        .values(revoked_at=revoked, revoked_by_id=w.user_id, last_used_at=revoked)
    )
    await db_session.commit()
    for values in ({"revoked_at": None}, {"revoked_by_id": None}):
        with pytest.raises(DBAPIError, match="a revoked feed key stays revoked"):
            await db_session.execute(
                update(CompositionEnvironmentKey).where(CompositionEnvironmentKey.id == key_id).values(**values)
            )
        await db_session.rollback()
    await db_session.execute(
        update(CompositionEnvironmentKey).where(CompositionEnvironmentKey.id == key_id).values(label="old")
    )
    await db_session.commit()


async def test_the_supporting_unique_keys_exist(db_session) -> None:
    def names(sync_session):
        inspector = inspect(sync_session.connection())
        return {
            table: {tuple(u["column_names"]) for u in inspector.get_unique_constraints(table)}
            for table in ("compositions", "composition_versions", "composition_evaluations")
        }

    found = await db_session.run_sync(names)
    assert ("id", "organization_id") in found["compositions"]
    assert ("id", "composition_id") in found["composition_versions"]
    assert ("id", "version_id") in found["composition_evaluations"]


async def test_the_domain_constants() -> None:
    assert MAX_LIVE_FEED_KEYS == 2
    assert [role.value for role in AdoptRole] == ["MEMBER", "ADMIN"]
    for good in ("production", "a", "staging-2", "p" * 40):
        assert ENVIRONMENT_SLUG.fullmatch(good)
    for bad in ("", "Production", "2nd", "-x", "p" * 41, "a_b"):
        assert not ENVIRONMENT_SLUG.fullmatch(bad)

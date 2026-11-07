"""The partial identity index, on a schema built by the migrations (PostgreSQL).

``test_artifact_identity_reuse.py`` pins the same three properties on SQLite, where the test
schema comes from ``Base.metadata.create_all`` -- so it tests what the **model** declares.
This module runs against the ``pg`` fixture, whose schema is ``alembic upgrade head``, so it
tests what the **migration** does. Both are needed and neither replaces the other: the
predicate is spelled per dialect, ``archived = 0`` against ``archived = false``, and a
migration that got one of them wrong would pass every SQLite test in the suite.

It also closes the half of the migration that SQLite cannot show. PostgreSQL enforces
foreign keys, so these rows are real: an organization, a user, and artifacts that belong to
them. And ``batch_alter_table`` is a table rebuild on SQLite and a plain
``ALTER TABLE ... ADD CONSTRAINT`` here, so the downgrade takes a different path on each.

Needs ``TEST_DATABASE_URL`` (the ``pg`` fixture skips without it); synthetic data, no network.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from openbinding_gateway.db.models import Artifact, Organization, User


async def _owner(session) -> tuple[User, Organization]:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com",
                password_hash="x", plan_cache="free")
    session.add(user)
    await session.flush()
    organization = Organization(slug=f"o{suffix}", name="Org",
                                billing_sponsor_user_id=user.id, created_by_id=user.id)
    session.add(organization)
    await session.flush()
    return user, organization


def _artifact(organization: Organization, user: User, name: str, *, archived: bool) -> Artifact:
    return Artifact(organization_id=organization.id, namespace=str(organization.id), name=name,
                    display_name=name, kind="Composition", archived=archived,
                    created_by_id=user.id)


async def test_the_migration_leaves_a_partial_unique_index(pg) -> None:
    """Read back from the catalogue, so the predicate is the server's reading and not ours."""
    async with pg.session() as session:
        definition = await session.scalar(text(
            "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_artifact_identity'",
        ))
        constraints = await session.scalar(text(
            "SELECT count(*) FROM pg_constraint "
            "WHERE conrelid = 'artifacts'::regclass AND contype = 'u'",
        ))
    assert definition is not None, "the migration must leave the index in place"
    assert "UNIQUE INDEX" in definition
    assert "archived = false" in definition, definition
    assert constraints == 0, "the plain unique constraint is what the index replaced"

    async with pg.session() as session:
        edge = await session.scalar(text(
            "SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_artifact_versions_based_on_id'",
        ))
    assert edge is not None, "the re-fork query reads based_on_id backwards"


async def test_two_live_artifacts_cannot_share_an_identity(pg) -> None:
    async with pg.session() as session:
        user, organization = await _owner(session)
        session.add(_artifact(organization, user, "fleet", archived=False))
        await session.flush()
        session.add(_artifact(organization, user, "fleet", archived=False))
        with pytest.raises(IntegrityError):
            await session.flush()


async def test_archiving_frees_the_identity_for_a_new_artifact(pg) -> None:
    """The case the change exists for, with the foreign keys actually enforced."""
    async with pg.session() as session:
        user, organization = await _owner(session)
        retired = _artifact(organization, user, "fleet", archived=False)
        session.add(retired)
        await session.flush()
        retired.archived = True
        await session.flush()

        successor = _artifact(organization, user, "fleet", archived=False)
        session.add(successor)
        await session.flush()
        assert successor.id != retired.id

        live = await session.scalar(text(
            "SELECT count(*) FROM artifacts WHERE name = 'fleet' AND archived = false",
        ))
        total = await session.scalar(text("SELECT count(*) FROM artifacts WHERE name = 'fleet'"))
    assert (live, total) == (1, 2), "one live holder of the name, and the retired one kept"

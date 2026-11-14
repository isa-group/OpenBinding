"""The baseline on PostgreSQL 16: the migrated schema is the models, and its triggers are ``db/triggers.py``.

``test_schema_baseline.py`` checks the same on SQLite. PostgreSQL is where the two dialect branches of the
baseline differ (the foreign key that closes the ``jobs`` <-> ``study_cells`` cycle is added after both tables,
the partial-index predicates are spelled for the dialect, and each trigger is a plpgsql function), and where the
SQLite suite cannot look: the ``pg`` fixture's schema is ``alembic upgrade head``.

Needs ``TEST_DATABASE_URL`` (the ``pg`` fixture skips without it); synthetic data, no network.
"""

from __future__ import annotations

import uuid

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import text, update
from sqlalchemy.exc import DBAPIError

from openbinding_gateway.db.base import Base
from openbinding_gateway.db.models import (
    BindingCase,
    BindingCaseRevision,
    Organization,
    Project,
    User,
)
from openbinding_gateway.db.triggers import TRIGGERS, function_names
from test_schema_baseline import RETIRED_TABLES


def _differences(sync_connection) -> list:
    context = MigrationContext.configure(sync_connection, opts={"compare_type": True})
    return compare_metadata(context, Base.metadata)


async def test_upgrade_head_builds_exactly_the_models(pg) -> None:
    async with pg.engine.connect() as connection:
        differences = await connection.run_sync(_differences)
        tables = set((await connection.execute(text(
            "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()"
        ))).scalars())

    assert differences == []
    assert tables == set(Base.metadata.tables) | {"alembic_version"}
    assert not RETIRED_TABLES & tables


async def test_the_triggers_are_those_of_the_trigger_module(pg) -> None:
    async with pg.engine.connect() as connection:
        triggers = set((await connection.execute(text(
            "SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid "
            "WHERE NOT t.tgisinternal"
        ))).all())
        functions = set((await connection.execute(text(
            "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname = current_schema() AND p.prorettype = 'trigger'::regtype"
        ))).scalars())

    assert triggers == {(trigger.name, trigger.table) for trigger in TRIGGERS}
    assert functions == set(function_names())


async def test_the_cycle_foreign_key_and_the_partial_index_exist(pg) -> None:
    async with pg.engine.connect() as connection:
        foreign_key = await connection.scalar(text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'fk_jobs_study_cell_id'"
        ))
        index = await connection.scalar(text(
            "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_jobs_study_cell_id'"
        ))

    assert foreign_key is not None and "REFERENCES study_cells(id) ON DELETE SET NULL" in foreign_key
    assert index is not None and "UNIQUE INDEX" in index and "WHERE (study_cell_id IS NOT NULL)" in index


async def test_an_update_of_a_case_revision_is_refused(pg) -> None:
    suffix = uuid.uuid4().hex[:8]
    async with pg.session() as session:
        user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="free")
        session.add(user)
        await session.flush()
        organization = Organization(slug=f"o{suffix}", name="Org", created_by_id=user.id)
        session.add(organization)
        await session.flush()
        project = Project(organization_id=organization.id, slug="p", name="P", created_by_id=user.id)
        session.add(project)
        await session.flush()
        case = BindingCase(project_id=project.id, slug="c", name="C", created_by_id=user.id)
        session.add(case)
        await session.flush()
        revision = BindingCaseRevision(binding_case_id=case.id, revision=1, digest="sha256-" + "0" * 64,
                                       document={}, created_by_id=user.id)
        session.add(revision)
        await session.commit()
        revision_id = revision.id

    async with pg.session() as session:
        with pytest.raises(DBAPIError, match="binding_case_revisions rows are sealed and immutable"):
            await session.execute(
                update(BindingCaseRevision).where(BindingCaseRevision.id == revision_id).values(revision=2)
            )
        await session.rollback()
        assert await session.scalar(
            text("SELECT revision FROM binding_case_revisions WHERE id = :id"), {"id": revision_id}
        ) == 1

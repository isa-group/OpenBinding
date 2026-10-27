"""Alembic revision e7f8a9b0c1d2 (M9.6) on PostgreSQL: the exact drop, a delete that fails midway, the downgrade.

Each test empties the ``public`` schema of the ``TEST_DATABASE_URL`` database, builds it with ``alembic upgrade
b6c7d8e9f0a1``, seeds it with ``seed`` of ``tests/test_export_retired_data.py`` and empties the schema again at
the end, so the other modules of this directory start from their own ``upgrade head``. Without
``TEST_DATABASE_URL`` the tests skip (``require_test_database_url``). The SQLite side is in
``tests/test_drop_retired_data_migration.py``.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

import pytest
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from test_drop_retired_data_migration import RETIRED_TABLES, VARIABLE
from test_export_retired_data import HEAD, MIGRATION, SOURCES, alembic, export_run, keys_of, read_rows, seed

from ._two_sessions import require_test_database_url
from ._watchdog import timeout_seconds, watchdog


@pytest.fixture(autouse=True)
def _test_watchdog():
    """The directory's limit times ten: every test here runs the whole Alembic history more than once."""
    with watchdog(timeout_seconds() * 10):
        yield


async def _run(url: str, work):
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as connection:
            return await work(connection)
    finally:
        await engine.dispose()


def pg(url: str, work):
    return asyncio.run(_run(url, work))


async def _reset(connection) -> None:
    await connection.execute(sa.text("DROP SCHEMA public CASCADE"))
    await connection.execute(sa.text("CREATE SCHEMA public"))


async def _snapshot(connection) -> dict[str, list[str]]:
    """Every table of the schema (``alembic_version`` included) with every row as JSON text, sorted."""
    tables = [row[0] for row in await connection.execute(sa.text(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"))]
    result = {}
    for table in tables:
        rows = await connection.execute(sa.text(f'SELECT row_to_json(t)::text FROM "{table}" t'))
        result[table] = sorted(row[0] for row in rows)
    return result


async def _schema(connection, table: str) -> dict:
    """Columns, constraints and indexes of one table, as PostgreSQL describes them."""
    parameters = {"table": table}
    columns = await connection.execute(sa.text(
        "SELECT column_name, data_type, character_maximum_length, is_nullable, column_default "
        "FROM information_schema.columns WHERE table_schema = 'public' AND table_name = :table"), parameters)
    constraints = await connection.execute(sa.text(
        "SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) FROM pg_constraint c "
        "JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace "
        "WHERE n.nspname = 'public' AND r.relname = :table"), parameters)
    indexes = await connection.execute(sa.text(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = :table"), parameters)
    return {
        "columns": sorted(tuple(row) for row in columns),
        "constraints": sorted(tuple(row) for row in constraints),
        "indexes": sorted(tuple(row) for row in indexes),
    }


async def _schemas(connection) -> dict:
    return {table: await _schema(connection, table) for table in RETIRED_TABLES}


def _output(result) -> str:
    return result.stdout + result.stderr


@pytest.fixture
def database():
    """``(url, seed result)``: a seeded PostgreSQL database at b6c7d8e9f0a1."""
    url = require_test_database_url()
    pg(url, _reset)
    try:
        prepared = alembic(url, "upgrade", HEAD)
        assert prepared.returncode == 0, _output(prepared)

        async def populate(connection):
            return await connection.run_sync(seed)

        yield url, pg(url, populate)
    finally:
        pg(url, _reset)


def export(url: str, tmp_path, seeded: dict):
    out = tmp_path / "export" / "m96"
    exported = export_run(url, out)
    assert exported.returncode == 0, exported.stderr
    for source in SOURCES:
        assert set(keys_of(source, read_rows(out, source))) == seeded["expected"][source], source
    return out / "manifest.json"


# [utest->req~data-retirement-guard~1]
# [utest->req~data-retirement-removed-set~1]
# [utest->req~data-retirement-kept-set~1]
def test_postgresql_refuses_without_an_export_then_drops_exactly_with_one(database, tmp_path):
    url, seeded = database
    before = pg(url, _snapshot)
    assert before["alembic_version"] == [f'{{"version_num":"{HEAD}"}}'] and len(before["analysis_tasks"]) == 3

    refused = alembic(url, "upgrade", MIGRATION)
    assert refused.returncode != 0 and VARIABLE in _output(refused)
    assert pg(url, _snapshot) == before

    manifest = export(url, tmp_path, seeded)
    upgraded = alembic(url, "upgrade", MIGRATION, **{VARIABLE: str(manifest)})
    assert upgraded.returncode == 0, _output(upgraded)
    after = pg(url, _snapshot)
    assert after["alembic_version"] == [f'{{"version_num":"{MIGRATION}"}}']
    assert not set(RETIRED_TABLES) & set(after)
    assert len(after["reports"]) == len(before["reports"]) - 2
    assert len(after["artifacts"]) == len(before["artifacts"]) - 3
    assert len(after["artifact_drafts"]) == len(before["artifact_drafts"]) - 3
    assert len(after["project_artifacts"]) == len(before["project_artifacts"]) - 2
    for table in ("reports", "artifacts", "artifact_drafts", "project_artifacts"):
        assert set(after[table]) <= set(before[table]), table
    for table in set(before) - {"reports", "artifacts", "artifact_drafts", "project_artifacts", "alembic_version",
                                *RETIRED_TABLES}:
        assert after[table] == before[table], table


# [utest->req~data-retirement-removed-set~1]
def test_a_delete_that_fails_midway_leaves_every_table_and_row_as_it_was(database, tmp_path):
    url, seeded = database
    manifest = export(url, tmp_path, seeded)

    async def refuse_artifact_deletes(connection):
        # The test hook: the last delete of the revision (the report artifacts) fails, after three others ran.
        await connection.execute(sa.text(
            "CREATE FUNCTION m96_test_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ "
            "BEGIN RAISE EXCEPTION 'm96 test hook: report artifact delete refused'; END $$"))
        await connection.execute(sa.text(
            "CREATE TRIGGER m96_test_refuse_delete BEFORE DELETE ON artifacts "
            "FOR EACH ROW EXECUTE FUNCTION m96_test_refuse_delete()"))

    pg(url, refuse_artifact_deletes)
    before = pg(url, _snapshot)
    schemas = pg(url, _schemas)
    failed = alembic(url, "upgrade", MIGRATION, **{VARIABLE: str(manifest)})
    assert failed.returncode != 0, _output(failed)
    assert "m96 test hook" in _output(failed)
    assert pg(url, _snapshot) == before
    assert pg(url, _schemas) == schemas
    assert before["alembic_version"] == [f'{{"version_num":"{HEAD}"}}']


# [utest->req~data-retirement-downgrade~1]
def test_the_downgrade_recreates_both_tables_with_the_schema_of_b6c7d8e9f0a1(database, tmp_path):
    url, seeded = database
    schemas = pg(url, _schemas)
    assert all(schemas[table]["columns"] for table in RETIRED_TABLES)
    manifest = export(url, tmp_path, seeded)
    upgraded = alembic(url, "upgrade", MIGRATION, **{VARIABLE: str(manifest)})
    assert upgraded.returncode == 0, _output(upgraded)
    kept = pg(url, _snapshot)

    downgraded = alembic(url, "downgrade", HEAD)
    assert downgraded.returncode == 0, _output(downgraded)
    restored = pg(url, _snapshot)
    assert restored["alembic_version"] == [f'{{"version_num":"{HEAD}"}}']
    assert {table: restored[table] for table in RETIRED_TABLES} == {table: [] for table in RETIRED_TABLES}
    assert {table: rows for table, rows in restored.items() if table not in RETIRED_TABLES and table != "alembic_version"} \
        == {table: rows for table, rows in kept.items() if table != "alembic_version"}
    assert pg(url, _schemas) == schemas
    index = dict(schemas["sponsor_proposals"]["indexes"])["uq_sponsor_proposal_pending"]
    assert "UNIQUE" in index and "pending" in index

    # The partial unique index works again: one pending proposal per organization.
    organization = uuid.UUID(seeded["ids"]["organization"])
    expires = datetime(2030, 1, 1, tzinfo=timezone.utc)

    def proposal(status: str):
        async def work(connection):
            await connection.execute(sa.text(
                "INSERT INTO sponsor_proposals (id, organization_id, status, expires_at) "
                "VALUES (:id, :organization, :status, :expires)"),
                {"id": uuid.uuid4(), "organization": organization, "status": status, "expires": expires})
        return work

    pg(url, proposal("pending"))
    pg(url, proposal("accepted"))
    with pytest.raises(sa.exc.IntegrityError):
        pg(url, proposal("pending"))

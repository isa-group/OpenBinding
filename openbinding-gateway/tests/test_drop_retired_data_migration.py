"""Alembic revision e7f8a9b0c1d2 (M9.6): the guard, the exact drop, the kept data and the downgrade.

Databases are built with ``alembic upgrade b6c7d8e9f0a1`` and seeded with Core inserts (helpers in
``test_export_retired_data.py``); nothing here uses the ORM models of the retired tables.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path

import pytest
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from concurrency._two_sessions import require_test_database_url
from test_export_retired_data import (
    HEAD,
    MIGRATION,
    MIGRATION_FILE,
    NOW,
    SOURCES,
    alembic,
    build_seeded,
    build_template,
    copy_database,
    dump,
    export_run,
    keys_of,
    load_module,
    read_rows,
    seed,
    sha256_of,
    sqlite_url,
    tool,
    uid,
)

VARIABLE = "OPENBINDING_M96_EXPORT_MANIFEST"
RETIRED_TABLES = ("analysis_tasks", "sponsor_proposals")
# source -> table, for the four selections the migration deletes rows from
DELETED_ROWS = {
    "report_drafts": "reports",
    "report_artifact_drafts": "artifact_drafts",
    "report_artifacts": "artifacts",
    "report_project_artifacts": "project_artifacts",
}


@pytest.fixture(scope="module")
def empty_template(tmp_path_factory) -> Path:
    return build_template(tmp_path_factory.mktemp("empty"))


@pytest.fixture(scope="module")
def seeded_template(tmp_path_factory) -> tuple[Path, dict]:
    return build_seeded(tmp_path_factory.mktemp("seeded"))


@pytest.fixture
def exported(seeded_template, tmp_path):
    """A seeded copy at b6c7d8e9f0a1, its export directory, and the seed's expectations."""
    database = copy_database(seeded_template[0], tmp_path / "db")
    out = tmp_path / "export" / "m96"
    result = export_run(sqlite_url(database), out)
    assert result.returncode == 0, result.stderr
    return database, out, seeded_template[1]


def upgrade(database: Path, manifest: Path | None = None):
    environment = {VARIABLE: str(manifest)} if manifest is not None else {}
    return alembic(sqlite_url(database), "upgrade", MIGRATION, **environment)


def version(database: Path) -> list[str]:
    with closing(sqlite3.connect(database)) as connection:
        return [row[0] for row in connection.execute("SELECT version_num FROM alembic_version")]


def assert_refused(result, database: Path, before: dict, digest: str, *mentions: str) -> None:
    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    for text in (VARIABLE, "tools/export_retired_data.py", *mentions):
        assert text in output, (text, output[-1500:])
    # Nothing changed: same rows, same tables, still at b6c7d8e9f0a1, same bytes on disk.
    assert version(database) == [HEAD]
    assert dump(database) == before
    assert sha256_of(database) == digest


def rewrite_manifest(out: Path, change) -> Path:
    path = out / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    change(manifest)
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


def reseal(out: Path, source: str, data: bytes) -> Path:
    """Replace one data file and make the manifest agree with it (a forged but consistent export)."""
    (out / f"{source}.jsonl").write_bytes(data)

    def change(manifest):
        manifest["sources"][source]["sha256"] = hashlib.sha256(data).hexdigest()

    return rewrite_manifest(out, change)


def add_draft_report(database: Path, ids: dict) -> None:
    """A third never-versioned draft report, created after the export was taken."""
    engine = sa.create_engine(f"sqlite:///{database}")
    metadata = sa.MetaData()
    with engine.begin() as connection:
        metadata.reflect(connection)
        artifact, draft, report = (uid(number).hex for number in (900, 901, 902))
        alice = uuid.UUID(ids["alice"]).hex
        connection.execute(metadata.tables["artifacts"].insert().values(
            id=artifact, organization_id=uuid.UUID(ids["organization"]).hex, namespace="isa-demo", name="late",
            display_name="late", kind="Report", description="", labels={}, archived=False, created_by_id=alice))
        connection.execute(metadata.tables["artifact_drafts"].insert().values(
            id=draft, artifact_id=artifact, revision=1, payload={"content": {}}, created_by_id=alice, updated_at=NOW))
        connection.execute(metadata.tables["reports"].insert().values(
            id=report, project_id=uuid.UUID(ids["project"]).hex, slug="late", title="late", artifact_id=artifact,
            draft_id=draft, version_id=None, state="draft", created_by_id=alice))
    engine.dispose()


# --- the guard --------------------------------------------------------------------------------------------


# [utest->req~data-retirement-guard~1]
def test_without_a_manifest_the_migration_refuses_and_changes_nothing(exported):
    database, _out, _seeded = exported
    before, digest = dump(database), sha256_of(database)
    result = upgrade(database)
    assert_refused(result, database, before, digest)
    assert "analysis_tasks" in before and "sponsor_proposals" in before


# [utest->req~data-retirement-guard~1]
def test_a_variable_that_names_nothing_is_refused_when_rows_exist(exported, tmp_path):
    database, _out, _seeded = exported
    before, digest = dump(database), sha256_of(database)
    assert_refused(upgrade(database, tmp_path / "nowhere.json"), database, before, digest)


# [utest->req~data-retirement-guard~1]
def test_counts_that_changed_after_the_export_are_refused(exported):
    database, out, seeded = exported
    add_draft_report(database, seeded["ids"])
    before, digest = dump(database), sha256_of(database)
    assert_refused(upgrade(database, out / "manifest.json"), database, before, digest, "report_drafts")


# [utest->req~data-retirement-guard~1]
def test_a_forged_export_with_equal_counts_but_other_primary_keys_is_refused(exported):
    database, out, _seeded = exported
    rows = read_rows(out, "analysis_tasks")
    rows[0]["id"] = str(uid(424242))
    forged = b"".join((json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode() for row in rows)
    manifest = reseal(out, "analysis_tasks", forged)
    before, digest = dump(database), sha256_of(database)
    assert_refused(upgrade(database, manifest), database, before, digest, "analysis_tasks", "primary keys")


# [utest->req~data-retirement-guard~1]
def test_a_tampered_file_is_refused(exported):
    database, out, _seeded = exported
    path = out / "sponsor_proposals.jsonl"
    data = path.read_bytes()
    assert b"pending" in data
    path.write_bytes(data.replace(b"pending", b"pendinG"))
    before, digest = dump(database), sha256_of(database)
    assert_refused(upgrade(database, out / "manifest.json"), database, before, digest, "sponsor_proposals")


def _delete_file(out: Path):
    (out / "report_artifacts.jsonl").unlink()


def _wrong_head(out: Path):
    rewrite_manifest(out, lambda manifest: manifest.update(alembic_head="a0a0a0a0a0a0"))


def _wrong_format(out: Path):
    rewrite_manifest(out, lambda manifest: manifest.update(format="something-else/1"))


def _not_json(out: Path):
    (out / "manifest.json").write_text("not json", encoding="utf-8")


def _drop_source(out: Path):
    rewrite_manifest(out, lambda manifest: manifest["sources"].pop("report_project_artifacts"))


def _foreign_path(out: Path):
    rewrite_manifest(out, lambda manifest: manifest["sources"]["report_drafts"].update(file="../elsewhere.jsonl"))


def _wrong_rows(out: Path):
    rewrite_manifest(out, lambda manifest: manifest["sources"]["report_artifact_drafts"].update(rows=99))


def _line_without_key(out: Path):
    path = out / "report_drafts.jsonl"
    reseal(out, "report_drafts", b'{"title":"no id"}\n' + b"".join(path.read_bytes().splitlines(keepends=True)[1:]))


@pytest.mark.parametrize(
    "damage, source",
    [
        (_delete_file, "report_artifacts"),
        (_wrong_head, "a0a0a0a0a0a0"),
        (_wrong_format, "format"),
        (_not_json, "manifest"),
        (_drop_source, "report_project_artifacts"),
        (_foreign_path, "report_drafts"),
        (_wrong_rows, "report_artifact_drafts"),
        (_line_without_key, "report_drafts"),
    ],
    ids=lambda value: getattr(value, "__name__", None),
)
# [utest->req~data-retirement-guard~1]
def test_a_manifest_that_is_damaged_in_any_other_way_is_refused(exported, damage, source):
    database, out, _seeded = exported
    damage(out)
    before, digest = dump(database), sha256_of(database)
    assert_refused(upgrade(database, out / "manifest.json"), database, before, digest, source)


# [utest->req~data-retirement-guard-empty~1]
def test_empty_selections_need_no_manifest(empty_template, tmp_path):
    database = copy_database(empty_template, tmp_path / "unset")
    result = upgrade(database)
    assert result.returncode == 0, result.stdout + result.stderr
    assert version(database) == [MIGRATION]
    other = copy_database(empty_template, tmp_path / "missing")
    result = upgrade(other, Path("/nonexistent/manifest.json"))
    assert result.returncode == 0, result.stdout + result.stderr
    assert version(other) == [MIGRATION]


# --- the drop ---------------------------------------------------------------------------------------------


# [utest->req~data-retirement-removed-set~1]
# [utest->req~data-retirement-kept-set~1]
def test_the_upgrade_removes_exactly_the_exported_rows_and_keeps_everything_else(exported):
    database, out, seeded = exported
    before = dump(database)
    result = upgrade(database, out / "manifest.json")
    assert result.returncode == 0, result.stdout + result.stderr
    after = dump(database)
    assert version(database) == [MIGRATION]
    assert not set(RETIRED_TABLES) & set(after)

    removed = {}
    for source, table in DELETED_ROWS.items():
        removed[source] = set(before[table]) - set(after[table])
        assert not set(after[table]) - set(before[table])
        # every row that is still there is byte-identical to what it was
        assert all(after[table][key] == before[table][key] for key in after[table])
    for source in DELETED_ROWS:
        exported_keys = keys_of(source, read_rows(out, source))
        assert removed[source] == set(exported_keys) == seeded["expected"][source], source
    assert len(removed["report_drafts"]) == 2

    for table in set(before) - set(DELETED_ROWS.values()) - set(RETIRED_TABLES) - {"alembic_version"}:
        assert after[table] == before[table], table

    ids = seeded["ids"]
    surviving_reports = {key[0] for key in after["reports"]}
    for name in ("d2", "d3", "d4", "f1"):
        assert ids["report:" + name] in surviving_reports, name
    assert ids["report:d1"] not in surviving_reports and ids["report:d5"] not in surviving_reports
    surviving_artifacts = {key[0] for key in after["artifacts"]}
    assert {ids["artifact:" + name] for name in ("d2", "d3", "d4", "f1", "orphan", "ds-draft", "ds-empty")} <= surviving_artifacts
    assert ids["draft:orphan"] not in {key[0] for key in after["artifact_drafts"]}
    assert len(after["publications"]) == 2 and len(after["artifact_publications"]) == 2  # d3 and the frozen f1


# [utest->req~data-retirement-removed-set~1]
def test_the_migration_and_the_tool_select_with_the_same_sql():
    migration = load_module(MIGRATION_FILE, "m96_migration_under_test")
    assert migration.SELECTIONS == tool.SELECTIONS
    assert migration.SOURCES == tool.SOURCES
    assert migration.PRIMARY_KEYS == tool.PRIMARY_KEYS
    assert migration.ALEMBIC_HEAD == tool.ALEMBIC_HEAD and migration.FORMAT == tool.FORMAT
    assert migration.down_revision == HEAD and migration.revision == MIGRATION


# --- the downgrade ----------------------------------------------------------------------------------------


def schema(database: Path, table: str) -> dict:
    engine = sa.create_engine(f"sqlite:///{database}")
    try:
        inspector = sa.inspect(engine)
        with closing(sqlite3.connect(database)) as connection:
            index_sql = sorted(connection.execute(
                "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL", (table,)))
        return {
            "columns": sorted(
                (column["name"], str(column["type"]), column["nullable"], str(column["default"]))
                for column in inspector.get_columns(table)),
            "primary_key": inspector.get_pk_constraint(table)["constrained_columns"],
            "foreign_keys": sorted(
                (tuple(key["constrained_columns"]), key["referred_table"], tuple(key["referred_columns"]),
                 key["options"].get("ondelete"))
                for key in inspector.get_foreign_keys(table)),
            "unique": sorted((item["name"], tuple(item["column_names"])) for item in inspector.get_unique_constraints(table)),
            "indexes": index_sql,
        }
    finally:
        engine.dispose()


# [utest->req~data-retirement-downgrade~1]
def test_the_downgrade_recreates_both_tables_empty_with_their_old_schema(exported, empty_template):
    database, out, seeded = exported
    assert upgrade(database, out / "manifest.json").returncode == 0
    downgraded = alembic(sqlite_url(database), "downgrade", HEAD)
    assert downgraded.returncode == 0, downgraded.stdout + downgraded.stderr
    assert version(database) == [HEAD]
    after = dump(database)
    for table in RETIRED_TABLES:
        assert after[table] == {}
        assert schema(database, table) == schema(empty_template, table), table
    assert seeded["ids"]["report:d1"] not in {key[0] for key in after["reports"]}
    sqlite_indexes = dict(schema(database, "sponsor_proposals")["indexes"])
    assert "uq_sponsor_proposal_pending" in sqlite_indexes and "WHERE status = 'pending'" in sqlite_indexes["uq_sponsor_proposal_pending"]
    # the partial unique index works again: one pending proposal per organization
    organization = uuid.UUID(seeded["ids"]["organization"]).hex
    with closing(sqlite3.connect(database)) as connection:
        for status, allowed in (("pending", True), ("accepted", True), ("pending", False)):
            statement = "INSERT INTO sponsor_proposals (id, organization_id, status, expires_at) VALUES (?, ?, ?, '2030-01-01')"
            if allowed:
                connection.execute(statement, (uuid.uuid4().hex, organization, status))
            else:
                with pytest.raises(sqlite3.IntegrityError):
                    connection.execute(statement, (uuid.uuid4().hex, organization, status))


# --- PostgreSQL ---------------------------------------------------------------------------------------------


async def _pg_run(url: str, work):
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as connection:
            return await work(connection)
    finally:
        await engine.dispose()


def pg(url: str, work):
    return asyncio.run(_pg_run(url, work))


def test_postgresql_refuses_without_an_export_then_drops_exactly_with_one(tmp_path):
    url = require_test_database_url()

    async def reset(connection):
        await connection.execute(sa.text("DROP SCHEMA public CASCADE"))
        await connection.execute(sa.text("CREATE SCHEMA public"))

    async def populate(connection):
        return await connection.run_sync(seed)

    async def snapshot(connection):
        counts = {}
        for table in ("reports", "artifacts", "artifact_drafts", "project_artifacts", "publications", "artifact_versions"):
            counts[table] = (await connection.execute(sa.text(f"SELECT count(*) FROM {table}"))).scalar()
        for table in RETIRED_TABLES:
            counts[table] = (await connection.execute(sa.text(
                "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = :name"),
                {"name": table})).scalar()
        counts["version"] = (await connection.execute(sa.text("SELECT version_num FROM alembic_version"))).scalar()
        return counts

    pg(url, reset)
    prepared = alembic(url, "upgrade", HEAD)
    assert prepared.returncode == 0, prepared.stdout + prepared.stderr
    seeded = pg(url, populate)
    before = pg(url, snapshot)
    assert before["version"] == HEAD and before["analysis_tasks"] == 1

    refused = alembic(url, "upgrade", MIGRATION)
    assert refused.returncode != 0 and VARIABLE in refused.stdout + refused.stderr
    assert pg(url, snapshot) == before

    out = tmp_path / "export" / "m96"
    exported = export_run(url, out)
    assert exported.returncode == 0, exported.stderr
    for source in SOURCES:
        assert set(keys_of(source, read_rows(out, source))) == seeded["expected"][source], source

    upgraded = alembic(url, "upgrade", MIGRATION, **{VARIABLE: str(out / "manifest.json")})
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
    after = pg(url, snapshot)
    assert after["version"] == MIGRATION
    assert after["analysis_tasks"] == 0 and after["sponsor_proposals"] == 0
    assert after["reports"] == before["reports"] - 2
    assert after["artifacts"] == before["artifacts"] - 3
    assert after["artifact_drafts"] == before["artifact_drafts"] - 3
    assert after["project_artifacts"] == before["project_artifacts"] - 2
    assert after["publications"] == before["publications"] and after["artifact_versions"] == before["artifact_versions"]

    downgraded = alembic(url, "downgrade", HEAD)
    assert downgraded.returncode == 0, downgraded.stdout + downgraded.stderr
    restored = pg(url, snapshot)
    assert restored["analysis_tasks"] == 1 and restored["sponsor_proposals"] == 1

    async def emptiness(connection):
        rows = {table: (await connection.execute(sa.text(f"SELECT count(*) FROM {table}"))).scalar()
                for table in RETIRED_TABLES}
        index = (await connection.execute(sa.text(
            "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_sponsor_proposal_pending'"))).scalar()
        attempts = (await connection.execute(sa.text(
            "SELECT is_nullable, column_default FROM information_schema.columns "
            "WHERE table_name = 'analysis_tasks' AND column_name = 'attempts'"))).one()
        return rows, index, tuple(attempts)

    rows, index, attempts = pg(url, emptiness)
    assert rows == {"analysis_tasks": 0, "sponsor_proposals": 0}
    assert index is not None and "UNIQUE" in index and "pending" in index
    assert attempts[0] == "NO" and "0" in attempts[1]
    shutil.rmtree(out)

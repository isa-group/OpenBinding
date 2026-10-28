"""Alembic revision e7f8a9b0c1d2 (M9.6): the guard, the exact drop, the kept data and the downgrade.

Databases are built with ``alembic upgrade b6c7d8e9f0a1`` and seeded with Core inserts (helpers in
``test_export_retired_data.py``); nothing here uses the ORM models of the retired tables.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path

import pytest
import sqlalchemy as sa

from test_export_retired_data import (
    HEAD,
    MIGRATION,
    MIGRATION_FILE,
    NOW,
    SOURCES,
    _filler,
    alembic,
    build_seeded,
    build_template,
    copy_database,
    dump,
    export_run,
    keys_of,
    load_module,
    read_rows,
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


def insert(connection, metadata: sa.MetaData, table_name: str, /, **values) -> None:
    """One SQLite row: UUIDs as 32 hex digits, required columns without a value filled like ``seed`` does."""
    table = metadata.tables[table_name]
    row = {}
    for column in table.columns:
        if column.name in values:
            value = values[column.name]
            row[column.name] = value.hex if isinstance(value, uuid.UUID) else value
        elif not column.nullable and column.server_default is None:
            row[column.name] = _filler(column)
    connection.execute(table.insert().values(**row))


def edit(database: Path, change) -> None:
    engine = sa.create_engine(f"sqlite:///{database}")
    metadata = sa.MetaData()
    try:
        with engine.begin() as connection:
            metadata.reflect(connection)
            change(connection, metadata)
    finally:
        engine.dispose()


# Kept tables that ``seed`` leaves empty; ``add_kept_rows`` puts one row in each.
SEEDED_LATER = ("binding_case_revisions", "case_artifacts", "artifact_dependencies", "study_cells", "artifact_evidence")


def add_kept_rows(database: Path, ids: dict) -> None:
    """A case revision pinning a sealed version, a dependency between two versions, a study cell and its evidence."""

    def change(connection, metadata):
        def version_of(name: str) -> uuid.UUID:
            artifact = uuid.UUID(ids["artifact:" + name]).hex
            return uuid.UUID(connection.execute(
                sa.text("SELECT id FROM artifact_versions WHERE artifact_id = :id"), {"id": artifact}).scalar_one())

        report_version, definition = version_of("f1"), version_of("study-definition")
        run = uuid.UUID(connection.execute(sa.text("SELECT id FROM study_runs")).scalar_one())
        alice, case, revision = uuid.UUID(ids["alice"]), uid(950), uid(951)
        insert(connection, metadata, "binding_cases", id=case, project_id=uuid.UUID(ids["project"]), slug="c1",
               name="C1", description="", created_by_id=alice)
        insert(connection, metadata, "binding_case_revisions", id=revision, binding_case_id=case, revision=1,
               digest="sha256-" + "e" * 64, document={"kind": "Instance"}, created_by_id=alice)
        insert(connection, metadata, "case_artifacts", revision_id=revision, alias="app", role="application",
               version_id=definition, bindings={})
        insert(connection, metadata, "artifact_dependencies", version_id=report_version, dependency_id=definition)
        # The cell before the evidence: a run that is report evidence takes no new cell.
        insert(connection, metadata, "study_cells", id=uid(952), study_run_id=run, ordinal=0,
               binding_case_revision_id=revision, engine_ref={"name": "random-search"}, parameters={}, seed=7,
               fingerprint="cell-0", state="completed", metrics={"score": 1})
        insert(connection, metadata, "artifact_evidence", version_id=report_version, position=0, study_run_id=run,
               job_id=None, digest="sha256-" + "f" * 64)

    edit(database, change)


# --- the guard --------------------------------------------------------------------------------------------


# [utest->req~data-retirement-guard~1]
def test_without_a_manifest_the_migration_refuses_and_changes_nothing(exported):
    database, _out, _seeded = exported
    before, digest = dump(database), sha256_of(database)
    result = upgrade(database)
    assert_refused(result, database, before, digest)
    assert "analysis_tasks" in before and "sponsor_proposals" in before


def _owner(connection, metadata) -> dict:
    alice, organization, project = uid(800), uid(801), uid(802)
    insert(connection, metadata, "users", id=alice, username="alice", email="alice@example.org", password_hash="x",
           role="user", is_active=True, plan_cache="free", contract_pending=False)
    insert(connection, metadata, "organizations", id=organization, slug="isa-demo", name="ISA",
           billing_sponsor_user_id=alice, created_by_id=alice)
    insert(connection, metadata, "projects", id=project, organization_id=organization, slug="p1", name="P1",
           description="", visibility="private", created_by_id=alice)
    return {"alice": alice, "organization": organization, "project": project}


def _artifact(connection, metadata, owner, key: uuid.UUID, kind: str = "Report") -> uuid.UUID:
    insert(connection, metadata, "artifacts", id=key, organization_id=owner["organization"], namespace="isa-demo",
           name=f"a{key.int}", display_name="a", kind=kind, description="", labels={}, archived=False,
           created_by_id=owner["alice"])
    return key


def _only_analysis_tasks(connection, metadata, owner):
    insert(connection, metadata, "analysis_tasks", id=uid(810), owner_id=owner["alice"], fingerprint="f0",
           revision="r1", request={"query": 0}, state="queued", progress=0.0, cancellation_requested=False)


def _only_sponsor_proposals(connection, metadata, owner):
    insert(connection, metadata, "sponsor_proposals", id=uid(811), organization_id=owner["organization"],
           proposed_user_id=owner["alice"], proposed_by_user_id=owner["alice"], status="pending",
           expires_at=NOW)


def _only_report_drafts(connection, metadata, owner):
    # A never-versioned draft report without an editable draft, on an artifact that is not of kind Report:
    # nothing else is selected with it.
    artifact = _artifact(connection, metadata, owner, uid(812), kind="Dataset")
    insert(connection, metadata, "reports", id=uid(813), project_id=owner["project"], slug="d1", title="d1",
           artifact_id=artifact, draft_id=None, version_id=None, state="draft", created_by_id=owner["alice"])


def _only_report_artifact_drafts(connection, metadata, owner):
    # The unsealed draft of a versioned Report artifact that no report points to.
    artifact, blob, sealed = _artifact(connection, metadata, owner, uid(814)), uid(815), uid(816)
    insert(connection, metadata, "blobs", id=blob, organization_id=owner["organization"], digest="sha256-" + "1" * 64,
           media_type="application/json", size_bytes=2, storage_uri="memory://blob", public=False,
           created_by_id=owner["alice"])
    insert(connection, metadata, "artifact_versions", id=sealed, artifact_id=artifact, ordinal=1, version="1",
           blob_id=blob, content_digest="sha256-" + "1" * 64, version_digest="sha256-" + "2" * 64, manifest={},
           created_by_id=owner["alice"])
    insert(connection, metadata, "artifact_drafts", id=uid(817), artifact_id=artifact, revision=1,
           payload={"content": {}}, created_by_id=owner["alice"], updated_at=NOW)


def _only_report_artifacts(connection, metadata, owner):
    _artifact(connection, metadata, owner, uid(818))


def _report_project_artifacts(connection, metadata, owner):
    # A project link of a Report artifact with nothing else; the artifact itself is selected with it.
    artifact = _artifact(connection, metadata, owner, uid(819))
    insert(connection, metadata, "project_artifacts", project_id=owner["project"], artifact_id=artifact)


ONE_SOURCE = {
    "analysis_tasks": (_only_analysis_tasks, {"analysis_tasks"}),
    "sponsor_proposals": (_only_sponsor_proposals, {"sponsor_proposals"}),
    "report_drafts": (_only_report_drafts, {"report_drafts"}),
    "report_artifact_drafts": (_only_report_artifact_drafts, {"report_artifact_drafts"}),
    "report_artifacts": (_only_report_artifacts, {"report_artifacts"}),
    "report_project_artifacts": (_report_project_artifacts, {"report_project_artifacts", "report_artifacts"}),
}


@pytest.mark.parametrize("source", SOURCES)
# [utest->req~data-retirement-guard~1]
def test_any_one_source_with_rows_needs_the_export(empty_template, tmp_path, source):
    assert set(ONE_SOURCE) == set(SOURCES)
    database = copy_database(empty_template, tmp_path / "db")
    fill, expected = ONE_SOURCE[source]
    edit(database, lambda connection, metadata: fill(connection, metadata, _owner(connection, metadata)))
    with closing(sqlite3.connect(database)) as connection:
        selected = {name for name in SOURCES if connection.execute(tool.SELECTIONS[name]).fetchall()}
    assert selected == expected
    before, digest = dump(database), sha256_of(database)
    assert_refused(upgrade(database), database, before, digest)


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
        (_not_json, "cannot be read as a manifest"),
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
    # Rows in the kept tables the seed leaves empty; none of them is in a selection, so the export still matches.
    add_kept_rows(database, seeded["ids"])
    before = dump(database)
    assert all(len(before[table]) == 1 for table in SEEDED_LATER), {table: len(before[table]) for table in SEEDED_LATER}
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
    assert set(SEEDED_LATER) <= set(after)

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


# The PostgreSQL runs (the exact drop, a delete that fails midway, the downgrade) are in
# tests/concurrency/test_m96_migration_pg.py.


# [utest->req~data-retirement-removed-set~1]
def test_a_delete_that_does_not_remove_the_selected_rows_raises():
    """``_delete`` sums the row counts of its chunks and raises when they differ from the selection."""
    migration = load_module(MIGRATION_FILE, "m96_migration_delete_under_test")
    engine = sa.create_engine("sqlite://")
    values = [f"row-{number}" for number in range(migration.CHUNK * 2 + 1)]
    try:
        with engine.begin() as connection:
            connection.execute(sa.text("CREATE TABLE things (id TEXT PRIMARY KEY)"))
            connection.execute(sa.text("INSERT INTO things (id) VALUES (:id)"), [{"id": value} for value in values])
            # Three chunks, every row found: no error.
            migration._delete(connection, "things", "id", values, len(values))
            assert connection.execute(sa.text("SELECT count(*) FROM things")).scalar() == 0
            connection.execute(sa.text("INSERT INTO things (id) VALUES ('kept')"))
            # One of the two selected rows is gone already: the migration stops.
            with pytest.raises(RuntimeError, match="deleted 1 rows of things, expected 2; nothing is committed"):
                migration._delete(connection, "things", "id", ["kept", "vanished"], 2)
    finally:
        engine.dispose()

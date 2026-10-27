"""The export tool of the M9.6 data drop (tools/export_retired_data.py).

The database is built through ``alembic upgrade b6c7d8e9f0a1`` and seeded with Core inserts into reflected
tables: the ORM models of the retired tables are being removed, so nothing here may depend on them.

The seeding and process helpers below are shared with ``test_drop_retired_data_migration.py``.
"""

from __future__ import annotations

import hashlib
import importlib.util
import itertools
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import pytest
import sqlalchemy as sa

from _paths import GATEWAY_ROOT

HEAD = "b6c7d8e9f0a1"
MIGRATION = "e7f8a9b0c1d2"
TOOL = GATEWAY_ROOT / "tools" / "export_retired_data.py"
MIGRATION_FILE = GATEWAY_ROOT / "alembic" / "versions" / "e7f8a9b0c1d2_drop_retired_data.py"
NOW = datetime(2026, 3, 1, 8, 30, 15, 123456)
TIMESTAMP = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?Z$")


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = load_module(TOOL, "export_retired_data_under_test")
SOURCES = tool.SOURCES
PRIMARY_KEYS = tool.PRIMARY_KEYS


# --- processes -------------------------------------------------------------------------------------------


def sqlite_url(database: Path, driver: str = "sqlite+aiosqlite") -> str:
    return f"{driver}:///{database}"


def alembic(url: str, *arguments: str, **environment: str) -> subprocess.CompletedProcess:
    inherited = {key: value for key, value in os.environ.items() if key != "OPENBINDING_M96_EXPORT_MANIFEST"}
    env = {**inherited, "DATABASE_URL": url, **environment}
    return subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", *arguments],
        cwd=GATEWAY_ROOT, env=env, capture_output=True, text=True, check=False,
    )


def export_run(url: str | None, out: Path) -> subprocess.CompletedProcess:
    env = {key: value for key, value in os.environ.items() if key != "DATABASE_URL"}
    if url is not None:
        env["DATABASE_URL"] = url
    return subprocess.run(
        [sys.executable, str(TOOL), "--out", str(out)],
        cwd=GATEWAY_ROOT, env=env, capture_output=True, text=True, check=False,
    )


# --- seeding (Core inserts into reflected tables) -----------------------------------------------------------


def uid(number: int) -> uuid.UUID:
    return uuid.UUID(int=number)


def norm(value) -> str:
    return tool.normalise(value)


def _filler(column: sa.Column):
    kind = column.type
    if isinstance(kind, sa.Uuid) or (isinstance(kind, sa.CHAR) and kind.length == 32):
        raise AssertionError(f"the seed gives no value for required key {column.table.name}.{column.name}")
    if isinstance(kind, sa.Boolean):
        return False
    if isinstance(kind, sa.Integer):
        return 0
    if isinstance(kind, (sa.Float, sa.Numeric)):
        return 0.0
    if isinstance(kind, sa.DateTime):
        return NOW
    if isinstance(kind, sa.JSON):
        return {}
    if isinstance(kind, sa.String):
        return "x"
    raise AssertionError(f"the seed gives no value for required column {column.table.name}.{column.name}")


def seed(connection: sa.Connection) -> dict:
    """Fill a database at b6c7d8e9f0a1; return the expected selections and the ids of the named rows."""
    metadata = sa.MetaData()
    metadata.reflect(connection)
    sqlite = connection.dialect.name == "sqlite"
    counter = itertools.count(1000)

    def bind(value):
        # SQLite keeps UUIDs as 32 hex digits and naive timestamps; PostgreSQL wants UUIDs and aware timestamps.
        if sqlite and isinstance(value, uuid.UUID):
            return value.hex
        if not sqlite and isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value

    def new() -> uuid.UUID:
        return uid(next(counter))

    def put(table_name: str, /, **values) -> None:
        table = metadata.tables[table_name]
        unknown = set(values) - set(table.c.keys())
        assert not unknown, f"{table_name} has no column {unknown}"
        row = {}
        for column in table.columns:
            if column.name in values:
                row[column.name] = bind(values[column.name])
            elif not column.nullable and column.server_default is None:
                row[column.name] = bind(_filler(column))
        connection.execute(table.insert().values(**row))

    alice, bob, org, project = new(), new(), new(), new()
    for user, name in ((alice, "alice"), (bob, "bob")):
        put("users", id=user, username=name, email=f"{name}@example.org", password_hash="x", role="user",
            is_active=True, plan_cache="free", contract_pending=False)
    put("organizations", id=org, slug="isa-demo", name="ISA", billing_sponsor_user_id=alice, created_by_id=alice)
    put("projects", id=project, organization_id=org, slug="p1", name="P1", description="", visibility="private",
        created_by_id=alice)

    ids: dict[str, str] = {}
    expected: dict[str, set[tuple[str, ...]]] = {source: set() for source in SOURCES}

    for number in range(3):
        task = new()
        put("analysis_tasks", id=task, owner_id=alice, fingerprint=f"f{number}", revision="r1",
            request={"query": number}, state="queued", progress=0.0, cancellation_requested=False)
        expected["analysis_tasks"].add((str(task),))
    proposal = new()
    put("sponsor_proposals", id=proposal, organization_id=org, proposed_user_id=bob, proposed_by_user_id=alice,
        status="pending", expires_at=datetime(2026, 11, 10, 12, 0, 0))
    expected["sponsor_proposals"].add((str(proposal),))
    ids["proposal"] = str(proposal)

    def artifact(name: str, kind: str = "Report") -> uuid.UUID:
        key = new()
        put("artifacts", id=key, organization_id=org, namespace="isa-demo", name=name, display_name=name, kind=kind,
            description="", labels={}, archived=False, created_by_id=alice)
        ids["artifact:" + name] = str(key)
        return key

    def version(artifact_id: uuid.UUID) -> uuid.UUID:
        blob, key = new(), new()
        digest = f"sha256-{blob.int:064x}"
        put("blobs", id=blob, organization_id=org, digest=digest, media_type="application/json", size_bytes=2,
            storage_uri=f"memory://{blob}", public=False, created_by_id=alice)
        put("artifact_versions", id=key, artifact_id=artifact_id, ordinal=1, version="1", blob_id=blob,
            content_digest=digest, version_digest=f"sha256-v{key.int:063x}", manifest={}, created_by_id=alice)
        return key

    def draft(artifact_id: uuid.UUID, content: dict, sealed: uuid.UUID | None = None) -> uuid.UUID:
        key = new()
        put("artifact_drafts", id=key, artifact_id=artifact_id, revision=1, payload={"content": content},
            sealed_version_id=sealed, created_by_id=alice, updated_at=NOW)
        return key

    def report(slug: str, artifact_id, draft_id, version_id, state: str) -> uuid.UUID:
        key = new()
        put("reports", id=key, project_id=project, slug=slug, title=slug, artifact_id=artifact_id, draft_id=draft_id,
            version_id=version_id, state=state, created_by_id=alice)
        ids["report:" + slug] = str(key)
        return key

    def link(artifact_id: uuid.UUID) -> None:
        put("project_artifacts", project_id=project, artifact_id=artifact_id)

    def publish(report_id, version_id, slug: str) -> None:
        put("publications", id=new(), project_id=project, report_id=report_id, version_id=version_id, withdrawn=False,
            slug=slug, citation={}, published_by_id=alice)
        put("artifact_publications", version_id=version_id, withdrawn=False, citation={}, published_by_id=alice,
            published_at=NOW)

    # Removed: draft reports that never had a version or a publication (d1, d5).
    a1 = artifact("d1")
    draft1 = draft(a1, {"title": "Q3"})
    d1 = report("d1", a1, draft1, None, "draft")
    link(a1)
    a5 = artifact("d5")
    draft5 = draft(a5, {"title": "Q3 \u2013 \u00fcn\u00ef\u2028x"})
    d5 = report("d5", a5, draft5, None, "draft")
    link(a5)
    expected["report_drafts"] |= {(str(d1),), (str(d5),)}
    expected["report_artifact_drafts"] |= {(str(draft1),), (str(draft5),)}
    expected["report_artifacts"] |= {(str(a1),), (str(a5),)}
    expected["report_project_artifacts"] |= {(str(project), str(a1)), (str(project), str(a5))}

    # d2: frozen once at version 1, never published, then returned to draft.
    a2 = artifact("d2")
    v2 = version(a2)
    draft(a2, {"title": "sealed"}, sealed=v2)
    report("d2", a2, draft(a2, {"title": "again"}), v2, "draft")
    link(a2)
    # d3: published at version 1, then returned to draft.
    a3 = artifact("d3")
    v3 = version(a3)
    draft(a3, {"title": "sealed"}, sealed=v3)
    d3 = report("d3", a3, draft(a3, {"title": "again"}), v3, "draft")
    publish(d3, v3, "d3")
    link(a3)
    # f1: frozen.
    a4 = artifact("f1")
    v4 = version(a4)
    f1 = report("f1", a4, draft(a4, {"title": "sealed"}, sealed=v4), v4, "frozen")
    publish(f1, v4, "f1")
    link(a4)
    # d4: a draft report without version_id whose artifact received a sealed version through a second draft.
    a6 = artifact("d4")
    v6 = version(a6)
    draft(a6, {"title": "sealed in the library"}, sealed=v6)
    report("d4", a6, draft(a6, {"title": "still editing"}), None, "draft")
    link(a6)
    # An unsealed draft of a versioned Report artifact that no report points to.
    a7 = artifact("orphan")
    version(a7)
    orphan = draft(a7, {"title": "orphan"})
    expected["report_artifact_drafts"].add((str(orphan),))
    ids["draft:orphan"] = str(orphan)
    # A Report artifact with nothing at all.
    stray = artifact("stray")
    expected["report_artifacts"].add((str(stray),))
    # Other kinds are never touched.
    dataset = artifact("ds-draft", "Dataset")
    draft(dataset, {"rows": 1})
    link(dataset)
    artifact("ds-empty", "Dataset")

    # Study data, a project resource with two revisions.
    study, run, resource = new(), new(), new()
    definition = version(artifact("study-definition", "Study"))
    put("studies", id=study, project_id=project, slug="s1", name="S1", description="", state="draft",
        definition_version_id=definition, created_by_id=alice)
    put("study_runs", id=run, study_id=study, run_number=1, state="queued", matrix_digest="m", summary={},
        definition_version_id=definition, created_by_id=alice)
    put("project_resources", id=resource, project_id=project, slug="r1", name="R1", description="", kind="Dataset",
        created_by_id=alice)
    for revision in (1, 2):
        put("project_resource_revisions", id=new(), project_resource_id=resource, revision=revision,
            digest=f"sha256-r{revision}", document={"revision": revision}, created_by_id=alice)
    ids.update(project=str(project), alice=str(alice), organization=str(org))
    return {"expected": expected, "ids": ids}


def dump(database: Path) -> dict[str, dict[tuple, str]]:
    """Every table of a SQLite file as {table: {primary key (UUIDs hyphenated): repr of the row}}."""
    with closing(sqlite3.connect(database)) as connection:
        tables = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        result = {}
        for table in tables:
            info = list(connection.execute(f'PRAGMA table_info("{table}")'))
            key_columns = [index for _, index in sorted((row[5], index) for index, row in enumerate(info) if row[5])]
            rows = {}
            for row in connection.execute(f'SELECT * FROM "{table}"'):
                key = tuple(norm(row[i]) for i in key_columns) or (repr(row),)
                rows[key] = repr(row)
            result[table] = rows
        return result


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_rows(directory: Path, source: str) -> list[dict]:
    data = (directory / f"{source}.jsonl").read_bytes()
    assert data == b"" or data.endswith(b"\n")
    return [json.loads(line) for line in data.decode("utf-8").split("\n")[:-1]]


def keys_of(source: str, rows: list[dict]) -> list[tuple[str, ...]]:
    return [tuple(norm(row[name]) for name in PRIMARY_KEYS[source]) for row in rows]


def build_template(directory: Path) -> Path:
    """A SQLite database upgraded to b6c7d8e9f0a1 and nothing else."""
    directory.mkdir(parents=True, exist_ok=True)
    database = directory / "gateway.db"
    upgraded = alembic(sqlite_url(database), "upgrade", HEAD)
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
    return database


def build_seeded(directory: Path) -> tuple[Path, dict]:
    database = build_template(directory)
    engine = sa.create_engine(f"sqlite:///{database}")
    with engine.begin() as connection:
        seeded = seed(connection)
    engine.dispose()
    return database, seeded


def copy_database(source: Path, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "gateway.db"
    shutil.copy(source, target)
    return target


@pytest.fixture(scope="module")
def empty_template(tmp_path_factory) -> Path:
    return build_template(tmp_path_factory.mktemp("empty"))


@pytest.fixture(scope="module")
def seeded_template(tmp_path_factory) -> tuple[Path, dict]:
    return build_seeded(tmp_path_factory.mktemp("seeded"))


@pytest.fixture
def database(seeded_template, tmp_path) -> Path:
    return copy_database(seeded_template[0], tmp_path / "db")


@pytest.fixture
def seeded(seeded_template) -> dict:
    return seeded_template[1]


# --- tests ------------------------------------------------------------------------------------------------


# [utest->req~data-retirement-export-files~1]
def test_export_writes_the_six_files_and_the_manifest(database, seeded, tmp_path):
    before = dump(database)
    out = tmp_path / "export" / "m96"
    result = export_run(sqlite_url(database), out)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(out.resolve() / "manifest.json")
    assert Path(result.stdout.strip()).is_absolute()
    assert sorted(path.name for path in out.iterdir()) == sorted([f"{source}.jsonl" for source in SOURCES] + ["manifest.json"])
    assert len(read_rows(out, "analysis_tasks")) == 3
    assert len(read_rows(out, "sponsor_proposals")) == 1
    assert len(read_rows(out, "report_drafts")) == 2
    with closing(sqlite3.connect(database)) as connection:
        for source in SOURCES:
            table = tool.TABLES[source]
            columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
            assert all(set(row) == columns for row in read_rows(out, source)), source
    assert dump(database) == before


# [utest->req~data-retirement-export-files~1]
def test_values_are_written_as_the_spec_says(database, seeded, tmp_path):
    out = tmp_path / "export"
    assert export_run(sqlite_url(database), out).returncode == 0
    (proposal,) = read_rows(out, "sponsor_proposals")
    assert proposal["id"] == seeded["ids"]["proposal"] and proposal["id"] == proposal["id"].lower() and "-" in proposal["id"]
    assert proposal["status"] == "pending"
    assert proposal["expires_at"] == "2026-11-10T12:00:00Z"
    assert proposal["decided_at"] is None
    assert TIMESTAMP.match(proposal["created_at"])
    task = read_rows(out, "analysis_tasks")[0]
    assert task["request"] in ({"query": 0}, {"query": 1}, {"query": 2})
    assert task["cancellation_requested"] is False and task["attempts"] == 0 and task["progress"] == 0.0
    drafts = {row["id"]: row for row in read_rows(out, "report_artifact_drafts")}
    by_artifact = {row["artifact_id"]: row for row in drafts.values()}
    assert by_artifact[seeded["ids"]["artifact:d1"]]["payload"] == {"content": {"title": "Q3"}}
    assert by_artifact[seeded["ids"]["artifact:d5"]]["payload"] == {"content": {"title": "Q3 \u2013 \u00fcn\u00ef\u2028x"}}
    assert by_artifact[seeded["ids"]["artifact:d1"]]["updated_at"] == "2026-03-01T08:30:15.123456Z"
    assert all(row["sealed_version_id"] is None for row in drafts.values())


# [utest->req~data-retirement-export-selection~1]
def test_each_file_holds_exactly_its_selection_ordered_by_primary_key(database, seeded, tmp_path):
    out = tmp_path / "export"
    assert export_run(sqlite_url(database), out).returncode == 0
    for source in SOURCES:
        keys = keys_of(source, read_rows(out, source))
        assert keys == sorted(keys), source
        assert set(keys) == seeded["expected"][source], source
        assert len(keys) == len(seeded["expected"][source]), source


# [utest->req~data-retirement-export-selection~1]
def test_mixed_reports_only_the_never_versioned_draft_is_selected(database, seeded, tmp_path):
    out = tmp_path / "export"
    assert export_run(sqlite_url(database), out).returncode == 0
    ids = seeded["ids"]
    reports = {row["id"] for row in read_rows(out, "report_drafts")}
    assert reports == {ids["report:d1"], ids["report:d5"]}
    for kept in ("d2", "d3", "f1", "d4"):  # d4: its artifact has a sealed version, so its permanent link survives
        assert ids["report:" + kept] not in reports
    artifacts = {row["id"] for row in read_rows(out, "report_artifacts")}
    assert artifacts == {ids["artifact:d1"], ids["artifact:d5"], ids["artifact:stray"]}
    drafts = {row["id"] for row in read_rows(out, "report_artifact_drafts")}
    assert ids["draft:orphan"] in drafts and ids["artifact:orphan"] not in artifacts
    everything = json.dumps([read_rows(out, source) for source in SOURCES])
    assert ids["artifact:ds-draft"] not in everything and ids["artifact:ds-empty"] not in everything


# [utest->req~data-retirement-export-manifest~1]
def test_the_manifest_describes_the_files(database, tmp_path):
    out = tmp_path / "export"
    assert export_run(sqlite_url(database), out).returncode == 0
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["format"] == "openbinding-m96-export/1"
    assert manifest["alembic_head"] == HEAD
    assert TIMESTAMP.match(manifest["exported_at"]) and manifest["exported_at"].endswith("Z")
    assert list(manifest["sources"]) == list(SOURCES)
    for source, entry in manifest["sources"].items():
        data = (out / entry["file"]).read_bytes()
        assert entry == {"file": f"{source}.jsonl", "rows": data.count(b"\n"), "sha256": hashlib.sha256(data).hexdigest()}
    assert manifest["sources"]["analysis_tasks"]["rows"] == 3
    assert set(manifest) == {"format", "alembic_head", "exported_at", "sources"}


# [utest->req~data-retirement-export-files~1]
def test_an_empty_selection_gives_empty_files_and_zero_rows(empty_template, tmp_path):
    database = copy_database(empty_template, tmp_path / "db")
    out = tmp_path / "export"
    assert export_run(sqlite_url(database), out).returncode == 0
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    for source in SOURCES:
        assert (out / f"{source}.jsonl").read_bytes() == b""
        assert manifest["sources"][source] == {
            "file": f"{source}.jsonl", "rows": 0, "sha256": hashlib.sha256(b"").hexdigest()}


# [utest->req~data-retirement-export-manifest~1]
def test_the_export_is_deterministic_and_the_sync_url_form_gives_the_same_bytes(database, tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    assert export_run(sqlite_url(database), first).returncode == 0
    assert export_run(sqlite_url(database, "sqlite"), second).returncode == 0
    for source in SOURCES:
        assert (first / f"{source}.jsonl").read_bytes() == (second / f"{source}.jsonl").read_bytes()
    one = json.loads((first / "manifest.json").read_text(encoding="utf-8"))
    two = json.loads((second / "manifest.json").read_text(encoding="utf-8"))
    one.pop("exported_at"), two.pop("exported_at")
    assert one == two


# [utest->req~data-retirement-export-files~1]
def test_the_export_reads_only(database, tmp_path):
    folder = database.parent
    listing = sorted(path.name for path in folder.iterdir())
    digest = sha256_of(database)
    out = tmp_path / "elsewhere" / "m96"
    assert out.parent != folder
    assert export_run(sqlite_url(database), out).returncode == 0
    assert sha256_of(database) == digest
    assert sorted(path.name for path in folder.iterdir()) == listing


def test_url_forms_map_to_the_async_drivers():
    assert tool.async_url("sqlite:///x.db") == "sqlite+aiosqlite:///x.db"
    assert tool.async_url("sqlite+aiosqlite:///x.db") == "sqlite+aiosqlite:///x.db"
    assert tool.async_url("postgresql://u:p%40ss@h:5432/d") == "postgresql+asyncpg://u:p%40ss@h:5432/d"
    assert tool.async_url("postgresql+psycopg2://u:p@h/d") == "postgresql+asyncpg://u:p@h/d"
    assert tool.async_url("postgresql+asyncpg://u:p@h/d") == "postgresql+asyncpg://u:p@h/d"


# [utest->req~data-retirement-export-refusals~1]
def test_a_directory_that_holds_an_entry_is_refused_and_left_alone(database, tmp_path):
    out = tmp_path / "export"
    assert export_run(sqlite_url(database), out).returncode == 0
    snapshot = {path.name: path.read_bytes() for path in out.iterdir()}
    again = export_run(sqlite_url(database), out)
    assert again.returncode == 2 and again.stderr
    assert {path.name: path.read_bytes() for path in out.iterdir()} == snapshot
    stranger = tmp_path / "stranger"
    stranger.mkdir()
    (stranger / "notes.txt").write_text("keep", encoding="utf-8")
    assert export_run(sqlite_url(database), stranger).returncode == 2
    assert [path.name for path in stranger.iterdir()] == ["notes.txt"]


# [utest->req~data-retirement-export-refusals~1]
def test_a_migrated_database_is_refused_and_nothing_is_written(empty_template, tmp_path):
    database = copy_database(empty_template, tmp_path / "db")
    upgraded = alembic(sqlite_url(database), "upgrade", MIGRATION)
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
    existing = tmp_path / "empty-dir"
    existing.mkdir()
    missing = tmp_path / "missing-dir"
    for out in (existing, missing):
        result = export_run(sqlite_url(database), out)
        assert result.returncode == 2, result.stdout + result.stderr
        assert "revision" in result.stderr
    assert list(existing.iterdir()) == []
    assert not missing.exists()


# [utest->req~data-retirement-export-refusals~1]
def test_missing_database_configuration_or_file_is_refused(tmp_path):
    out = tmp_path / "export"
    assert export_run(None, out).returncode == 2
    assert export_run(sqlite_url(tmp_path / "nothing.db"), out).returncode == 2
    assert not out.exists() and not (tmp_path / "nothing.db").exists()

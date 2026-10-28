"""Export the data that Alembic revision e7f8a9b0c1d2 (M9.6) removes, before it is removed.

    python tools/export_retired_data.py --out DIR

Run it from ``openbinding-gateway/`` against a database that is still at revision ``b6c7d8e9f0a1``,
with ``DATABASE_URL`` set as for the other tools (sync and async URL forms are both accepted).
It writes one JSON Lines file per retired-data source and a ``manifest.json``; the migration refuses to
drop non-empty data unless ``OPENBINDING_M96_EXPORT_MANIFEST`` names that manifest and it still matches
the database (docs/runbooks/retired-data-export.md).

The tool reads the six source tables by name with raw SQL and SQLAlchemy Core reflection, never through
the ORM models, because the image that runs it no longer maps them. It reads everything in one
read-only transaction, so the six files are one consistent snapshot. It never writes to the database.

The selection SQL below is the same text as in the migration (``alembic/versions/e7f8a9b0c1d2_*``);
``tests/test_drop_retired_data_migration.py`` compares the two.

Exit status: 0 on success (the absolute path of ``manifest.json`` is printed), 2 on a refusal
(``--out`` holds an entry, the database is not at ``b6c7d8e9f0a1``, no ``DATABASE_URL``).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError, InvalidRequestError
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

ALEMBIC_HEAD = "b6c7d8e9f0a1"
FORMAT = "openbinding-m96-export/1"
MANIFEST = "manifest.json"
CHUNK = 500

SOURCES = (
    "analysis_tasks",
    "sponsor_proposals",
    "report_drafts",
    "report_artifact_drafts",
    "report_artifacts",
    "report_project_artifacts",
)
TABLES = {
    "analysis_tasks": "analysis_tasks",
    "sponsor_proposals": "sponsor_proposals",
    "report_drafts": "reports",
    "report_artifact_drafts": "artifact_drafts",
    "report_artifacts": "artifacts",
    "report_project_artifacts": "project_artifacts",
}
PRIMARY_KEYS = {
    "analysis_tasks": ("id",),
    "sponsor_proposals": ("id",),
    "report_drafts": ("id",),
    "report_artifact_drafts": ("id",),
    "report_artifacts": ("id",),
    "report_project_artifacts": ("project_id", "artifact_id"),
}

# [impl->req~data-retirement-export-selection~1]
# Draft reports that never produced a sealed version, a version of their artifact or a publication.
_REPORT_DRAFTS = (
    "SELECT rd.id FROM reports rd WHERE rd.state = 'draft' AND rd.version_id IS NULL "
    "AND NOT EXISTS (SELECT 1 FROM artifact_versions rdv WHERE rdv.artifact_id = rd.artifact_id) "
    "AND NOT EXISTS (SELECT 1 FROM publications rdp WHERE rdp.report_id = rd.id)"
)
_REPORT_ARTIFACT_DRAFTS = (
    "SELECT ad.id FROM artifact_drafts ad JOIN artifacts ada ON ada.id = ad.artifact_id "
    "WHERE ad.sealed_version_id IS NULL AND ada.kind = 'Report' "
    "AND NOT EXISTS (SELECT 1 FROM reports adr WHERE adr.draft_id = ad.id "
    "AND adr.id NOT IN (" + _REPORT_DRAFTS + "))"
)
_REPORT_ARTIFACTS = (
    "SELECT ra.id FROM artifacts ra WHERE ra.kind = 'Report' "
    "AND NOT EXISTS (SELECT 1 FROM artifact_versions rav WHERE rav.artifact_id = ra.id) "
    "AND NOT EXISTS (SELECT 1 FROM reports rar WHERE rar.artifact_id = ra.id "
    "AND rar.id NOT IN (" + _REPORT_DRAFTS + ")) "
    "AND NOT EXISTS (SELECT 1 FROM artifact_drafts rad WHERE rad.artifact_id = ra.id "
    "AND rad.id NOT IN (" + _REPORT_ARTIFACT_DRAFTS + "))"
)
SELECTIONS = {
    "analysis_tasks": "SELECT id FROM analysis_tasks",
    "sponsor_proposals": "SELECT id FROM sponsor_proposals",
    "report_drafts": _REPORT_DRAFTS,
    "report_artifact_drafts": _REPORT_ARTIFACT_DRAFTS,
    "report_artifacts": _REPORT_ARTIFACTS,
    "report_project_artifacts": (
        "SELECT pa.project_id, pa.artifact_id FROM project_artifacts pa WHERE pa.artifact_id IN ("
        + _REPORT_ARTIFACTS + ")"
    ),
}


class ExportRefused(Exception):
    """The tool will not run: nothing was written."""


def async_url(url: str) -> str:
    """The async form of a sync or async database URL, so one code path serves both."""
    parsed = make_url(url)
    drivers = {
        "sqlite": "sqlite+aiosqlite",
        "sqlite+pysqlite": "sqlite+aiosqlite",
        "postgresql": "postgresql+asyncpg",
        "postgres": "postgresql+asyncpg",
        "postgresql+psycopg2": "postgresql+asyncpg",
        "postgresql+psycopg": "postgresql+asyncpg",
        "postgresql+pg8000": "postgresql+asyncpg",
    }
    return parsed.set(drivername=drivers.get(parsed.drivername, parsed.drivername)).render_as_string(hide_password=False)


def normalise(value) -> str:
    """A key part as the lowercase hyphenated UUID text when it is a UUID (the SQLite form is 32 hex digits)."""
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, str):
        try:
            return str(uuid.UUID(value)) if len(value) in (32, 36) else value
        except ValueError:
            return value
    return str(value)


def _timestamp(value: datetime) -> str:
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc)
    # Timestamps are stored in UTC; SQLite hands them back without a zone.
    text = value.replace(tzinfo=None).isoformat(timespec="seconds" if value.microsecond == 0 else "microseconds")
    return text + "Z"


def _is_uuid(column_type) -> bool:
    return isinstance(column_type, sa.Uuid) or (isinstance(column_type, sa.CHAR) and column_type.length == 32)


def _jsonable(value, column_type):
    if value is None:
        return None
    if _is_uuid(column_type):
        return normalise(value)
    if isinstance(value, datetime):
        return _timestamp(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        raise ValueError("a binary column cannot be exported as JSON")
    return value


def _line(row, table: sa.Table) -> bytes:
    document = {column.name: _jsonable(row[column.name], column.type) for column in table.columns}
    return (json.dumps(document, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _chunks(values: list, size: int = CHUNK):
    for start in range(0, len(values), size):
        yield values[start : start + size]


def _collect(connection: sa.Connection) -> dict[str, list[bytes]]:
    """The lines of every source, from the connection's single read-only transaction."""
    try:
        head = connection.execute(sa.text("SELECT version_num FROM alembic_version")).scalars().all()
    except DBAPIError:
        raise ExportRefused("the database has no alembic_version table; it is not at revision " + ALEMBIC_HEAD) from None
    if head != [ALEMBIC_HEAD]:
        raise ExportRefused(
            f"the database is at revision {', '.join(head) or '(none)'}, the export needs {ALEMBIC_HEAD}: "
            "run it before the M9.6 upgrade, or the data is already gone"
        )
    metadata = sa.MetaData()
    try:
        metadata.reflect(connection, only=sorted(set(TABLES.values())))
    except InvalidRequestError as error:
        raise ExportRefused(f"the database at {ALEMBIC_HEAD} lacks a source table: {error}") from None
    result: dict[str, list[bytes]] = {}
    for source in SOURCES:
        table = metadata.tables[TABLES[source]]
        keys = [tuple(row) for row in connection.execute(sa.text(SELECTIONS[source])).all()]
        # The full rows, fetched by the raw key values the database itself returned.
        column = table.c[PRIMARY_KEYS[source][-1]]
        rows = []
        for chunk in _chunks(sorted({key[-1] for key in keys}, key=normalise)):
            rows.extend(connection.execute(sa.select(table).where(column.in_(chunk))).mappings().all())
        wanted = {tuple(normalise(part) for part in key) for key in keys}
        selected = [
            row for row in rows
            if tuple(normalise(row[name]) for name in PRIMARY_KEYS[source]) in wanted
        ]
        selected.sort(key=lambda row: tuple(normalise(row[name]) for name in PRIMARY_KEYS[source]))
        if len(selected) != len(wanted):
            raise RuntimeError(f"{source}: selected {len(wanted)} keys but read {len(selected)} rows")
        result[source] = [_line(row, table) for row in selected]
    return result


async def _snapshot(url: str) -> dict[str, list[bytes]]:
    engine = create_async_engine(async_url(url), poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            if connection.dialect.name == "postgresql":
                connection = await connection.execution_options(isolation_level="REPEATABLE READ", postgresql_readonly=True)
            elif connection.dialect.name == "sqlite":
                await connection.exec_driver_sql("PRAGMA query_only = ON")
                await connection.exec_driver_sql("BEGIN")
            try:
                return await connection.run_sync(_collect)
            finally:
                await connection.rollback()
    finally:
        await engine.dispose()


def _check_target(url: str, out: Path) -> None:
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise ExportRefused(f"{out} exists and is not an empty directory; choose a new --out directory")
    database = make_url(async_url(url))
    if database.get_backend_name() == "sqlite" and database.database not in (None, "", ":memory:"):
        if not Path(database.database).is_file():
            raise ExportRefused(f"the SQLite database {database.database} does not exist")


# [impl->req~data-retirement-export-files~1]
# [impl->req~data-retirement-export-manifest~1]
# [impl->req~data-retirement-export-refusals~1]
def export(url: str, out: Path, *, now: datetime | None = None) -> Path:
    """Write the six files and the manifest into ``out``; return the manifest's path."""
    out = out.resolve()
    _check_target(url, out)
    lines = asyncio.run(_snapshot(url))
    out.mkdir(parents=True, exist_ok=True)
    sources = {}
    for source in SOURCES:
        data = b"".join(lines[source])
        name = f"{source}.jsonl"
        (out / name).write_bytes(data)
        sources[source] = {"file": name, "rows": len(lines[source]), "sha256": hashlib.sha256(data).hexdigest()}
    manifest = {
        "format": FORMAT,
        "alembic_head": ALEMBIC_HEAD,
        "exported_at": _timestamp(now or datetime.now(timezone.utc)),
        "sources": sources,
    }
    path = out / MANIFEST
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export the data that the M9.6 migration removes.")
    parser.add_argument("--out", required=True, help="a new or empty directory for the export")
    parser.add_argument("--database-url", default=None, help="defaults to the DATABASE_URL environment variable")
    arguments = parser.parse_args(argv)
    url = arguments.database_url or os.environ.get("DATABASE_URL")
    if not url:
        print("error: set DATABASE_URL (or pass --database-url)", file=sys.stderr)
        return 2
    try:
        manifest = export(url, Path(arguments.out))
    except ExportRefused as refusal:
        print(f"error: {refusal}", file=sys.stderr)
        return 2
    print(manifest)
    return 0


if __name__ == "__main__":
    sys.exit(main())

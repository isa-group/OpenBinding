"""The schema is one generated Alembic revision equal to the models, with one source of triggers.

Decisions D1 and D2 of the F0b plan: ``tools/rebaseline.py`` writes the only revision from the models and from
``db/triggers.py``, and nothing else may drift from it. This module checks, on SQLite:

* there is one revision, with no parent, and it is the only head;
* ``alembic upgrade head`` builds exactly the models (``compare_metadata`` with types) and the trigger set that
  ``create_all`` builds, statement for statement;
* the generator still reproduces the committed file (``rebaseline.py --check``);
* ``register_triggers`` refuses a trigger on a table or column the metadata lacks;
* the partial indexes keep their ``WHERE``; ``downgrade base`` leaves only ``alembic_version``;
* ``alembic/env.py`` refuses a database stamped with a revision this checkout does not have;
* no retired table comes back (``RETIRED_TABLES``, grown by each block that drops one).

``test_schema_baseline_pg.py`` checks the same parity on PostgreSQL.
"""

from __future__ import annotations

import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Column, Integer, MetaData, String, Table, create_engine

from _paths import GATEWAY_ROOT
from openbinding_gateway.db import models  # noqa: F401  (every table and the triggers)
from openbinding_gateway.db.base import Base
from openbinding_gateway.db.triggers import TRIGGERS, protect, register_triggers, render

#: Tables that features removed before or during F0b used to own. None may be modelled or migrated again.
RETIRED_TABLES = frozenset({
    # Before F0b (M9.6 and the pricing and federation work).
    "analysis_tasks",
    "federated_engines",
    "pricing_releases",
    "sponsor_proposals",
    # F0b B1: the leftovers of the features F0a removed.
    "artifact_evidence",
    "collection_items",
    "collection_revisions",
    "collections",
    "publications",
    "reports",
    "v1_dialect_revisions",
    "v1_registered_resource_revisions",
    # F0b B5: problems hang off the organization; snapshots fused into revisions and compilations.
    "case_artifacts",
    "v1_binding_ir",
    "v1_instance_resources",
    "v1_instance_snapshots",
    # F0b B6: runs move under the organization; the write-only run provenance copy goes (D28).
    "v1_job_provenance",
})

VERSIONS = GATEWAY_ROOT / "alembic" / "versions"


def alembic(database: Path, *arguments: str) -> subprocess.CompletedProcess:
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    return subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", *arguments],
        cwd=GATEWAY_ROOT, env=environment, capture_output=True, text=True, check=False,
    )


def run(database: Path, *arguments: str) -> None:
    done = alembic(database, *arguments)
    assert done.returncode == 0, done.stdout + done.stderr


@pytest.fixture(scope="module")
def migrated(tmp_path_factory) -> Path:
    database = tmp_path_factory.mktemp("baseline") / "migrated.db"
    run(database, "upgrade", "head")
    return database


@pytest.fixture(scope="module")
def created(tmp_path_factory) -> Path:
    database = tmp_path_factory.mktemp("create_all") / "created.db"
    engine = create_engine(f"sqlite:///{database}")
    try:
        Base.metadata.create_all(engine)
    finally:
        engine.dispose()
    return database


def normalised(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def triggers_of(database: Path) -> set[tuple[str, str, str]]:
    with sqlite3.connect(database) as connection:
        rows = connection.execute("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'")
        return {(name, table, normalised(sql)) for name, table, sql in rows}


def tables_of(database: Path) -> set[str]:
    with sqlite3.connect(database) as connection:
        rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        return {name for (name,) in rows}


def index_sql(database: Path, name: str) -> str:
    with sqlite3.connect(database) as connection:
        row = connection.execute("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", (name,)).fetchone()
    assert row is not None, f"index {name} is missing"
    return normalised(row[0])


def test_there_is_one_revision_and_it_is_the_baseline():
    config = Config()
    config.set_main_option("script_location", str(GATEWAY_ROOT / "alembic"))
    script = ScriptDirectory.from_config(config)

    revisions = list(script.walk_revisions())
    files = sorted(path.name for path in VERSIONS.glob("*.py"))

    assert len(revisions) == 1 and revisions[0].down_revision is None
    assert script.get_heads() == [revisions[0].revision]
    assert files == [f"{revisions[0].revision}_baseline.py"]


def test_the_generator_reproduces_the_committed_baseline():
    done = subprocess.run(
        [sys.executable, "tools/rebaseline.py", "--check"],
        cwd=GATEWAY_ROOT, capture_output=True, text=True, check=False,
    )

    assert done.returncode == 0, done.stdout + done.stderr


def test_upgrade_head_builds_exactly_the_models(migrated):
    engine = create_engine(f"sqlite:///{migrated}")
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(connection, opts={"compare_type": True})
            differences = compare_metadata(context, Base.metadata)
    finally:
        engine.dispose()

    assert differences == []
    assert tables_of(migrated) == set(Base.metadata.tables) | {"alembic_version"}


def test_the_migrated_triggers_are_the_create_all_triggers(migrated, created):
    expected = {(trigger.name, trigger.table, normalised(trigger.sqlite_sql)) for trigger in TRIGGERS}

    assert triggers_of(created) == expected
    assert triggers_of(migrated) == expected
    assert len(render("sqlite")) == len(TRIGGERS) and len(render("postgresql")) == 2 * len(TRIGGERS)


def test_a_trigger_on_a_table_the_metadata_lacks_is_refused():
    metadata = MetaData()
    Table("jobs", metadata, Column("id", Integer, primary_key=True), Column("configuration_version_id", Integer))

    with pytest.raises(ValueError, match="artifact_versions"):
        register_triggers(metadata)


def test_a_trigger_on_a_column_the_table_lacks_is_refused():
    metadata = MetaData()
    Table("jobs", metadata, Column("id", Integer, primary_key=True), Column("state", String(16)))

    with pytest.raises(ValueError, match="configuration_version_id"):
        register_triggers(metadata, (protect("jobs", ("configuration_version_id",)),))


def test_the_partial_indexes_keep_their_where(migrated, created):
    for database in (migrated, created):
        assert index_sql(database, "uq_jobs_study_cell_id").endswith("WHERE study_cell_id IS NOT NULL")
        assert index_sql(database, "uq_artifact_identity").endswith("WHERE archived = 0")


def test_the_downgrade_leaves_only_the_version_table(tmp_path):
    database = tmp_path / "round-trip.db"
    run(database, "upgrade", "head")

    run(database, "downgrade", "base")

    assert tables_of(database) == {"alembic_version"}
    assert triggers_of(database) == set()


def test_a_database_from_an_older_baseline_is_refused_with_the_reset_recipe(tmp_path):
    database = tmp_path / "stale.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)")
        connection.execute("INSERT INTO alembic_version VALUES ('0123456789ab')")
        connection.execute("CREATE TABLE reports (id INTEGER PRIMARY KEY)")

    done = alembic(database, "upgrade", "head")

    assert done.returncode != 0
    assert "Rebuild the local development database" in done.stderr
    assert tables_of(database) == {"alembic_version", "reports"}, "nothing is dropped or created automatically"


def test_no_retired_table_is_modelled_or_migrated(migrated):
    assert not RETIRED_TABLES & set(Base.metadata.tables)
    assert not RETIRED_TABLES & tables_of(migrated)

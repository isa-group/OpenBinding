"""The migration that drops the job columns only consumption accounting used."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

from _paths import GATEWAY_ROOT

ROOT = GATEWAY_ROOT
PREVIOUS_REVISION = "b4c5d6e7f8a9"
THIS_REVISION = "c8d9e0f1a2b3"
RETIRED_COLUMNS = {"metered", "concurrency_released", "billing_sponsor_user_id"}
RETIRED_INDEX = "ix_jobs_billing_sponsor_user_id"


def alembic(database: Path, *arguments: str) -> None:
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    done = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", *arguments],
        cwd=ROOT, env=environment, capture_output=True, text=True, check=False,
    )
    assert done.returncode == 0, done.stdout + done.stderr


def job_columns(database: Path) -> set[str]:
    with sqlite3.connect(database) as connection:
        return {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}


def job_objects(database: Path, kind: str) -> dict[str, str]:
    with sqlite3.connect(database) as connection:
        rows = connection.execute(
            "SELECT name, sql FROM sqlite_master WHERE type = ? AND tbl_name = 'jobs' AND sql IS NOT NULL", (kind,)
        )
        return dict(rows.fetchall())


def test_this_revision_sits_on_the_previous_one_in_a_single_chain():
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "alembic"))
    scripts = ScriptDirectory.from_config(config)

    # Later migrations move the head; this one only has to stay in the chain.
    assert len(scripts.get_heads()) == 1
    history = {script.revision for script in scripts.walk_revisions()}
    assert THIS_REVISION in history
    assert scripts.get_revision(THIS_REVISION).down_revision == PREVIOUS_REVISION


def test_the_retired_columns_go_and_the_rows_triggers_and_indexes_stay(tmp_path):
    database = tmp_path / "retire.db"
    alembic(database, "upgrade", PREVIOUS_REVISION)
    assert RETIRED_COLUMNS <= job_columns(database)
    triggers = job_objects(database, "trigger")
    indexes = job_objects(database, "index")
    assert {"protect_jobs", "pin_job_configuration"} <= set(triggers)
    assert RETIRED_INDEX in indexes
    job_id = uuid.uuid4().hex
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO jobs (id, engine_id, engine_job_id, service_url, state, verbose, metered, concurrency_released)"
            " VALUES (?, 'random-search', 'engine-1', 'http://engine', 'queued', 0, 1, 1)",
            (job_id,),
        )

    alembic(database, "upgrade", "head")

    assert not RETIRED_COLUMNS & job_columns(database)
    assert job_objects(database, "trigger") == triggers
    upgraded = job_objects(database, "index")
    assert RETIRED_INDEX not in upgraded
    assert {name for name in indexes if name != RETIRED_INDEX} <= set(upgraded)
    assert "WHERE" in upgraded["uq_jobs_study_cell_id"].upper()  # still the partial unique index
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT id, state FROM jobs").fetchall() == [(job_id, "queued")]

    alembic(database, "downgrade", PREVIOUS_REVISION)

    assert RETIRED_COLUMNS <= job_columns(database)
    assert job_objects(database, "trigger") == triggers
    assert RETIRED_INDEX in job_objects(database, "index")
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT id, metered, concurrency_released FROM jobs").fetchall() == [(job_id, 0, 0)]

    alembic(database, "upgrade", "head")
    assert not RETIRED_COLUMNS & job_columns(database)

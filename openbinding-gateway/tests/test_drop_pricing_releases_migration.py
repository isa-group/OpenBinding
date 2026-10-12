"""The local pricing release registry is dropped by migration, and brought back empty by its downgrade."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

ROOT = Path(__file__).parents[1]
PREVIOUS_REVISION = "c8d9e0f1a2b3"
THIS_REVISION = "d9e0f1a2b3c4"


def alembic(database: Path, *arguments: str) -> None:
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    done = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", *arguments],
        cwd=ROOT, env=environment, capture_output=True, text=True, check=False,
    )
    assert done.returncode == 0, done.stdout + done.stderr


def tables(database: Path) -> set[str]:
    with sqlite3.connect(database) as connection:
        return {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def indexes(database: Path) -> set[str]:
    with sqlite3.connect(database) as connection:
        return {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pricing_releases'"
            )
        }


def test_this_revision_sits_on_the_previous_head_in_a_single_chain():
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "alembic"))
    scripts = ScriptDirectory.from_config(config)

    # Later migrations move the head; this one only has to stay in the chain.
    assert len(scripts.get_heads()) == 1
    assert THIS_REVISION in {script.revision for script in scripts.walk_revisions()}
    assert scripts.get_revision(THIS_REVISION).down_revision == PREVIOUS_REVISION


def test_the_table_is_dropped_and_the_downgrade_recreates_it_empty(tmp_path):
    database = tmp_path / "pricing-releases.db"

    alembic(database, "upgrade", PREVIOUS_REVISION)
    assert "pricing_releases" in tables(database)

    alembic(database, "upgrade", "head")
    assert "pricing_releases" not in tables(database)

    alembic(database, "downgrade", PREVIOUS_REVISION)
    assert "pricing_releases" in tables(database)
    assert {
        "ix_pricing_releases_digest",
        "ix_pricing_releases_is_live",
        "ix_pricing_releases_version",
    } <= indexes(database)
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM pricing_releases").fetchone() == (0,)

    alembic(database, "upgrade", "head")
    assert "pricing_releases" not in tables(database)

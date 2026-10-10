"""B3: the sponsor_proposals table arrives through the migration chain, from scratch."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.schema import CreateTable

from openbinding_gateway.db.base import Base
from openbinding_gateway.db.models import SponsorProposal  # noqa: F401  (registers the table)

ROOT = Path(__file__).parents[1]
PREVIOUS_HEAD = "c0d1e2f3a4b5"
THIS_REVISION = "d1e2f3a4b5c6"


def alembic(database: Path, *arguments: str) -> subprocess.CompletedProcess:
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    return subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", *arguments],
        cwd=ROOT, env=environment, capture_output=True, text=True, check=False,
    )


def columns(database: Path, table: str) -> dict[str, tuple]:
    with sqlite3.connect(database) as connection:
        return {row[1]: row for row in connection.execute(f"PRAGMA table_info({table})")}


def insert(connection, organization_id: str, status: str) -> None:
    connection.execute(
        "INSERT INTO sponsor_proposals (id, organization_id, status, expires_at) VALUES (?, ?, ?, '2030-01-01')",
        (uuid.uuid4().hex, organization_id, status),
    )


def test_the_migration_creates_the_table_from_scratch_and_is_reversible(tmp_path):
    database = tmp_path / "b3.db"

    upgraded = alembic(database, "upgrade", "head")
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
    heads = alembic(database, "heads")
    assert heads.returncode == 0 and THIS_REVISION in heads.stdout
    assert heads.stdout.count("(head)") == 1, "the migration chain must have a single head"

    table = columns(database, "sponsor_proposals")
    assert {
        "id", "organization_id", "proposed_user_id", "proposed_by_user_id", "status",
        "created_at", "expires_at", "decided_at", "decided_by_user_id", "decision_reason",
    } == set(table)
    assert table["expires_at"][3] == 1  # NOT NULL
    assert table["status"][3] == 1

    organization = uuid.uuid4().hex
    with sqlite3.connect(database) as connection:
        insert(connection, organization, "pending")
        # Resolved proposals pile up freely; a second *pending* one cannot exist.
        insert(connection, organization, "accepted")
        insert(connection, organization, "expired")
        insert(connection, uuid.uuid4().hex, "pending")  # another organization
        with pytest.raises(sqlite3.IntegrityError):
            insert(connection, organization, "pending")

    downgraded = alembic(database, "downgrade", PREVIOUS_HEAD)
    assert downgraded.returncode == 0, downgraded.stdout + downgraded.stderr
    assert columns(database, "sponsor_proposals") == {}
    again = alembic(database, "upgrade", "head")
    assert again.returncode == 0, again.stdout + again.stderr
    assert "status" in columns(database, "sponsor_proposals")


def test_the_model_and_the_migration_describe_the_same_table():
    """The ORM metadata (used by create_all in tests) matches what the migration builds."""
    table = Base.metadata.tables["sponsor_proposals"]
    assert {column.name for column in table.columns} == {
        "id", "organization_id", "proposed_user_id", "proposed_by_user_id", "status",
        "created_at", "expires_at", "decided_at", "decided_by_user_id", "decision_reason",
    }
    pending = [index for index in table.indexes if index.name == "uq_sponsor_proposal_pending"]
    assert len(pending) == 1 and pending[0].unique
    assert [column.name for column in pending[0].columns] == ["organization_id"]
    ddl = str(CreateTable(table).compile(create_engine("sqlite://")))
    assert "sponsor_proposals" in ddl

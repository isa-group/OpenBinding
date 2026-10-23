"""Two independent database sessions, for tests about concurrent access.

Row locks and SKIP LOCKED only mean something on PostgreSQL, so the fixture
skips when ``TEST_DATABASE_URL`` is not defined rather than pretending SQLite
exercised them. When it *is* defined it must name a throwaway PostgreSQL
database whose name starts with ``test``; anything else fails the test, because
the fixture truncates every table it finds.

The schema comes from the Alembic migrations (``upgrade head``), not from
``create_all``, so the partial unique indexes the tests rely on are the ones a
deployment actually gets. Between tests the data is truncated; the schema stays.
"""

from __future__ import annotations

import os

import pytest
import pytest_asyncio
from _paths import GATEWAY_ROOT
from sqlalchemy.engine import make_url


def check_test_database_url(url: str) -> None:
    """Raise ValueError unless ``url`` is a PostgreSQL URL for a database named ``test*``."""
    try:
        parsed = make_url(url)
    except Exception as error:  # noqa: BLE001 - any parse failure is a refusal
        raise ValueError(f"TEST_DATABASE_URL is not a valid database URL: {error}") from None
    if not parsed.drivername.startswith("postgresql"):
        raise ValueError(
            f"TEST_DATABASE_URL must be a PostgreSQL URL, not {parsed.drivername!r}: "
            "row locks and SKIP LOCKED are not exercised by other dialects"
        )
    if not (parsed.database or "").startswith("test"):
        raise ValueError(
            f"TEST_DATABASE_URL database name {parsed.database!r} must start with 'test': "
            "the fixture truncates every table"
        )


def require_test_database_url() -> str:
    """The validated URL; skip if TEST_DATABASE_URL is unset, fail if it is set but unusable."""
    url = os.environ.get("TEST_DATABASE_URL")
    if url is None:
        pytest.skip("requires PostgreSQL: set TEST_DATABASE_URL (see docs/qa/PG_HARNESS.md)")
    try:
        check_test_database_url(url)
    except ValueError as error:
        pytest.fail(str(error), pytrace=False)
    return url


def _upgrade_to_head(sync_connection) -> None:
    from alembic import command
    from alembic.config import Config

    # No ini file on purpose: env.py would call fileConfig() and reconfigure
    # the logging of the whole test process.
    config = Config()
    config.set_main_option("script_location", str(GATEWAY_ROOT / "alembic"))
    config.attributes["connection"] = sync_connection
    command.upgrade(config, "head")


async def _truncate_all(connection) -> None:
    from sqlalchemy import text

    rows = await connection.execute(
        text("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'alembic_version'")
    )
    tables = sorted(row[0] for row in rows)
    if tables:
        quoted = ", ".join('"' + name.replace('"', '""') + '"' for name in tables)
        await connection.execute(text(f"TRUNCATE TABLE {quoted} RESTART IDENTITY CASCADE"))


@pytest_asyncio.fixture
async def two_sessions():
    """Two AsyncSessions on two distinct connections to the same database."""
    url = require_test_database_url()

    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(url)
    async with engine.begin() as connection:
        await connection.run_sync(_upgrade_to_head)
        await _truncate_all(connection)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    first = factory()
    second = factory()
    try:
        yield first, second
    finally:
        await first.close()
        await second.close()
        await engine.dispose()

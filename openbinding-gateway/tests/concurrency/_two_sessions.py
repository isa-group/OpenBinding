"""Two independent database sessions, for tests about concurrent access.

Row locks and SKIP LOCKED only mean something on PostgreSQL, so the fixture
skips anywhere else rather than pretending SQLite exercised them.
"""

from __future__ import annotations

import os

import pytest
import pytest_asyncio


@pytest_asyncio.fixture
async def two_sessions():
    """Two AsyncSessions on two distinct connections to the same database."""
    url = os.environ.get("TEST_DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.skip("requires PostgreSQL: row locks and SKIP LOCKED are not exercised by SQLite")

    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from openbinding_gateway.db.base import Base

    engine = create_async_engine(url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    first = factory()
    second = factory()
    try:
        yield first, second
    finally:
        await first.close()
        await second.close()
        await engine.dispose()

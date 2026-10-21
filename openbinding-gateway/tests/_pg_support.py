"""Support for the PostgreSQL tests that sit beside the ordinary suite (``tests/test_*_pg.py``).

``tests/concurrency`` has the ``two_sessions`` fixture; these tests need more than two sessions, a way to see
that one session is really waiting for another's lock, and the HTTP application wired to the same server, so
they share this module (and the ``pg`` fixture of ``conftest.py``) instead of growing that directory's fixture.

The rules are those of ``tests/concurrency/_two_sessions.py`` and ``docs/qa/PG_HARNESS.md``:

* no ``TEST_DATABASE_URL``: the ``pg`` fixture skips, which is the *only* reason a ``*_pg.py`` test may skip;
* the URL must name a PostgreSQL database called ``test*`` or the test fails (the fixture truncates every table);
* the schema is the Alembic ``upgrade head`` one, not ``create_all``; data is truncated before each test, so a
  test never depends on another or on the order they run in. The ordinary ``db_session`` fixture must not be
  pointed at this URL (it drops and recreates the schema).
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from concurrency._two_sessions import _truncate_all, _upgrade_to_head, require_test_database_url

#: How long a test waits for a lock wait, or for a whole race, before it fails with a message of its own.
WAIT_SECONDS = 20.0
POLL_SECONDS = 0.02
# Bound now: a test that replaces ``asyncio.sleep`` for the code under test must not slow or stop the polling.
_sleep = asyncio.sleep


@dataclass
class PgDatabase:
    """A migrated, empty PostgreSQL database and the means to open independent sessions on it."""

    engine: AsyncEngine
    factory: async_sessionmaker[AsyncSession]

    def session(self) -> AsyncSession:
        """A new session, which takes its own connection from the pool when it first needs one."""
        return self.factory()

    async def backend_pid(self, session: AsyncSession) -> int:
        """The server process behind ``session``'s connection (its transaction starts here, and stays on it)."""
        return int(await session.scalar(text("SELECT pg_backend_pid()")))

    async def wait_until_blocked(self, pid: int, *, seconds: float = WAIT_SECONDS) -> None:
        """Return once backend ``pid`` is waiting for a lock another transaction holds, seen from a third connection.

        This is what makes "the second session waited for the first" an observation and not an assumption: a
        statement that never blocks never shows ``wait_event_type = 'Lock'``.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + seconds
        async with self.engine.connect() as probe:
            while True:
                waiting = await probe.scalar(
                    text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid"), {"pid": pid}
                )
                if waiting == "Lock":
                    return
                if loop.time() >= deadline:
                    raise AssertionError(f"backend {pid} was never seen waiting for a lock within {seconds:g} s")
                await probe.rollback()  # a fresh snapshot of pg_stat_activity on the next poll
                await _sleep(POLL_SECONDS)


@contextlib.asynccontextmanager
async def database() -> AsyncIterator[PgDatabase]:
    """The migrated, truncated test database; skips when ``TEST_DATABASE_URL`` is not defined."""
    url = require_test_database_url()
    engine = create_async_engine(url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to_head)
            await _truncate_all(connection)
        yield PgDatabase(engine, async_sessionmaker(engine, expire_on_commit=False))
    finally:
        await engine.dispose()


async def settle(*awaitables: Awaitable[Any], seconds: float = WAIT_SECONDS) -> list[Any]:
    """Run the awaitables at once; each result is its value or the exception it raised. Fails if they hang."""
    return list(
        await asyncio.wait_for(asyncio.gather(*awaitables, return_exceptions=True), seconds)
    )


async def pause(seconds: float) -> None:
    await _sleep(seconds)


@contextlib.asynccontextmanager
async def http_client(pg: PgDatabase) -> AsyncIterator[Any]:
    """The gateway over HTTP with one session per request, committed or rolled back with it, as ``get_session`` does."""
    from httpx import ASGITransport, AsyncClient

    from openbinding_gateway.access.dependencies import optional_session, session_dependency
    from openbinding_gateway.main import app

    async def one_session_per_request():
        async with pg.session() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[session_dependency] = one_session_per_request
    app.dependency_overrides[optional_session] = one_session_per_request
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://gateway") as client:
            yield client
    finally:
        app.dependency_overrides.clear()

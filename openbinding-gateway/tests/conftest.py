"""Shared setup for the gateway unit tests.

Every test needs the gateway to find the repository's schemas, and several
need the same small placement instance. Both used to be repeated per module -
the schema bootstrap in five files, and the instance through a sys.path hack
that imported a helper out of another test module.
"""

from __future__ import annotations

import os
import sys
import uuid

import pytest
import pytest_asyncio

REPO_ROOT = os.environ.get(
    "OPENBINDING_REPO_ROOT",
    os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")),
)
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

# Set before anything imports the gateway: schema paths are resolved when the
# validators are constructed.
os.environ.setdefault(
    "GENERAL_SCHEMA_PATH", os.path.join(REPO_ROOT, "schemas", "general", "schema.json")
)
os.environ.setdefault("SCHEMAS_DIR", os.path.join(REPO_ROOT, "schemas"))
# The accounts tests sign real tokens, so they need a real secret. It has no
# bearing on any deployment: this one only ever signs tokens for the suite.
os.environ.setdefault("GATEWAY_JWT_SECRET", "test-secret-not-used-anywhere-real")


@pytest.fixture
def micro_placement_instance():
    """The shared placement instance, for tests that prefer injection."""
    from _fixtures import micro_instance

    return micro_instance()


@pytest.fixture(autouse=True)
def pricing_catalog_gate():
    """Every test gets an explicit catalog-backed SPACE substitute."""
    from _pricing import fake_pricing_gate
    from openbinding_gateway import space_client

    space_client.set_gate(fake_pricing_gate())
    yield
    space_client.set_gate(None)


@pytest_asyncio.fixture
async def db_session():
    """A session against a database that exists only for this test.

    SQLite in memory by default rather than a Postgres container: the models
    are kept portable on purpose, the suite stays runnable with nothing
    installed, and CI does not grow a service just to check that a password
    hash round-trips.

    Portable is a claim, though, and deployments run Postgres. Point
    ``TEST_DATABASE_URL`` at one to run this same suite against it - which is
    how the claim gets checked rather than assumed.
    """
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from openbinding_gateway.db.base import Base

    url = os.environ.get("TEST_DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    engine = create_async_engine(url)
    async with engine.begin() as connection:
        # A shared server keeps whatever the last test left behind; an
        # in-memory database never has anything to drop.
        await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session

    await engine.dispose()


@pytest_asyncio.fixture
async def api_client(db_session):
    """The gateway over HTTP, wired to the throwaway database.

    The suite had no HTTP-level tests before the accounts module: everything
    called the pipeline directly, because there was nothing about a request
    worth asserting on. Authentication is the opposite - status codes, headers
    and who gets refused are the whole subject - so these go through the app.
    """
    from httpx import ASGITransport, AsyncClient

    from openbinding_gateway.access.dependencies import optional_session, session_dependency
    from openbinding_gateway.main import app

    async def _session_override():
        yield db_session

    # Both, and for a reason worth remembering: `optional_session` decides
    # whether this deployment has accounts at all, and answers by asking the
    # real engine registry. Left un-overridden it reports "no database", every
    # request arrives anonymous, and the tests quietly stop testing anything.
    app.dependency_overrides[session_dependency] = _session_override
    app.dependency_overrides[optional_session] = _session_override
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://gateway") as client:
        yield client
    app.dependency_overrides.clear()


@pytest.fixture
def registration():
    """Details for an account nobody else in the suite will collide with."""

    def _make(**overrides):
        unique = uuid.uuid4().hex[:8]
        return {
            "username": f"user{unique}",
            "email": f"user{unique}@example.org",
            "password": "correct-horse-battery",
            **overrides,
        }

    return _make

"""Shared setup for the gateway unit tests.

Every test needs the gateway to find the repository's schemas, and several
need the same small placement instance. Both used to be repeated per module -
the schema bootstrap in five files, and the instance through a sys.path hack
that imported a helper out of another test module.
"""

from __future__ import annotations

import os
import re
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

# The administrator configuration of the environment the suite runs in (the CI
# job generates one per run for the integration tests). Unit tests must never
# see it: they build their own settings. Only ``bootstrap_admin_credentials``
# hands it out, and only to integration tests. Captured before the environment
# is cleaned below.
_ADMIN_ENVIRONMENT = (
    "BOOTSTRAP_ADMIN_USERNAME",
    "BOOTSTRAP_ADMIN_PASSWORD",
    "BOOTSTRAP_ADMIN_EMAIL",
    "SEED_DEFAULT_ADMIN",
)
_CAPTURED_ADMIN_ENVIRONMENT = {
    name: os.environ[name] for name in _ADMIN_ENVIRONMENT if name in os.environ
}

# Hermetic environment: the gateway container (and a developer's shell) carries
# the deployment's own configuration, and a value that is already set would win
# over the suite's. Everything ``Settings`` reads is removed before the gateway
# is imported, then only the values the suite itself needs are set below.
# ``TEST_DATABASE_URL`` is not a setting of the gateway and is left alone.
from openbinding_gateway.core.settings import Settings  # noqa: E402  (reads field names; builds no settings)

assert Settings.model_config["case_sensitive"] is False and not Settings.model_config.get("env_prefix")
_DEPLOYMENT_VARIABLES = {name.upper() for name in Settings.model_fields}
_DEPLOYMENT_VARIABLES.update(_ADMIN_ENVIRONMENT)
# Read outside ``Settings``: the per-engine endpoints (``Settings.engine_urls``), the built-in cancellation
# switch and the BIM package limits (``BIM_MAX_*``).
_OTHER_DEPLOYMENT_VARIABLE = re.compile(r"ENGINE_[A-Z0-9_]+_URL|ENGINE_CANCELLATION_BUILTIN|BIM_MAX_[A-Z0-9_]+")
for _name in list(os.environ):
    if _name.upper() in _DEPLOYMENT_VARIABLES or _OTHER_DEPLOYMENT_VARIABLE.fullmatch(_name.upper()):
        del os.environ[_name]

# Set before anything imports the gateway: schema paths are resolved when the
# validators are constructed.
#
# The schemas sit in the repository's ``schemas`` directory in a checkout and in the gateway project's own
# ``schemas`` directory in the container image (``/app/schemas``): the first that holds the BIM v1 schemas wins.
_GATEWAY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SCHEMAS_ROOT = next(
    (
        root
        for root in (REPO_ROOT, _GATEWAY_DIR)
        if os.path.isdir(os.path.join(root, "schemas", "bim", "v1"))
    ),
    REPO_ROOT,
)
os.environ["GENERAL_SCHEMA_PATH"] = os.path.join(_SCHEMAS_ROOT, "schemas", "general", "schema.json")
os.environ["SCHEMAS_DIR"] = os.path.join(_SCHEMAS_ROOT, "schemas")
# The accounts tests sign real tokens, so they need a real secret. It has no
# bearing on any deployment: this one only ever signs tokens for the suite.
os.environ["GATEWAY_JWT_SECRET"] = "test-secret-not-used-anywhere-real"
# Jobs run in the request that creates them; there is no worker to claim a queued one.
os.environ["JOB_DISPATCH_MODE"] = "inline"
os.environ["SPHERE_ENABLED"] = "false"
# The fake gate installed below is built from tests/fixtures/pricing_test.yml
# (version 0.1.0, default plan BASIC); the gateway names that version and plan
# when it creates contracts.
os.environ["SPACE_PRICING_VERSION"] = "0.1.0"
os.environ["SPACE_DEFAULT_PLAN"] = "BASIC"
# The suite always uses the toolchain installed beside the gateway: a ``BIM_MODE=http`` left in the environment
# would point every test at a service that is not there.
os.environ["BIM_MODE"] = "inproc"


@pytest.fixture(scope="session", autouse=True)
def cheap_password_hashing():
    """Argon2 at its cheapest cost.

    Registering and signing in an account hashes and verifies a password twice, and the API tests do it for every
    account of every test (about 100 ms with the production parameters), which was most of the time of the
    suite. The hash format carries its parameters, so a hash made here still verifies anywhere and a hash made
    with the production parameters still verifies here; only the cost of making one changes.
    """
    from argon2 import PasswordHasher

    from openbinding_gateway.security import passwords

    production = passwords._hasher
    passwords._hasher = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)
    yield
    passwords._hasher = production


@pytest.fixture
def micro_placement_instance():
    """The shared placement instance, for tests that prefer injection."""
    from _fixtures import micro_instance

    return micro_instance()


@pytest.fixture(autouse=True)
def clean_mock_env(monkeypatch):
    monkeypatch.setenv("SPHERE_ENABLED", "false")
    monkeypatch.delenv("SPHERE_ORGANIZATION_ID", raising=False)
    for name in _ADMIN_ENVIRONMENT:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def bootstrap_admin_credentials(request):
    """``(username, password)`` of the administrator the running stack was started with.

    For the integration tests only: they sign in to a real gateway whose
    administrator comes from ``BOOTSTRAP_ADMIN_USERNAME`` / ``BOOTSTRAP_ADMIN_PASSWORD``.
    Nothing is assumed about them - there is no default account.
    """
    if request.node.get_closest_marker("integration") is None:
        pytest.fail(
            "bootstrap_admin_credentials is only for tests marked @pytest.mark.integration; "
            "unit tests create their own accounts and never see the environment's."
        )
    username = _CAPTURED_ADMIN_ENVIRONMENT.get("BOOTSTRAP_ADMIN_USERNAME", "")
    password = _CAPTURED_ADMIN_ENVIRONMENT.get("BOOTSTRAP_ADMIN_PASSWORD", "")
    if not username or not password:
        pytest.fail(
            "The integration tests sign in as the bootstrap administrator, so "
            "BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD must be set in the "
            "environment pytest runs in (the CI job writes them to .env and passes them "
            "to the container). Missing: "
            + ", ".join(
                name
                for name, value in (
                    ("BOOTSTRAP_ADMIN_USERNAME", username),
                    ("BOOTSTRAP_ADMIN_PASSWORD", password),
                )
                if not value
            )
        )
    return username, password


@pytest.fixture(autouse=True)
def isolated_auth_rate_limiter():
    """Authentication throttling counted in this test's own memory.

    The default limiter talks to Redis, which the unit suite never has, and a
    counter shared between tests would make a test depend on how many logins
    ran before it. ``tests/test_security_hardening.py`` installs its own.
    """
    from openbinding_gateway.core.ratelimit import AuthRateLimiter, set_auth_limiter

    set_auth_limiter(AuthRateLimiter(primary=None))
    yield
    set_auth_limiter(None)


@pytest.fixture(autouse=True)
def fresh_bim_port():
    """Each test builds the BIM port its settings ask for (in process by default) and leaves none behind."""
    from openbinding_gateway.integrations import bim

    bim.set_bim(None)
    yield
    bim.set_bim(None)


@pytest.fixture(autouse=True)
def pricing_catalog_gate():
    """Every test gets a SPACE substitute built from the synthetic pricing fixture."""
    from _pricing import fake_pricing_gate
    from openbinding_gateway import space_client

    space_client.set_gate(fake_pricing_gate())
    yield
    space_client.set_gate(None)


@pytest_asyncio.fixture
async def db_session(tmp_path, monkeypatch):
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

    from openbinding_gateway.core.settings import get_settings
    monkeypatch.setattr(get_settings(), "artifact_root", str(tmp_path / "blobs"))
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
async def pg():
    """A migrated, empty PostgreSQL 16 database for the ``tests/test_*_pg.py`` modules, and sessions on it.

    Unlike ``db_session`` this one never touches SQLite: without ``TEST_DATABASE_URL`` it skips, with one that
    is not a PostgreSQL ``test*`` database it fails (see ``tests/_pg_support.py`` and docs/qa/PG_REAL_RUN.md).
    ``db_session`` stays what it was; do not point it at that URL.
    """
    import _pg_support

    async with _pg_support.database() as database:
        yield database


@pytest.fixture(autouse=True)
def _pg_test_watchdog(request):
    """The ``tests/test_*_pg.py`` modules get the per-test limit that ``tests/concurrency`` has.

    A race test that waits for a lock that never comes would otherwise run until the harness times out and
    loses its output (docs/qa/PG_HARNESS.md). Every other test, and the ones under ``tests/concurrency``
    (which arm their own), are untouched.
    """
    path = request.node.path
    if not path.name.endswith("_pg.py") or path.parent.name == "concurrency":
        yield
        return
    from concurrency._watchdog import timeout_seconds, watchdog

    with watchdog(timeout_seconds()):
        yield


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

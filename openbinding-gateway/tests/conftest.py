"""Shared setup for the gateway unit tests.

Every test needs the gateway to find the repository's schemas, and several
need the same small placement instance. Both used to be repeated per module -
the schema bootstrap in five files, and the instance through a sys.path hack
that imported a helper out of another test module.
"""

from __future__ import annotations

import importlib.util
import os
import re
import sys
import types
import uuid

import pytest

# A few tests only read files of the repository (Dockerfiles, ignore files, workflows) and may run where neither the
# gateway nor its dependencies are installed. There the gateway's setup below is left out and a test that does need the
# gateway fails on its own import. Where the gateway is installed nothing changes: a missing dependency still stops the
# session.
GATEWAY_INSTALLED = importlib.util.find_spec("openbinding_gateway") is not None
try:
    import pytest_asyncio
except ImportError:
    if GATEWAY_INSTALLED:
        raise
    pytest_asyncio = types.SimpleNamespace(fixture=pytest.fixture)

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
if GATEWAY_INSTALLED:
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
# The fake gate installed below is built from the recorded SPHERE version 0.2.0 (tests/_pricing.py)
# (the published pricing 0.2.0: plans FREE, RESEARCH and LAB, default FREE); the gateway names
# that version and plan when it creates contracts.
os.environ["SPACE_PRICING_VERSION"] = "0.2.0"
os.environ["SPACE_DEFAULT_PLAN"] = "FREE"


@pytest.fixture(scope="session", autouse=True)
def cheap_password_hashing():
    """Argon2 at its cheapest cost.

    Registering and signing in an account hashes and verifies a password twice, and the API tests do it for every
    account of every test (about 100 ms with the production parameters), which was most of the time of the
    suite. The hash format carries its parameters, so a hash made here still verifies anywhere and a hash made
    with the production parameters still verifies here; only the cost of making one changes.
    """
    if not GATEWAY_INSTALLED:
        yield
        return
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
    if not GATEWAY_INSTALLED:
        yield
        return
    from openbinding_gateway.core.ratelimit import AuthRateLimiter, set_auth_limiter

    set_auth_limiter(AuthRateLimiter(primary=None))
    yield
    set_auth_limiter(None)


@pytest.fixture(autouse=True)
def isolated_feed_rate_limiter():
    """The feed limiter counted in this test's own memory, never in Redis."""
    if not GATEWAY_INSTALLED:
        yield
        return
    from openbinding_gateway.core.ratelimit import FeedRateLimiter, set_feed_limiter

    set_feed_limiter(FeedRateLimiter(primary=None))
    yield
    set_feed_limiter(None)


@pytest.fixture(autouse=True)
def identity_stores():
    """The identity module's one-time store and session lock, in this test's own memory.

    The lifespan installs Redis ones (``IDENTITY_STORE_BACKEND``); the unit suite has no Redis and runs no
    lifespan, so every test starts with empty memory adapters. Yields ``(store, lock)``.
    """
    if not GATEWAY_INSTALLED:
        yield None
        return
    from openbinding_gateway.modules.identity.adapters.stores import MemoryOneTimeStore, MemorySessionLock
    from openbinding_gateway.modules.identity.application import set_lock, set_store

    store, lock = MemoryOneTimeStore(), MemorySessionLock()
    set_store(store)
    set_lock(lock)
    yield store, lock
    set_store(None)
    set_lock(None)


@pytest.fixture(autouse=True)
def isolated_work_rate_limiter(monkeypatch):
    """The per-client work budget switched off, and counted in this test's own memory.

    The default is sized for one person at a keyboard and the suite is not one: a test
    that validates more than ten packages would be refused at the eleventh. Every class
    (``compile``, ``read`` and ``evaluate``) is switched off.
    ``tests/test_work_limits.py`` switches it on again.
    """
    if not GATEWAY_INSTALLED:
        yield
        return
    from openbinding_gateway.access.work_limits import WorkRateLimiter, set_work_limiter
    from openbinding_gateway.core.settings import get_settings

    monkeypatch.setattr(get_settings(), "work_rate_limit_compile_requests", 0)
    monkeypatch.setattr(get_settings(), "work_rate_limit_read_requests", 0)
    monkeypatch.setattr(get_settings(), "work_rate_limit_evaluate_requests", 0)
    set_work_limiter(WorkRateLimiter(primary=None))
    yield
    set_work_limiter(None)


@pytest.fixture(autouse=True)
def artifact_root(tmp_path, monkeypatch):
    """Every test stores blobs (problem packages, library content) in a directory of its own."""
    if not GATEWAY_INSTALLED:
        yield None
        return
    from openbinding_gateway.core.settings import get_settings

    root = tmp_path / "artifacts"
    monkeypatch.setattr(get_settings(), "artifact_root", str(root))
    yield root


@pytest.fixture(autouse=True)
def fresh_bim_port():
    """Each test builds the BIM port its settings ask for (in process by default) and leaves none behind."""
    if not GATEWAY_INSTALLED:
        yield
        return
    from openbinding_gateway.integrations import bim

    bim.set_bim(None)
    yield
    bim.set_bim(None)


if GATEWAY_INSTALLED:
    from sphere_recorded import NetworkForbidden  # noqa: E402


if GATEWAY_INSTALLED and os.environ.get("OPENBINDING_FORBID_NETWORK") == "1":
    # The CI unit shards run with this set: a raw connect to anything but loopback or a unix socket fails,
    # whatever library makes it. The PostgreSQL and compose-integration jobs, which talk to services, do not set it.
    import ipaddress as _ipaddress
    import socket as _socket

    _real_connect = _socket.socket.connect
    _real_connect_ex = _socket.socket.connect_ex

    def _allowed(sock, address) -> bool:
        if sock.family not in (_socket.AF_INET, _socket.AF_INET6):
            return True
        host = address[0] if isinstance(address, tuple) else address
        try:
            return _ipaddress.ip_address(host).is_loopback
        except ValueError:
            return host == "localhost"

    def _guarded_connect(sock, address):
        if not _allowed(sock, address):
            raise NetworkForbidden(f"the tests opened a network socket to {address!r}")
        return _real_connect(sock, address)

    def _guarded_connect_ex(sock, address):
        if not _allowed(sock, address):
            raise NetworkForbidden(f"the tests opened a network socket to {address!r}")
        return _real_connect_ex(sock, address)

    _socket.socket.connect = _guarded_connect
    _socket.socket.connect_ex = _guarded_connect_ex


@pytest.fixture(autouse=True)
def no_outbound_network(monkeypatch):
    """``core.outbound`` refuses anything a test did not script: no real DNS answer and no real transport.

    A test scripts DNS by patching ``socket.getaddrinfo`` (the engine and outbound tests do), or uses the
    recorded SPHERE (``sphere`` below), whose hosts resolve to fixed addresses.
    """
    if not GATEWAY_INSTALLED:
        yield
        return
    import socket

    import httpx

    from openbinding_gateway.core import outbound

    real = socket.getaddrinfo

    def resolve(host, port):
        if socket.getaddrinfo is not real:
            return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        raise NetworkForbidden(f"an outbound read asked for the address of {host}")

    def forbid(request):
        raise NetworkForbidden(f"an outbound read was sent to {request.url}")

    monkeypatch.setattr(outbound, "_getaddrinfo", resolve)
    monkeypatch.setattr(outbound, "default_transport", lambda: httpx.MockTransport(forbid))
    yield


@pytest.fixture(autouse=True)
def sphere(monkeypatch, no_outbound_network):
    """Every test reads SPHERE through the recorded answers (``fixtures/sphere``), with the default SPHERE on."""
    if not GATEWAY_INSTALLED:
        yield None
        return
    from openbinding_gateway.core import outbound
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource
    from openbinding_gateway.modules.plans.application import set_pricing_source
    from sphere_recorded import RecordedSphere

    recorded = RecordedSphere()
    guarded = outbound._getaddrinfo

    def resolve(host, port):
        if host in recorded.hosts:
            return recorded.getaddrinfo(host, port)
        return guarded(host, port)

    monkeypatch.setattr(outbound, "_getaddrinfo", resolve)
    settings = get_settings().model_copy(update={"sphere_enabled": True})
    recorded.source = SphereHttpSource(settings, transport=recorded.transport())
    set_pricing_source(recorded.source)
    yield recorded
    set_pricing_source(None)


@pytest.fixture(autouse=True)
def fixture_catalog_gate():
    """Every test gets a SPACE substitute built from the pricing 0.2.0 fixture."""
    if not GATEWAY_INSTALLED:
        yield
        return
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
    if engine.dialect.name == "sqlite":
        # pysqlite starts a transaction only at the first write, so a SAVEPOINT taken before any write opens one
        # that its RELEASE commits; ``begin_nested`` (the job insert, a compilation's) then commits for good.
        # Transactions begin explicitly instead, as they do on PostgreSQL (the SQLAlchemy recipe for pysqlite).
        from sqlalchemy import event

        @event.listens_for(engine.sync_engine, "connect")
        def _no_implicit_transactions(dbapi_connection, _record):
            dbapi_connection.isolation_level = None

        @event.listens_for(engine.sync_engine, "begin")
        def _begin_explicitly(connection):
            if connection.get_execution_options().get("isolation_level") != "AUTOCOMMIT":
                connection.exec_driver_sql("BEGIN")

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
    is not a PostgreSQL ``test*`` database it fails (see ``tests/_pg_support.py``).
    ``db_session`` stays what it was; do not point it at that URL.
    """
    import _pg_support

    async with _pg_support.database() as database:
        yield database


@pytest.fixture(autouse=True)
def _pg_test_watchdog(request):
    """The ``tests/test_*_pg.py`` modules get the per-test limit that ``tests/concurrency`` has.

    A race test that waits for a lock that never comes would otherwise run until the harness times out and
    loses its output. Every other test, and the ones under ``tests/concurrency``
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

    # A script, not a browser: bearer tokens only, no cookie jar. Local sign-in also sets the session cookie,
    # and a session cookie presented at the next sign-in is revoked (``replaced``), which would end the first
    # account's token when one client signs several accounts in (tests/identity/test_local_session.py).
    async def _forget_cookies(response):
        client.cookies.clear()

    async with AsyncClient(
        transport=transport, base_url="http://gateway", event_hooks={"response": [_forget_cookies]}
    ) as client:
        yield client
    app.dependency_overrides.clear()


@pytest.fixture
def session_token(db_session):
    """``await session_token(user_id, **claims)``: a gateway token bound to a fresh ``local`` session of the user.

    Every gateway token names its session (``sid``), which the gateway checks on every request; a test that needs a
    token with particular claims (an expired one, another audience) mints it here, as login would, over a real row.
    """
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db.models import User
    from openbinding_gateway.modules.identity.application import sessions
    from openbinding_gateway.security.tokens import issue_access_token

    async def _make(user_id, *, ttl_seconds: int = 60, issuer=None, audience=None) -> str:
        settings = get_settings()
        user = await db_session.get(User, user_id)
        row, _ = await sessions.create(db_session, user, "local", settings=settings)
        await db_session.commit()
        return issue_access_token(
            settings.gateway_jwt_secret,
            user_id=user_id,
            ttl_seconds=ttl_seconds,
            session_id=row.id,
            provider="local",
            issuer=issuer if issuer is not None else settings.gateway_jwt_issuer,
            audience=audience if audience is not None else settings.gateway_jwt_audience,
        )

    return _make


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

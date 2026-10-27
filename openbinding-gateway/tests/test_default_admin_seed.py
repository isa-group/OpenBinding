"""A fresh gateway must not ship a well-known administrator.

The gateway used to seed ``admin`` with a fixed password in an empty database
whenever ``APP_ENV`` was not ``prod`` - and ``APP_ENV`` defaults to ``dev``, so
a deployment that simply forgot to set it had a public administrator login.
Seeding is now an explicit opt-in (``SEED_DEFAULT_ADMIN``) that also needs a
password from the operator; with neither, an empty database stays empty.

Most tests here start the whole gateway (the lifespan, through ``TestClient``),
because the earlier rules were all correct in isolation and the bug lived in
what startup did with them.
"""

from __future__ import annotations

import importlib.util
import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from _paths import GATEWAY_ROOT
from _pricing import fake_pricing_gate
from openbinding_gateway import space_client
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.base import Base
from openbinding_gateway.db.bootstrap import seed_default_administrator
from openbinding_gateway.db.models import User, UserRole
from openbinding_gateway.security.passwords import verify_password

BOOTSTRAP_SOURCE = GATEWAY_ROOT / "src" / "openbinding_gateway" / "db" / "bootstrap.py"
SEED_ADMIN_TOOL = GATEWAY_ROOT / "tools" / "seed_admin.py"

JWT_SECRET = "a-secret-long-enough-for-hs256-signing"
STRONG_PASSWORD = "an-operator-chosen-passphrase"
WEAK_PASSWORD = "weakpw1"  # shorter than the minimum length


@pytest.fixture
def database(tmp_path, monkeypatch):
    """An empty SQLite file with the schema, and the environment pointing at it."""
    path = tmp_path / "gateway.db"
    engine = create_engine(f"sqlite:///{path}")
    with engine.begin() as connection:
        Base.metadata.create_all(connection)
    engine.dispose()

    url = f"sqlite+aiosqlite:///{path}"
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("GATEWAY_JWT_SECRET", JWT_SECRET)
    monkeypatch.setattr(space_client, "build_gate", lambda *_a, **_k: fake_pricing_gate())
    get_settings.cache_clear()
    yield path
    get_settings.cache_clear()


def accounts(path: Path) -> list[tuple[str, UserRole, str]]:
    engine = create_engine(f"sqlite:///{path}")
    try:
        with Session(engine) as session:
            return [
                (user.username, user.role, user.password_hash)
                for user in session.execute(select(User)).scalars()
            ]
    finally:
        engine.dispose()


@pytest.fixture
def started_gateway(database):
    """Start the whole gateway (lifespan included) on the empty database.

    Yields a function taking the settings overrides; it returns the running
    client, and leaves the database path for ``accounts`` to read.
    """
    from openbinding_gateway.main import create_app

    opened: list = []

    def start(**overrides) -> TestClient:
        settings = Settings(
            _env_file=None,
            database_url=f"sqlite+aiosqlite:///{database}",
            gateway_jwt_secret=JWT_SECRET,
            **overrides,
        )
        client = TestClient(create_app(settings))
        client.__enter__()
        opened.append(client)
        return client

    yield start
    for client in reversed(opened):
        client.__exit__(None, None, None)


def login(client: TestClient, username: str, password: str) -> int:
    return client.post(
        "/v1/auth/login", json={"username_or_email": username, "password": password}
    ).status_code


# -- Starting the gateway ---------------------------------------------------


def test_defaults_leave_an_empty_database_without_accounts(database, started_gateway):
    # app_env is "dev" here, which is what a forgotten APP_ENV looks like.
    settings = Settings(_env_file=None)
    assert settings.app_env == "dev"
    assert settings.seed_default_admin is False

    client = started_gateway()

    assert accounts(database) == []
    assert login(client, "admin", "admin") == 401


def test_a_password_alone_does_not_seed_anything(database, started_gateway):
    started_gateway(bootstrap_admin_password=STRONG_PASSWORD)

    assert accounts(database) == []


def test_opt_in_without_a_password_creates_no_account(database, started_gateway, caplog):
    caplog.set_level(logging.DEBUG, logger="openbinding_gateway")

    started_gateway(seed_default_admin=True)

    assert accounts(database) == []
    assert any("BOOTSTRAP_ADMIN_PASSWORD" in record.getMessage() for record in caplog.records)


def test_opt_in_with_a_weak_password_creates_no_account_and_logs_no_password(
    database, started_gateway, caplog
):
    caplog.set_level(logging.DEBUG, logger="openbinding_gateway")

    started_gateway(seed_default_admin=True, bootstrap_admin_password=WEAK_PASSWORD)

    assert accounts(database) == []
    assert WEAK_PASSWORD not in caplog.text


def test_opt_in_with_a_configured_password_seeds_the_administrator(
    database, started_gateway, caplog
):
    caplog.set_level(logging.DEBUG, logger="openbinding_gateway")

    client = started_gateway(seed_default_admin=True, bootstrap_admin_password=STRONG_PASSWORD)

    (username, role, stored), = accounts(database)
    assert (username, role) == ("admin", UserRole.ADMIN)
    assert verify_password(STRONG_PASSWORD, stored)
    assert STRONG_PASSWORD not in caplog.text
    assert login(client, "admin", STRONG_PASSWORD) == 200


def test_the_seed_does_not_depend_on_app_env(database, started_gateway):
    # The opt-in is the only switch: "test" seeds with it, and "dev" did not without it.
    started_gateway(app_env="test", seed_default_admin=True, bootstrap_admin_password=STRONG_PASSWORD)

    assert [name for name, _role, _hash in accounts(database)] == ["admin"]


def test_opt_in_does_not_touch_a_database_that_already_has_accounts(database, started_gateway):
    engine = create_engine(f"sqlite:///{database}")
    with Session(engine) as session:
        session.add(User(username="someone", email="someone@example.org", password_hash="x", plan_cache="BASIC"))
        session.commit()
    engine.dispose()

    started_gateway(seed_default_admin=True, bootstrap_admin_password=STRONG_PASSWORD)

    assert [name for name, _role, _hash in accounts(database)] == ["someone"]


def test_the_configured_bootstrap_administrator_gets_the_configured_password(
    database, started_gateway
):
    client = started_gateway(
        bootstrap_admin_username="alice",
        bootstrap_admin_email="alice@example.org",
        bootstrap_admin_password=STRONG_PASSWORD,
    )

    (username, role, stored), = accounts(database)
    assert (username, role) == ("alice", UserRole.ADMIN)
    assert verify_password(STRONG_PASSWORD, stored)
    assert login(client, "alice", STRONG_PASSWORD) == 200
    assert login(client, "admin", STRONG_PASSWORD) == 401


# -- The seeding function ---------------------------------------------------


def configured(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


async def test_the_function_does_nothing_without_the_opt_in(db_session):
    seeded = await seed_default_administrator(
        db_session, configured(bootstrap_admin_password=STRONG_PASSWORD), STRONG_PASSWORD
    )

    assert seeded is False
    assert (await db_session.execute(select(User))).scalars().all() == []


async def test_the_function_takes_the_password_argument_over_the_configured_one(db_session):
    settings = configured(seed_default_admin=True, bootstrap_admin_password="configured-password-1")

    assert await seed_default_administrator(db_session, settings, STRONG_PASSWORD) is True

    admin = (await db_session.execute(select(User))).scalar_one()
    assert verify_password(STRONG_PASSWORD, admin.password_hash)
    assert not verify_password("configured-password-1", admin.password_hash)
    assert admin.email == "admin@example.org"


async def test_the_function_refuses_a_weak_password_without_logging_it(db_session, caplog):
    caplog.set_level(logging.DEBUG, logger="openbinding_gateway")

    seeded = await seed_default_administrator(
        db_session, configured(seed_default_admin=True), WEAK_PASSWORD
    )

    assert seeded is False
    assert (await db_session.execute(select(User))).scalars().all() == []
    assert WEAK_PASSWORD not in caplog.text


async def test_the_function_refuses_once_anybody_exists(db_session):
    db_session.add(User(username="someone", email="someone@example.org", password_hash="x", plan_cache="BASIC"))
    await db_session.flush()

    seeded = await seed_default_administrator(
        db_session, configured(seed_default_admin=True), STRONG_PASSWORD
    )

    assert seeded is False
    assert len((await db_session.execute(select(User))).scalars().all()) == 1


# -- tools/seed_admin.py ----------------------------------------------------


def load_tool():
    spec = importlib.util.spec_from_file_location("seed_admin_under_test", SEED_ADMIN_TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_the_tool_generates_a_password_and_shows_it_once(database, capsys):
    assert await load_tool().main() == 0

    (username, role, stored), = accounts(database)
    assert (username, role) == ("admin", UserRole.ADMIN)
    shown = capsys.readouterr().out
    # The one place the generated password appears: whichever token in the
    # output verifies against the stored hash is it, and it is there once.
    matching = [token for token in shown.split() if verify_password(token, stored)]
    assert len(matching) == 1
    assert shown.count(matching[0]) == 1


async def test_the_tool_uses_the_environment_password_and_does_not_print_it(
    database, monkeypatch, capsys
):
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", STRONG_PASSWORD)
    get_settings.cache_clear()

    assert await load_tool().main() == 0

    (_username, _role, stored), = accounts(database)
    assert verify_password(STRONG_PASSWORD, stored)
    captured = capsys.readouterr()
    assert STRONG_PASSWORD not in captured.out + captured.err


async def test_the_tool_creates_nothing_in_a_database_with_accounts(database, capsys):
    engine = create_engine(f"sqlite:///{database}")
    with Session(engine) as session:
        session.add(User(username="someone", email="someone@example.org", password_hash="x", plan_cache="BASIC"))
        session.commit()
    engine.dispose()

    assert await load_tool().main() == 0

    assert [name for name, _role, _hash in accounts(database)] == ["someone"]


# -- The source -------------------------------------------------------------


@pytest.mark.parametrize("path", [BOOTSTRAP_SOURCE, SEED_ADMIN_TOOL], ids=lambda path: path.name)
def test_the_well_known_password_is_gone_from_the_source(path):
    assert "4dm1n" not in path.read_text(encoding="utf-8")

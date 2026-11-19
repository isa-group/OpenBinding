"""Fixtures of the identity tests: a gateway in ``scoretech`` mode and the fake issuer (never the real one)."""

from __future__ import annotations

import pytest
import pytest_asyncio
from pydantic import SecretStr

from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.modules.identity.adapters.oidc import IdentityOidc
from openbinding_gateway.modules.identity.application import set_oidc

from ._settings import FRONTEND, scoretech_values
from .fake_issuer import FakeIssuer, script_dns


@pytest.fixture(autouse=True)
def forget_anonymous_errors():
    """These tests answer many anonymous 4xx on purpose; the per-process budget of stored anonymous failures
    (``telemetry``, a minute long) must not run out for the tests that come after them."""
    from openbinding_gateway import telemetry

    yield
    telemetry.reset_anonymous_error_limits()


@pytest.fixture
def scoretech(monkeypatch):
    """The process settings switched to ``scoretech`` mode for this test (every reader sees the same object)."""
    settings = get_settings()
    for key, value in scoretech_values().items():
        if key == "scoretech_identity_client_secret":
            value = SecretStr(value)
        monkeypatch.setattr(settings, key, value)
    return settings


@pytest.fixture
def fake_issuer(monkeypatch, scoretech):
    script_dns(monkeypatch)
    fake = FakeIssuer()
    set_oidc(IdentityOidc(scoretech, transport=fake.transport()))
    yield fake
    set_oidc(None)


@pytest_asyncio.fixture
async def browser(db_session):
    """The gateway over https at the frontend's origin, with a cookie jar (``__Host-`` cookies need https)."""
    from httpx import ASGITransport, AsyncClient

    from openbinding_gateway.access.dependencies import optional_session, session_dependency
    from openbinding_gateway.main import app

    async def _session_override():
        yield db_session

    app.dependency_overrides[session_dependency] = _session_override
    app.dependency_overrides[optional_session] = _session_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url=FRONTEND, headers={"origin": FRONTEND}
    ) as client:
        yield client
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def pooled(tmp_path):
    """A file database and one session per request, as in production (for the parallel-request tests).

    Yields ``(factory, browser)``: ``factory()`` opens a session of its own, and ``browser`` is the gateway at the
    frontend's origin whose every request commits or rolls back its own session.
    """
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from openbinding_gateway.access.dependencies import optional_session, session_dependency
    from openbinding_gateway.db.base import Base
    from openbinding_gateway.main import app

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'pooled.db'}", connect_args={"timeout": 30})
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def per_request():
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[session_dependency] = per_request
    app.dependency_overrides[optional_session] = per_request
    async with AsyncClient(transport=ASGITransport(app=app), base_url=FRONTEND, headers={"origin": FRONTEND}) as client:
        yield factory, client
    app.dependency_overrides.clear()
    await engine.dispose()

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

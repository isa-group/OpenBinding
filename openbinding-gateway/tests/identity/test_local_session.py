"""Local sign-in opens the same browser session as SCORETech Identity (D-a, J9, T2, T9).

Login and registration set the HttpOnly session cookie and return a token bound to the session (``sid``,
``prv=local``); ``POST /v1/auth/identity/session`` turns the cookie into fresh tokens and
``POST /v1/auth/identity/logout`` ends it, so a captured bearer stops at once. A present foreign ``Origin`` is
refused (login CSRF); ``AUTH_TRUSTED_ORIGINS`` adds the origin the lab's walks browse.
"""

from __future__ import annotations

import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import AuditEvent, IdentitySession

from ._settings import FRONTEND

PASSWORD = "correct-horse-battery"


@pytest.fixture
def local(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_provider", "local")
    monkeypatch.setattr(settings, "frontend_url", FRONTEND)
    monkeypatch.setattr(settings, "public_base_url", FRONTEND)
    monkeypatch.setattr(settings, "auth_trusted_origins", "")
    return settings


@pytest_asyncio.fixture
async def gateway(db_session):
    """A client factory: ``gateway(base_url, origin)`` with its own cookie jar, on the test database."""
    from openbinding_gateway.access.dependencies import optional_session, session_dependency
    from openbinding_gateway.main import app

    async def _session_override():
        yield db_session

    app.dependency_overrides[session_dependency] = _session_override
    app.dependency_overrides[optional_session] = _session_override
    clients: list[AsyncClient] = []

    def make(base_url: str = FRONTEND, origin: str | None = FRONTEND) -> AsyncClient:
        headers = {"origin": origin} if origin else {}
        client = AsyncClient(transport=ASGITransport(app=app), base_url=base_url, headers=headers)
        clients.append(client)
        return client

    yield make
    for client in clients:
        await client.aclose()
    app.dependency_overrides.clear()


def _claims(token: str) -> dict:
    return jwt.decode(token, options={"verify_signature": False})


async def _register_and_login(client: AsyncClient, registration) -> tuple[dict, str]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    login = await client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]}
    )
    assert login.status_code == 200, login.text
    return details, login.json()["access_token"]


async def test_login_sets_the_cookie_and_a_session_bound_token(local, gateway, registration, db_session) -> None:
    client = gateway()
    _, token = await _register_and_login(client, registration)
    assert "__Host-ob_session" in client.cookies
    claims = _claims(token)
    assert claims["prv"] == "local" and claims["sid"]
    row = await db_session.get(IdentitySession, uuid.UUID(claims["sid"]))
    assert row is not None and row.provider == "local" and row.refresh_ciphertext is None
    me = await client.get("/v1/users/me", headers={"authorization": f"Bearer {token}"})
    assert me.status_code == 200


async def test_the_session_route_mints_fresh_tokens_from_the_cookie(local, gateway, registration) -> None:
    client = gateway()
    _, token = await _register_and_login(client, registration)
    minted = await client.post("/v1/auth/identity/session")
    assert minted.status_code == 200, minted.text
    fresh = minted.json()["access_token"]
    assert _claims(fresh)["sid"] == _claims(token)["sid"]
    me = await client.get("/v1/users/me", headers={"authorization": f"Bearer {fresh}"})
    assert me.status_code == 200


async def test_logout_ends_the_session_and_the_old_bearer(local, gateway, registration, db_session) -> None:
    client = gateway()
    _, token = await _register_and_login(client, registration)
    bearer = {"authorization": f"Bearer {token}"}
    out = await client.post("/v1/auth/identity/logout")
    assert out.status_code == 204
    assert (await client.get("/v1/users/me", headers=bearer)).status_code == 401
    assert (await client.post("/v1/auth/identity/session")).status_code == 401
    actions = (await db_session.execute(select(AuditEvent.action))).scalars().all()
    assert "account.signed_in" in actions and "account.signed_out" in actions


async def test_register_opens_a_session_too(local, gateway, registration) -> None:
    client = gateway()
    created = await client.post("/v1/auth/register", json=registration())
    assert created.status_code == 201
    assert "__Host-ob_session" in client.cookies
    minted = await client.post("/v1/auth/identity/session")
    assert minted.status_code == 200
    me = await client.get("/v1/users/me", headers={"authorization": f"Bearer {minted.json()['access_token']}"})
    assert me.json()["id"] == created.json()["id"]


async def test_a_presented_session_is_replaced_at_sign_in(local, gateway, registration, db_session) -> None:
    client = gateway()
    details, first = await _register_and_login(client, registration)
    again = await client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]}
    )
    assert again.status_code == 200
    old = await db_session.get(IdentitySession, uuid.UUID(_claims(first)["sid"]))
    await db_session.refresh(old)
    assert old.revoked_reason == "replaced"
    assert (await client.get("/v1/users/me", headers={"authorization": f"Bearer {first}"})).status_code == 401


@pytest.mark.parametrize("path", ["/v1/auth/login", "/v1/auth/register"])
async def test_a_foreign_origin_is_refused(local, gateway, registration, path) -> None:
    details = registration()
    body = details if path.endswith("register") else {"username_or_email": "nobody", "password": PASSWORD}
    refused = await gateway(origin="https://evil.test").post(path, json=body)
    assert refused.status_code == 403 and refused.json()["code"] == "origin_refused"


async def test_an_absent_origin_is_allowed_for_scripts(local, gateway, registration) -> None:
    script = gateway(origin=None)
    details = registration()
    assert (await script.post("/v1/auth/register", json=details)).status_code == 201
    login = await script.post("/v1/auth/login", json={"username_or_email": details["username"], "password": PASSWORD})
    assert login.status_code == 200


async def test_the_lab_origin_pair(local, gateway, registration, monkeypatch) -> None:
    """The ordinary lab: FRONTEND_URL is the public origin, the walks browse ``http://web:8080``."""
    monkeypatch.setattr(local, "frontend_url", "http://localhost:18199")
    monkeypatch.setattr(local, "public_base_url", "http://localhost:18199")
    monkeypatch.setattr(local, "auth_trusted_origins", "http://web:8080")
    web = gateway(base_url="http://web:8080", origin="http://web:8080")
    details, token = await _register_and_login(web, registration)
    assert "ob_session" in web.cookies
    assert (await web.post("/v1/auth/identity/session")).status_code == 200
    assert (await web.post("/v1/auth/identity/logout")).status_code == 204
    assert (await web.get("/v1/users/me", headers={"authorization": f"Bearer {token}"})).status_code == 401

    evil = gateway(base_url="http://web:8080", origin="http://evil.test")
    login = await evil.post("/v1/auth/login", json={"username_or_email": details["username"], "password": PASSWORD})
    assert login.status_code == 403
    assert (await evil.post("/v1/auth/identity/session")).status_code == 403
    assert (await evil.post("/v1/auth/identity/logout")).status_code == 403

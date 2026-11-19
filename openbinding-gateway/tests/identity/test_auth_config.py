"""``GET /v1/auth/config``: public, in both modes, and it leaks nothing."""

from __future__ import annotations

from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.main import app

from ._settings import CLIENT_ID, CLIENT_SECRET, scoretech_settings


async def test_local_mode_names_only_the_provider(api_client) -> None:
    response = await api_client.get("/v1/auth/config")
    assert response.status_code == 200
    assert response.json() == {"provider": "local", "login_url": None, "register_url": None, "account_url": None}
    assert response.headers["cache-control"] == "no-store"


async def test_scoretech_mode_names_the_browser_urls_and_no_secret(api_client) -> None:
    settings = scoretech_settings(scoretech_identity_transport_url="https://keycloak.test/identity/auth/realms/score")
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        response = await api_client.get("/v1/auth/config")
    finally:
        app.dependency_overrides.pop(get_settings, None)
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "provider": "scoretech",
        "login_url": "https://openbinding.test/api/v1/auth/identity/login",
        "register_url": "https://openbinding.test/api/v1/auth/identity/login?screen=register",
        "account_url": "https://identity.test/identity/account/#public-profile",
    }
    text = response.text
    for leaked in (CLIENT_SECRET, CLIENT_ID, "keycloak.test"):
        assert leaked not in text
    assert response.headers["cache-control"] == "no-store"

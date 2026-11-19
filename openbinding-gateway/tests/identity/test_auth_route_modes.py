"""In each mode there is exactly one way in: every ``/v1/auth`` route declares the mode it serves (D-h, T20)."""

from __future__ import annotations

import pytest
from fastapi.routing import APIRoute

from openbinding_gateway.main import app

from ._settings import FRONTEND


def _declared(route: APIRoute) -> list[tuple[str, bool]]:
    found = []
    stack = list(route.dependant.dependencies)
    while stack:
        dependency = stack.pop()
        call = dependency.call
        if hasattr(call, "auth_provider"):
            found.append((call.auth_provider, call.auth_browser))
        stack.extend(dependency.dependencies)
    return found


def _auth_routes() -> list[tuple[str, str, APIRoute]]:
    routes = []
    for included in app.routes:
        original = getattr(included, "original_router", None)
        for route in original.routes if original is not None else [included]:
            if isinstance(route, APIRoute) and route.path.startswith("/v1/auth"):
                for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                    routes.append((method, route.path, route))
    return routes


EXPECTED = {
    ("GET", "/v1/auth/config"): ("any", False),
    ("GET", "/v1/auth/identity/login"): ("scoretech", True),
    ("GET", "/v1/auth/identity/callback"): ("scoretech", True),
    ("GET", "/v1/auth/identity/pending"): ("scoretech", False),
    ("POST", "/v1/auth/identity/complete"): ("scoretech", False),
    ("POST", "/v1/auth/identity/session"): ("any", False),
    ("POST", "/v1/auth/identity/logout"): ("any", False),
    ("POST", "/v1/auth/register"): ("local", False),
    ("POST", "/v1/auth/login"): ("local", False),
    ("POST", "/v1/auth/refresh"): ("local", False),
    ("POST", "/v1/auth/logout"): ("local", False),
    ("POST", "/v1/auth/password-reset/request"): ("local", False),
    ("POST", "/v1/auth/password-reset/complete"): ("local", False),
    ("GET", "/v1/auth/cas/start"): ("local", False),
    ("POST", "/v1/auth/cas/link-intent"): ("local", False),
    ("GET", "/v1/auth/cas/callback"): ("local", False),
    ("POST", "/v1/auth/cas/exchange"): ("local", False),
}


def test_every_auth_route_declares_exactly_one_mode() -> None:
    table = {(method, path): _declared(route) for method, path, route in _auth_routes()}
    assert set(table) == set(EXPECTED), sorted(set(table) ^ set(EXPECTED))
    for key, declared in table.items():
        assert declared == [EXPECTED[key]], (key, declared)


LOCAL_ROUTES = [key for key, (mode, _) in EXPECTED.items() if mode == "local"]
SCORETECH_JSON = [key for key, (mode, browser) in EXPECTED.items() if mode == "scoretech" and not browser]


BODIES = {
    "/v1/auth/register": {"username": "someone", "email": "someone@example.org", "password": "a-long-password-1"},
    "/v1/auth/login": {"username_or_email": "someone", "password": "a-long-password-1"},
    "/v1/auth/refresh": {"refresh_token": "x"},
    "/v1/auth/logout": {"refresh_token": "x"},
    "/v1/auth/password-reset/request": {"email": "someone@example.org"},
    "/v1/auth/password-reset/complete": {"token": "obr_" + "x" * 40, "new_password": "a-long-password-1"},
    "/v1/auth/cas/exchange": {"code": "c" * 40},
}


@pytest.mark.parametrize(("method", "path"), LOCAL_ROUTES)
async def test_local_routes_answer_409_in_scoretech_mode(browser, scoretech, method, path) -> None:
    response = await browser.request(method, path, json=BODIES.get(path) if method == "POST" else None)
    assert response.status_code == 409, (path, response.text)
    assert response.json()["detail"]["code"] == "local_auth_disabled"


@pytest.mark.parametrize(("method", "path"), SCORETECH_JSON)
async def test_identity_json_routes_answer_409_in_local_mode(api_client, method, path) -> None:
    response = await api_client.request(method, path, json={"username": "someone"}, headers={"origin": "http://localhost:5173"})
    assert response.status_code == 409 and response.json()["detail"]["code"] == "identity_disabled"


async def test_identity_browser_routes_redirect_in_local_mode(api_client) -> None:
    for path in ("/v1/auth/identity/login", "/v1/auth/identity/callback"):
        response = await api_client.get(path)
        assert response.status_code == 303
        assert response.headers["location"].endswith("/authentication?identity_error=unavailable")


@pytest.mark.parametrize("change", [{"email": "new@example.org", "current_password": "x"}, {"new_password": "a-new-password-1", "current_password": "x"}])
async def test_email_and_password_are_managed_by_identity_in_scoretech_mode(browser, fake_issuer, db_session, change) -> None:
    from ._flow import known_user, sign_in

    _, _, person = await known_user(db_session, fake_issuer)
    await sign_in(browser, fake_issuer, person)
    token = (await browser.post("/v1/auth/identity/session")).json()["access_token"]
    response = await browser.patch("/v1/users/me", json=change, headers={"authorization": f"Bearer {token}"})
    assert response.status_code == 409 and response.json()["detail"]["code"] == "managed_by_identity"
    read = await browser.patch("/v1/users/me", json={}, headers={"authorization": f"Bearer {token}"})
    assert read.status_code == 200


def test_the_frontend_origin_of_the_fixtures() -> None:
    assert FRONTEND.startswith("https://")

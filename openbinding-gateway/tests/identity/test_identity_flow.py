"""Sign-in through SCORETech Identity: PKCE, state, nonce and the browser binding (T1-T3, T9, T18, T21)."""

from __future__ import annotations

import base64
import hashlib
import logging
from urllib.parse import urlsplit

import pytest
from sqlalchemy import select

from openbinding_gateway.core.ratelimit import AuthRateLimiter, set_auth_limiter
from openbinding_gateway.db.models import AuditEvent, IdentitySession

from ._flow import known_user, query_of, session_cookie, sign_in, start
from ._settings import FRONTEND, ISSUER

pytestmark = pytest.mark.usefixtures("fake_issuer")


async def test_the_authorization_url_carries_pkce_state_nonce_and_the_locale(browser, fake_issuer, identity_stores) -> None:
    store, _ = identity_stores
    response = await start(browser)
    assert response.status_code == 302
    location = response.headers["location"]
    assert location.startswith(ISSUER + "/protocol/openid-connect/auth?")
    query = query_of(location)
    assert query["client_id"] == "ob-test-client" and query["response_type"] == "code"
    assert query["scope"] == "openid profile email" and query["ui_locales"] == "en"
    assert query["redirect_uri"] == "https://openbinding.test/api/v1/auth/identity/callback"
    assert len(query["state"]) == 64 and len(query["nonce"]) == 64
    flow = await store.peek("identity-flow", query["state"])
    challenge = base64.urlsafe_b64encode(hashlib.sha256(flow["verifier"].encode()).digest()).rstrip(b"=").decode()
    assert query["code_challenge"] == challenge and query["code_challenge_method"] == "S256"
    assert flow["nonce"] == query["nonce"] and len(flow["binding"]) == 64
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"__Host-ob_flow_{query['state']}=")
    binding = browser.cookies.get(f"__Host-ob_flow_{query['state']}")
    assert len(binding) == 64 and hashlib.sha256(binding.encode()).hexdigest() == flow["binding"]
    for attribute in ("HttpOnly", "Path=/", "SameSite=lax", "Secure", "Max-Age=600"):
        assert attribute.lower() in cookie.lower()


async def test_register_uses_the_registrations_page(browser) -> None:
    response = await start(browser, screen="register")
    assert "/protocol/openid-connect/registrations?" in response.headers["location"]


async def test_a_known_user_signs_in_and_holds_only_an_opaque_cookie(browser, fake_issuer, db_session) -> None:
    user, _, person = await known_user(db_session, fake_issuer)
    response = await sign_in(browser, fake_issuer, person)
    assert response.status_code == 303
    assert response.headers["location"] == f"{FRONTEND}/sso/identity/callback?returnTo=%2Fcompositions"
    value = session_cookie(browser)
    assert value and len(value) == 43
    row = (await db_session.execute(select(IdentitySession).where(IdentitySession.user_id == user.id))).scalars().one()
    assert row.provider == "scoretech" and row.revoked_at is None
    refresh = fake_issuer.refresh_tokens
    assert all(token not in row.refresh_ciphertext for token in refresh)
    actions = (await db_session.execute(select(AuditEvent.action).where(AuditEvent.target_id == user.id))).scalars().all()
    assert "account.signed_in" in actions
    session_set = [h for h in response.headers.get_list("set-cookie") if h.startswith("__Host-ob_session=")][0]
    assert "httponly" in session_set.lower() and "secure" in session_set.lower() and "path=/" in session_set.lower()


async def test_a_callback_without_the_binding_leaves_the_flow_usable(browser, fake_issuer, db_session, identity_stores) -> None:
    store, _ = identity_stores
    _, _, person = await known_user(db_session, fake_issuer)
    begun = await start(browser)
    query = fake_issuer.authorize(begun.headers["location"], person)
    state = query["state"]
    real = browser.cookies.get(f"__Host-ob_flow_{state}")
    browser.cookies.delete(f"__Host-ob_flow_{state}")
    missing = await browser.get("/v1/auth/identity/callback", params=query)
    assert missing.headers["location"].endswith("/authentication?identity_error=expired")
    browser.cookies.set(f"__Host-ob_flow_{state}", "0" * 64, domain="openbinding.test")
    forged = await browser.get("/v1/auth/identity/callback", params=query)
    assert forged.headers["location"].endswith("identity_error=expired")
    assert await store.peek("identity-flow", state) is not None
    browser.cookies.set(f"__Host-ob_flow_{state}", real, domain="openbinding.test")
    ok = await browser.get("/v1/auth/identity/callback", params=query)
    assert "/sso/identity/callback" in ok.headers["location"]
    replay = await browser.get("/v1/auth/identity/callback", params=query)
    assert replay.headers["location"].endswith("identity_error=expired")


async def test_an_expired_flow_is_refused(browser, fake_issuer, db_session, identity_stores) -> None:
    store, _ = identity_stores
    _, _, person = await known_user(db_session, fake_issuer)
    begun = await start(browser)
    query = fake_issuer.authorize(begun.headers["location"], person)
    store.clock = lambda: 10**12
    response = await browser.get("/v1/auth/identity/callback", params=query)
    assert response.headers["location"].endswith("identity_error=expired")


async def test_an_iss_parameter_of_another_issuer_fails(browser, fake_issuer, db_session) -> None:
    _, _, person = await known_user(db_session, fake_issuer)
    begun = await start(browser)
    query = fake_issuer.authorize(begun.headers["location"], person)
    query["iss"] = "https://evil.test/realms/score"
    response = await browser.get("/v1/auth/identity/callback", params=query)
    assert response.headers["location"].endswith("identity_error=signin_failed")
    assert fake_issuer.code_grants() == 0


@pytest.mark.parametrize(
    ("error", "code"),
    [("access_denied", "access_denied"), ("temporarily_unavailable", "unavailable"), ("server_error", "signin_failed")],
)
async def test_identity_errors_map_to_closed_codes(browser, fake_issuer, error, code) -> None:
    begun = await start(browser)
    state = query_of(begun.headers["location"])["state"]
    response = await browser.get("/v1/auth/identity/callback", params={"state": state, "error": error})
    assert response.headers["location"] == f"{FRONTEND}/authentication?identity_error={code}"


async def test_a_missing_permission_is_access_denied_and_ends_the_identity_session(browser, fake_issuer, db_session) -> None:
    _, _, person = await known_user(db_session, fake_issuer)
    fake_issuer.switches.add("no_permission")
    response = await sign_in(browser, fake_issuer, person)
    assert response.headers["location"].endswith("identity_error=access_denied")
    assert len(fake_issuer.logouts) == 1
    assert session_cookie(browser) is None


async def test_a_deactivated_account_is_refused_and_ends_the_identity_session(browser, fake_issuer, db_session) -> None:
    user, _, person = await known_user(db_session, fake_issuer)
    user.is_active = False
    await db_session.flush()
    response = await sign_in(browser, fake_issuer, person)
    assert response.headers["location"].endswith("identity_error=account_disabled")
    assert len(fake_issuer.logouts) == 1
    refused = (await db_session.execute(select(AuditEvent).where(AuditEvent.action == "account.identity.refused"))).scalars().all()
    assert refused and refused[0].detail["reason"] == "account_disabled"


async def test_identity_down_is_unavailable(browser, fake_issuer) -> None:
    fake_issuer.switches.add("down")
    response = await start(browser)
    assert response.status_code == 303
    assert response.headers["location"] == f"{FRONTEND}/authentication?identity_error=unavailable"


@pytest.mark.parametrize(
    "unsafe",
    ["//evil.test", "/\\evil.test", "https://evil.test", "/api/v1/users/me", "/sso/identity/callback", "/x\r\nSet-Cookie: a=b", "/" + "a" * 600, "javascript:alert(1)"],
)
async def test_unsafe_return_paths_become_the_home(browser, fake_issuer, db_session, unsafe) -> None:
    _, _, person = await known_user(db_session, fake_issuer)
    response = await sign_in(browser, fake_issuer, person, return_to=unsafe)
    assert response.headers["location"] == f"{FRONTEND}/sso/identity/callback?returnTo=%2F"


async def test_no_redirect_carries_a_token_code_or_state(browser, fake_issuer, db_session) -> None:
    _, _, person = await known_user(db_session, fake_issuer)
    begun = await start(browser)
    query = fake_issuer.authorize(begun.headers["location"], person)
    response = await browser.get("/v1/auth/identity/callback", params=query)
    location = response.headers["location"]
    assert urlsplit(location).netloc == "openbinding.test"
    for secret in (query["code"], query["state"], *fake_issuer.refresh_tokens):
        assert secret not in location


async def test_the_previous_session_is_revoked_on_a_new_sign_in(browser, fake_issuer, db_session) -> None:
    user, _, person = await known_user(db_session, fake_issuer)
    await sign_in(browser, fake_issuer, person)
    first = session_cookie(browser)
    again = await sign_in(browser, fake_issuer, person)
    assert "/sso/identity/callback" in again.headers["location"], again.headers["location"]
    assert session_cookie(browser) != first
    rows = (await db_session.execute(select(IdentitySession).where(IdentitySession.user_id == user.id))).scalars().all()
    assert sorted(str(row.revoked_reason) for row in rows) == ["None", "replaced"]


async def test_cookies_are_plain_on_a_loopback_http_origin(fake_issuer, scoretech, monkeypatch) -> None:
    from openbinding_gateway.modules.identity.adapters import cookies

    monkeypatch.setattr(scoretech, "frontend_url", "http://localhost:18198")
    assert cookies.name(scoretech, cookies.SESSION) == "ob_session"
    assert scoretech.identity_secure_cookies is False


async def test_the_sign_in_routes_are_rate_limited(browser, fake_issuer) -> None:
    set_auth_limiter(AuthRateLimiter(primary=None))
    for _ in range(30):
        assert (await start(browser)).status_code == 302
    limited = await start(browser)
    assert limited.status_code == 429 and int(limited.headers["retry-after"]) > 0


async def test_local_mode_never_touches_identity(api_client, fake_issuer, monkeypatch, scoretech) -> None:
    monkeypatch.setattr(scoretech, "auth_provider", "local")
    response = await api_client.get("/v1/auth/identity/login")
    assert response.status_code == 303
    assert response.headers["location"].endswith("/authentication?identity_error=unavailable")
    callback = await api_client.get("/v1/auth/identity/callback", params={"state": "a" * 64, "code": "c"})
    assert callback.headers["location"].endswith("identity_error=unavailable")
    assert fake_issuer.requests == []


async def test_no_log_line_carries_a_code_token_or_email(browser, fake_issuer, db_session, caplog) -> None:
    _, _, person = await known_user(db_session, fake_issuer, email="private.person@example.invalid")
    with caplog.at_level(logging.DEBUG):
        begun = await start(browser)
        query = fake_issuer.authorize(begun.headers["location"], person)
        await browser.get("/v1/auth/identity/callback", params=query)
    ours = [r for r in caplog.records if r.name.startswith(("openbinding_gateway", "uvicorn"))]
    text = "\n".join(record.getMessage() for record in ours)
    for secret in (query["code"], query["state"], "private.person@example.invalid", *fake_issuer.refresh_tokens):
        assert secret not in text

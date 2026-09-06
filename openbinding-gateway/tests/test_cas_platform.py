"""Universidad de Sevilla CAS validation, replay safety and account lifecycle."""

from __future__ import annotations

import uuid
from urllib.parse import parse_qs, urlparse

import pytest
import pytest_asyncio

from openbinding_gateway import space_client
from openbinding_gateway.cas import (
    CasPrincipal,
    MemoryOneTimeStore,
    parse_service_validate,
    set_cas_store,
)
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.main import app
from openbinding_gateway.routes import cas as cas_routes
from _pricing import fake_pricing_gate, pricing_catalog


@pytest_asyncio.fixture
async def cas_environment():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    store = MemoryOneTimeStore()
    set_cas_store(store)
    settings = Settings(
        _env_file=None,
        cas_enabled=True,
        cas_environment="preproduction",
        cas_store_backend="memory",
        public_base_url="https://openbinding.example",
        frontend_url="https://app.openbinding.example",
        gateway_jwt_secret="cas-test-secret-that-is-at-least-32-bytes",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    yield gate, store
    app.dependency_overrides.pop(get_settings, None)
    set_cas_store(None)
    space_client.set_gate(previous)


def test_cas_xml_attributes_are_case_insensitive() -> None:
    principal = parse_service_validate(
        b"""<?xml version="1.0"?>
<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
  <cas:authenticationSuccess>
    <cas:user>UVUS42</cas:user>
    <cas:attributes><cas:MAIL>Person@us.es</cas:MAIL><cas:givenName>Ana</cas:givenName></cas:attributes>
  </cas:authenticationSuccess>
</cas:serviceResponse>"""
    )
    assert principal.subject == "UVUS42"
    assert principal.attributes == {"mail": "Person@us.es", "givenname": "Ana"}


@pytest.mark.parametrize(
    "payload",
    [
        b'<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><x>&leak;</x>',
        b"<!ENTITY leak 'value'><x/>",
    ],
)
def test_cas_xml_entities_and_dtds_are_rejected(payload: bytes) -> None:
    with pytest.raises(ValueError, match="Unsafe"):
        parse_service_validate(payload)


async def test_memory_state_is_single_use_and_expires(monkeypatch) -> None:
    moment = 10.0
    monkeypatch.setattr("openbinding_gateway.cas.time.monotonic", lambda: moment)
    store = MemoryOneTimeStore()
    await store.put("state", "replay", {"value": 1}, ttl=10)
    assert await store.pop("state", "replay") == {"value": 1}
    assert await store.pop("state", "replay") is None

    await store.put("state", "expired", {"value": 2}, ttl=10)
    moment = 21.0
    assert await store.pop("state", "expired") is None


async def _account(client, registration):
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    logged = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert created.status_code == 201 and logged.status_code == 200
    return created.json(), {"Authorization": f"Bearer {logged.json()['access_token']}"}


def _state(location: str) -> str:
    service = parse_qs(urlparse(location).query)["service"][0]
    return parse_qs(urlparse(service).query)["state"][0]


async def test_linking_cas_assigns_research_and_unlink_requires_typed_confirmation(
    api_client, registration, cas_environment, monkeypatch
) -> None:
    profile, headers = await _account(api_client, registration)

    async def validated(_settings, _state, _ticket):
        return CasPrincipal(
            subject="uvus-person",
            attributes={"mail": profile["email"].upper()},
        )

    monkeypatch.setattr(cas_routes, "_validated_principal", validated)
    started = await api_client.get(
        "/v1/auth/cas/start?mode=link", headers=headers, follow_redirects=False
    )
    assert started.status_code == 307
    assert started.headers["location"].startswith("https://ssopre.us.es/CAS/login?")
    callback = await api_client.get(
        "/v1/auth/cas/callback",
        params={"state": _state(started.headers["location"]), "ticket": "ST-1"},
        follow_redirects=False,
    )
    code = parse_qs(urlparse(callback.headers["location"]).query)["code"][0]
    exchanged = await api_client.post("/v1/auth/cas/exchange", json={"code": code})
    replay = await api_client.post("/v1/auth/cas/exchange", json={"code": code})
    linked_headers = {"Authorization": f"Bearer {exchanged.json()['access_token']}"}
    linked = await api_client.get("/v1/users/me", headers=linked_headers)
    identities = await api_client.get("/v1/users/me/identities", headers=linked_headers)
    identity_id = identities.json()[0]["id"]

    unconfirmed = await api_client.delete(
        f"/v1/users/me/identities/{identity_id}", headers=linked_headers
    )
    removed = await api_client.delete(
        f"/v1/users/me/identities/{identity_id}",
        headers=linked_headers,
        params={"confirmation": "DOWNGRADE RESEARCH"},
    )
    downgraded = await api_client.get("/v1/users/me", headers=linked_headers)

    assert callback.status_code == 303
    assert exchanged.status_code == 200
    assert replay.status_code == 401
    assert linked.json()["plan"] == "RESEARCH"
    assert unconfirmed.status_code == 409
    assert unconfirmed.json()["detail"]["code"] == "research_downgrade_confirmation_required"
    assert removed.status_code == 204
    assert downgraded.json()["plan"] == pricing_catalog().default_plan


async def test_link_intent_allows_navigation_without_putting_a_jwt_in_the_url(
    api_client, registration, cas_environment
) -> None:
    _, headers = await _account(api_client, registration)
    intent = await api_client.post("/v1/auth/cas/link-intent", headers=headers)

    assert intent.status_code == 200
    assert "Bearer" not in intent.json()["url"]
    assert "token" not in intent.json()["url"].casefold()
    route = intent.json()["url"].removeprefix("/api")
    started = await api_client.get(route, follow_redirects=False)
    replay = await api_client.get(route, follow_redirects=False)

    assert started.status_code == 307
    assert replay.status_code == 401
    assert replay.json()["detail"]["code"] == "cas_link_intent_invalid"


async def test_cas_never_auto_links_an_existing_email(
    api_client, registration, cas_environment, monkeypatch
) -> None:
    profile, _ = await _account(api_client, registration)

    async def validated(_settings, _state, _ticket):
        return CasPrincipal(subject=f"other-{uuid.uuid4().hex[:8]}", attributes={"mail": profile["email"]})

    monkeypatch.setattr(cas_routes, "_validated_principal", validated)
    started = await api_client.get("/v1/auth/cas/start", follow_redirects=False)
    collision = await api_client.get(
        "/v1/auth/cas/callback",
        params={"state": _state(started.headers["location"]), "ticket": "ST-2"},
        follow_redirects=False,
    )
    assert collision.status_code == 409
    assert collision.json()["detail"]["code"] == "account_collision"

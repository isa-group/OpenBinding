"""B2 #14 and #15: CAS failures come back as ``?error=<code>``; a plan change is reported.

The callback is a browser navigation, so a JSON error would strand the person
on the gateway's host. Every failure now returns to the frontend with a code
from a closed list, and the destination is configuration, never request input.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select

from openbinding_gateway import space_client
from openbinding_gateway.cas import CasPrincipal, MemoryOneTimeStore, set_cas_store
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.models import AuditEvent, AuthIdentity, User
from openbinding_gateway.main import app
from openbinding_gateway.models.errors import api_error
from openbinding_gateway.routes import cas as cas_routes
from openbinding_gateway.routes.cas import CAS_ERROR_CODES
from _pricing import fake_pricing_gate, largest_plan, pricing_catalog

FRONTEND = "https://app.openbinding.example"
CALLBACK_PREFIX = f"{FRONTEND}/auth/cas/callback?"
DEFAULT_PLAN = pricing_catalog().default_plan


def make_settings(**overrides) -> Settings:
    values = dict(
        _env_file=None,
        cas_enabled=True,
        cas_environment="preproduction",
        cas_store_backend="memory",
        public_base_url="https://openbinding.example",
        frontend_url=FRONTEND,
        gateway_jwt_secret="cas-test-secret-that-is-at-least-32-bytes",
    )
    values.update(overrides)
    return Settings(**values)


@pytest_asyncio.fixture
async def cas_environment():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    set_cas_store(MemoryOneTimeStore())
    settings = make_settings()
    app.dependency_overrides[get_settings] = lambda: settings
    yield gate
    app.dependency_overrides.pop(get_settings, None)
    set_cas_store(None)
    space_client.set_gate(previous)


async def account(client, registration) -> tuple[dict, dict]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    logged = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert created.status_code == 201 and logged.status_code == 200
    return created.json(), {"Authorization": f"Bearer {logged.json()['access_token']}"}


def state_of(location: str) -> str:
    service = parse_qs(urlparse(location).query)["service"][0]
    return parse_qs(urlparse(service).query)["state"][0]


def query_of(response) -> dict[str, str]:
    location = response.headers["location"]
    assert location.startswith(CALLBACK_PREFIX), location
    return {key: values[0] for key, values in parse_qs(urlparse(location).query).items()}


def principal_is(monkeypatch, subject: str, **attributes) -> None:
    async def validated(_settings, _state, _ticket):
        return CasPrincipal(subject=subject, attributes=attributes)

    monkeypatch.setattr(cas_routes, "_validated_principal", validated)


async def callback(client, mode: str = "login", headers=None, ticket: str = "ST-1"):
    started = await client.get(
        f"/v1/auth/cas/start?mode={mode}", headers=headers or {}, follow_redirects=False
    )
    assert started.status_code == 307, started.text
    return await client.get(
        "/v1/auth/cas/callback",
        params={"state": state_of(started.headers["location"]), "ticket": ticket},
        follow_redirects=False,
    )


async def link(client, headers, monkeypatch, subject: str, **attributes):
    principal_is(monkeypatch, subject, **attributes)
    return await callback(client, "link", headers)


async def exchange(client, response) -> dict:
    code = query_of(response)["code"]
    exchanged = await client.post("/v1/auth/cas/exchange", json={"code": code})
    assert exchanged.status_code == 200, exchanged.text
    return exchanged.json()


async def audit(db_session, action: str) -> list[AuditEvent]:
    return list((await db_session.execute(select(AuditEvent).where(AuditEvent.action == action))).scalars())


# -- #14: failures redirect with a stable code --------------------------------


def fake_http(result):
    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, params=None):
            if isinstance(result, Exception):
                raise result
            return SimpleNamespace(content=result, raise_for_status=lambda: None)

    return SimpleNamespace(AsyncClient=Client, HTTPError=httpx.HTTPError)


REFUSED = (
    b'<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">'
    b'<cas:authenticationFailure code="INVALID_TICKET">Ticket ST-1 not recognized</cas:authenticationFailure>'
    b"</cas:serviceResponse>"
)


async def test_a_ticket_the_university_refuses_redirects_with_cas_ticket_invalid(
    api_client, cas_environment, monkeypatch
):
    monkeypatch.setattr(cas_routes, "httpx", fake_http(REFUSED))

    response = await callback(api_client)

    assert response.status_code == 303
    assert query_of(response) == {"error": "cas_ticket_invalid"}


async def test_an_unreachable_university_redirects_with_cas_unavailable(
    api_client, cas_environment, monkeypatch
):
    monkeypatch.setattr(cas_routes, "httpx", fake_http(httpx.ConnectError("no route")))

    response = await callback(api_client)

    assert response.status_code == 303
    assert query_of(response) == {"error": "cas_unavailable"}


async def test_a_disabled_cas_redirects_with_cas_unavailable(api_client, cas_environment):
    disabled = make_settings(cas_enabled=False)
    app.dependency_overrides[get_settings] = lambda: disabled

    response = await api_client.get(
        "/v1/auth/cas/callback", params={"state": "x", "ticket": "y"}, follow_redirects=False
    )

    assert response.status_code == 303
    assert query_of(response) == {"error": "cas_unavailable"}


async def test_an_unknown_replayed_or_missing_state_redirects_with_cas_state_invalid(
    api_client, cas_environment, monkeypatch
):
    principal_is(monkeypatch, "uvus-state")
    unknown = await api_client.get(
        "/v1/auth/cas/callback", params={"state": "never-issued", "ticket": "ST-1"}, follow_redirects=False
    )
    started = await api_client.get("/v1/auth/cas/start", follow_redirects=False)
    state = state_of(started.headers["location"])
    first = await api_client.get(
        "/v1/auth/cas/callback", params={"state": state, "ticket": "ST-1"}, follow_redirects=False
    )
    replay = await api_client.get(
        "/v1/auth/cas/callback", params={"state": state, "ticket": "ST-1"}, follow_redirects=False
    )
    no_state = await api_client.get("/v1/auth/cas/callback", params={"ticket": "ST-1"}, follow_redirects=False)
    nothing = await api_client.get("/v1/auth/cas/callback", follow_redirects=False)

    assert query_of(unknown) == {"error": "cas_state_invalid"}
    assert "code" in query_of(first)
    assert query_of(replay) == {"error": "cas_state_invalid"}
    assert query_of(no_state) == {"error": "cas_state_invalid"}
    assert query_of(nothing) == {"error": "cas_state_invalid"}
    assert all(r.status_code == 303 for r in (unknown, replay, no_state, nothing))


async def test_a_missing_ticket_redirects_with_cas_ticket_invalid(api_client, cas_environment):
    started = await api_client.get("/v1/auth/cas/start", follow_redirects=False)

    response = await api_client.get(
        "/v1/auth/cas/callback", params={"state": state_of(started.headers["location"])}, follow_redirects=False
    )

    assert response.status_code == 303
    assert query_of(response) == {"error": "cas_ticket_invalid"}


async def test_a_deactivated_cas_account_redirects_with_account_inactive(
    api_client, registration, cas_environment, monkeypatch, db_session
):
    profile, headers = await account(api_client, registration)
    await link(api_client, headers, monkeypatch, "uvus-gone")
    (await db_session.get(User, uuid.UUID(profile["id"]))).is_active = False
    await db_session.flush()
    principal_is(monkeypatch, "uvus-gone")

    response = await callback(api_client, "login")

    assert response.status_code == 303
    assert query_of(response) == {"error": "account_inactive"}


async def test_linking_for_an_account_deactivated_mid_flow_redirects_with_account_inactive(
    api_client, registration, cas_environment, monkeypatch, db_session
):
    profile, headers = await account(api_client, registration)
    principal_is(monkeypatch, "uvus-midflow")
    started = await api_client.get("/v1/auth/cas/start?mode=link", headers=headers, follow_redirects=False)
    (await db_session.get(User, uuid.UUID(profile["id"]))).is_active = False
    await db_session.flush()

    response = await api_client.get(
        "/v1/auth/cas/callback",
        params={"state": state_of(started.headers["location"]), "ticket": "ST-1"},
        follow_redirects=False,
    )

    assert query_of(response) == {"error": "account_inactive"}
    assert (await db_session.scalar(select(AuthIdentity.id).where(AuthIdentity.subject == "uvus-midflow"))) is None


async def test_an_identity_linked_to_another_account_redirects_with_identity_in_use(
    api_client, registration, cas_environment, monkeypatch, db_session
):
    _, first = await account(api_client, registration)
    second, second_headers = await account(api_client, registration)
    await link(api_client, first, monkeypatch, "uvus-shared")

    response = await link(api_client, second_headers, monkeypatch, "uvus-shared")

    assert response.status_code == 303
    assert query_of(response) == {"error": "identity_in_use"}
    # The refused link changed nothing for the second account.
    me = await api_client.get("/v1/users/me", headers=second_headers)
    assert me.json()["plan"] == DEFAULT_PLAN
    assert me.json()["cas_verified"] is False


async def test_an_existing_email_redirects_with_account_collision(
    api_client, registration, cas_environment, monkeypatch
):
    profile, _ = await account(api_client, registration)
    principal_is(monkeypatch, f"other-{uuid.uuid4().hex[:8]}", mail=profile["email"])

    response = await callback(api_client)

    assert response.status_code == 303
    assert query_of(response) == {"error": "account_collision"}


async def test_a_pricing_outage_redirects_with_pricing_unavailable(
    api_client, registration, cas_environment, monkeypatch
):
    _, headers = await account(api_client, registration)
    principal_is(monkeypatch, "uvus-pricing")
    started = await api_client.get("/v1/auth/cas/start?mode=link", headers=headers, follow_redirects=False)
    cas_environment.unavailable = True

    response = await api_client.get(
        "/v1/auth/cas/callback",
        params={"state": state_of(started.headers["location"]), "ticket": "ST-1"},
        follow_redirects=False,
    )
    cas_environment.unavailable = False

    assert response.status_code == 303
    assert query_of(response) == {"error": "pricing_unavailable"}


async def test_a_research_plan_space_refuses_redirects_with_pricing_unavailable(
    api_client, registration, cas_environment, monkeypatch
):
    """SPACE, not the gateway, knows whether the deployed version has a RESEARCH plan."""
    _, headers = await account(api_client, registration)
    principal_is(monkeypatch, "uvus-nopricing")
    started = await api_client.get("/v1/auth/cas/start?mode=link", headers=headers, follow_redirects=False)

    async def refused(*_args, **_kwargs):
        raise space_client.SubscriptionRejected("RESEARCH is not declared by this pricing version")

    monkeypatch.setattr(cas_environment, "change_plan", refused)
    response = await api_client.get(
        "/v1/auth/cas/callback",
        params={"state": state_of(started.headers["location"]), "ticket": "ST-1"},
        follow_redirects=False,
    )

    assert query_of(response) == {"error": "pricing_unavailable"}


async def test_an_error_the_list_does_not_know_collapses_to_cas_error(
    api_client, cas_environment, monkeypatch
):
    async def refused(_settings, _state, _ticket):
        raise api_error(500, "something_internal", "do not leak this")

    monkeypatch.setattr(cas_routes, "_validated_principal", refused)

    response = await callback(api_client)

    assert response.status_code == 303
    assert query_of(response) == {"error": "cas_error"}
    assert "something_internal" not in response.headers["location"]
    assert "leak" not in response.headers["location"]


async def test_an_unexpected_exception_also_ends_as_a_cas_error_redirect(
    api_client, cas_environment, monkeypatch
):
    async def broken(_settings, _state, _ticket):
        raise RuntimeError("database is on fire")

    monkeypatch.setattr(cas_routes, "_validated_principal", broken)

    response = await callback(api_client)

    assert response.status_code == 303
    assert query_of(response) == {"error": "cas_error"}
    assert "fire" not in response.headers["location"]


async def test_the_redirect_destination_never_comes_from_the_request(
    api_client, cas_environment, monkeypatch
):
    principal_is(monkeypatch, "uvus-hostile")
    hostile = {
        "state": "https://evil.example/steal",
        "ticket": "ST-1\r\nLocation: https://evil.example",
        "redirect": "https://evil.example",
        "next": "//evil.example",
        "frontend_url": "https://evil.example",
        "error": "https://evil.example",
    }

    failed = await api_client.get(
        "/v1/auth/cas/callback",
        params=hostile,
        headers={"Origin": "https://evil.example", "Host": "evil.example", "Referer": "https://evil.example/"},
        follow_redirects=False,
    )
    started = await api_client.get("/v1/auth/cas/start", follow_redirects=False)
    succeeded = await api_client.get(
        "/v1/auth/cas/callback",
        params={**hostile, "state": state_of(started.headers["location"])},
        headers={"Origin": "https://evil.example", "Host": "evil.example"},
        follow_redirects=False,
    )

    for response in (failed, succeeded):
        assert response.status_code == 303
        location = response.headers["location"]
        assert location.startswith(CALLBACK_PREFIX)
        assert urlparse(location).netloc == "app.openbinding.example"
        assert "evil.example" not in location
    assert query_of(failed) == {"error": "cas_state_invalid"}
    assert "code" in query_of(succeeded)


async def test_every_redirected_error_is_in_the_closed_list(api_client, cas_environment, monkeypatch):
    seen = set()
    for raised in (
        api_error(401, "cas_ticket_invalid", "x"),
        api_error(503, "cas_unavailable", "x"),
        api_error(401, "unauthorized", "legacy name"),
        api_error(409, "last_login_method", "unrelated"),
        RuntimeError("boom"),
    ):
        async def failing(_settings, _state, _ticket, raised=raised):
            raise raised

        monkeypatch.setattr(cas_routes, "_validated_principal", failing)
        seen.add(query_of(await callback(api_client))["error"])

    assert seen == {"cas_ticket_invalid", "cas_unavailable", "cas_error"}
    assert seen <= set(CAS_ERROR_CODES)
    assert len(CAS_ERROR_CODES) == len(set(CAS_ERROR_CODES))


def test_the_openapi_document_lists_every_error_code_and_the_redirect():
    operation = app.openapi()["paths"]["/v1/auth/cas/callback"]["get"]

    assert "303" in operation["responses"]
    description = operation["responses"]["303"]["description"]
    for code in CAS_ERROR_CODES:
        assert f"`{code}`" in description
    assert "plan_changed" in description
    assert "Location" in operation["responses"]["303"]["headers"]
    parameters = {parameter["name"]: parameter for parameter in operation["parameters"]}
    assert set(parameters) == {"state", "ticket"}


async def test_a_successful_callback_still_redirects_with_only_a_code(
    api_client, registration, cas_environment, monkeypatch
):
    profile, headers = await account(api_client, registration)

    response = await link(api_client, headers, monkeypatch, "uvus-ok")

    assert response.status_code == 303
    assert set(query_of(response)) <= {"code", "plan_changed"}
    assert "error" not in query_of(response)


# -- #15: the plan change is reported ------------------------------------------


async def test_linking_from_the_default_plan_reports_plan_changed_everywhere(
    api_client, registration, cas_environment, monkeypatch, db_session
):
    profile, headers = await account(api_client, registration)

    response = await link(api_client, headers, monkeypatch, "uvus-upgrade")
    query = query_of(response)
    session = await exchange(api_client, response)
    me = await api_client.get(
        "/v1/users/me", headers={"Authorization": f"Bearer {session['access_token']}"}
    )

    assert query["plan_changed"] == "RESEARCH"
    assert session["plan_changed"] == {"from": DEFAULT_PLAN, "to": "RESEARCH", "extra_cost": False}
    assert session["token_type"] == "bearer" and session["access_token"] and session["refresh_token"]
    assert me.json()["plan"] == "RESEARCH"
    assert me.json()["cas_verified"] is True
    linked = await audit(db_session, "account.cas.linked")
    assert len(linked) == 1
    assert str(linked[0].actor_id) == profile["id"] and str(linked[0].target_id) == profile["id"]
    assert linked[0].detail["provider"] == "us-cas"
    assert linked[0].detail["plan_changed"] == {"from": DEFAULT_PLAN, "to": "RESEARCH", "extra_cost": False}
    # No identity attribute (UVUS, mail) is copied into the event.
    assert "uvus-upgrade" not in str(linked[0].detail)


async def test_the_link_intent_flow_reports_the_change_too(
    api_client, registration, cas_environment, monkeypatch
):
    _, headers = await account(api_client, registration)
    principal_is(monkeypatch, "uvus-intent")
    intent = await api_client.post("/v1/auth/cas/link-intent", headers=headers)
    started = await api_client.get(intent.json()["url"].removeprefix("/api"), follow_redirects=False)

    response = await api_client.get(
        "/v1/auth/cas/callback",
        params={"state": state_of(started.headers["location"]), "ticket": "ST-1"},
        follow_redirects=False,
    )
    session = await exchange(api_client, response)

    assert query_of(response)["plan_changed"] == "RESEARCH"
    assert session["plan_changed"]["from"] == DEFAULT_PLAN
    assert session["plan_changed"]["extra_cost"] is False


async def test_an_account_already_on_research_gets_no_plan_changed(
    api_client, registration, cas_environment, monkeypatch, db_session
):
    profile, headers = await account(api_client, registration)
    cas_environment.plans[uuid.UUID(profile["id"])] = "RESEARCH"

    response = await link(api_client, headers, monkeypatch, "uvus-already")
    session = await exchange(api_client, response)

    assert "plan_changed" not in query_of(response)
    assert session["plan_changed"] is None
    me = await api_client.get(
        "/v1/users/me", headers={"Authorization": f"Bearer {session['access_token']}"}
    )
    assert me.json()["plan"] == "RESEARCH"
    linked = await audit(db_session, "account.cas.linked")
    assert len(linked) == 1 and linked[0].detail["plan_changed"] is None


async def test_an_account_on_another_plan_keeps_it_and_reports_nothing(
    api_client, registration, cas_environment, monkeypatch
):
    profile, headers = await account(api_client, registration)
    cas_environment.plans[uuid.UUID(profile["id"])] = largest_plan()

    response = await link(api_client, headers, monkeypatch, "uvus-other-plan")
    session = await exchange(api_client, response)

    assert "plan_changed" not in query_of(response)
    assert session["plan_changed"] is None
    assert cas_environment.plans[uuid.UUID(profile["id"])] == largest_plan()


async def test_signing_in_with_an_already_linked_identity_reports_nothing(
    api_client, registration, cas_environment, monkeypatch
):
    _, headers = await account(api_client, registration)
    await link(api_client, headers, monkeypatch, "uvus-again")
    principal_is(monkeypatch, "uvus-again")

    response = await callback(api_client, "login")
    session = await exchange(api_client, response)

    assert "plan_changed" not in query_of(response)
    assert session["plan_changed"] is None


async def test_a_new_cas_account_is_created_on_research_without_a_plan_change(
    api_client, cas_environment, monkeypatch
):
    principal_is(monkeypatch, f"uvus-new-{uuid.uuid4().hex[:6]}", mail=f"{uuid.uuid4().hex[:8]}@us.es")

    response = await callback(api_client, "login")
    session = await exchange(api_client, response)
    me = await api_client.get(
        "/v1/users/me", headers={"Authorization": f"Bearer {session['access_token']}"}
    )

    assert "plan_changed" not in query_of(response)
    assert session["plan_changed"] is None
    assert me.json()["plan"] == "RESEARCH"


async def test_unlinking_keeps_its_logic_and_a_later_relink_reports_the_change_again(
    api_client, registration, cas_environment, monkeypatch
):
    _, headers = await account(api_client, registration)
    first = await exchange(api_client, await link(api_client, headers, monkeypatch, "uvus-cycle"))
    session_headers = {"Authorization": f"Bearer {first['access_token']}"}
    identities = await api_client.get("/v1/users/me/identities", headers=session_headers)
    identity_id = identities.json()[0]["id"]

    unconfirmed = await api_client.delete(f"/v1/users/me/identities/{identity_id}", headers=session_headers)
    removed = await api_client.delete(
        f"/v1/users/me/identities/{identity_id}",
        headers=session_headers,
        params={"confirmation": "DOWNGRADE RESEARCH"},
    )
    downgraded = await api_client.get("/v1/users/me", headers=session_headers)
    relinked = await exchange(api_client, await link(api_client, session_headers, monkeypatch, "uvus-cycle"))

    assert first["plan_changed"]["to"] == "RESEARCH"
    assert unconfirmed.status_code == 409
    assert unconfirmed.json()["detail"]["code"] == "research_downgrade_confirmation_required"
    assert removed.status_code == 204
    assert downgraded.json()["plan"] == DEFAULT_PLAN
    assert relinked["plan_changed"] == {"from": DEFAULT_PLAN, "to": "RESEARCH", "extra_cost": False}


def test_the_openapi_document_describes_plan_changed():
    schemas = app.openapi()["components"]["schemas"]

    exchange_schema = schemas["CasSession"]
    plan_change = schemas["PlanChange"]
    assert "plan_changed" in exchange_schema["properties"]
    assert set(plan_change["properties"]) == {"from", "to", "extra_cost"}
    extra_cost = plan_change["properties"]["extra_cost"]
    assert extra_cost["type"] == "boolean" and extra_cost["default"] is False
    assert "no extra charge" in extra_cost["description"]
    operation = app.openapi()["paths"]["/v1/auth/cas/exchange"]["post"]
    assert operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith("/CasSession")

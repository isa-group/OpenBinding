"""A pricing service that cannot be read is a fixed 503 with a ``correlationId``, never its own words.

SPACE and SPHERE report failures in text that quotes the host, the address or the
body of the other side. The routes that depend on them answer ``503
pricing_unavailable`` with a fixed sentence (to an anonymous caller too), the
refusal of a novation stays ``422 invalid_subscription`` with a fixed sentence,
and the reason is in the log, masked, under the id the 5xx carries. The
administrator reads no more than anybody else: the reason is found by id.

Nothing here talks to SPACE or SPHERE: the gates are local doubles and SPHERE is
an ``httpx.MockTransport`` or a stub of ``published_pricing``.
"""

from __future__ import annotations

import functools
import logging
import re
import uuid
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select

from _fake_space import FakePricingGate
from _pricing import largest_plan, pricing_catalog
from openbinding_gateway import pricing_catalog as catalog_module
from openbinding_gateway import space_client
from openbinding_gateway.core import public_errors
from openbinding_gateway.core.public_errors import (
    INVALID_SUBSCRIPTION,
    PRICING_UNAVAILABLE,
    PUBLISHED_PRICING_UNAVAILABLE,
)
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.models import User, UserRole
from openbinding_gateway.main import app
from openbinding_gateway.pricing_catalog import PricingCatalogError, published_pricing
from openbinding_gateway.routes import pricing as pricing_routes
from openbinding_gateway.services.entitlements import EntitlementsUnavailable, entitlement_service
from openbinding_gateway.space_client import (
    PricingUnavailable,
    SpacePricingGate,
    SubscriptionRejected,
)

SRC = Path(public_errors.__file__).parents[1]
HEX32 = re.compile(r"^[0-9a-f]{32}$")

SPACE_HOST = "space.internal.corp"
SPACE_ADDRESS = "10.9.8.7"
SPHERE_HOST = "sphere.internal.corp"
REASON = f"SPACE is not reachable: HTTPSConnectionPool(host='{SPACE_HOST}', port=443) via {SPACE_ADDRESS}"
LEAKS = (SPACE_HOST, SPACE_ADDRESS, SPHERE_HOST, "HTTPSConnectionPool", "not reachable", "ConnectError")


class DownGate(FakePricingGate):
    """A SPACE that is down and says so with what it knows: the host and the address."""

    def _check_available(self):
        raise PricingUnavailable(REASON)


class RefusingGate(FakePricingGate):
    """A SPACE that does not accept the novation and says why in its own words."""

    async def change_subscription(self, user_id, plan, add_ons, pricing_version=None):
        raise SubscriptionRejected(f"{SPACE_HOST} refused plan {plan!r}: add-on 'x' is not in pricing 9.9.9")


@pytest.fixture
def logs(caplog, monkeypatch) -> pytest.LogCaptureFixture:
    """The log of the reason, even after a test that configured logging in-process (alembic does)."""
    monkeypatch.setattr(public_errors.logger, "disabled", False)
    caplog.set_level(logging.INFO)
    return caplog


def logged(caplog) -> str:
    return "\n".join(record.getMessage() for record in caplog.records)


async def account(client, registration, db_session=None, *, admin=False) -> tuple[dict, dict]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    if admin:
        user = (await db_session.execute(select(User).where(User.username == details["username"]))).scalars().one()
        user.role = UserRole.ADMIN
        await db_session.flush()
    tokens = await client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]}
    )
    return created.json(), {"Authorization": f"Bearer {tokens.json()['access_token']}"}


def down() -> DownGate:
    return DownGate(pricing_catalog())


def assert_a_fixed_503(response, sentence: str) -> None:
    assert response.status_code == 503, response.text
    body = response.json()
    assert body["detail"]["code"] == "pricing_unavailable" and body["code"] == "pricing_unavailable"
    assert body["detail"]["error"].endswith(sentence)
    assert HEX32.match(body["correlationId"]), body
    for leak in LEAKS:
        assert leak not in response.text, leak


def assert_the_reason_is_in_the_log(logs, response) -> None:
    log = logged(logs)
    assert f"correlation_id={response.json()['correlationId']}" in log
    assert "PricingUnavailable" in log and "SPACE is not reachable" in log
    assert SPACE_HOST not in log and SPACE_ADDRESS not in log, "the host and the address are masked in the log too"


# -- The routes of an account ------------------------------------------------------------


async def test_the_pricing_token_503_is_fixed_and_carries_the_correlation_id(api_client, registration, logs):
    _, headers = await account(api_client, registration)
    space_client.set_gate(down())

    response = await api_client.get("/v1/users/me/pricing-token", headers=headers)

    assert_a_fixed_503(response, PRICING_UNAVAILABLE.detail)
    assert response.json()["detail"]["error"] == f"A pricing token cannot be issued right now: {PRICING_UNAVAILABLE.detail}"
    assert_the_reason_is_in_the_log(logs, response)


@pytest.mark.parametrize("path", ["/v1/users/me", "/v1/users/me/usage"])
async def test_the_account_routes_503_is_fixed(api_client, registration, logs, path):
    _, headers = await account(api_client, registration)
    space_client.set_gate(down())

    response = await api_client.get(path, headers=headers)

    assert_a_fixed_503(response, PRICING_UNAVAILABLE.detail)
    assert "SPACE is not reachable" in logged(logs)
    assert SPACE_HOST not in logged(logs)


async def test_deleting_an_account_when_the_contract_cannot_be_removed_is_a_fixed_503(
    api_client, registration, logs
):
    profile, headers = await account(api_client, registration)
    gate = FakePricingGate(pricing_catalog())
    space_client.set_gate(gate)

    async def remove_contract(user_id):
        raise PricingUnavailable(REASON)

    gate.remove_contract = remove_contract
    response = await api_client.request(
        "DELETE",
        "/v1/users/me",
        headers=headers,
        json={"confirmation": profile["username"], "current_password": "correct-horse-battery"},
    )

    assert_a_fixed_503(response, PRICING_UNAVAILABLE.detail)
    assert "SPACE is not reachable" in logged(logs)


# -- The entitlement service ---------------------------------------------------------------


async def test_entitlements_that_cannot_be_read_say_a_fixed_sentence_to_every_caller(logs):
    space_client.set_gate(down())

    with pytest.raises(EntitlementsUnavailable) as raised:
        await entitlement_service.caps_for(uuid.uuid4())

    assert str(raised.value) == PRICING_UNAVAILABLE.detail, "callers put str() of this in their 503 documents"
    assert isinstance(raised.value.__cause__, PricingUnavailable) and REASON in str(raised.value.__cause__)
    assert "SPACE is not reachable" in logged(logs) and SPACE_HOST not in logged(logs)
    assert raised.value.to_http().detail == {"code": "pricing_unavailable", "error": PRICING_UNAVAILABLE.detail}


# -- The administration -----------------------------------------------------------------------


async def test_an_administrator_reads_the_same_fixed_503_and_not_the_reason(
    api_client, registration, db_session, logs
):
    target, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    space_client.set_gate(down())

    for method, path, body in (
        ("GET", "/v1/admin/users?limit=50", None),
        ("GET", f"/v1/admin/users/{target['id']}/subscription", None),
        ("PATCH", f"/v1/admin/users/{target['id']}", {"is_active": True}),
        ("POST", f"/v1/admin/users/{target['id']}/plan", {"plan": largest_plan()}),
    ):
        response = await api_client.request(method, path, headers=admin, json=body)

        assert response.status_code == 503, (path, response.text)
        assert response.json()["detail"]["code"] == "pricing_unavailable", path
        assert HEX32.match(response.json()["correlationId"]), path
        for leak in LEAKS:
            assert leak not in response.text, (path, leak)

    assert "SPACE is not reachable" in logged(logs) and SPACE_HOST not in logged(logs)


async def test_a_novation_in_an_outage_is_a_fixed_503(api_client, registration, db_session, logs):
    target, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    healthy = FakePricingGate(pricing_catalog())
    space_client.set_gate(healthy)

    async def unavailable(user_id, plan, add_ons, pricing_version=None):
        raise PricingUnavailable(REASON)

    healthy.change_subscription = unavailable
    response = await api_client.post(
        f"/v1/admin/users/{target['id']}/plan", headers=admin, json={"plan": largest_plan()}
    )

    assert_a_fixed_503(response, PRICING_UNAVAILABLE.detail)
    assert response.json()["detail"]["error"].startswith("The subscription cannot be changed right now")


async def test_a_refused_novation_keeps_its_code_and_says_a_fixed_sentence(
    api_client, registration, db_session, logs
):
    target, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    space_client.set_gate(RefusingGate(pricing_catalog()))

    response = await api_client.post(
        f"/v1/admin/users/{target['id']}/plan", headers=admin, json={"plan": largest_plan()}
    )

    assert response.status_code == 422, response.text
    # A 422 is a problem document: the code and the sentence at the top level, as for any validation refusal.
    assert response.json()["code"] == "invalid_subscription"
    assert response.json()["detail"] == INVALID_SUBSCRIPTION.detail
    for leak in (SPACE_HOST, "9.9.9", "add-on 'x'"):
        assert leak not in response.text, leak
    log = logged(logs)
    assert "SubscriptionRejected" in log and "refused plan" in log, "the reason of SPACE is in the log"
    assert SPACE_HOST not in log


# -- The published pricing, to anyone ------------------------------------------------------------


@pytest.fixture(autouse=True)
def fresh_cache():
    catalog_module.clear_cache()
    yield
    catalog_module.clear_cache()


def sphere_settings(**overrides) -> Settings:
    values = dict(
        _env_file=None,
        sphere_enabled=True,
        sphere_url=f"https://{SPHERE_HOST}",
        sphere_api_key="read-key",
        sphere_organization_id="org-1",
        space_pricing_version="0.1.0",
    )
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def sphere_is_on(monkeypatch):
    settings = sphere_settings()
    app.dependency_overrides[get_settings] = lambda: settings
    yield settings
    app.dependency_overrides.pop(get_settings, None)


PUBLIC_PATHS = ("/v1/pricing/current", "/v1/pricing/catalog", "/v1/pricing")


@pytest.mark.parametrize("path", PUBLIC_PATHS)
async def test_the_anonymous_503_is_fixed_whatever_sphere_said(api_client, sphere_is_on, monkeypatch, logs, path):
    async def unavailable(_settings):
        raise PricingCatalogError(f"SPHERE is unavailable: ConnectError to https://{SPHERE_HOST}/api/v1: {SPACE_ADDRESS}")

    monkeypatch.setattr(pricing_routes, "published_pricing", unavailable)

    response = await api_client.get(path)

    assert_a_fixed_503(response, PUBLISHED_PRICING_UNAVAILABLE.detail)
    assert response.json()["detail"]["error"] == PUBLISHED_PRICING_UNAVAILABLE.detail
    log = logged(logs)
    assert "PricingCatalogError" in log and "SPHERE is unavailable" in log
    assert SPHERE_HOST not in log and SPACE_ADDRESS not in log
    assert f"correlation_id={response.json()['correlationId']}" in log


async def test_what_the_sphere_client_wraps_is_fixed_too(api_client, sphere_is_on, monkeypatch, logs):
    def refuse(request):
        raise httpx.ConnectError(f"All connection attempts failed to {SPHERE_HOST} ({SPACE_ADDRESS})")

    monkeypatch.setattr(
        pricing_routes,
        "published_pricing",
        functools.partial(published_pricing, transport=httpx.MockTransport(refuse)),
    )

    response = await api_client.get("/v1/pricing/current")

    assert_a_fixed_503(response, PUBLISHED_PRICING_UNAVAILABLE.detail)
    log = logged(logs)
    assert "SPHERE is unavailable" in log and "ConnectError" in log
    assert SPHERE_HOST not in log and SPACE_ADDRESS not in log


async def test_what_sphere_answers_with_an_error_is_not_repeated(api_client, sphere_is_on, monkeypatch, logs):
    def answers(request):
        return httpx.Response(500, json={"error": f"database {SPHERE_HOST} is down, contact ops@{SPHERE_HOST}"})

    monkeypatch.setattr(
        pricing_routes,
        "published_pricing",
        functools.partial(published_pricing, transport=httpx.MockTransport(answers)),
    )

    response = await api_client.get("/v1/pricing/catalog")

    assert_a_fixed_503(response, PUBLISHED_PRICING_UNAVAILABLE.detail)
    assert "database" not in response.text and "ops@" not in response.text
    assert "SPHERE returned 500" in logged(logs)


async def test_without_sphere_the_reason_is_in_the_log_and_not_in_the_answer(api_client, logs):
    response = await api_client.get("/v1/pricing/current")

    assert response.status_code == 503
    assert response.json()["detail"] == {"code": "pricing_unavailable", "error": PUBLISHED_PRICING_UNAVAILABLE.detail}
    assert HEX32.match(response.json()["correlationId"])
    assert "SPHERE is not enabled" in logged(logs)


async def test_with_no_version_configured_the_answer_does_not_name_the_setting(
    api_client, monkeypatch, logs
):
    settings = sphere_settings(space_pricing_version=None)
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        response = await api_client.get("/v1/pricing/catalog")
    finally:
        app.dependency_overrides.pop(get_settings, None)

    assert_a_fixed_503(response, PUBLISHED_PRICING_UNAVAILABLE.detail)
    assert "SPACE_PRICING_VERSION" not in response.text
    assert "SPACE_PRICING_VERSION is not configured" in logged(logs)


# -- The adapters carry no host in the exception that travels -------------------------------------


class _Explodes:
    """A SPACE client whose transport fails with an operating-system error."""

    def __init__(self, error: BaseException) -> None:
        self._error = error
        self.features = self
        self.contracts = self

    def generate_user_pricing_token(self, user_id):
        raise self._error

    def get_contract(self, user_id):
        raise self._error


@pytest.mark.parametrize(
    "error",
    [
        OSError(111, f"Connect call failed ('{SPACE_ADDRESS}', 443)"),
        ConnectionRefusedError(f"[Errno 111] connect to {SPACE_HOST}:443 refused"),
        RuntimeError(f"HTTPSConnectionPool(host='{SPACE_HOST}', port=443): Max retries exceeded"),
    ],
)
async def test_the_space_adapter_does_not_carry_the_text_of_a_transport_error(error, logs):
    gate = SpacePricingGate(Settings(_env_file=None), client=_Explodes(error))

    with pytest.raises(PricingUnavailable) as raised:
        await gate.caps(uuid.uuid4())

    assert str(raised.value) == f"SPACE is not reachable ({type(error).__name__})"
    for leak in (SPACE_HOST, SPACE_ADDRESS, "Max retries", "443"):
        assert leak not in str(raised.value), leak
    log = logged(logs)
    assert type(error).__name__ in log and SPACE_HOST not in log and SPACE_ADDRESS not in log


# -- No route builds a pricing answer out of an exception ------------------------------------------


def test_no_pricing_answer_is_built_from_the_text_of_an_exception():
    """A guard for the sites no test above reaches (CAS, deletion): ``api_error(..., "pricing_unavailable", <text>)``."""
    offending = []
    for path in sorted((SRC / "routes").glob("*.py")) + [SRC / "services" / "entitlements.py"]:
        source = path.read_text(encoding="utf-8")
        for call in re.finditer(r"api_error\((?:[^()]|\([^()]*\))*\)", source):
            text = call.group(0)
            if "pricing_unavailable" in text and re.search(r"str\(|\{(error|exc|self)\}", text):
                offending.append(f"{path.name}: {' '.join(text.split())}")
    assert offending == []

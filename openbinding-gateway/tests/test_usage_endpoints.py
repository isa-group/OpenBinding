"""What an account can find out about its own entitlements, over HTTP.

Everything the interface shows about plans and quotas comes from here, because
the interface is a client of this API and not a privileged path into it. So
these check the endpoints an account page needs, and that they say the same
thing a solve will be judged by.
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from openbinding_gateway import space_client
from openbinding_gateway.space_client import FakePricingGate


@pytest_asyncio.fixture
async def gate():
    """A pricing gate installed for the duration of one test."""
    installed = FakePricingGate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


async def account(client, registration) -> tuple[dict, dict]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), {"Authorization": f"Bearer {tokens.json()['access_token']}"}


async def test_registering_puts_the_account_on_a_contract(api_client, registration, gate):
    profile, _ = await account(api_client, registration)

    import uuid

    assert uuid.UUID(profile["id"]) in gate.contracts


async def test_a_new_account_starts_on_the_free_plan(api_client, registration, gate):
    _, headers = await account(api_client, registration)

    usage = await api_client.get("/v1/users/me/usage", headers=headers)

    assert usage.status_code == 200
    assert usage.json()["plan"] == "FREE"


async def test_usage_reports_every_limit_with_what_is_left(api_client, registration, gate):
    _, headers = await account(api_client, registration)

    body = (await api_client.get("/v1/users/me/usage", headers=headers)).json()

    limits = {limit["limit_id"]: limit for limit in body["limits"]}
    assert "tasksLimit" in limits
    assert limits["tasksLimit"]["used"] == 0
    assert limits["tasksLimit"]["remaining"] == limits["tasksLimit"]["limit"]


async def test_usage_reports_the_ceilings_one_request_runs_into(api_client, registration, gate):
    # These are what the Playground needs to seed and clamp its options, so
    # they travel with the balances rather than in a second call.
    _, headers = await account(api_client, registration)

    caps = (await api_client.get("/v1/users/me/usage", headers=headers)).json()["caps"]

    assert caps["max_timeout_s"] > 0
    assert caps["max_iterations"] > 0
    assert caps["max_payload_mb"] > 0
    assert caps["max_binding_space_log10"] > 0


async def test_spending_shows_up_in_usage(api_client, registration, gate):
    profile, headers = await account(api_client, registration)

    import uuid

    gate.spend(uuid.UUID(profile["id"]), "tasksLimit", 7)
    body = (await api_client.get("/v1/users/me/usage", headers=headers)).json()

    limits = {limit["limit_id"]: limit for limit in body["limits"]}
    assert limits["tasksLimit"]["used"] == 7
    assert limits["tasksLimit"]["remaining"] == limits["tasksLimit"]["limit"] - 7


async def test_moving_to_pro_raises_what_usage_reports(api_client, registration, gate):
    profile, headers = await account(api_client, registration)
    import uuid

    before = (await api_client.get("/v1/users/me/usage", headers=headers)).json()
    await gate.change_plan(uuid.UUID(profile["id"]), "PRO")
    after = (await api_client.get("/v1/users/me/usage", headers=headers)).json()

    assert before["plan"] == "FREE"
    assert after["plan"] == "PRO"
    assert after["caps"]["max_timeout_s"] > before["caps"]["max_timeout_s"]


async def test_usage_needs_an_account(api_client, gate):
    assert (await api_client.get("/v1/users/me/usage")).status_code == 401


async def test_a_pricing_token_is_issued_to_its_owner(api_client, registration, gate):
    _, headers = await account(api_client, registration)

    response = await api_client.get("/v1/users/me/pricing-token", headers=headers)

    assert response.status_code == 200
    assert response.json()["pricing_token"]


async def test_a_pricing_token_needs_an_account(api_client, gate):
    # The browser never talks to SPACE directly, so this endpoint is the only
    # way to get one - which makes it worth guarding.
    assert (await api_client.get("/v1/users/me/pricing-token")).status_code == 401


async def test_an_api_key_works_for_these_too(api_client, registration, gate):
    # Everything the interface can do, the API channel can do. That is the
    # point of both channels resolving to the same account.
    _, headers = await account(api_client, registration)
    created = await api_client.post(
        "/v1/users/me/api-keys", headers=headers, json={"name": "a key"}
    )

    usage = await api_client.get(
        "/v1/users/me/usage", headers={"X-API-Key": created.json()["secret"]}
    )

    assert usage.status_code == 200


@pytest.mark.parametrize("path", ["/v1/users/me/usage", "/v1/users/me/pricing-token"])
async def test_an_unreachable_pricing_service_is_a_503(api_client, registration, gate, path):
    # Not a 402: the account may well have quota. Saying so would be a lie
    # about the reason, and the caller's right response is to retry.
    _, headers = await account(api_client, registration)
    gate.unavailable = True

    response = await api_client.get(path, headers=headers)

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "pricing_unavailable"


async def test_registration_survives_the_pricing_service_being_down(
    api_client, registration, gate
):
    # Losing a sign-up because a pricing service was restarting would be a
    # worse failure than a contract that arrives late.
    gate.unavailable = True

    created = await api_client.post("/v1/auth/register", json=registration())

    assert created.status_code == 201


async def test_an_account_created_without_a_contract_says_so(api_client, registration, gate):
    gate.unavailable = True
    details = registration()
    await api_client.post("/v1/auth/register", json=details)
    gate.unavailable = False

    tokens = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    body = (
        await api_client.get(
            "/v1/users/me/usage",
            headers={"Authorization": f"Bearer {tokens.json()['access_token']}"},
        )
    ).json()

    assert body["contract_pending"] is True

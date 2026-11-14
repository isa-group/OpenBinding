"""The profile shows the plan SPACE assigned when the contract was created without one.

``GET /v1/users/me`` reads the plan from the account row (``plan_cache``) and never
asks SPACE. With ``SPACE_DEFAULT_PLAN`` unset the contract is created with no plan
and SPACE assigns its default, so the gateway reads that plan once, right after the
contract exists (at registration, or when a pending contract is settled).
"""

from __future__ import annotations

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings


async def test_registration_records_the_plan_space_assigned(api_client, registration, monkeypatch):
    monkeypatch.setattr(get_settings(), "space_default_plan", "")
    details = registration()

    created = await api_client.post("/v1/auth/register", json=details)

    assert created.status_code == 201, created.text
    assert created.json()["plan"] == "FREE"
    login = await api_client.post("/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]})
    me = await api_client.get("/v1/users/me", headers={"Authorization": f"Bearer {login.json()['access_token']}"})
    assert me.status_code == 200, me.text
    assert me.json()["plan"] == "FREE"


async def test_settling_a_pending_contract_records_the_plan_space_assigned(api_client, registration, monkeypatch):
    monkeypatch.setattr(get_settings(), "space_default_plan", "")
    gate = space_client.get_gate()
    gate.unavailable = True
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    assert created.json()["plan"] == ""

    gate.unavailable = False
    login = await api_client.post("/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    await api_client.get("/v1/users/me", headers=headers)
    me = await api_client.get("/v1/users/me", headers=headers)

    assert me.status_code == 200, me.text
    assert me.json()["plan"] == "FREE"

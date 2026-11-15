"""Shared setup for the B1 authorization and integrity tests.

Not a test module (no ``test_`` prefix); the B1 test files import from it.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from _pricing import fake_pricing_gate, largest_plan
from openbinding_gateway import space_client
from openbinding_gateway.db.models import User, UserRole


@pytest.fixture
def gate():
    """A pricing gate whose plans the test controls."""
    previous = space_client.get_gate()
    installed = fake_pricing_gate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(previous)


async def make_account(client, registration, db_session, gate, *, admin: bool = False):
    """Register and sign in; returns ``(account json, bearer headers)``."""
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    account = created.json()
    gate.plans[uuid.UUID(account["id"])] = largest_plan()
    if admin:
        user = (
            await db_session.execute(select(User).where(User.username == details["username"]))
        ).scalars().one()
        user.role = UserRole.ADMIN
        await db_session.flush()
    login = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login.status_code == 200, login.text
    return account, {"Authorization": f"Bearer {login.json()['access_token']}"}


async def make_key(client, headers, permissions: list[str]) -> dict[str, str]:
    """Mint an API key with exactly these permissions; returns its headers."""
    response = await client.post(
        "/v1/users/me/api-keys",
        headers=headers,
        json={
            "name": "b1 test key",
            "permissions": permissions,
            "engine_access": {"all": True, "engines": []},
            "boundary": {},
        },
    )
    assert response.status_code == 201, response.text
    return {"X-API-Key": response.json()["secret"]}


async def make_org(client, headers, slug: str | None = None, **extra) -> dict:
    slug = slug or f"b1-{uuid.uuid4().hex[:8]}"
    response = await client.post(
        "/v1/organizations", headers=headers, json={"slug": slug, "name": slug, **extra}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def put_member(client, headers, org: str, user_id: str, role: str):
    return await client.put(
        f"/v1/organizations/{org}/members/{user_id}",
        headers=headers,
        json={"user_id": user_id, "role": role},
    )


async def roles(client, headers, org: str) -> dict[str, str]:
    response = await client.get(f"/v1/organizations/{org}/members", headers=headers)
    assert response.status_code == 200, response.text
    return {row["user_id"]: row["role"] for row in response.json()}

"""Atomic membership drafts adapted from SPHERE's bulk-permissions workflow."""

from __future__ import annotations

import uuid

from openbinding_gateway import space_client
from _pricing import fake_pricing_gate, largest_plan


async def _account(client, registration) -> tuple[dict, dict[str, str]]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    login = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), {"Authorization": f"Bearer {login.json()['access_token']}"}


async def test_membership_batch_is_atomic_and_protects_the_last_owner(
    api_client, registration
) -> None:
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    try:
        owner, headers = await _account(api_client, registration)
        collaborator, _ = await _account(api_client, registration)
        owner_id = uuid.UUID(owner["id"])
        gate.plans[owner_id] = largest_plan()
        organization = await api_client.post(
            "/v1/organizations",
            headers=headers,
            json={"slug": f"batch-{uuid.uuid4().hex[:8]}", "name": "Batch lab"},
        )
        assert organization.status_code == 201, organization.text
        endpoint = f"/v1/organizations/{organization.json()['slug']}/members/batch"

        refused = await api_client.post(
            endpoint,
            headers=headers,
            json={
                "changes": [
                    {"user_id": collaborator["id"], "role": "VIEWER"},
                    {"user_id": owner["id"], "role": "ADMIN"},
                ]
            },
        )
        after_refusal = await api_client.get(
            f"/v1/organizations/{organization.json()['slug']}/members", headers=headers
        )

        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "last_owner"
        assert [(row["user_id"], row["role"]) for row in after_refusal.json()] == [
            (owner["id"], "OWNER")
        ]

        saved = await api_client.post(
            endpoint,
            headers=headers,
            json={
                "changes": [
                    {"user_id": collaborator["id"], "role": "OWNER"},
                    {"user_id": owner["id"], "role": "ADMIN"},
                ]
            },
        )

        assert saved.status_code == 200, saved.text
        assert {row["user_id"]: row["role"] for row in saved.json()} == {
            owner["id"]: "ADMIN",
            collaborator["id"]: "OWNER",
        }

        removed_self = await api_client.post(
            endpoint,
            headers=headers,
            json={"changes": [{"user_id": owner["id"], "role": None}]},
        )
        assert removed_self.status_code == 200, removed_self.text
        assert [(row["user_id"], row["role"]) for row in removed_self.json()] == [
            (collaborator["id"], "OWNER")
        ]
    finally:
        space_client.set_gate(previous)

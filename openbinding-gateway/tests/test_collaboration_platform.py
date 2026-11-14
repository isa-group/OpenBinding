"""Organization-tree inheritance, isolation and sponsor accounting."""

from __future__ import annotations

import uuid

import pytest_asyncio
from sqlalchemy import select

from openbinding_gateway import space_client
from openbinding_gateway.collaboration import sponsor_usage
from openbinding_gateway.db.models import Organization
from _pricing import fake_pricing_gate, largest_plan

LARGER_PLAN = largest_plan()


@pytest_asyncio.fixture
async def platform_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


async def account(client, registration, **overrides) -> tuple[dict, dict[str, str]]:
    details = registration(**overrides)
    response = await client.post("/v1/auth/register", json=details)
    assert response.status_code == 201, response.text
    login = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login.status_code == 200, login.text
    return response.json(), {"Authorization": f"Bearer {login.json()['access_token']}"}


async def tree(client, headers: dict[str, str]) -> tuple[dict, dict]:
    root = await client.post(
        "/v1/organizations",
        headers=headers,
        json={"slug": f"root-{uuid.uuid4().hex[:8]}", "name": "Root laboratory"},
    )
    assert root.status_code == 201, root.text
    child = await client.post(
        "/v1/organizations",
        headers=headers,
        json={
            "slug": f"child-{uuid.uuid4().hex[:8]}",
            "name": "Child group",
            "parent_id": root.json()["id"],
        },
    )
    assert child.status_code == 201, child.text
    return root.json(), child.json()


async def test_roles_inherit_downward_and_cross_org_access_is_hidden(
    api_client, registration, platform_gate
) -> None:
    owner, owner_headers = await account(api_client, registration)
    viewer, viewer_headers = await account(api_client, registration)
    _, outsider_headers = await account(api_client, registration)
    platform_gate.plans[uuid.UUID(owner["id"])] = LARGER_PLAN
    root, child = await tree(api_client, owner_headers)

    added = await api_client.put(
        f"/v1/organizations/{root['slug']}/members/{viewer['id']}",
        headers=owner_headers,
        json={"user_id": viewer["id"], "role": "VIEWER"},
    )
    inherited = await api_client.get(
        f"/v1/organizations/{child['slug']}", headers=viewer_headers
    )
    hidden = await api_client.get(
        f"/v1/organizations/{child['slug']}", headers=outsider_headers
    )

    assert added.status_code == 200, added.text
    assert inherited.json()["effective_role"] == "VIEWER"
    assert hidden.status_code == 403


async def test_cycles_and_removing_the_last_owner_are_refused(
    api_client, registration, platform_gate
) -> None:
    owner, headers = await account(api_client, registration)
    platform_gate.plans[uuid.UUID(owner["id"])] = LARGER_PLAN
    root, child = await tree(api_client, headers)

    cycle = await api_client.patch(
        f"/v1/organizations/{root['slug']}",
        headers=headers,
        json={"parent_id": child["id"]},
    )
    last_owner = await api_client.delete(
        f"/v1/organizations/{root['slug']}/members/{owner['id']}", headers=headers
    )
    demoted_owner = await api_client.put(
        f"/v1/organizations/{root['slug']}/members/{owner['id']}",
        headers=headers,
        json={"user_id": owner["id"], "role": "ADMIN"},
    )

    assert cycle.status_code == 409
    assert cycle.json()["detail"]["code"] == "organization_cycle"
    assert last_owner.status_code == 409
    assert last_owner.json()["detail"]["code"] == "last_owner"
    assert demoted_owner.status_code == 409
    assert demoted_owner.json()["detail"]["code"] == "last_owner"


async def test_sponsor_transfer_validates_and_moves_the_whole_tree_atomically(
    api_client, db_session, registration, platform_gate
) -> None:
    owner, headers = await account(api_client, registration)
    sponsor, sponsor_headers = await account(api_client, registration)
    owner_id = uuid.UUID(owner["id"])
    sponsor_id = uuid.UUID(sponsor["id"])
    platform_gate.plans[owner_id] = LARGER_PLAN
    root, child = await tree(api_client, headers)

    # Only the caller can become the sponsor (M9.6): the new sponsor is an OWNER
    # who takes the sponsorship, and their plan's limits are checked first.
    promoted = await api_client.put(
        f"/v1/organizations/{root['slug']}/members/{sponsor['id']}",
        headers=headers,
        json={"user_id": sponsor["id"], "role": "OWNER"},
    )
    assert promoted.status_code == 200, promoted.text
    take = {"billing_sponsor_user_id": sponsor["id"]}
    refused = await api_client.patch(
        f"/v1/organizations/{root['slug']}", headers=sponsor_headers, json=take
    )
    assert refused.status_code == 402
    assert refused.json()["detail"]["code"] == "sponsor_quota_exceeded"
    rows = (
        await db_session.execute(
            select(Organization).where(
                Organization.id.in_([uuid.UUID(root["id"]), uuid.UUID(child["id"])])
            )
        )
    ).scalars().all()
    assert {row.billing_sponsor_user_id for row in rows} == {owner_id}

    platform_gate.plans[sponsor_id] = LARGER_PLAN
    moved = await api_client.patch(
        f"/v1/organizations/{root['slug']}", headers=sponsor_headers, json=take
    )
    db_session.expire_all()
    rows = (
        await db_session.execute(
            select(Organization).where(
                Organization.id.in_([uuid.UUID(root["id"]), uuid.UUID(child["id"])])
            )
        )
    ).scalars().all()

    assert moved.status_code == 200, moved.text
    assert {row.billing_sponsor_user_id for row in rows} == {sponsor_id}

    added = await api_client.put(
        f"/v1/organizations/{child['slug']}/members/{sponsor['id']}",
        headers=headers,
        json={"user_id": sponsor["id"], "role": "MEMBER"},
    )
    assert added.status_code == 200, added.text
    usage = await sponsor_usage(db_session, sponsor_id)
    assert usage["organizations"] == 2
    assert usage["members"] == 2


async def test_delete_project_and_organization_lifecycle(
    api_client, registration, platform_gate
) -> None:
    owner, owner_headers = await account(api_client, registration)
    viewer, viewer_headers = await account(api_client, registration)
    platform_gate.plans[uuid.UUID(owner["id"])] = LARGER_PLAN

    org_res = await api_client.post(
        "/v1/organizations",
        headers=owner_headers,
        json={"slug": f"lifecycle-{uuid.uuid4().hex[:8]}", "name": "Lifecycle Lab"},
    )
    org = org_res.json()

    # Add viewer to org
    await api_client.put(
        f"/v1/organizations/{org['slug']}/members/{viewer['id']}",
        headers=owner_headers,
        json={"user_id": viewer["id"], "role": "VIEWER"},
    )

    # Create project
    proj_res = await api_client.post(
        f"/v1/organizations/{org['slug']}/projects",
        headers=owner_headers,
        json={"slug": "proj-lifecycle", "name": "Lifecycle Project", "visibility": "private"},
    )
    assert proj_res.status_code == 201

    # Viewer cannot delete project
    del_forbidden = await api_client.delete(
        f"/v1/organizations/{org['slug']}/projects/proj-lifecycle",
        headers=viewer_headers,
    )
    assert del_forbidden.status_code == 403

    # Owner can delete project
    del_ok = await api_client.delete(
        f"/v1/organizations/{org['slug']}/projects/proj-lifecycle",
        headers=owner_headers,
    )
    assert del_ok.status_code == 204

    # Verify project is gone
    get_proj = await api_client.get(
        f"/v1/organizations/{org['slug']}/projects/proj-lifecycle",
        headers=owner_headers,
    )
    assert get_proj.status_code == 404

    # Viewer cannot delete organization
    del_org_forbidden = await api_client.delete(
        f"/v1/organizations/{org['slug']}",
        headers=viewer_headers,
    )
    assert del_org_forbidden.status_code == 403

    # Owner can delete organization
    del_org_ok = await api_client.delete(
        f"/v1/organizations/{org['slug']}",
        headers=owner_headers,
    )
    assert del_org_ok.status_code == 204

    # Verify org is gone
    get_org = await api_client.get(
        f"/v1/organizations/{org['slug']}",
        headers=owner_headers,
    )
    assert get_org.status_code == 404

"""Organization-tree inheritance and isolation; organizations carry no billing sponsor."""

from __future__ import annotations

import uuid

import pytest_asyncio
from sqlalchemy import func, select

from openbinding_gateway import space_client
from openbinding_gateway.db.models import BindingCase, BindingCaseRevision, Blob, ProblemCompilation
from _pricing import fake_pricing_gate, largest_plan
from _problem_helpers import upload_problem

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


async def test_organizations_carry_no_sponsor_and_no_subtree_quota(
    api_client, registration, platform_gate
) -> None:
    owner, headers = await account(api_client, registration)
    member, _ = await account(api_client, registration)
    root, child = await tree(api_client, headers)
    assert "billing_sponsor_user_id" not in root and "billing_sponsor_user_id" not in child

    # The default plan's account can create organizations and add members with no subtree count.
    for _ in range(3):
        extra = await api_client.post(
            "/v1/organizations",
            headers=headers,
            json={"slug": f"more-{uuid.uuid4().hex[:8]}", "name": "More", "parent_id": root["id"]},
        )
        assert extra.status_code == 201, extra.text
    added = await api_client.put(
        f"/v1/organizations/{child['slug']}/members/{member['id']}",
        headers=headers,
        json={"user_id": member["id"], "role": "MEMBER"},
    )
    assert added.status_code == 200, added.text

    # Naming a sponsor is not part of the API any more.
    named = await api_client.patch(
        f"/v1/organizations/{root['slug']}", headers=headers, json={"billing_sponsor_user_id": owner["id"]}
    )
    assert named.status_code == 422
    assert named.json()["code"] == "validation_error"


async def test_delete_organization_lifecycle(
    api_client, db_session, registration, platform_gate
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

    # A problem of the organization, with its revision and the blob behind it.
    uploaded = await upload_problem(api_client, owner_headers, org["slug"])
    revision_id = uuid.UUID(uploaded["revision_id"])
    blob_id = await db_session.scalar(
        select(BindingCaseRevision.package_blob_id).where(BindingCaseRevision.id == revision_id)
    )
    assert blob_id is not None

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

    # Deleting the organization takes its problems, revisions, compilations and blobs with it.
    org_id = uuid.UUID(org["id"])
    db_session.expire_all()
    assert await db_session.scalar(
        select(func.count()).select_from(BindingCase).where(BindingCase.organization_id == org_id)
    ) == 0
    assert await db_session.get(BindingCaseRevision, revision_id) is None
    assert await db_session.scalar(
        select(func.count()).select_from(ProblemCompilation).where(ProblemCompilation.revision_id == revision_id)
    ) == 0
    assert await db_session.scalar(
        select(func.count()).select_from(Blob).where(Blob.organization_id == org_id)
    ) == 0

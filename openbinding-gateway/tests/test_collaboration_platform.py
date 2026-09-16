"""Organization-tree inheritance, isolation and sponsor accounting."""

from __future__ import annotations

import uuid

import pytest_asyncio
from sqlalchemy import select

from openbinding_gateway import space_client
from openbinding_gateway.collaboration import sponsor_usage
from openbinding_gateway.db.models import Organization, Publication, Report, ReportState
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
    sponsor, _ = await account(api_client, registration)
    owner_id = uuid.UUID(owner["id"])
    sponsor_id = uuid.UUID(sponsor["id"])
    platform_gate.plans[owner_id] = LARGER_PLAN
    root, child = await tree(api_client, headers)

    refused = await api_client.patch(
        f"/v1/organizations/{root['slug']}",
        headers=headers,
        json={"billing_sponsor_user_id": sponsor["id"]},
    )
    assert refused.status_code == 402
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
        f"/v1/organizations/{root['slug']}",
        headers=headers,
        json={"billing_sponsor_user_id": sponsor["id"]},
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

    for organization in (root, child):
        added = await api_client.put(
            f"/v1/organizations/{organization['slug']}/members/{sponsor['id']}",
            headers=headers,
            json={"user_id": sponsor["id"], "role": "MEMBER"},
        )
        assert added.status_code == 200, added.text
    usage = await sponsor_usage(db_session, sponsor_id)
    assert usage["organizations"] == 2
    assert usage["members"] == 2


async def test_project_resources_have_immutable_deduplicated_revisions(
    api_client, registration, platform_gate
) -> None:
    owner, headers = await account(api_client, registration)
    organization = await api_client.post(
        "/v1/organizations",
        headers=headers,
        json={"slug": f"resources-{uuid.uuid4().hex[:8]}", "name": "Resource lab"},
    )
    project = await api_client.post(
        f"/v1/organizations/{organization.json()['slug']}/projects",
        headers=headers,
        json={"slug": "binding-data", "name": "Binding data", "visibility": "private"},
    )
    assert project.status_code == 201, project.text
    created = await api_client.post(
        f"/v1/organizations/{organization.json()['slug']}/projects/binding-data/resources",
        headers=headers,
        json={"slug": "providers", "name": "Provider catalogue", "kind": "qos-offerings"},
    )
    assert created.status_code == 201, created.text
    endpoint = (
        f"/v1/organizations/{organization.json()['slug']}/projects/binding-data/"
        "resources/providers/revisions"
    )
    document = {"apiVersion": "openbinding.dev/qos-binding/v1", "providers": ["alpha"]}
    first = await api_client.post(endpoint, headers=headers, json={"document": document})
    duplicate = await api_client.post(endpoint, headers=headers, json={"document": document})
    second = await api_client.post(
        endpoint,
        headers=headers,
        json={"document": {**document, "providers": ["alpha", "beta"]}},
    )
    listed = await api_client.get(endpoint, headers=headers)

    assert first.status_code == duplicate.status_code == second.status_code == 201
    assert duplicate.json()["id"] == first.json()["id"]
    assert [row["revision"] for row in listed.json()] == [1, 2]
    assert first.json()["digest"].startswith("sha256-")


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


async def test_sealed_reports_protect_project_and_organization_history(
    api_client, registration, platform_gate, db_session
):
    owner, owner_headers = await account(api_client, registration)
    platform_gate.plans[uuid.UUID(owner["id"])] = LARGER_PLAN
    parent_slug = f"parent-org-{uuid.uuid4().hex[:8]}"
    child_slug = f"child-org-{uuid.uuid4().hex[:8]}"

    # 1. Create parent organization
    p_res = await api_client.post(
        "/v1/organizations",
        headers=owner_headers,
        json={"slug": parent_slug, "name": "Parent Org"},
    )
    assert p_res.status_code == 201
    parent = p_res.json()

    # 2. Create child organization
    c_res = await api_client.post(
        "/v1/organizations",
        headers=owner_headers,
        json={"slug": child_slug, "name": "Child Org", "parent_id": parent["id"]},
    )
    assert c_res.status_code == 201

    # 3. Create project in child org
    proj_res = await api_client.post(
        f"/v1/organizations/{child_slug}/projects",
        headers=owner_headers,
        json={"slug": "nested-proj", "name": "Nested Project", "visibility": "public"},
    )
    assert proj_res.status_code == 201
    proj_data = proj_res.json()

    # 4. Create case in project
    case_res = await api_client.post(
        f"/v1/organizations/{child_slug}/projects/nested-proj/cases",
        headers=owner_headers,
        json={"slug": "case-1", "name": "Case One"},
    )
    assert case_res.status_code == 201

    # 5. Create report in project
    rep_res = await api_client.post(
        f"/v1/organizations/{child_slug}/projects/nested-proj/reports",
        headers=owner_headers,
        json={
            "slug": "report-1",
            "title": "Initial Report",
            "document": {"summary": "Execution report"},
        },
    )
    assert rep_res.status_code == 201
    report_data = rep_res.json()

    # Seal real library content through the same path used by the application.
    document = {'provenance': {
        'study': {'reference': 'urn:test:editorial-study', 'digest': 'sha256-' + 'a' * 64},
        'datasets': [{'reference': 'urn:test:external-dataset', 'digest': 'sha256-' + 'b' * 64}],
        'software': [{'name': 'test', 'version': '1', 'digest': 'sha256-' + 'c' * 64}],
        'bimVersion': 'bim/v1', 'engineRevisions': ['sha256-' + 'd' * 64], 'parameters': {},
    }}
    edited = await api_client.patch(f"/v1/organizations/{child_slug}/projects/nested-proj/reports/report-1",
        headers=owner_headers, json={'document': document, 'draft_revision': report_data['draft_revision']})
    assert edited.status_code == 200, edited.text
    sealed = await api_client.post(f"/v1/organizations/{child_slug}/projects/nested-proj/reports/report-1/freeze", headers=owner_headers)
    assert sealed.status_code == 200, sealed.text
    published = await api_client.post(f"/v1/organizations/{child_slug}/projects/nested-proj/publications", headers=owner_headers,
        json={'report_id': report_data['id'], 'version_id': sealed.json()['version_id'], 'slug': 'pub-1'})
    assert published.status_code == 201, published.text

    # 7. A project containing publication history cannot be deleted.
    del_proj = await api_client.delete(
        f"/v1/organizations/{child_slug}/projects/nested-proj",
        headers=owner_headers,
    )
    assert del_proj.status_code == 409

    # 8. Create another project and delete parent organization cascading to child
    proj2_res = await api_client.post(
        f"/v1/organizations/{child_slug}/projects",
        headers=owner_headers,
        json={"slug": "nested-proj-2", "name": "Nested Project 2", "visibility": "private"},
    )
    assert proj2_res.status_code == 201

    del_parent = await api_client.delete(
        f"/v1/organizations/{parent_slug}",
        headers=owner_headers,
    )
    assert del_parent.status_code == 409

    # Both organizations retain the historical publication.
    assert (await api_client.get(f"/v1/organizations/{parent_slug}", headers=owner_headers)).status_code == 200
    assert (await api_client.get(f"/v1/organizations/{child_slug}", headers=owner_headers)).status_code == 200

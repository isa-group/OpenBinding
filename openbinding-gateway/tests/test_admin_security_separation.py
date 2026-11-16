"""Tests for strict administrative separation and privacy isolation."""

from __future__ import annotations

from _problem_helpers import ZIP, package_bytes, upload_problem
# ruff: noqa: E402

import sys
import uuid

from _paths import GATEWAY_ROOT

_tools_dir = str(GATEWAY_ROOT / "tools")
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

import pytest
import pytest_asyncio
from sqlalchemy import select

from _pricing import fake_pricing_gate, largest_plan
from openbinding_gateway import space_client
from openbinding_gateway.db.models import (
    ApiKey,
    AuditEvent,
    BindingCase,
    User,
    UserRole,
)
from openbinding_gateway.security.apikeys import ADMIN_PERMISSIONS


@pytest_asyncio.fixture
async def gate():
    installed = fake_pricing_gate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


async def create_account(
    client, registration, db_session, *, admin: bool = False
) -> tuple[dict, dict[str, str]]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text

    if admin:
        user = (
            await db_session.execute(
                select(User).where(User.username == details["username"])
            )
        ).scalars().one()
        user.role = UserRole.ADMIN
        await db_session.flush()

    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert tokens.status_code == 200, tokens.text
    return created.json(), {"Authorization": f"Bearer {tokens.json()['access_token']}"}


@pytest.mark.asyncio
async def test_admin_cannot_access_private_organization_or_problems(
    api_client, registration, gate, db_session
):
    owner, owner_headers = await create_account(api_client, registration, db_session)
    admin, admin_headers = await create_account(
        api_client, registration, db_session, admin=True
    )
    owner_id = uuid.UUID(owner["id"])
    gate.plans[owner_id] = largest_plan()

    org_slug = f"lab-{uuid.uuid4().hex[:8]}"
    org_res = await api_client.post(
        "/v1/organizations",
        headers=owner_headers,
        json={"slug": org_slug, "name": "Private Lab"},
    )
    assert org_res.status_code == 201, org_res.text

    await upload_problem(api_client, owner_headers, org_slug, slug="secret-problem")

    # Owner can access org and problem
    assert (
        await api_client.get(f"/v1/organizations/{org_slug}", headers=owner_headers)
    ).status_code == 200
    assert (
        await api_client.get(
            f"/v1/organizations/{org_slug}/problems/secret-problem", headers=owner_headers
        )
    ).status_code == 200

    # Platform administrator NOT in the organization must receive 403 Forbidden
    refused_org = await api_client.get(
        f"/v1/organizations/{org_slug}", headers=admin_headers
    )
    assert refused_org.status_code == 403
    assert refused_org.json()["detail"]["code"] == "organization_forbidden"

    refused_problem = await api_client.get(
        f"/v1/organizations/{org_slug}/problems/secret-problem", headers=admin_headers
    )
    assert refused_problem.status_code == 403
    assert refused_problem.json()["detail"]["code"] == "organization_forbidden"

    # Admin listing organizations does not see this private organization
    org_list = await api_client.get("/v1/organizations", headers=admin_headers)
    assert org_list.status_code == 200
    assert not any(item["slug"] == org_slug for item in org_list.json())


@pytest.mark.asyncio
async def test_admin_cannot_download_private_problem_packages(
    api_client, registration, gate, db_session, tmp_path
):
    owner, owner_headers = await create_account(api_client, registration, db_session)
    _, admin_headers = await create_account(
        api_client, registration, db_session, admin=True
    )
    owner_id = uuid.UUID(owner["id"])
    gate.plans[owner_id] = largest_plan()

    org_slug = f"artifact-lab-{uuid.uuid4().hex[:8]}"
    org_res = await api_client.post(
        "/v1/organizations",
        headers=owner_headers,
        json={"slug": org_slug, "name": "Blob Lab"},
    )
    assert org_res.status_code == 201

    await upload_problem(api_client, owner_headers, org_slug, slug="confidential-run")
    source = f"/v1/organizations/{org_slug}/problems/confidential-run/revisions/1/source"

    # Owner can download
    owner_get = await api_client.get(source, headers=owner_headers)
    assert owner_get.status_code == 200
    assert owner_get.content.startswith(b"PK")

    # Admin is refused with 403
    admin_get = await api_client.get(source, headers=admin_headers)
    assert admin_get.status_code == 403
    assert admin_get.json()["detail"]["code"] == "organization_forbidden"


@pytest.mark.asyncio
async def test_account_deletion_keeps_authorship_on_the_pseudonymised_account_not_an_admin(
    api_client, registration, gate, db_session
):
    owner1, owner1_headers = await create_account(api_client, registration, db_session)
    owner2, owner2_headers = await create_account(api_client, registration, db_session)
    admin, admin_headers = await create_account(
        api_client, registration, db_session, admin=True
    )

    owner1_id = uuid.UUID(owner1["id"])
    owner2_id = uuid.UUID(owner2["id"])
    admin_id = uuid.UUID(admin["id"])

    gate.plans[owner1_id] = largest_plan()
    gate.plans[owner2_id] = largest_plan()

    org_slug = f"coop-{uuid.uuid4().hex[:8]}"
    org_res = await api_client.post(
        "/v1/organizations",
        headers=owner1_headers,
        json={"slug": org_slug, "name": "Cooperative Lab"},
    )
    assert org_res.status_code == 201
    org_id = uuid.UUID(org_res.json()["id"])

    # Owner1 hands the organization over to owner2 (one owner, B8): owner1 stays on as an admin.
    add_owner2 = await api_client.put(
        f"/v1/organizations/{org_slug}/members/{owner2['id']}",
        headers=owner1_headers,
        json={"user_id": owner2["id"], "role": "ADMIN"},
    )
    assert add_owner2.status_code == 200
    handed = await api_client.put(
        f"/v1/organizations/{org_slug}/owner", headers=owner1_headers, json={"user_id": owner2["id"]}
    )
    assert handed.status_code == 200, handed.text

    # Owner1 uploads a problem of the organization
    await upload_problem(api_client, owner1_headers, org_slug, slug="case-1")

    # Owner1 deletes their own account
    del_res = await api_client.request(
        "DELETE",
        "/v1/users/me",
        headers=owner1_headers,
        json={"confirmation": owner1["username"], "current_password": "correct-horse-battery"},
    )
    assert del_res.status_code == 204

    # Owner1's row stays, pseudonymised: nothing that names the person, and no way to sign in.
    db_session.expire_all()
    deleted = await db_session.get(User, owner1_id)
    assert deleted is not None and deleted.deleted_at is not None
    assert deleted.username == f"deleted-{owner1_id.hex[:12]}" and deleted.is_active is False

    # What owner1 created still names owner1, never owner2 or the administrator.
    case = (
        await db_session.execute(
            select(BindingCase).where(
                BindingCase.organization_id == org_id, BindingCase.slug == "case-1"
            )
        )
    ).scalars().one()
    assert case.created_by_id == owner1_id
    assert case.created_by_id not in (owner2_id, admin_id)


@pytest.mark.asyncio
async def test_audit_separation_between_platform_and_tenants(
    api_client, registration, gate, db_session
):
    user, user_headers = await create_account(api_client, registration, db_session)
    admin, admin_headers = await create_account(
        api_client, registration, db_session, admin=True
    )

    user_id = uuid.UUID(user["id"])
    admin_id = uuid.UUID(admin["id"])
    gate.plans[user_id] = largest_plan()

    # Create an organization (produces tenant audit event with organization_id set)
    org_slug = f"audit-org-{uuid.uuid4().hex[:8]}"
    org_res = await api_client.post(
        "/v1/organizations",
        headers=user_headers,
        json={"slug": org_slug, "name": "Audit Org"},
    )
    assert org_res.status_code == 201
    org_id = org_res.json()["id"]

    # Record a platform-level audit event
    db_session.add(
        AuditEvent(
            organization_id=None,
            actor_id=admin_id,
            action="platform.maintenance.performed",
            target_type="System",
            detail={"note": "global maintenance"},
        )
    )
    await db_session.flush()

    # /v1/admin/audit shows platform events AND organization events (B2 #12): the
    # latter carry their organization id and slug, the former carry null.
    admin_audit = await api_client.get("/v1/admin/audit", headers=admin_headers)
    assert admin_audit.status_code == 200
    events = admin_audit.json()["events"]
    assert any(ev["action"] == "platform.maintenance.performed" and ev["organizationId"] is None for ev in events)
    created = [ev for ev in events if ev["action"] == "organization.created"]
    assert len(created) == 1
    assert created[0]["organizationId"] == org_id
    assert created[0]["organizationSlug"] == org_slug
    for ev in events:
        assert (ev["organizationId"] is None) == (ev["organizationSlug"] is None)
    # ... and the organization filter narrows it to that organization alone.
    only_org = await api_client.get(
        f"/v1/admin/audit?organization_id={org_id}", headers=admin_headers
    )
    assert only_org.status_code == 200
    assert {ev["organizationId"] for ev in only_org.json()["events"]} == {org_id}
    assert all(ev["action"] != "platform.maintenance.performed" for ev in only_org.json()["events"])

    # /v1/admin/overview still only contains platform-level events
    overview = await api_client.get("/v1/admin/overview", headers=admin_headers)
    assert overview.status_code == 200
    assert "projects" not in overview.json()["counts"]
    for item in overview.json()["recentAudit"]:
        assert item["action"] != "organization.created"

    # Tenant audit: /v1/organizations/{org}/audit accessible to org ADMIN/OWNER
    org_audit = await api_client.get(
        f"/v1/organizations/{org_slug}/audit", headers=user_headers
    )
    assert org_audit.status_code == 200
    org_events = org_audit.json()["events"]
    assert any(ev["action"] == "organization.created" for ev in org_events)
    for ev in org_events:
        assert ev["organizationId"] == org_id

    # Platform administrator NOT a member cannot access tenant audit log
    refused_admin_audit = await api_client.get(
        f"/v1/organizations/{org_slug}/audit", headers=admin_headers
    )
    assert refused_admin_audit.status_code == 403


@pytest.mark.asyncio
async def test_remove_member_does_not_revoke_user_personal_api_keys(
    api_client, registration, gate, db_session
):
    owner, owner_headers = await create_account(api_client, registration, db_session)
    member, member_headers = await create_account(api_client, registration, db_session)

    owner_id = uuid.UUID(owner["id"])
    member_id = uuid.UUID(member["id"])
    gate.plans[owner_id] = largest_plan()
    gate.plans[member_id] = largest_plan()

    org_slug = f"membership-org-{uuid.uuid4().hex[:8]}"
    org_res = await api_client.post(
        "/v1/organizations",
        headers=owner_headers,
        json={"slug": org_slug, "name": "Membership Org"},
    )
    assert org_res.status_code == 201

    # Add member
    add_res = await api_client.put(
        f"/v1/organizations/{org_slug}/members/{member['id']}",
        headers=owner_headers,
        json={"user_id": member["id"], "role": "MEMBER"},
    )
    assert add_res.status_code == 200

    # Member mints a personal API key
    key_res = await api_client.post(
        "/v1/users/me/api-keys",
        headers=member_headers,
        json={
            "name": "Member Personal Key",
            "permissions": ["account:read"],
            "engine_access": {"all": True, "engines": []},
            "boundary": {},
        },
    )
    assert key_res.status_code == 201
    key_id = uuid.UUID(key_res.json()["id"])

    # Owner removes member from the organization
    del_member = await api_client.delete(
        f"/v1/organizations/{org_slug}/members/{member['id']}",
        headers=owner_headers,
    )
    assert del_member.status_code == 204

    # Verify personal API key is STILL active
    api_key = await db_session.get(ApiKey, key_id)
    assert api_key is not None
    assert api_key.revoked_at is None
    assert api_key.is_active is True


@pytest.mark.asyncio
async def test_seed_dev_non_admin_users_have_no_admin_permissions(db_session):
    from seed_dev import ensure_users

    users = await ensure_users(db_session)
    assert "admin" in users
    assert "alice" in users
    assert "bob" in users

    admin_key = (
        await db_session.execute(
            select(ApiKey).where(ApiKey.user_id == users["admin"].id)
        )
    ).scalars().one()
    admin_perms = set(admin_key.grants.get("permissions", []))
    assert ADMIN_PERMISSIONS <= admin_perms

    for username in ("alice", "bob", "carol"):
        user_key = (
            await db_session.execute(
                select(ApiKey).where(ApiKey.user_id == users[username].id)
            )
        ).scalars().one()
        user_perms = set(user_key.grants.get("permissions", []))
        assert not (user_perms & ADMIN_PERMISSIONS)
        assert "account:read" in user_perms


@pytest.mark.asyncio
async def test_admin_invited_as_viewer_cannot_escalate_privileges(
    api_client, registration, gate, db_session
):
    owner, owner_headers = await create_account(api_client, registration, db_session)
    admin, admin_headers = await create_account(
        api_client, registration, db_session, admin=True
    )
    owner_id = uuid.UUID(owner["id"])
    gate.plans[owner_id] = largest_plan()

    org_slug = f"restricted-lab-{uuid.uuid4().hex[:8]}"
    org_res = await api_client.post(
        "/v1/organizations",
        headers=owner_headers,
        json={"slug": org_slug, "name": "Restricted Lab"},
    )
    assert org_res.status_code == 201

    # Invite admin strictly as VIEWER
    add_member = await api_client.put(
        f"/v1/organizations/{org_slug}/members/{admin['id']}",
        headers=owner_headers,
        json={"user_id": admin["id"], "role": "VIEWER"},
    )
    assert add_member.status_code == 200

    # Admin as VIEWER can view organization
    view_org = await api_client.get(f"/v1/organizations/{org_slug}", headers=admin_headers)
    assert view_org.status_code == 200
    assert view_org.json()["effective_role"] == "VIEWER"

    # Admin as VIEWER CANNOT upload problems (requires MEMBER)
    refused_create = await api_client.post(
        f"/v1/organizations/{org_slug}/problems",
        params={"slug": "escalate"},
        content=package_bytes(),
        headers={**admin_headers, **ZIP},
    )
    assert refused_create.status_code == 403
    assert refused_create.json()["detail"]["code"] == "organization_forbidden"

    # Admin as VIEWER CANNOT access organization audit logs (requires ADMIN)
    refused_audit = await api_client.get(
        f"/v1/organizations/{org_slug}/audit", headers=admin_headers
    )
    assert refused_audit.status_code == 403
    assert refused_audit.json()["detail"]["code"] == "organization_forbidden"


@pytest.mark.asyncio
async def test_an_administrator_is_deleted_without_any_pricing_authorship_rule(
    api_client, registration, gate, db_session
):
    """Pricings are authored in SPHERE and SPACE, so deleting an account never depends on them."""
    admin, admin_headers = await create_account(
        api_client, registration, db_session, admin=True
    )
    admin_id = uuid.UUID(admin["id"])
    assert admin_id in gate.contracts

    del_res = await api_client.request(
        "DELETE",
        "/v1/users/me",
        headers=admin_headers,
        json={"confirmation": admin["username"], "current_password": "correct-horse-battery"},
    )

    assert del_res.status_code == 204, del_res.text
    db_session.expire_all()
    assert (await db_session.get(User, admin_id)).deleted_at is not None
    assert admin_id not in gate.contracts

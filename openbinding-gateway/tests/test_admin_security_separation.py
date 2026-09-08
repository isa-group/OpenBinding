"""Tests for strict administrative separation and privacy isolation."""

from __future__ import annotations

# ruff: noqa: E402

import copy
import json
import sys
import uuid
from pathlib import Path

_tools_dir = str(Path(__file__).resolve().parents[1] / "tools")
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

import pytest
import pytest_asyncio
from sqlalchemy import select

from _pricing import fake_pricing_gate, largest_plan
from _repo import REPO_ROOT
from openbinding_gateway import space_client
from openbinding_gateway.v1.package import load_package

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"


def _optimization_document(name: str, version: str) -> dict:
    document = copy.deepcopy(load_package(EXAMPLE).json("optimization.json"))
    document["metadata"].update({"name": name, "version": version})
    return document


from openbinding_gateway.db.models import (
    ApiKey,
    Artifact,
    AuditEvent,
    BindingCase,
    Organization,
    PricingRelease,
    Project,
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
async def test_admin_cannot_access_private_organization_or_projects(
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

    proj_slug = "secret-project"
    proj_res = await api_client.post(
        f"/v1/organizations/{org_slug}/projects",
        headers=owner_headers,
        json={"slug": proj_slug, "name": "Secret Project", "visibility": "private"},
    )
    assert proj_res.status_code == 201, proj_res.text

    # Owner can access org and project
    assert (
        await api_client.get(f"/v1/organizations/{org_slug}", headers=owner_headers)
    ).status_code == 200
    assert (
        await api_client.get(
            f"/v1/organizations/{org_slug}/projects/{proj_slug}", headers=owner_headers
        )
    ).status_code == 200

    # Platform administrator NOT in the organization must receive 403 Forbidden
    refused_org = await api_client.get(
        f"/v1/organizations/{org_slug}", headers=admin_headers
    )
    assert refused_org.status_code == 403
    assert refused_org.json()["detail"]["code"] == "organization_forbidden"

    refused_proj = await api_client.get(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}", headers=admin_headers
    )
    assert refused_proj.status_code == 403
    assert refused_proj.json()["detail"]["code"] == "organization_forbidden"

    # Admin listing organizations does not see this private organization
    org_list = await api_client.get("/v1/organizations", headers=admin_headers)
    assert org_list.status_code == 200
    assert not any(item["slug"] == org_slug for item in org_list.json())


@pytest.mark.asyncio
async def test_admin_cannot_download_private_artifacts(
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
        json={"slug": org_slug, "name": "Artifact Lab"},
    )
    assert org_res.status_code == 201

    proj_slug = "confidential-run"
    proj_res = await api_client.post(
        f"/v1/organizations/{org_slug}/projects",
        headers=owner_headers,
        json={"slug": proj_slug, "name": "Confidential", "visibility": "private"},
    )
    assert proj_res.status_code == 201

    org_obj = (
        await db_session.execute(select(Organization).where(Organization.slug == org_slug))
    ).scalars().one()
    proj_obj = (
        await db_session.execute(
            select(Project).where(
                Project.organization_id == org_obj.id, Project.slug == proj_slug
            )
        )
    ).scalars().one()

    fake_digest = "sha256-" + "a" * 64
    storage_file = tmp_path / "test_artifact.bin"
    storage_file.write_bytes(b'{"secret": "data"}')

    artifact = Artifact(
        organization_id=org_obj.id,
        project_id=proj_obj.id,
        digest=fake_digest,
        media_type="application/json",
        size_bytes=18,
        storage_uri=str(storage_file),
        public=False,
        created_by_id=owner_id,
    )
    db_session.add(artifact)
    await db_session.flush()

    # Owner can download
    owner_get = await api_client.get(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/artifacts/{fake_digest}",
        headers=owner_headers,
    )
    assert owner_get.status_code == 200
    assert owner_get.content == b'{"secret": "data"}'

    # Admin is refused with 403
    admin_get = await api_client.get(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/artifacts/{fake_digest}",
        headers=admin_headers,
    )
    assert admin_get.status_code == 403
    assert admin_get.json()["detail"]["code"] == "organization_forbidden"


@pytest.mark.asyncio
async def test_admin_cannot_spoof_dialect_or_resource_namespace(
    api_client, registration, gate, db_session
):
    user_a, user_a_headers = await create_account(api_client, registration, db_session)
    admin, admin_headers = await create_account(
        api_client, registration, db_session, admin=True
    )

    # Admin attempting to register under user_a's namespace is rejected
    spoof_res = await api_client.post(
        "/v1/resources",
        params={
            "namespace": user_a["username"],
            "name": "opt-test",
            "version": "1.0.0",
            "role": "optimization",
        },
        headers={**admin_headers, "Content-Type": "application/json"},
        content=json.dumps(_optimization_document("opt-test", "1.0.0")),
    )
    assert spoof_res.status_code == 403
    assert spoof_res.json()["title"] == "forbidden"

    # Admin registering under their own username produces pending_review (NOT published)
    admin_personal_res = await api_client.post(
        "/v1/resources",
        params={
            "namespace": admin["username"],
            "name": "opt-admin",
            "version": "1.0.0",
            "role": "optimization",
        },
        headers={**admin_headers, "Content-Type": "application/json"},
        content=json.dumps(_optimization_document("opt-admin", "1.0.0")),
    )
    assert admin_personal_res.status_code == 201
    assert admin_personal_res.json()["status"] == "pending_review"

    # Admin registering under official system namespace 'openbinding' auto-publishes
    system_res = await api_client.post(
        "/v1/resources",
        params={
            "namespace": "openbinding",
            "name": "opt-sys",
            "version": "1.0.0",
            "role": "optimization",
        },
        headers={**admin_headers, "Content-Type": "application/json"},
        content=json.dumps(_optimization_document("opt-sys", "1.0.0")),
    )
    assert system_res.status_code == 201
    assert system_res.json()["status"] == "published"

    # Regular user attempting to register under 'openbinding' namespace is rejected
    user_system_res = await api_client.post(
        "/v1/resources",
        params={
            "namespace": "openbinding",
            "name": "opt-user-sys",
            "version": "1.0.0",
            "role": "optimization",
        },
        headers={**user_a_headers, "Content-Type": "application/json"},
        content=json.dumps(_optimization_document("opt-user-sys", "1.0.0")),
    )
    assert user_system_res.status_code == 403


@pytest.mark.asyncio
async def test_account_deletion_reassigns_to_tenant_owner_not_admin(
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

    # Add owner2 as OWNER
    add_owner2 = await api_client.put(
        f"/v1/organizations/{org_slug}/members/{owner2['id']}",
        headers=owner1_headers,
        json={"user_id": owner2["id"], "role": "OWNER"},
    )
    assert add_owner2.status_code == 200

    # Owner1 creates a project
    proj_slug = "coop-project"
    proj_res = await api_client.post(
        f"/v1/organizations/{org_slug}/projects",
        headers=owner1_headers,
        json={"slug": proj_slug, "name": "Coop Project", "visibility": "private"},
    )
    assert proj_res.status_code == 201

    # Owner1 creates a binding case
    case_res = await api_client.post(
        f"/v1/organizations/{org_slug}/projects/{proj_slug}/cases",
        headers=owner1_headers,
        json={"slug": "case-1", "name": "Case 1"},
    )
    assert case_res.status_code == 201

    # Owner1 deletes their own account
    del_res = await api_client.request(
        "DELETE",
        "/v1/users/me",
        headers=owner1_headers,
        json={"confirmation": owner1["username"], "current_password": "correct-horse-battery"},
    )
    assert del_res.status_code == 204

    # Verify Owner1 is deleted
    assert await db_session.get(User, owner1_id) is None

    # Verify project and case were reassigned to Owner2, NOT to admin
    proj = (
        await db_session.execute(
            select(Project).where(
                Project.organization_id == org_id, Project.slug == proj_slug
            )
        )
    ).scalars().one()
    assert proj.created_by_id == owner2_id
    assert proj.created_by_id != admin_id

    case = (
        await db_session.execute(
            select(BindingCase).where(
                BindingCase.project_id == proj.id, BindingCase.slug == "case-1"
            )
        )
    ).scalars().one()
    assert case.created_by_id == owner2_id
    assert case.created_by_id != admin_id


@pytest.mark.asyncio
async def test_admin_transfer_organization_sponsor(
    api_client, registration, gate, db_session
):
    sponsor1, sponsor1_headers = await create_account(api_client, registration, db_session)
    sponsor2, sponsor2_headers = await create_account(api_client, registration, db_session)
    admin, admin_headers = await create_account(
        api_client, registration, db_session, admin=True
    )

    s1_id = uuid.UUID(sponsor1["id"])
    s2_id = uuid.UUID(sponsor2["id"])
    gate.plans[s1_id] = largest_plan()
    gate.plans[s2_id] = largest_plan()

    org_slug = f"sponsored-{uuid.uuid4().hex[:8]}"
    org_res = await api_client.post(
        "/v1/organizations",
        headers=sponsor1_headers,
        json={"slug": org_slug, "name": "Sponsored Lab"},
    )
    assert org_res.status_code == 201
    org_id = org_res.json()["id"]

    # Admin transfers sponsorship via /v1/admin/organizations/{id}/sponsor without being member
    transfer_res = await api_client.post(
        f"/v1/admin/organizations/{org_id}/sponsor",
        headers=admin_headers,
        json={"billing_sponsor_user_id": str(s2_id)},
    )
    assert transfer_res.status_code == 200, transfer_res.text
    assert transfer_res.json()["billing_sponsor_user_id"] == str(s2_id)

    # Database reflected
    org = await db_session.get(Organization, uuid.UUID(org_id))
    assert org.billing_sponsor_user_id == s2_id

    # Non-admin cannot call admin sponsor transfer endpoint
    refused = await api_client.post(
        f"/v1/admin/organizations/{org_id}/sponsor",
        headers=sponsor1_headers,
        json={"billing_sponsor_user_id": str(s1_id)},
    )
    assert refused.status_code == 403


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

    # /v1/admin/audit only shows platform-level events (organization_id is None)
    admin_audit = await api_client.get("/v1/admin/audit", headers=admin_headers)
    assert admin_audit.status_code == 200
    events = admin_audit.json()["events"]
    assert len(events) > 0
    for ev in events:
        assert ev["organizationId"] is None
        assert ev["action"] != "organization.created"

    # /v1/admin/overview only contains platform-level events
    overview = await api_client.get("/v1/admin/overview", headers=admin_headers)
    assert overview.status_code == 200
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

    # Admin as VIEWER CANNOT create projects (requires MEMBER)
    refused_create = await api_client.post(
        f"/v1/organizations/{org_slug}/projects",
        headers=admin_headers,
        json={"slug": "escalate-proj", "name": "Escalate"},
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
async def test_tenant_owner_transfers_sponsor_via_patch_while_admin_role_enforces_owner(
    api_client, registration, gate, db_session
):
    owner, owner_headers = await create_account(api_client, registration, db_session)
    admin_member, admin_member_headers = await create_account(
        api_client, registration, db_session
    )
    sponsor2, _ = await create_account(api_client, registration, db_session)

    owner_id = uuid.UUID(owner["id"])
    sponsor2_id = uuid.UUID(sponsor2["id"])
    gate.plans[owner_id] = largest_plan()
    gate.plans[sponsor2_id] = largest_plan()

    org_slug = f"transfer-org-{uuid.uuid4().hex[:8]}"
    org_res = await api_client.post(
        "/v1/organizations",
        headers=owner_headers,
        json={"slug": org_slug, "name": "Transfer Org"},
    )
    assert org_res.status_code == 201

    # Add admin_member as ADMIN (not OWNER) of the organization
    await api_client.put(
        f"/v1/organizations/{org_slug}/members/{admin_member['id']}",
        headers=owner_headers,
        json={"user_id": admin_member["id"], "role": "ADMIN"},
    )

    # Org ADMIN (non-owner) attempting to transfer sponsorship via PATCH is refused
    refused_transfer = await api_client.patch(
        f"/v1/organizations/{org_slug}",
        headers=admin_member_headers,
        json={"billing_sponsor_user_id": str(sponsor2_id)},
    )
    assert refused_transfer.status_code == 403
    assert refused_transfer.json()["detail"]["code"] == "organization_forbidden"

    # Org OWNER transfers sponsorship via PATCH successfully without platform admin role
    success_transfer = await api_client.patch(
        f"/v1/organizations/{org_slug}",
        headers=owner_headers,
        json={"billing_sponsor_user_id": str(sponsor2_id)},
    )
    assert success_transfer.status_code == 200
    assert success_transfer.json()["billing_sponsor_user_id"] == str(sponsor2_id)


@pytest.mark.asyncio
async def test_admin_sponsor_transfer_endpoint_enforces_api_key_write_permission(
    api_client, registration, gate, db_session
):
    admin, admin_headers = await create_account(
        api_client, registration, db_session, admin=True
    )
    user, user_headers = await create_account(api_client, registration, db_session)
    sponsor, _ = await create_account(api_client, registration, db_session)

    user_id = uuid.UUID(user["id"])
    sponsor_id = uuid.UUID(sponsor["id"])
    admin_id = uuid.UUID(admin["id"])
    gate.plans[user_id] = largest_plan()
    gate.plans[sponsor_id] = largest_plan()
    gate.plans[admin_id] = largest_plan()

    org_res = await api_client.post(
        "/v1/organizations",
        headers=user_headers,
        json={"slug": f"api-org-{uuid.uuid4().hex[:8]}", "name": "API Org"},
    )
    assert org_res.status_code == 201
    org_id = org_res.json()["id"]

    # Admin mints read-only admin key (admin:accounts:read only)
    ro_key_res = await api_client.post(
        "/v1/users/me/api-keys",
        headers=admin_headers,
        json={
            "name": "RO Key",
            "permissions": ["admin:accounts:read"],
            "engine_access": {"all": True, "engines": []},
            "boundary": {},
        },
    )
    assert ro_key_res.status_code == 201
    ro_key = ro_key_res.json()["secret"]

    # Read-only admin key is refused on POST /v1/admin/organizations/{id}/sponsor
    refused = await api_client.post(
        f"/v1/admin/organizations/{org_id}/sponsor",
        headers={"X-API-Key": ro_key},
        json={"billing_sponsor_user_id": str(sponsor_id)},
    )
    assert refused.status_code == 403

    # Admin mints write admin key (admin:accounts:write)
    rw_key_res = await api_client.post(
        "/v1/users/me/api-keys",
        headers=admin_headers,
        json={
            "name": "RW Key",
            "permissions": ["admin:accounts:write"],
            "engine_access": {"all": True, "engines": []},
            "boundary": {},
        },
    )
    assert rw_key_res.status_code == 201
    rw_key = rw_key_res.json()["secret"]

    # Write admin key succeeds
    success = await api_client.post(
        f"/v1/admin/organizations/{org_id}/sponsor",
        headers={"X-API-Key": rw_key},
        json={"billing_sponsor_user_id": str(sponsor_id)},
    )
    assert success.status_code == 200
    assert success.json()["billing_sponsor_user_id"] == str(sponsor_id)


@pytest.mark.asyncio
async def test_cannot_delete_last_admin_who_authored_pricing_releases(
    api_client, registration, gate, db_session
):
    admin, admin_headers = await create_account(
        api_client, registration, db_session, admin=True
    )
    admin_id = uuid.UUID(admin["id"])

    # Create a pricing release authored by this sole admin
    db_session.add(
        PricingRelease(
            version="2026.9.1-test",
            digest="sha256-" + "b" * 64,
            sphere_organization="OpenBinding",
            sphere_organization_id="org_123",
            sphere_slug="openbinding",
            created_by_id=admin_id,
        )
    )
    await db_session.flush()

    # Sole admin tries to delete account
    del_res = await api_client.request(
        "DELETE",
        "/v1/users/me",
        headers=admin_headers,
        json={"confirmation": admin["username"], "current_password": "correct-horse-battery"},
    )
    assert del_res.status_code == 409
    assert del_res.json()["detail"]["code"] == "last_pricing_admin"


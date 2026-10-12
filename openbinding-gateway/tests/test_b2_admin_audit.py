"""B2 #10, #11, #12: real ``cas_verified``, audited admin actions, org events in the platform log.

The audit assertions count rows in ``audit_events`` rather than trusting a
response: "exactly one event per action, and none for a refusal" is a statement
about the table.
"""

from __future__ import annotations

import json
import uuid

import pytest_asyncio
from sqlalchemy import event, func, select

from openbinding_gateway import space_client
from openbinding_gateway.db.models import ApiKey, AuditEvent, AuthIdentity, User, UserRole
from _pricing import fake_pricing_gate, largest_plan


@pytest_asyncio.fixture
async def gate():
    installed = fake_pricing_gate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


async def account(client, registration, db_session=None, *, admin=False) -> tuple[dict, dict]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    if admin:
        user = (
            await db_session.execute(select(User).where(User.username == details["username"]))
        ).scalars().one()
        user.role = UserRole.ADMIN
        await db_session.flush()
    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), {"Authorization": f"Bearer {tokens.json()['access_token']}"}


async def events(db_session, action: str | None = None) -> list[AuditEvent]:
    query = select(AuditEvent).order_by(AuditEvent.created_at)
    if action:
        query = query.where(AuditEvent.action == action)
    return list((await db_session.execute(query)).scalars().all())


async def total_events(db_session) -> int:
    return int(await db_session.scalar(select(func.count(AuditEvent.id))) or 0)


async def create_key(client, headers) -> dict:
    created = await client.post(
        "/v1/users/me/api-keys",
        headers=headers,
        json={
            "name": "ci-key",
            "permissions": ["account:read"],
            "engine_access": {"all": False, "engines": []},
        },
    )
    assert created.status_code == 201, created.text
    return created.json()


# -- #10: cas_verified is the real value -----------------------------------


async def test_cas_verified_reflects_the_linked_identity_in_the_listing(
    api_client, registration, gate, db_session
):
    linked, _ = await account(api_client, registration)
    plain, _ = await account(api_client, registration)
    other_provider, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    db_session.add(AuthIdentity(
        user_id=uuid.UUID(linked["id"]), provider="us-cas", subject="uvus-1", attributes={}
    ))
    db_session.add(AuthIdentity(
        user_id=uuid.UUID(other_provider["id"]), provider="somewhere-else", subject="x", attributes={}
    ))
    await db_session.flush()

    listing = await api_client.get("/v1/admin/users?limit=200", headers=admin)

    assert listing.status_code == 200
    by_id = {user["id"]: user for user in listing.json()["users"]}
    assert by_id[linked["id"]]["cas_verified"] is True
    assert by_id[plain["id"]]["cas_verified"] is False
    # An identity from another provider is not an institutional verification.
    assert by_id[other_provider["id"]]["cas_verified"] is False


async def test_cas_verified_is_loaded_in_one_query_for_the_whole_page(
    api_client, registration, gate, db_session
):
    for _ in range(5):
        profile, _ = await account(api_client, registration)
        db_session.add(AuthIdentity(
            user_id=uuid.UUID(profile["id"]), provider="us-cas", subject=f"s-{profile['id']}", attributes={}
        ))
    _, admin = await account(api_client, registration, db_session, admin=True)
    await db_session.flush()

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if "auth_identities" in statement:
            statements.append(statement)

    engine = db_session.bind.sync_engine
    event.listen(engine, "before_cursor_execute", record)
    try:
        listing = await api_client.get("/v1/admin/users?limit=200", headers=admin)
    finally:
        event.remove(engine, "before_cursor_execute", record)

    assert listing.status_code == 200
    assert sum(user["cas_verified"] for user in listing.json()["users"]) == 5
    assert len(listing.json()["users"]) == 6
    # Six accounts, one identity query: no per-row lookups.
    assert len(statements) == 1


async def test_cas_verified_is_real_in_the_other_admin_views(
    api_client, registration, gate, db_session
):
    linked, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    db_session.add(AuthIdentity(
        user_id=uuid.UUID(linked["id"]), provider="us-cas", subject="uvus-2", attributes={}
    ))
    await db_session.flush()

    patched = await api_client.patch(
        f"/v1/admin/users/{linked['id']}", headers=admin, json={"is_active": True}
    )
    subscription = await api_client.get(f"/v1/admin/users/{linked['id']}/subscription", headers=admin)
    plan = await api_client.post(
        f"/v1/admin/users/{linked['id']}/plan", headers=admin, json={"plan": largest_plan()}
    )

    assert patched.json()["cas_verified"] is True
    assert subscription.json()["user"]["cas_verified"] is True
    assert plan.json()["cas_verified"] is True


async def test_an_account_without_cas_is_not_verified_in_the_detail_views(
    api_client, registration, gate, db_session
):
    plain, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    patched = await api_client.patch(
        f"/v1/admin/users/{plain['id']}", headers=admin, json={"is_active": True}
    )
    subscription = await api_client.get(f"/v1/admin/users/{plain['id']}/subscription", headers=admin)

    assert patched.json()["cas_verified"] is False
    assert subscription.json()["user"]["cas_verified"] is False


# -- #11: audited administrator actions -------------------------------------


async def test_a_role_change_leaves_exactly_one_event_with_before_and_after(
    api_client, registration, gate, db_session
):
    target, _ = await account(api_client, registration)
    admin_profile, admin = await account(api_client, registration, db_session, admin=True)

    changed = await api_client.patch(
        f"/v1/admin/users/{target['id']}", headers=admin, json={"role": "admin"}
    )

    assert changed.status_code == 200
    recorded = await events(db_session, "admin.user.updated")
    assert len(recorded) == 1
    event_row = recorded[0]
    assert str(event_row.actor_id) == admin_profile["id"]
    assert event_row.target_type == "User"
    assert str(event_row.target_id) == target["id"]
    assert event_row.organization_id is None
    assert event_row.detail["username"] == target["username"]
    assert event_row.detail["changes"] == {"role": {"from": "user", "to": "admin"}}


async def test_a_deactivation_and_a_role_change_in_one_request_are_one_event(
    api_client, registration, gate, db_session
):
    target, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    await api_client.patch(
        f"/v1/admin/users/{target['id']}",
        headers=admin,
        json={"role": "admin", "is_active": False},
    )

    recorded = await events(db_session, "admin.user.updated")
    assert len(recorded) == 1
    assert recorded[0].detail["changes"] == {
        "role": {"from": "user", "to": "admin"},
        "is_active": {"from": True, "to": False},
    }


async def test_a_patch_that_changes_nothing_is_not_recorded(
    api_client, registration, gate, db_session
):
    target, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    same = await api_client.patch(
        f"/v1/admin/users/{target['id']}", headers=admin, json={"is_active": True, "role": "user"}
    )
    empty = await api_client.patch(f"/v1/admin/users/{target['id']}", headers=admin, json={})

    assert same.status_code == 200 and empty.status_code == 200
    assert await events(db_session, "admin.user.updated") == []


async def test_refused_patches_leave_no_event(api_client, registration, gate, db_session):
    target, theirs = await account(api_client, registration)
    admin_profile, admin = await account(api_client, registration, db_session, admin=True)
    before = await total_events(db_session)

    forbidden = await api_client.patch(
        f"/v1/admin/users/{target['id']}", headers=theirs, json={"role": "admin"}
    )
    missing = await api_client.patch(
        f"/v1/admin/users/{uuid.uuid4()}", headers=admin, json={"is_active": False}
    )
    self_demotion = await api_client.patch(
        f"/v1/admin/users/{admin_profile['id']}", headers=admin, json={"role": "user"}
    )
    self_deactivation = await api_client.patch(
        f"/v1/admin/users/{admin_profile['id']}", headers=admin, json={"is_active": False}
    )
    anonymous = await api_client.patch(f"/v1/admin/users/{target['id']}", json={"role": "admin"})

    assert forbidden.status_code == 403
    assert missing.status_code == 404
    assert self_demotion.status_code == 409
    assert self_deactivation.status_code == 409
    assert anonymous.status_code == 401
    assert await total_events(db_session) == before
    # And the refused changes really did not happen.
    refreshed = await db_session.get(User, uuid.UUID(target["id"]))
    assert refreshed.role == UserRole.USER


async def test_a_pricing_outage_during_a_patch_leaves_no_change_and_no_event(
    api_client, registration, gate, db_session
):
    target, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    before = await total_events(db_session)
    gate.unavailable = True

    response = await api_client.patch(
        f"/v1/admin/users/{target['id']}", headers=admin, json={"role": "admin"}
    )
    gate.unavailable = False

    assert response.status_code == 503
    assert await total_events(db_session) == before
    assert (await db_session.get(User, uuid.UUID(target["id"]))).role == UserRole.USER


async def test_revoking_a_key_leaves_one_event_and_never_a_secret(
    api_client, registration, gate, db_session
):
    target, theirs = await account(api_client, registration)
    key = await create_key(api_client, theirs)
    admin_profile, admin = await account(api_client, registration, db_session, admin=True)

    revoked = await api_client.delete(
        f"/v1/admin/users/{target['id']}/api-keys/{key['id']}", headers=admin
    )

    assert revoked.status_code == 204
    recorded = await events(db_session, "admin.api_key.revoked")
    assert len(recorded) == 1
    event_row = recorded[0]
    assert str(event_row.actor_id) == admin_profile["id"]
    assert event_row.target_type == "ApiKey"
    assert str(event_row.target_id) == key["id"]
    assert event_row.detail["user_id"] == target["id"]
    assert event_row.detail["key"] == {"id": key["id"], "name": "ci-key", "prefix": key["prefix"]}
    assert event_row.detail["before"] == {"revoked": False}
    assert event_row.detail["after"] == {"revoked": True}
    # No secret material anywhere in the event.
    stored_hash = (await db_session.get(ApiKey, uuid.UUID(key["id"]))).secret_hash
    serialized = json.dumps(event_row.detail)
    assert key["secret"] not in serialized
    assert stored_hash not in serialized
    assert "hash" not in serialized.lower()


async def test_refused_revocations_leave_no_event(api_client, registration, gate, db_session):
    target, theirs = await account(api_client, registration)
    other, others = await account(api_client, registration)
    key = await create_key(api_client, theirs)
    _, admin = await account(api_client, registration, db_session, admin=True)
    before = await total_events(db_session)

    forbidden = await api_client.delete(
        f"/v1/admin/users/{target['id']}/api-keys/{key['id']}", headers=others
    )
    unknown_key = await api_client.delete(
        f"/v1/admin/users/{target['id']}/api-keys/{uuid.uuid4()}", headers=admin
    )
    wrong_owner = await api_client.delete(
        f"/v1/admin/users/{other['id']}/api-keys/{key['id']}", headers=admin
    )

    assert forbidden.status_code == 403
    assert unknown_key.status_code == 404
    assert wrong_owner.status_code == 404
    assert await total_events(db_session) == before
    # The key still works: nothing was revoked.
    assert (await api_client.get("/v1/users/me", headers={"X-API-Key": key["secret"]})).status_code == 200


async def test_revoking_twice_records_only_the_first(api_client, registration, gate, db_session):
    target, theirs = await account(api_client, registration)
    key = await create_key(api_client, theirs)
    _, admin = await account(api_client, registration, db_session, admin=True)

    first = await api_client.delete(f"/v1/admin/users/{target['id']}/api-keys/{key['id']}", headers=admin)
    second = await api_client.delete(f"/v1/admin/users/{target['id']}/api-keys/{key['id']}", headers=admin)

    assert first.status_code == 204
    assert second.status_code == 404
    assert len(await events(db_session, "admin.api_key.revoked")) == 1


async def test_reconciling_jobs_leaves_one_event_with_the_failed_count(
    api_client, registration, gate, db_session
):
    admin_profile, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.post("/v1/admin/maintenance/reconcile-jobs", headers=admin)

    assert response.status_code == 200
    assert response.json() == {"failed": 0}
    recorded = await events(db_session, "maintenance.jobs.reconciled")
    assert len(recorded) == 1
    assert str(recorded[0].actor_id) == admin_profile["id"]
    assert recorded[0].detail == {"failed": 0}


async def test_a_plan_change_by_an_administrator_is_one_audit_event(
    api_client, registration, gate, db_session
):
    target, _ = await account(api_client, registration)
    admin_profile, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.post(
        f"/v1/admin/users/{target['id']}/plan", headers=admin, json={"plan": largest_plan()}
    )

    assert response.status_code == 200
    recorded = await events(db_session, "contract.subscription.changed")
    assert len(recorded) == 1
    assert str(recorded[0].actor_id) == admin_profile["id"]
    assert recorded[0].detail["current"]["plan"] == largest_plan()


async def test_the_new_events_are_listed_in_the_platform_audit(
    api_client, registration, gate, db_session
):
    target, theirs = await account(api_client, registration)
    key = await create_key(api_client, theirs)
    _, admin = await account(api_client, registration, db_session, admin=True)
    await api_client.patch(f"/v1/admin/users/{target['id']}", headers=admin, json={"role": "admin"})
    await api_client.delete(f"/v1/admin/users/{target['id']}/api-keys/{key['id']}", headers=admin)

    listing = await api_client.get("/v1/admin/audit?limit=500", headers=admin)

    actions = [item["action"] for item in listing.json()["events"]]
    assert actions.count("admin.user.updated") == 1
    assert actions.count("admin.api_key.revoked") == 1
    for item in listing.json()["events"]:
        assert item["organizationId"] is None
        assert item["organizationSlug"] is None


# -- #12: organization events in the platform audit --------------------------


async def organization_with_two_users(
    api_client, registration, gate, db_session, *, bob_headers: bool = False
):
    alice, alice_headers = await account(api_client, registration)
    bob, bob_auth = await account(api_client, registration)
    for profile in (alice, bob):
        gate.plans[uuid.UUID(profile["id"])] = largest_plan()
    slug = f"org-{uuid.uuid4().hex[:8]}"
    created = await api_client.post(
        "/v1/organizations", headers=alice_headers, json={"slug": slug, "name": "Sponsored Org"}
    )
    assert created.status_code == 201, created.text
    if bob_headers:
        return alice, alice_headers, bob, created.json(), bob_auth
    return alice, alice_headers, bob, created.json()


async def test_an_admin_sponsor_proposal_and_its_acceptance_appear_in_the_platform_audit(
    api_client, registration, gate, db_session
):
    alice, alice_headers, bob, organization, bob_auth = await organization_with_two_users(
        api_client, registration, gate, db_session, bob_headers=True
    )
    admin_profile, admin = await account(api_client, registration, db_session, admin=True)

    proposed = await api_client.post(
        f"/v1/admin/organizations/{organization['id']}/sponsor",
        headers=admin,
        json={"billing_sponsor_user_id": bob["id"]},
    )
    assert proposed.status_code == 202, proposed.text
    accepted = await api_client.post(
        f"/v1/sponsor-proposals/{proposed.json()['id']}/accept", headers=bob_auth
    )
    assert accepted.status_code == 200, accepted.text
    proposed_events = await api_client.get(
        "/v1/admin/audit?action=organization.sponsor.proposed", headers=admin
    )
    accepted_events = await api_client.get(
        "/v1/admin/audit?action=organization.sponsor.accepted", headers=admin
    )

    assert proposed_events.json()["total"] == 1
    item = proposed_events.json()["events"][0]
    assert item["organizationId"] == organization["id"]
    assert item["organizationSlug"] == organization["slug"]
    assert item["targetType"] == "SponsorProposal"
    assert item["targetId"] == proposed.json()["id"]
    assert item["actorId"] == admin_profile["id"]
    assert item["detail"]["proposed_user_id"] == bob["id"]
    assert item["detail"]["proposed_by_user_id"] == admin_profile["id"]
    assert accepted_events.json()["total"] == 1
    done = accepted_events.json()["events"][0]
    assert done["organizationId"] == organization["id"]
    assert done["actorId"] == bob["id"]
    assert done["detail"]["previous_sponsor_user_id"] == alice["id"]
    assert done["detail"]["new_sponsor_user_id"] == bob["id"]


async def test_an_admin_taking_the_sponsorship_themselves_is_immediate_and_audited(
    api_client, registration, gate, db_session
):
    alice, alice_headers, bob, organization = await organization_with_two_users(
        api_client, registration, gate, db_session
    )
    admin_profile, admin = await account(api_client, registration, db_session, admin=True)
    gate.plans[uuid.UUID(admin_profile["id"])] = largest_plan()

    transferred = await api_client.post(
        f"/v1/admin/organizations/{organization['id']}/sponsor",
        headers=admin,
        json={"billing_sponsor_user_id": admin_profile["id"]},
    )
    listing = await api_client.get(
        "/v1/admin/audit?action=organization.sponsor_transferred", headers=admin
    )

    assert transferred.status_code == 200, transferred.text
    assert transferred.json()["billing_sponsor_user_id"] == admin_profile["id"]
    assert listing.json()["total"] == 1
    item = listing.json()["events"][0]
    assert item["organizationId"] == organization["id"]
    assert item["detail"]["previous_sponsor_user_id"] == alice["id"]
    assert item["detail"]["new_sponsor_user_id"] == admin_profile["id"]


async def test_a_sponsor_proposal_through_the_organization_patch_appears_too(
    api_client, registration, gate, db_session
):
    alice, alice_headers, bob, organization, bob_auth = await organization_with_two_users(
        api_client, registration, gate, db_session, bob_headers=True
    )
    _, admin = await account(api_client, registration, db_session, admin=True)

    patched = await api_client.patch(
        f"/v1/organizations/{organization['slug']}",
        headers=alice_headers,
        json={"billing_sponsor_user_id": bob["id"]},
    )
    proposals = await api_client.get(
        f"/v1/admin/audit?organization_id={organization['id']}&action=organization.sponsor.proposed",
        headers=admin,
    )

    assert patched.status_code == 202, patched.text
    assert proposals.json()["total"] == 1
    item = proposals.json()["events"][0]
    assert item["organizationSlug"] == organization["slug"]
    assert item["detail"]["proposed_user_id"] == bob["id"]
    assert item["detail"]["current_sponsor_user_id"] == alice["id"]

    # Bob accepts, then the owner takes the sponsorship back: that one is immediate
    # and keeps the `organization.updated` detail the audit always had.
    accepted = await api_client.post(
        f"/v1/sponsor-proposals/{patched.json()['id']}/accept", headers=bob_auth
    )
    assert accepted.status_code == 200, accepted.text
    back = await api_client.patch(
        f"/v1/organizations/{organization['slug']}",
        headers=alice_headers,
        json={"billing_sponsor_user_id": alice["id"]},
    )
    assert back.status_code == 200, back.text
    listing = await api_client.get(
        f"/v1/admin/audit?organization_id={organization['id']}&action=organization.updated",
        headers=admin,
    )
    details = [event["detail"] for event in listing.json()["events"]]
    assert {
        "previous_sponsor_user_id": bob["id"],
        "new_sponsor_user_id": alice["id"],
    } in details


async def test_the_audit_can_be_filtered_by_organization(
    api_client, registration, gate, db_session
):
    alice, alice_headers, bob, organization = await organization_with_two_users(
        api_client, registration, gate, db_session
    )
    other_slug = f"org-{uuid.uuid4().hex[:8]}"
    other = await api_client.post(
        "/v1/organizations", headers=alice_headers, json={"slug": other_slug, "name": "Other"}
    )
    admin_profile, admin = await account(api_client, registration, db_session, admin=True)
    await api_client.patch(f"/v1/admin/users/{bob['id']}", headers=admin, json={"role": "admin"})

    everything = await api_client.get("/v1/admin/audit?limit=500", headers=admin)
    mine = await api_client.get(
        f"/v1/admin/audit?organization_id={organization['id']}&limit=500", headers=admin
    )
    nothing = await api_client.get(
        f"/v1/admin/audit?organization_id={uuid.uuid4()}", headers=admin
    )
    invalid = await api_client.get("/v1/admin/audit?organization_id=not-a-uuid", headers=admin)

    organizations_seen = {item["organizationId"] for item in everything.json()["events"]}
    # Platform events (null) and both organizations' events are in the unfiltered log.
    assert {None, organization["id"], other.json()["id"]} <= organizations_seen
    assert mine.json()["total"] >= 1
    assert {item["organizationId"] for item in mine.json()["events"]} == {organization["id"]}
    assert all(item["organizationSlug"] == organization["slug"] for item in mine.json()["events"])
    assert nothing.json() == {"events": [], "total": 0, "offset": 0, "limit": 100}
    assert invalid.status_code == 422


async def test_the_action_filter_and_paging_still_apply_to_organization_events(
    api_client, registration, gate, db_session
):
    _, _, _, organization = await organization_with_two_users(api_client, registration, gate, db_session)
    _, admin = await account(api_client, registration, db_session, admin=True)

    created = await api_client.get("/v1/admin/audit?action=organization.created", headers=admin)
    paged = await api_client.get("/v1/admin/audit?limit=1", headers=admin)

    assert created.json()["total"] >= 1
    assert all(item["action"] == "organization.created" for item in created.json()["events"])
    assert len(paged.json()["events"]) == 1
    assert paged.json()["total"] >= 1


async def test_organization_members_see_exactly_what_they_saw_before(
    api_client, registration, gate, db_session
):
    alice, alice_headers, bob, organization = await organization_with_two_users(
        api_client, registration, gate, db_session
    )
    _, admin = await account(api_client, registration, db_session, admin=True)
    await api_client.patch(f"/v1/admin/users/{bob['id']}", headers=admin, json={"role": "admin"})
    await api_client.post(
        f"/v1/admin/organizations/{organization['id']}/sponsor",
        headers=admin,
        json={"billing_sponsor_user_id": bob["id"]},
    )

    own = await api_client.get(f"/v1/organizations/{organization['slug']}/audit", headers=alice_headers)

    assert own.status_code == 200
    assert {item["organizationId"] for item in own.json()["events"]} == {organization["id"]}
    # The org view keeps its shape (no new key) and never shows platform events.
    assert set(own.json()["events"][0]) == {
        "id", "organizationId", "actorId", "action", "targetType", "targetId", "detail", "createdAt",
    }
    actions = {item["action"] for item in own.json()["events"]}
    assert "organization.sponsor.proposed" in actions
    assert not any(action.startswith("admin.") for action in actions)


async def test_a_non_admin_cannot_read_the_platform_audit(api_client, registration, gate, db_session):
    _, theirs = await account(api_client, registration)

    refused = await api_client.get("/v1/admin/audit", headers=theirs)
    filtered = await api_client.get(f"/v1/admin/audit?organization_id={uuid.uuid4()}", headers=theirs)
    anonymous = await api_client.get("/v1/admin/audit")

    assert refused.status_code == 403
    assert filtered.status_code == 403
    assert anonymous.status_code == 401

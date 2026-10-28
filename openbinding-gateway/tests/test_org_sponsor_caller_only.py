"""M9.6: only the caller can become the billing sponsor of an organization.

``PATCH /v1/organizations/{org}`` naming somebody other than the caller and the
current sponsor answers 422 ``sponsor_must_be_caller`` before anything in the
request is applied; there are no sponsorship proposals any more, so account
deactivation and deletion never read or write them.

The API client and ``db_session`` share one session, so a refusal that touched
the organization before raising would show here even without a commit.
"""

from __future__ import annotations

import uuid

import pytest_asyncio
from sqlalchemy import func, inspect, select

from _pricing import fake_pricing_gate, largest_plan
from openbinding_gateway import space_client
from openbinding_gateway.db.base import Base
from openbinding_gateway.db.models import AuditEvent, Notification, Organization, User, UserRole
from openbinding_gateway.main import app

LARGER_PLAN = largest_plan()


@pytest_asyncio.fixture
async def gate():
    previous = space_client.get_gate()
    installed = fake_pricing_gate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(previous)


async def account(client, registration, db_session=None, *, admin: bool = False) -> tuple[dict, dict]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
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
    return created.json(), {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest_asyncio.fixture
async def acme(api_client, registration, gate, db_session):
    """``acme`` (with a child) sponsored by alice; bob OWNER, dave ADMIN, carol MEMBER."""

    people = {}
    for name in ("alice", "bob", "carol", "dave"):
        people[name] = await account(api_client, registration)
    alice, alice_headers = people["alice"]
    gate.plans[uuid.UUID(alice["id"])] = LARGER_PLAN
    root = await api_client.post(
        "/v1/organizations",
        headers=alice_headers,
        json={"slug": f"acme-{uuid.uuid4().hex[:8]}", "name": "Acme"},
    )
    assert root.status_code == 201, root.text
    child = await api_client.post(
        "/v1/organizations",
        headers=alice_headers,
        json={"slug": f"acme-child-{uuid.uuid4().hex[:8]}", "name": "Acme child", "parent_id": root.json()["id"]},
    )
    assert child.status_code == 201, child.text
    for name, role in (("bob", "OWNER"), ("carol", "MEMBER"), ("dave", "ADMIN")):
        profile = people[name][0]
        added = await api_client.put(
            f"/v1/organizations/{root.json()['slug']}/members/{profile['id']}",
            headers=alice_headers,
            json={"user_id": profile["id"], "role": role},
        )
        assert added.status_code == 200, added.text
    return {
        **people,
        "root": root.json(),
        "child": child.json(),
        "url": f"/v1/organizations/{root.json()['slug']}",
    }


async def sponsors(db_session, *organizations: dict) -> set[str]:
    db_session.expire_all()
    rows = (
        await db_session.execute(
            select(Organization).where(Organization.id.in_([uuid.UUID(o["id"]) for o in organizations]))
        )
    ).scalars().all()
    return {str(row.billing_sponsor_user_id) for row in rows}


async def written(db_session) -> tuple[int, int]:
    audits = await db_session.scalar(select(func.count(AuditEvent.id)))
    notifications = await db_session.scalar(select(func.count(Notification.id)))
    return int(audits or 0), int(notifications or 0)


# -- req~auth-roles-entitlements-sponsor-caller-only~1 ------------------------


async def test_an_owner_naming_another_member_is_refused_and_nothing_is_applied(api_client, db_session, acme):
    # [utest->req~auth-roles-entitlements-sponsor-caller-only~1]
    alice, carol = acme["alice"][0], acme["carol"][0]
    before = await written(db_session)

    refused = await api_client.patch(
        acme["url"],
        headers=acme["bob"][1],
        json={"name": "Acme Lab", "billing_sponsor_user_id": carol["id"]},
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "sponsor_must_be_caller"
    assert await written(db_session) == before
    organization = await db_session.get(Organization, uuid.UUID(acme["root"]["id"]))
    assert organization.name == "Acme"
    assert await sponsors(db_session, acme["root"], acme["child"]) == {alice["id"]}


async def test_unknown_and_inactive_users_get_identical_answers(api_client, db_session, registration, acme):
    # [utest->req~auth-roles-entitlements-sponsor-caller-only~1]
    erin, _ = await account(api_client, registration)
    user = await db_session.get(User, uuid.UUID(erin["id"]))
    user.is_active = False
    await db_session.flush()

    unknown = await api_client.patch(
        acme["url"], headers=acme["bob"][1], json={"billing_sponsor_user_id": str(uuid.uuid4())}
    )
    inactive = await api_client.patch(
        acme["url"], headers=acme["bob"][1], json={"billing_sponsor_user_id": erin["id"]}
    )

    assert unknown.status_code == inactive.status_code == 422
    assert unknown.json()["code"] == "sponsor_must_be_caller"
    assert unknown.json() == inactive.json()


async def test_the_refusal_comes_before_any_other_validation(api_client, db_session, acme):
    # [utest->req~auth-roles-entitlements-sponsor-caller-only~1]
    # ``move_to_root`` together with ``parent_id`` is ``ambiguous_parent`` on its own;
    # a foreign sponsor is refused first, and the parent is untouched.
    refused = await api_client.patch(
        f"/v1/organizations/{acme['child']['slug']}",
        headers=acme["bob"][1],
        json={
            "billing_sponsor_user_id": acme["carol"][0]["id"],
            "move_to_root": True,
            "parent_id": str(uuid.uuid4()),
            "name": "Moved",
        },
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "sponsor_must_be_caller"
    db_session.expire_all()
    child = await db_session.get(Organization, uuid.UUID(acme["child"]["id"]))
    assert str(child.parent_id) == acme["root"]["id"] and child.name == "Acme child"


async def test_the_retired_request_field_is_a_validation_error(api_client, db_session, acme):
    # [utest->req~auth-roles-entitlements-sponsor-caller-only~1]
    bob, bob_headers = acme["bob"]

    refused = await api_client.patch(
        acme["url"],
        headers=bob_headers,
        json={"billing_sponsor_user_id": bob["id"], "replace_pending_proposal": True},
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "validation_error"
    pointers = {item.get("pointer") for item in refused.json()["diagnostics"]}
    assert "/replace_pending_proposal" in pointers
    assert await sponsors(db_session, acme["root"]) == {acme["alice"][0]["id"]}


def test_the_contract_documents_the_refusal():
    # [utest->req~auth-roles-entitlements-sponsor-caller-only~1]
    responses = app.openapi()["paths"]["/v1/organizations/{org}"]["patch"]["responses"]

    assert "202" not in responses and "409" not in responses
    assert "sponsor_proposal_pending" not in str(responses)
    assert "sponsor_must_be_caller" in responses["422"]["description"]
    assert "sponsor_quota_exceeded" in responses["402"]["description"]


# -- req~auth-roles-entitlements-sponsor-self-transfer~1 -----------------------


async def test_an_owner_takes_the_sponsorship_of_the_whole_subtree(api_client, db_session, gate, acme):
    # [utest->req~auth-roles-entitlements-sponsor-self-transfer~1]
    alice, bob, bob_headers = acme["alice"][0], *acme["bob"]
    gate.plans[uuid.UUID(bob["id"])] = LARGER_PLAN

    taken = await api_client.patch(acme["url"], headers=bob_headers, json={"billing_sponsor_user_id": bob["id"]})

    assert taken.status_code == 200, taken.text
    assert taken.json()["billing_sponsor_user_id"] == bob["id"]
    assert await sponsors(db_session, acme["root"], acme["child"]) == {bob["id"]}
    [event] = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.action == "organization.updated",
                AuditEvent.organization_id == uuid.UUID(acme["root"]["id"]),
            )
        )
    ).scalars().all()
    assert event.actor_id == uuid.UUID(bob["id"])
    assert event.detail == {"previous_sponsor_user_id": alice["id"], "new_sponsor_user_id": bob["id"]}


async def test_a_plan_too_small_is_refused_and_the_sponsor_stays(api_client, db_session, acme):
    # [utest->req~auth-roles-entitlements-sponsor-self-transfer~1]
    bob, bob_headers = acme["bob"]

    refused = await api_client.patch(acme["url"], headers=bob_headers, json={"billing_sponsor_user_id": bob["id"]})

    assert refused.status_code == 402, refused.text
    assert refused.json()["code"] == "sponsor_quota_exceeded"
    assert await sponsors(db_session, acme["root"], acme["child"]) == {acme["alice"][0]["id"]}


async def test_an_admin_who_is_not_owner_is_forbidden_whoever_they_name(api_client, db_session, gate, acme):
    # [utest->req~auth-roles-entitlements-sponsor-self-transfer~1]
    dave, dave_headers = acme["dave"]
    gate.plans[uuid.UUID(dave["id"])] = LARGER_PLAN

    for named in (dave["id"], acme["carol"][0]["id"]):
        refused = await api_client.patch(acme["url"], headers=dave_headers, json={"billing_sponsor_user_id": named})
        assert refused.status_code == 403, refused.text
        assert refused.json()["code"] == "organization_forbidden"
    assert await sponsors(db_session, acme["root"], acme["child"]) == {acme["alice"][0]["id"]}


async def test_naming_the_current_sponsor_changes_nothing_but_the_rest(api_client, db_session, acme):
    # [utest->req~auth-roles-entitlements-sponsor-self-transfer~1]
    alice = acme["alice"][0]

    renamed = await api_client.patch(
        acme["url"],
        headers=acme["bob"][1],
        json={"name": "Acme Lab", "billing_sponsor_user_id": alice["id"]},
    )

    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Acme Lab"
    assert renamed.json()["billing_sponsor_user_id"] == alice["id"]
    assert await sponsors(db_session, acme["root"], acme["child"]) == {alice["id"]}


# -- req~auth-roles-entitlements-account-lifecycle-without-proposals~1 ---------


async def tables(db_session) -> set[str]:
    connection = await db_session.connection()
    return set(await connection.run_sync(lambda sync: inspect(sync).get_table_names()))


async def test_deactivation_works_on_a_schema_without_proposals(api_client, db_session, registration, gate):
    # [utest->req~auth-roles-entitlements-account-lifecycle-without-proposals~1]
    assert "sponsor_proposals" not in Base.metadata.tables
    assert "sponsor_proposals" not in await tables(db_session)
    erin, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    deactivated = await api_client.patch(f"/v1/admin/users/{erin['id']}", headers=admin, json={"is_active": False})

    assert deactivated.status_code == 200, deactivated.text
    assert deactivated.json()["is_active"] is False
    cancelled = await db_session.scalar(
        select(func.count(AuditEvent.id)).where(AuditEvent.action == "organization.sponsor.cancelled")
    )
    assert cancelled == 0


async def test_deletion_works_on_a_schema_without_proposals(api_client, db_session, registration, gate):
    # [utest->req~auth-roles-entitlements-account-lifecycle-without-proposals~1]
    assert "sponsor_proposals" not in await tables(db_session)
    frank, frank_headers = await account(api_client, registration)

    deleted = await api_client.request(
        "DELETE",
        "/v1/users/me",
        headers=frank_headers,
        json={"confirmation": frank["username"], "current_password": "correct-horse-battery"},
    )

    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    assert await db_session.get(User, uuid.UUID(frank["id"])) is None

"""B1 #1: only an organization OWNER may grant OWNER or alter an owner."""

from __future__ import annotations

import uuid

import pytest

from _b1_helpers import gate, make_account, make_key, make_org, put_member, roles  # noqa: F401

REFUSED = "owner_role_requires_owner"


@pytest.fixture
async def team(api_client, registration, db_session, gate):
    """One organization with an owner, a co-owner, an admin, a member and a viewer."""
    accounts = {}
    for name in ("owner", "coowner", "admin", "member", "viewer", "outsider", "candidate"):
        accounts[name] = await make_account(api_client, registration, db_session, gate)
    platform, platform_headers = await make_account(
        api_client, registration, db_session, gate, admin=True
    )
    accounts["platform"] = (platform, platform_headers)
    owner_headers = accounts["owner"][1]
    org = (await make_org(api_client, owner_headers))["slug"]
    for name, role in (
        ("coowner", "OWNER"),
        ("admin", "ADMIN"),
        ("member", "MEMBER"),
        ("viewer", "VIEWER"),
        ("platform", "ADMIN"),
    ):
        added = await put_member(api_client, owner_headers, org, accounts[name][0]["id"], role)
        assert added.status_code == 200, added.text
    return org, accounts


def uid(accounts, name):
    return accounts[name][0]["id"]


def auth(accounts, name):
    return accounts[name][1]


async def test_admin_cannot_grant_owner_through_put(api_client, team):
    org, accounts = team
    before = await roles(api_client, auth(accounts, "owner"), org)

    refused = await put_member(api_client, auth(accounts, "admin"), org, uid(accounts, "member"), "OWNER")
    brand_new = await put_member(api_client, auth(accounts, "admin"), org, uid(accounts, "candidate"), "OWNER")

    for response in (refused, brand_new):
        assert response.status_code == 403, response.text
        assert response.json()["detail"]["code"] == REFUSED
    assert refused.json()["detail"]["user_id"] == uid(accounts, "member")
    assert await roles(api_client, auth(accounts, "owner"), org) == before


async def test_admin_cannot_change_or_remove_an_owner(api_client, team):
    org, accounts = team
    before = await roles(api_client, auth(accounts, "owner"), org)
    admin = auth(accounts, "admin")

    demoted = await put_member(api_client, admin, org, uid(accounts, "coowner"), "VIEWER")
    same_role = await put_member(api_client, admin, org, uid(accounts, "coowner"), "OWNER")
    removed = await api_client.delete(
        f"/v1/organizations/{org}/members/{uid(accounts, 'coowner')}", headers=admin
    )

    for response in (demoted, same_role, removed):
        assert response.status_code == 403, response.text
        assert response.json()["detail"]["code"] == REFUSED
    assert await roles(api_client, auth(accounts, "owner"), org) == before


async def test_admin_keeps_every_non_owner_role_change(api_client, team):
    org, accounts = team
    admin = auth(accounts, "admin")

    promoted = await put_member(api_client, admin, org, uid(accounts, "member"), "ADMIN")
    demoted = await put_member(api_client, admin, org, uid(accounts, "viewer"), "MEMBER")
    added = await put_member(api_client, admin, org, uid(accounts, "candidate"), "MEMBER")
    removed = await api_client.delete(
        f"/v1/organizations/{org}/members/{uid(accounts, 'candidate')}", headers=admin
    )

    assert [r.status_code for r in (promoted, demoted, added)] == [200, 200, 200]
    assert removed.status_code == 204, removed.text
    final = await roles(api_client, auth(accounts, "owner"), org)
    assert final[uid(accounts, "member")] == "ADMIN"
    assert final[uid(accounts, "viewer")] == "MEMBER"
    assert uid(accounts, "candidate") not in final


async def test_owner_can_grant_demote_and_remove_owners(api_client, team):
    org, accounts = team
    owner = auth(accounts, "owner")

    granted = await put_member(api_client, owner, org, uid(accounts, "member"), "OWNER")
    demoted = await put_member(api_client, owner, org, uid(accounts, "coowner"), "ADMIN")
    removed = await api_client.delete(
        f"/v1/organizations/{org}/members/{uid(accounts, 'member')}", headers=owner
    )

    assert granted.status_code == 200 and granted.json()["role"] == "OWNER"
    assert demoted.status_code == 200 and demoted.json()["role"] == "ADMIN"
    assert removed.status_code == 204, removed.text


async def test_the_last_owner_stays_protected_for_owners(api_client, team):
    org, accounts = team
    owner = auth(accounts, "owner")
    # Two owners today: demote one, then the survivor cannot demote or remove itself.
    assert (await put_member(api_client, owner, org, uid(accounts, "coowner"), "ADMIN")).status_code == 200

    demote_last = await put_member(api_client, owner, org, uid(accounts, "owner"), "ADMIN")
    remove_last = await api_client.delete(
        f"/v1/organizations/{org}/members/{uid(accounts, 'owner')}", headers=owner
    )

    for response in (demote_last, remove_last):
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "last_owner"


@pytest.mark.parametrize("name", ["member", "viewer"])
async def test_lower_roles_are_refused_before_the_owner_rule(api_client, team, name):
    org, accounts = team
    refused = await put_member(api_client, auth(accounts, name), org, uid(accounts, "candidate"), "OWNER")
    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "organization_forbidden"


async def test_outsider_and_anonymous_cannot_touch_owners(api_client, team):
    org, accounts = team
    outsider = await put_member(api_client, auth(accounts, "outsider"), org, uid(accounts, "candidate"), "OWNER")
    anonymous = await api_client.put(
        f"/v1/organizations/{org}/members/{uid(accounts, 'candidate')}",
        json={"user_id": uid(accounts, "candidate"), "role": "OWNER"},
    )
    assert outsider.status_code == 403
    assert outsider.json()["detail"]["code"] == "organization_forbidden"
    assert anonymous.status_code == 401


async def test_platform_admin_with_admin_access_keeps_the_capability(api_client, team):
    org, accounts = team
    platform = auth(accounts, "platform")

    granted = await put_member(api_client, platform, org, uid(accounts, "member"), "OWNER")

    assert granted.status_code == 200, granted.text
    assert (await roles(api_client, auth(accounts, "owner"), org))[uid(accounts, "member")] == "OWNER"


async def test_platform_admin_without_membership_gets_no_access(api_client, team, registration, db_session, gate):
    org, accounts = team
    _, stranger = await make_account(api_client, registration, db_session, gate, admin=True)
    refused = await put_member(api_client, stranger, org, uid(accounts, "member"), "OWNER")
    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "organization_forbidden"


async def test_batch_with_an_owner_change_is_refused_whole_for_admins(api_client, team):
    org, accounts = team
    endpoint = f"/v1/organizations/{org}/members/batch"
    before = await roles(api_client, auth(accounts, "owner"), org)

    refused = await api_client.post(
        endpoint,
        headers=auth(accounts, "admin"),
        json={"changes": [
            {"user_id": uid(accounts, "viewer"), "role": "MEMBER"},
            {"user_id": uid(accounts, "member"), "role": "OWNER"},
        ]},
    )
    refused_removal = await api_client.post(
        endpoint,
        headers=auth(accounts, "admin"),
        json={"changes": [{"user_id": uid(accounts, "coowner"), "role": None}]},
    )

    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"]["code"] == REFUSED
    assert refused.json()["detail"]["index"] == 1
    assert refused.json()["detail"]["user_id"] == uid(accounts, "member")
    assert refused_removal.status_code == 403
    assert refused_removal.json()["detail"]["code"] == REFUSED
    # All-or-nothing: the harmless first change was not applied either.
    assert await roles(api_client, auth(accounts, "owner"), org) == before


async def test_batch_without_owner_changes_still_works_for_admins(api_client, team):
    org, accounts = team
    saved = await api_client.post(
        f"/v1/organizations/{org}/members/batch",
        headers=auth(accounts, "admin"),
        json={"changes": [
            {"user_id": uid(accounts, "viewer"), "role": "MEMBER"},
            {"user_id": uid(accounts, "candidate"), "role": "VIEWER"},
            {"user_id": uid(accounts, "member"), "role": None},
        ]},
    )
    assert saved.status_code == 200, saved.text
    final = {row["user_id"]: row["role"] for row in saved.json()}
    assert final[uid(accounts, "viewer")] == "MEMBER"
    assert final[uid(accounts, "candidate")] == "VIEWER"
    assert uid(accounts, "member") not in final


async def test_batch_owner_changes_work_for_owners_and_platform_admins(api_client, team):
    org, accounts = team
    endpoint = f"/v1/organizations/{org}/members/batch"

    by_owner = await api_client.post(
        endpoint, headers=auth(accounts, "owner"),
        json={"changes": [{"user_id": uid(accounts, "member"), "role": "OWNER"}]},
    )
    by_platform = await api_client.post(
        endpoint, headers=auth(accounts, "platform"),
        json={"changes": [{"user_id": uid(accounts, "viewer"), "role": "OWNER"}]},
    )

    assert by_owner.status_code == 200, by_owner.text
    assert by_platform.status_code == 200, by_platform.text
    final = {row["user_id"]: row["role"] for row in by_platform.json()}
    assert final[uid(accounts, "member")] == final[uid(accounts, "viewer")] == "OWNER"


async def test_invitations_cannot_smuggle_the_owner_role_past_an_admin(api_client, team):
    org, accounts = team
    endpoint = f"/v1/organizations/{org}/invitations"
    email = "someone@example.org"

    refused = await api_client.post(endpoint, headers=auth(accounts, "admin"), json={"email": email, "role": "OWNER"})
    allowed = await api_client.post(endpoint, headers=auth(accounts, "admin"), json={"email": email, "role": "ADMIN"})
    by_owner = await api_client.post(endpoint, headers=auth(accounts, "owner"), json={"email": email, "role": "OWNER"})

    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == REFUSED
    assert allowed.status_code == 201, allowed.text
    assert by_owner.status_code == 201, by_owner.text


async def test_api_keys_follow_the_role_of_their_account(api_client, team):
    org, accounts = team
    admin_key = await make_key(api_client, auth(accounts, "admin"), ["organizations:write", "organizations:read"])
    owner_key = await make_key(api_client, auth(accounts, "owner"), ["organizations:write", "organizations:read"])
    read_only = await make_key(api_client, auth(accounts, "owner"), ["organizations:read"])

    refused = await put_member(api_client, admin_key, org, uid(accounts, "member"), "OWNER")
    no_permission = await put_member(api_client, read_only, org, uid(accounts, "member"), "OWNER")
    granted = await put_member(api_client, owner_key, org, uid(accounts, "member"), "OWNER")

    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == REFUSED
    assert no_permission.status_code == 403
    assert no_permission.json()["detail"]["code"] == "insufficient_api_key_permission"
    assert granted.status_code == 200, granted.text


async def test_ownership_is_inherited_from_the_parent_organization(api_client, team):
    org, accounts = team
    owner = auth(accounts, "owner")
    parent = (await api_client.get(f"/v1/organizations/{org}", headers=owner)).json()
    child = (await make_org(api_client, owner, parent_id=parent["id"]))["slug"]
    assert (await put_member(api_client, owner, child, uid(accounts, "member"), "MEMBER")).status_code == 200

    # The parent's ADMIN is an effective ADMIN of the child; the parent's OWNER an effective OWNER.
    by_admin = await put_member(api_client, auth(accounts, "admin"), child, uid(accounts, "member"), "OWNER")
    by_parent_owner = await put_member(api_client, auth(accounts, "coowner"), child, uid(accounts, "member"), "OWNER")

    assert by_admin.status_code == 403
    assert by_admin.json()["detail"]["code"] == REFUSED
    assert by_parent_owner.status_code == 200, by_parent_owner.text

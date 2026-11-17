"""One owner per organization, as SPHERE (F2c B8): the owner's seat moves only by ``PUT .../owner``.

No member route grants OWNER (the role is not in their payloads), and none changes or removes the owner's
membership (409 ``owner_transfer_required``); everything else about members stays an admin's call.
"""

from __future__ import annotations

from _b1_helpers import gate, make_account, make_org, put_member, roles  # noqa: F401

import pytest

SEAT = "owner_transfer_required"


@pytest.fixture
async def team(api_client, registration, db_session, gate):  # noqa: F811 - gate is an imported fixture
    """One organization with an owner, an admin, a member, a viewer and two people outside it."""
    accounts = {}
    for name in ("owner", "admin", "member", "viewer", "outsider", "candidate"):
        accounts[name] = await make_account(api_client, registration, db_session, gate)
    owner_headers = accounts["owner"][1]
    org = (await make_org(api_client, owner_headers))["slug"]
    for name, role in (("admin", "ADMIN"), ("member", "MEMBER"), ("viewer", "VIEWER")):
        added = await put_member(api_client, owner_headers, org, accounts[name][0]["id"], role)
        assert added.status_code == 200, added.text
    return org, accounts


def uid(accounts, name):
    return accounts[name][0]["id"]


def auth(accounts, name):
    return accounts[name][1]


async def test_no_member_route_grants_owner(api_client, team):
    org, accounts = team
    for who in ("owner", "admin"):
        upsert = await put_member(api_client, auth(accounts, who), org, uid(accounts, "member"), "OWNER")
        batch = await api_client.post(
            f"/v1/organizations/{org}/members/batch",
            headers=auth(accounts, who),
            json={"changes": [{"user_id": uid(accounts, "candidate"), "role": "OWNER"}]},
        )
        assert upsert.status_code == 422, upsert.text
        assert batch.status_code == 422, batch.text
    final = await roles(api_client, auth(accounts, "owner"), org)
    assert [user for user, role in final.items() if role == "OWNER"] == [uid(accounts, "owner")]


async def test_the_owner_seat_is_neither_changed_nor_removed_by_member_routes(api_client, team):
    org, accounts = team
    owner_id = uid(accounts, "owner")
    for who in ("owner", "admin"):
        demoted = await put_member(api_client, auth(accounts, who), org, owner_id, "ADMIN")
        removed = await api_client.delete(f"/v1/organizations/{org}/members/{owner_id}", headers=auth(accounts, who))
        batch = await api_client.post(
            f"/v1/organizations/{org}/members/batch",
            headers=auth(accounts, who),
            json={"changes": [{"user_id": owner_id, "role": None}]},
        )
        for refused in (demoted, removed, batch):
            assert refused.status_code == 409, refused.text
            assert refused.json()["detail"]["code"] == SEAT
    assert (await roles(api_client, auth(accounts, "owner"), org))[owner_id] == "OWNER"


async def test_an_admin_keeps_every_other_role_change(api_client, team):
    org, accounts = team
    admin = auth(accounts, "admin")

    promoted = await put_member(api_client, admin, org, uid(accounts, "member"), "ADMIN")
    demoted = await put_member(api_client, admin, org, uid(accounts, "viewer"), "MEMBER")
    added = await put_member(api_client, admin, org, uid(accounts, "candidate"), "MEMBER")
    removed = await api_client.delete(f"/v1/organizations/{org}/members/{uid(accounts, 'candidate')}", headers=admin)

    assert [r.status_code for r in (promoted, demoted, added)] == [200, 200, 200]
    assert removed.status_code == 204, removed.text
    final = await roles(api_client, auth(accounts, "owner"), org)
    assert final[uid(accounts, "member")] == "ADMIN"
    assert final[uid(accounts, "viewer")] == "MEMBER"
    assert uid(accounts, "candidate") not in final


async def test_a_batch_without_the_owner_still_works_for_admins(api_client, team):
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


async def test_the_seat_moves_by_a_transfer(api_client, team):
    org, accounts = team
    moved = await api_client.put(
        f"/v1/organizations/{org}/owner", headers=auth(accounts, "owner"), json={"user_id": uid(accounts, "admin")}
    )
    assert moved.status_code == 200, moved.text
    final = await roles(api_client, auth(accounts, "admin"), org)
    assert final[uid(accounts, "admin")] == "OWNER"
    assert final[uid(accounts, "owner")] == "ADMIN"


async def test_outsiders_and_lower_roles_touch_no_member(api_client, team):
    org, accounts = team
    for who in ("member", "viewer", "outsider"):
        refused = await put_member(api_client, auth(accounts, who), org, uid(accounts, "candidate"), "VIEWER")
        assert refused.status_code in {403, 404}, (who, refused.text)
    anonymous = await api_client.put(
        f"/v1/organizations/{org}/members/{uid(accounts, 'candidate')}",
        json={"user_id": uid(accounts, "candidate"), "role": "VIEWER"},
    )
    assert anonymous.status_code == 401

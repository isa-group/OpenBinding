"""Handing an organization over, and leaving one (F2c G4).

As SPHERE: ``PUT .../owner`` is a swap over the whole branch. The recipient, already a member, takes the owner's
seat; every owner seat of the organization and its descendants steps down to ADMIN, the caller's included; the
recipient is told with a ``System`` notification. Only the organization's own owner hands it over. Any member but
an owner leaves with ``DELETE .../members/{me}``, without needing ADMIN; an owner hands it over first.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select

from _b1_helpers import gate, make_account  # noqa: F401
from openbinding_gateway.db.models import Notification


def code(response) -> str | None:
    body = response.json()
    detail = body.get("detail")
    return body.get("code") or (detail.get("code") if isinstance(detail, dict) else None)


async def org(client, headers, name: str, parent: str | None = None) -> dict:
    body = {"name": f"{name} {uuid.uuid4().hex[:6]}", **({"parent_id": parent} if parent else {})}
    created = await client.post("/v1/organizations", headers=headers, json=body)
    assert created.status_code == 201, created.text
    return created.json()


async def add(client, headers, slug: str, account: dict, role: str) -> None:
    added = await client.put(
        f"/v1/organizations/{slug}/members/{account['id']}", headers=headers,
        json={"user_id": account["id"], "role": role},
    )
    assert added.status_code == 200, added.text


async def roles(client, headers, slug: str) -> dict[str, str]:
    listed = await client.get(f"/v1/organizations/{slug}/members", headers=headers)
    assert listed.status_code == 200, listed.text
    return {row["user_id"]: row["role"] for row in listed.json()}


async def test_ownership_is_swapped_over_the_whole_branch(api_client, registration, db_session, gate):  # noqa: F811
    owner_account, owner = await make_account(api_client, registration, db_session, gate)
    heir_account, heir = await make_account(api_client, registration, db_session, gate)
    other_account, _ = await make_account(api_client, registration, db_session, gate)
    root = await org(api_client, owner, "Handed")
    child = await org(api_client, owner, "Handed child", parent=root["id"])
    await add(api_client, owner, root["slug"], heir_account, "MEMBER")
    await add(api_client, owner, child["slug"], other_account, "OWNER")

    handed = await api_client.put(
        f"/v1/organizations/{root['slug']}/owner", headers=owner, json={"user_id": heir_account["id"]},
    )

    assert handed.status_code == 200, handed.text
    assert {row["user_id"]: row["role"] for row in handed.json()} == {
        owner_account["id"]: "ADMIN", heir_account["id"]: "OWNER",
    }
    assert await roles(api_client, heir, child["slug"]) == {
        owner_account["id"]: "ADMIN", other_account["id"]: "ADMIN",
    }
    child_view = await api_client.get(f"/v1/organizations/{child['slug']}", headers=heir)
    assert child_view.json()["effective_role"] == "OWNER"
    told = (await db_session.scalars(
        select(Notification).where(Notification.user_id == uuid.UUID(heir_account["id"]))
    )).all()
    assert [(row.kind, row.subject) for row in told] == [("System", "You are now an owner")]
    # The previous owner has nothing left to hand over.
    again = await api_client.put(
        f"/v1/organizations/{root['slug']}/owner", headers=owner, json={"user_id": owner_account["id"]},
    )
    assert again.status_code == 422 and code(again) == "already_owner"
    back = await api_client.put(
        f"/v1/organizations/{root['slug']}/owner", headers=owner, json={"user_id": heir_account["id"]},
    )
    assert back.status_code == 403 and code(back) == "owner_transfer_requires_owner"


async def test_the_recipient_must_be_a_member(api_client, registration, db_session, gate):  # noqa: F811
    _, owner = await make_account(api_client, registration, db_session, gate)
    stranger_account, stranger = await make_account(api_client, registration, db_session, gate)
    parent_member, _ = await make_account(api_client, registration, db_session, gate)
    root = await org(api_client, owner, "Kept")
    child = await org(api_client, owner, "Kept child", parent=root["id"])
    await add(api_client, owner, root["slug"], parent_member, "VIEWER")
    url = f"/v1/organizations/{child['slug']}/owner"

    outsider = await api_client.put(url, headers=owner, json={"user_id": stranger_account["id"]})
    nobody = await api_client.put(url, headers=owner, json={"user_id": str(uuid.uuid4())})
    from_outside = await api_client.put(url, headers=stranger, json={"user_id": stranger_account["id"]})
    inherited = await api_client.put(url, headers=owner, json={"user_id": parent_member["id"]})

    assert outsider.status_code == 404 and nobody.status_code == 404 and from_outside.status_code == 404
    # A member above the organization may take it: they are seated here as its owner.
    assert inherited.status_code == 200, inherited.text
    assert {row["user_id"]: row["role"] for row in inherited.json()}[parent_member["id"]] == "OWNER"


async def test_a_member_leaves_but_an_owner_hands_over_first(api_client, registration, db_session, gate):  # noqa: F811
    owner_account, owner = await make_account(api_client, registration, db_session, gate)
    viewer_account, viewer = await make_account(api_client, registration, db_session, gate)
    _, stranger = await make_account(api_client, registration, db_session, gate)
    root = await org(api_client, owner, "Left")
    await add(api_client, owner, root["slug"], viewer_account, "VIEWER")
    members = f"/v1/organizations/{root['slug']}/members"

    left = await api_client.delete(f"{members}/{viewer_account['id']}", headers=viewer)
    not_member = await api_client.delete(f"{members}/{viewer_account['id']}", headers=viewer)
    stays = await api_client.delete(f"{members}/{owner_account['id']}", headers=owner)

    assert left.status_code == 204, left.text
    assert viewer_account["id"] not in await roles(api_client, owner, root["slug"])
    assert not_member.status_code == 404
    # The only owner is kept until it hands the organization over (B8 makes that the only way out).
    assert stays.status_code == 409 and code(stays) == "last_owner"
    # Removing somebody else is the ADMIN route it was (403 for a non-member until the routes move to 404).
    other = await api_client.delete(f"{members}/{owner_account['id']}", headers=stranger)
    assert other.status_code == 403

"""Invitation codes and user search (F2c G3).

As SPHERE's invitations: an ADMIN makes a shareable code (valid seven days by default, with an optional number of
uses), lists and revokes the organization's codes, and invites named users, which makes one code with a use for
each and sends each an ``OrganizationInvitation`` notification. Whoever holds a usable code previews what it
joins (no credential needed) and joins as MEMBER; an unknown, expired, revoked or used up code is the same 404,
and a member joining again is 409 ``already_member``. A non-member gets 404 on the organization's routes.

User search answers at most twenty users whose username holds four characters or more: id, username and avatar,
never an email. The email/token invitations stay until B8.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import select

from _b1_helpers import gate, make_account  # noqa: F401
from openbinding_gateway.db.models import Notification, OrganizationInvitationCode, utcnow


def code(response) -> str | None:
    body = response.json()
    detail = body.get("detail")
    return body.get("code") or (detail.get("code") if isinstance(detail, dict) else None)


async def org(client, headers, name: str = "Inviting") -> dict:
    created = await client.post("/v1/organizations", headers=headers, json={"name": f"{name} {uuid.uuid4().hex[:6]}"})
    assert created.status_code == 201, created.text
    return created.json()


async def test_a_code_joins_whoever_holds_it_as_member(api_client, registration, db_session, gate):  # noqa: F811
    owner_account, owner = await make_account(api_client, registration, db_session, gate)
    _, guest = await make_account(api_client, registration, db_session, gate)
    made = await org(api_client, owner)
    base = f"/v1/organizations/{made['slug']}/invitations"

    created = await api_client.post(base, headers=owner, json={"max_uses": 2})

    assert created.status_code == 201, created.text
    invitation = created.json()
    assert invitation["use_count"] == 0 and invitation["max_uses"] == 2
    assert invitation["created_by"] == {"id": owner_account["id"], "username": owner_account["username"], "avatar": None}
    assert invitation["expires_at"] is not None and len(invitation["code"]) == 16
    preview = await api_client.get(f"/v1/invitations/{invitation['code']}/preview")
    assert preview.status_code == 200, preview.text
    assert preview.json()["organization"]["slug"] == made["slug"]
    assert preview.json()["invited_by"]["username"] == owner_account["username"]
    assert "email" not in preview.text

    joined = await api_client.post(f"/v1/invitations/{invitation['code']}/join", headers=guest)

    assert joined.status_code == 200, joined.text
    assert joined.json()["slug"] == made["slug"] and joined.json()["effective_role"] == "MEMBER"
    again = await api_client.post(f"/v1/invitations/{invitation['code']}/join", headers=guest)
    assert again.status_code == 409 and code(again) == "already_member"
    listed = await api_client.get(base, headers=owner)
    assert [row["use_count"] for row in listed.json()] == [1]
    # The email invitation is still there until B8.
    email = await api_client.post(base, headers=owner, json={"email": "someone@example.org", "role": "VIEWER"})
    assert email.status_code == 201 and email.json()["token"].startswith("obi_")


async def test_an_expired_used_up_or_revoked_code_is_the_same_404(api_client, registration, db_session, gate):  # noqa: F811
    _, owner = await make_account(api_client, registration, db_session, gate)
    _, first = await make_account(api_client, registration, db_session, gate)
    _, second = await make_account(api_client, registration, db_session, gate)
    made = await org(api_client, owner)
    base = f"/v1/organizations/{made['slug']}/invitations"
    once = (await api_client.post(base, headers=owner, json={"max_uses": 1})).json()
    expiring = (await api_client.post(base, headers=owner, json={})).json()
    revoked = (await api_client.post(base, headers=owner, json={"expires_in_days": None})).json()
    assert revoked["expires_at"] is None
    row = await db_session.scalar(select(OrganizationInvitationCode).where(OrganizationInvitationCode.code == expiring["code"]))
    row.expires_at = utcnow() - timedelta(minutes=1)
    await db_session.commit()

    assert (await api_client.post(f"/v1/invitations/{once['code']}/join", headers=first)).status_code == 200
    removed = await api_client.delete(f"{base}/{revoked['id']}", headers=owner)
    assert removed.status_code == 204

    unknown = await api_client.get("/v1/invitations/0000000000000000/preview")
    for gone in (once, expiring, revoked):
        assert (await api_client.get(f"/v1/invitations/{gone['code']}/preview")).json() == unknown.json()
        refused = await api_client.post(f"/v1/invitations/{gone['code']}/join", headers=second)
        assert refused.status_code == 404, refused.text
    assert unknown.status_code == 404


async def test_invite_users_makes_one_code_and_notifies_each(api_client, registration, db_session, gate):  # noqa: F811
    owner_account, owner = await make_account(api_client, registration, db_session, gate)
    alice, alice_headers = await make_account(api_client, registration, db_session, gate)
    bob, _ = await make_account(api_client, registration, db_session, gate)
    made = await org(api_client, owner)
    url = f"/v1/organizations/{made['slug']}/invitations/invite-users"

    invited = await api_client.post(url, headers=owner, json={"user_ids": [alice["id"], bob["id"], owner_account["id"]]})

    assert invited.status_code == 201, invited.text
    assert invited.json()["max_uses"] == 2
    rows = (await db_session.scalars(
        select(Notification).where(Notification.kind == "OrganizationInvitation")
    )).all()
    assert {str(row.user_id) for row in rows} == {alice["id"], bob["id"]}
    assert all(row.payload["invitation_code"] == invited.json()["code"] for row in rows)
    assert rows[0].payload["organization_slug"] == made["slug"]
    inbox = await api_client.get("/v1/notifications", headers=alice_headers)
    assert [item["kind"] for item in inbox.json()] == ["OrganizationInvitation"]
    only_members = await api_client.post(url, headers=owner, json={"user_ids": [owner_account["id"]]})
    assert only_members.status_code == 409 and code(only_members) == "already_member"
    unknown = await api_client.post(url, headers=owner, json={"user_ids": [str(uuid.uuid4())]})
    assert unknown.status_code == 404


async def test_only_admins_manage_codes_and_strangers_find_nothing(api_client, registration, db_session, gate):  # noqa: F811
    _, owner = await make_account(api_client, registration, db_session, gate)
    member_account, member = await make_account(api_client, registration, db_session, gate)
    _, stranger = await make_account(api_client, registration, db_session, gate)
    made = await org(api_client, owner)
    base = f"/v1/organizations/{made['slug']}/invitations"
    joined = await api_client.post(
        f"/v1/invitations/{(await api_client.post(base, headers=owner, json={})).json()['code']}/join", headers=member,
    )
    assert joined.status_code == 200
    assert member_account

    assert (await api_client.get(base, headers=member)).status_code == 403
    assert (await api_client.post(base, headers=member, json={})).status_code == 403
    assert (await api_client.get(base, headers=stranger)).status_code == 404
    assert (await api_client.post(base, headers=stranger, json={})).status_code == 404
    elsewhere = await org(api_client, stranger, "Elsewhere")
    theirs = (await api_client.post(
        f"/v1/organizations/{elsewhere['slug']}/invitations", headers=stranger, json={},
    )).json()
    assert (await api_client.delete(f"{base}/{theirs['id']}", headers=owner)).status_code == 404


async def test_user_search_names_users_without_their_email(api_client, registration, db_session, gate):  # noqa: F811
    tag = uuid.uuid4().hex[:6]
    _, searcher = await make_account(api_client, registration, db_session, gate)
    found_account, _ = await make_account(
        api_client, lambda: registration(username=f"zed{tag}a", email=f"zed{tag}a@example.org"), db_session, gate,
    )
    await make_account(api_client, lambda: registration(username=f"zed{tag}b", email=f"zed{tag}b@example.org"), db_session, gate)

    found = await api_client.get("/v1/users", headers=searcher, params={"q": f"ZED{tag}"})
    short = await api_client.get("/v1/users", headers=searcher, params={"q": "zed"})
    anonymous = await api_client.get("/v1/users", params={"q": f"zed{tag}"})

    assert found.status_code == 200, found.text
    assert [row["username"] for row in found.json()] == [f"zed{tag}a", f"zed{tag}b"]
    assert found.json()[0] == {"id": found_account["id"], "username": f"zed{tag}a", "avatar": None}
    assert "@" not in found.text
    assert short.status_code == 422 and anonymous.status_code == 401

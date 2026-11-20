"""A person's SCORETech display name and avatar travel to every reference other users see (F5-C C2).

``UserRef`` (search results, invitation creators), ``MemberView`` (an organization's members) and the person's own
``UserProfile`` carry ``display_name`` and ``avatar``: the descriptor stored from Identity's ``scoretech_avatar`` claim,
colours as hex, or null. A stored value that is not one of Identity's three shapes is served as null, never guessed.
"""

from __future__ import annotations

import ast
import pathlib
import typing
import uuid

import pytest
from sqlalchemy import select

from _b1_helpers import gate, make_account, make_org, put_member  # noqa: F401
from openbinding_gateway.db.models import User
from openbinding_gateway.models.avatars import AvatarIconId, AvatarPresetId, avatar_of, stored_avatar
from openbinding_gateway.modules.identity.domain.claims import ICONS, PRESETS, parse_avatar

SRC = pathlib.Path(__file__).resolve().parents[2] / "src" / "openbinding_gateway"

#: What Identity's claim carries (``ApplicationUserClaims.java``) and what OpenBinding then serves.
IDENTITY_DESCRIPTORS = [
    (
        {"kind": "initials", "backgroundColor": "graphite", "foregroundColor": "paper"},
        {"kind": "initials", "backgroundColor": "#212529", "foregroundColor": "#ffffff"},
    ),
    (
        {"kind": "icon", "assetId": "leaf", "backgroundColor": "graphite", "foregroundColor": "paper"},
        {"kind": "icon", "assetId": "leaf", "backgroundColor": "#212529", "foregroundColor": "#ffffff"},
    ),
    (
        {"kind": "icon", "assetId": "avatar-7", "backgroundColor": "#BE1D37", "foregroundColor": "lime"},
        {"kind": "icon", "assetId": "avatar-7", "backgroundColor": "#be1d37", "foregroundColor": "#ffd900"},
    ),
    ({"kind": "preset", "assetId": "owl"}, {"kind": "preset", "assetId": "owl"}),
]


def test_the_wire_shapes_name_exactly_identitys_presets_and_icons() -> None:
    assert set(typing.get_args(AvatarPresetId)) == PRESETS
    assert set(typing.get_args(AvatarIconId)) == ICONS


@pytest.mark.parametrize(("claim", "served"), IDENTITY_DESCRIPTORS)
def test_identitys_descriptors_round_trip_as_hex(claim, served) -> None:
    stored = parse_avatar(claim)
    assert stored == served
    wire = avatar_of(stored)
    assert wire is not None
    assert wire.model_dump(by_alias=True) == served
    assert stored_avatar(wire) == served


@pytest.mark.parametrize(
    "value",
    [
        None,
        "avatar-1.svg",
        {},
        {"kind": "photo", "imageUrl": "https://example.invalid/a.png"},
        {"kind": "preset", "assetId": "dragon"},
        {"kind": "preset", "assetId": "owl", "backgroundColor": "#212529"},
        {"kind": "initials", "backgroundColor": "graphite", "foregroundColor": "#ffffff"},
        {"kind": "initials", "backgroundColor": "#fff", "foregroundColor": "#ffffff"},
        {"kind": "icon", "assetId": "avatar-5", "backgroundColor": "#212529", "foregroundColor": "#ffffff"},
        {"kind": "icon", "assetId": "leaf"},
    ],
)
def test_anything_else_is_no_avatar(value) -> None:
    assert avatar_of(value) is None


def test_every_user_reference_is_built_from_the_row() -> None:
    """No route builds a ``UserRef`` field by field (which would drop the display name and the avatar)."""
    offenders = []
    for path in SRC.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "UserRef":
                offenders.append(f"{path.relative_to(SRC)}:{node.lineno}")
    assert offenders == []


async def _dress(db_session, user_id: str, *, display_name: str | None, avatar: dict | None) -> None:
    user = await db_session.get(User, uuid.UUID(user_id))
    user.display_name = display_name
    user.avatar = avatar
    await db_session.flush()
    await db_session.commit()


async def test_the_profile_carries_the_display_name_and_the_avatar(api_client, registration, db_session, gate) -> None:  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    me = (await api_client.get("/v1/users/me", headers=headers)).json()
    assert me["display_name"] is None and me["avatar"] is None

    await _dress(db_session, account["id"], display_name="Ana Pérez", avatar=IDENTITY_DESCRIPTORS[1][1])
    me = (await api_client.get("/v1/users/me", headers=headers)).json()
    assert me["display_name"] == "Ana Pérez"
    assert me["avatar"] == IDENTITY_DESCRIPTORS[1][1]

    await _dress(db_session, account["id"], display_name=None, avatar={"kind": "photo"})
    assert (await api_client.get("/v1/users/me", headers=headers)).json()["avatar"] is None


async def test_search_members_and_invitations_carry_them(api_client, registration, db_session, gate) -> None:  # noqa: F811
    owner, owner_headers = await make_account(api_client, registration, db_session, gate)
    member, _ = await make_account(api_client, registration, db_session, gate)
    await _dress(db_session, member["id"], display_name="Walk Member", avatar=IDENTITY_DESCRIPTORS[0][1])
    await _dress(db_session, owner["id"], display_name="Walk Owner", avatar=IDENTITY_DESCRIPTORS[3][1])

    found = await api_client.get("/v1/users", params={"q": member["username"]}, headers=owner_headers)
    assert found.status_code == 200, found.text
    [ref] = found.json()
    assert ref == {
        "id": member["id"],
        "username": member["username"],
        "display_name": "Walk Member",
        "avatar": IDENTITY_DESCRIPTORS[0][1],
    }
    assert "email" not in ref

    org = await make_org(api_client, owner_headers)
    put = await put_member(api_client, owner_headers, org["slug"], member["id"], "MEMBER")
    assert put.status_code == 200, put.text
    assert put.json()["display_name"] == "Walk Member"
    members = {
        row["user_id"]: row
        for row in (await api_client.get(f"/v1/organizations/{org['slug']}/members", headers=owner_headers)).json()
    }
    assert members[member["id"]]["avatar"] == IDENTITY_DESCRIPTORS[0][1]
    assert members[owner["id"]]["display_name"] == "Walk Owner"
    assert members[owner["id"]]["avatar"] == {"kind": "preset", "assetId": "owl"}

    code = await api_client.post(f"/v1/organizations/{org['slug']}/invitations", headers=owner_headers, json={})
    assert code.status_code == 201, code.text
    assert code.json()["created_by"]["display_name"] == "Walk Owner"
    assert code.json()["created_by"]["avatar"] == {"kind": "preset", "assetId": "owl"}


async def test_a_deleted_account_keeps_neither(api_client, registration, db_session, gate) -> None:  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    await _dress(db_session, account["id"], display_name="Gone Soon", avatar=IDENTITY_DESCRIPTORS[0][1])
    deleted = await api_client.request(
        "DELETE", "/v1/users/me", headers=headers,
        json={"confirmation": account["username"], "current_password": "correct-horse-battery"},
    )
    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    user = (await db_session.execute(select(User).where(User.id == uuid.UUID(account["id"])))).scalars().one()
    assert user.display_name is None and user.avatar is None

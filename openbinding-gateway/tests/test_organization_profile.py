"""An organization's profile (F2c G1): a description, an avatar, its counts, and slugs derived from its name.

As SPHERE's organizations: a slug left out is derived from the name and made unique with a numeric suffix, and
never one of the reserved slugs (``new`` and ``join`` included); an organization has a description of at most
500 characters, an avatar (one of the predefined SVGs, or an uploaded PNG, JPEG or WebP image of at most 2 MiB)
drawn in two colours, and its view counts its members, sub-organizations, compositions, problems, runs and
studies. Changing the avatar needs ADMIN; a non-member gets 404, never 403.
"""

from __future__ import annotations

import re
import uuid

from _b1_helpers import gate, make_account  # noqa: F401
from openbinding_gateway.services.organizations import deduplicate_slug, generate_slug

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"\x00" * 32


def code(response) -> str | None:
    body = response.json()
    detail = body.get("detail")
    return body.get("code") or (detail.get("code") if isinstance(detail, dict) else None)


async def create(client, headers, **body) -> dict:
    created = await client.post("/v1/organizations", headers=headers, json=body)
    assert created.status_code == 201, created.text
    return created.json()


# -- slugs ------------------------------------------------------------------------------------------------


def test_a_slug_is_derived_from_the_name_as_sphere_does():
    assert generate_slug("  Acme  Labs ") == "acme-labs"
    assert generate_slug("Café & Té_Ltd") == "cafe-te-ltd"
    assert generate_slug("--A---B--") == "a-b"
    assert generate_slug("x" * 100) == "x" * 64


async def test_a_taken_slug_gets_a_numeric_suffix():
    taken = {"acme", "acme-1"}

    async def is_taken(slug: str) -> bool:
        seen.append(slug)
        return slug in taken

    seen: list[str] = []
    slug = await deduplicate_slug("acme", is_taken)

    assert seen[0] == "acme" and re.fullmatch(r"acme-\d{1,10}", slug)


async def test_an_organization_without_a_slug_takes_one_from_its_name(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    name = f"Acme Labs {uuid.uuid4().hex[:6]}"

    first = await create(api_client, headers, name=name)
    second = await create(api_client, headers, name=name)

    assert first["slug"] == generate_slug(name)
    assert re.fullmatch(re.escape(first["slug"]) + r"-\d{1,10}", second["slug"])


async def test_a_derived_slug_is_never_a_reserved_one(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)

    for name in ("Join", "New", "Public"):
        made = await create(api_client, headers, name=name)
        assert made["slug"].startswith(f"{name.lower()}-"), made

    refused = await api_client.post("/v1/organizations", headers=headers, json={"slug": "join", "name": "Join"})
    assert refused.status_code == 422 and code(refused) == "slug_reserved"


async def test_a_name_without_three_letters_needs_a_slug(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)

    refused = await api_client.post("/v1/organizations", headers=headers, json={"name": "!!"})

    assert refused.status_code == 422, refused.text
    assert code(refused) == "slug_underivable"


# -- description and counts -------------------------------------------------------------------------------


async def test_the_description_is_set_and_changed(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    made = await create(api_client, headers, name="Described", description="A lab.")
    assert made["description"] == "A lab."

    changed = await api_client.patch(f"/v1/organizations/{made['slug']}", headers=headers, json={"description": "Now."})
    assert changed.status_code == 200 and changed.json()["description"] == "Now."

    too_long = await api_client.patch(
        f"/v1/organizations/{made['slug']}", headers=headers, json={"description": "x" * 501},
    )
    assert too_long.status_code == 422


async def test_the_view_counts_what_the_organization_holds(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    parent = await create(api_client, headers, name="Counted")
    await create(api_client, headers, name="Counted child", parent_id=parent["id"])
    composed = await api_client.post(
        f"/v1/organizations/{parent['slug']}/compositions", headers=headers, json={"slug": "one", "name": "One"},
    )
    assert composed.status_code == 201, composed.text

    read = (await api_client.get(f"/v1/organizations/{parent['slug']}", headers=headers)).json()
    listed = {row["slug"]: row for row in (await api_client.get("/v1/organizations", headers=headers)).json()}

    expected = {"members": 1, "sub_organizations": 1, "compositions": 1, "problems": 0, "runs": 0, "studies": 0}
    assert read["stats"] == expected
    assert listed[parent["slug"]]["stats"] == expected


# -- avatars ----------------------------------------------------------------------------------------------


async def test_a_new_organization_shows_its_initials(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)

    made = await create(api_client, headers, name="Plain")

    assert made["avatar"] == {"url": None, "kind": None, "bg_color": None, "fg_color": None}


async def test_an_uploaded_avatar_is_served_to_whoever_holds_its_url(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await create(api_client, headers, name="Pictured")
    await api_client.put(
        f"/v1/organizations/{org['slug']}/avatar-colors", headers=headers, json={"bg_color": "#fff", "fg_color": "#000"},
    )

    uploaded = await api_client.post(
        f"/v1/organizations/{org['slug']}/avatar", content=PNG, headers={**headers, "content-type": "image/png"},
    )

    assert uploaded.status_code == 200, uploaded.text
    avatar = uploaded.json()["avatar"]
    assert avatar["kind"] == "upload" and avatar["bg_color"] == "#fff" and avatar["fg_color"] == "#000"
    assert avatar["url"].startswith(f"/v1/organizations/{org['id']}/avatar/")
    served = await api_client.get(avatar["url"])
    assert served.status_code == 200 and served.content == PNG
    assert served.headers["content-type"] == "image/png"
    assert served.headers["x-content-type-options"] == "nosniff"
    # The type comes from the bytes: a WebP sent as PNG is kept as WebP.
    second = await api_client.post(
        f"/v1/organizations/{org['slug']}/avatar", content=WEBP, headers={**headers, "content-type": "image/png"},
    )
    assert (await api_client.get(second.json()["avatar"]["url"])).headers["content-type"] == "image/webp"
    # The previous image is no longer the organization's: its URL answers 404.
    assert (await api_client.get(avatar["url"])).status_code == 404
    assert (await api_client.get(f"/v1/organizations/{uuid.uuid4()}/avatar/{'0' * 64}")).status_code == 404


async def test_an_upload_must_be_a_small_image(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await create(api_client, headers, name="Strict")
    url = f"/v1/organizations/{org['slug']}/avatar"

    svg = await api_client.post(url, content=b"<svg/>", headers={**headers, "content-type": "image/png"})
    huge = await api_client.post(
        url, content=PNG + b"\x00" * (2 * 1024 * 1024), headers={**headers, "content-type": "image/png"},
    )

    assert svg.status_code == 415 and code(svg) == "avatar_unsupported"
    assert huge.status_code == 413 and code(huge) == "avatar_too_large"


async def test_a_predefined_avatar_is_chosen_and_removed(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await create(api_client, headers, name="Chosen")
    url = f"/v1/organizations/{org['slug']}/avatar-colors"

    chosen = await api_client.put(url, headers=headers, json={"avatar": "avatar-3.svg"})
    assert chosen.status_code == 200, chosen.text
    assert chosen.json()["avatar"] == {
        "url": "/v1/avatars/avatar-3.svg", "kind": "predefined", "bg_color": "#023e8a", "fg_color": "#ffffff",
    }
    assert "ETag" in chosen.headers
    # Colours alone keep the image.
    recoloured = await api_client.put(url, headers=headers, json={"bg_color": "#123456"})
    assert recoloured.json()["avatar"]["url"] == "/v1/avatars/avatar-3.svg"
    assert recoloured.json()["avatar"]["bg_color"] == "#123456"

    unknown = await api_client.put(url, headers=headers, json={"avatar": "../../etc/passwd"})
    bad_colour = await api_client.put(url, headers=headers, json={"bg_color": "red"})
    assert unknown.status_code == 422 and code(unknown) == "avatar_unknown"
    assert bad_colour.status_code == 422

    removed = await api_client.delete(f"/v1/organizations/{org['slug']}/avatar", headers=headers)
    assert removed.status_code == 200
    assert removed.json()["avatar"] == {"url": None, "kind": None, "bg_color": None, "fg_color": None}


async def test_the_predefined_avatars_are_open_to_anybody(api_client):
    listed = await api_client.get("/v1/avatars")
    assert listed.status_code == 200 and "avatar-1.svg" in listed.json()

    svg = await api_client.get("/v1/avatars/avatar-1.svg")
    assert svg.status_code == 200 and svg.headers["content-type"].startswith("image/svg+xml")
    assert svg.text.startswith("<svg") and "currentColor" in svg.text
    assert (await api_client.get("/v1/avatars/avatar-5.svg")).status_code == 404


async def test_only_an_admin_changes_the_avatar_and_a_stranger_finds_nothing(
    api_client, registration, db_session, gate,  # noqa: F811
):
    _, owner = await make_account(api_client, registration, db_session, gate)
    member_account, member = await make_account(api_client, registration, db_session, gate)
    _, stranger = await make_account(api_client, registration, db_session, gate)
    org = await create(api_client, owner, name="Guarded")
    added = await api_client.put(
        f"/v1/organizations/{org['slug']}/members/{member_account['id']}", headers=owner,
        json={"user_id": member_account["id"], "role": "MEMBER"},
    )
    assert added.status_code == 200, added.text
    url = f"/v1/organizations/{org['slug']}/avatar-colors"

    weak = await api_client.put(url, headers=member, json={"avatar": "avatar-1.svg"})
    outside = await api_client.put(url, headers=stranger, json={"avatar": "avatar-1.svg"})
    missing = await api_client.put("/v1/organizations/no-such-org/avatar-colors", headers=owner, json={})

    assert weak.status_code == 403 and code(weak) == "organization_forbidden"
    assert outside.status_code == 404 and missing.status_code == 404
    assert outside.json() == missing.json()

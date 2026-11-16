"""Public organizations, profiles, the hierarchy and the caller's tree (F2c G2).

As SPHERE's organization pages, with OpenBinding's visibility rule (Q8): only an organization with at least one
public composition (public, not archived, with a version) has a public profile and appears in the explore list
of root organizations. Any other organization answers 404 to a non-member, the same 404 as a missing one. The
hierarchy is the whole branch, for members only, each node saying whether the caller opens it; ``tree=true``
nests the caller's organizations with the source of each role.
"""

from __future__ import annotations

import uuid

from _b1_helpers import gate, make_account  # noqa: F401
from test_compositions_public_list import create, declared, patch, published, seal


async def org(client, headers, name: str, parent: str | None = None, description: str = "") -> dict:
    body = {"name": name, "description": description, **({"parent_id": parent} if parent else {})}
    created = await client.post("/v1/organizations", headers=headers, json=body)
    assert created.status_code == 201, created.text
    return created.json()


async def add(client, headers, slug: str, account: dict, role: str) -> None:
    added = await client.put(
        f"/v1/organizations/{slug}/members/{account['id']}", headers=headers,
        json={"user_id": account["id"], "role": role},
    )
    assert added.status_code == 200, added.text


# -- the explore list and the profile ---------------------------------------------------------------------


async def test_only_root_organizations_with_a_public_composition_are_listed(
    api_client, registration, db_session, gate,  # noqa: F811
):
    _, owner = await make_account(api_client, registration, db_session, gate)
    tag = uuid.uuid4().hex[:6]
    shown = await org(api_client, owner, f"Shown {tag}", description="We publish.")
    await published(api_client, owner, shown["slug"], "menu", versions=2)
    await published(api_client, owner, shown["slug"], "card")
    quiet = await org(api_client, owner, f"Quiet {tag}")
    hidden = await create(api_client, owner, quiet["slug"], "hidden")
    await seal(api_client, owner, hidden, declared("hidden"))
    archived = await org(api_client, owner, f"Archived {tag}")
    old = await published(api_client, owner, archived["slug"], "old")
    await patch(api_client, owner, old, archived=True)
    child = await org(api_client, owner, f"Child {tag}", parent=quiet["id"])
    await published(api_client, owner, child["slug"], "inner")

    listed = await api_client.get("/v1/organizations/public", params={"q": tag})

    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["total"] == 1
    assert [item["slug"] for item in body["items"]] == [shown["slug"]]
    assert body["items"][0] == {
        "id": shown["id"], "slug": shown["slug"], "name": f"Shown {tag}", "description": "We publish.",
        "avatar": {"url": None, "kind": None, "bg_color": None, "fg_color": None}, "public_compositions": 2,
    }
    assert listed.headers["vary"] == "Authorization, X-API-Key"
    by_description = await api_client.get("/v1/organizations/public", params={"q": "we publish", "limit": 50})
    assert shown["slug"] in [item["slug"] for item in by_description.json()["items"]]
    assert (await api_client.get("/v1/organizations/public", params={"limit": 51})).status_code == 422


async def test_a_profile_is_public_only_with_a_public_composition(
    api_client, registration, db_session, gate,  # noqa: F811
):
    _, owner = await make_account(api_client, registration, db_session, gate)
    _, stranger = await make_account(api_client, registration, db_session, gate)
    shown = await org(api_client, owner, "Shown profile")
    await published(api_client, owner, shown["slug"], "menu")
    quiet = await org(api_client, owner, "Quiet profile")
    child = await org(api_client, owner, "Child profile", parent=quiet["id"])
    await published(api_client, owner, child["slug"], "inner")

    anonymous = await api_client.get(f"/v1/organizations/{shown['slug']}/profile")
    by_id = await api_client.get(f"/v1/organizations/{shown['id']}/profile", headers=stranger)
    assert anonymous.status_code == 200 and by_id.status_code == 200
    assert anonymous.json()["public_compositions"] == 1
    # A sub-organization that publishes has its own profile; its parent, which does not, has none.
    assert (await api_client.get(f"/v1/organizations/{child['slug']}/profile")).status_code == 200
    quiet_one = await api_client.get(f"/v1/organizations/{quiet['slug']}/profile", headers=stranger)
    missing = await api_client.get("/v1/organizations/no-such-org/profile", headers=stranger)
    assert quiet_one.status_code == 404 and missing.status_code == 404
    assert quiet_one.json() == missing.json()
    # Its members read it anyway.
    own = await api_client.get(f"/v1/organizations/{quiet['slug']}/profile", headers=owner)
    assert own.status_code == 200 and own.json()["public_compositions"] == 0
    # Everything else stays for members: a stranger finds no organization.
    assert (await api_client.get(f"/v1/organizations/{shown['slug']}", headers=stranger)).status_code == 403
    assert (await api_client.get(f"/v1/organizations/{shown['slug']}/hierarchy", headers=stranger)).status_code == 404


async def test_public_cannot_be_an_organization_slug(api_client, registration, db_session, gate):  # noqa: F811
    _, owner = await make_account(api_client, registration, db_session, gate)

    refused = await api_client.post("/v1/organizations", headers=owner, json={"slug": "public", "name": "Public"})
    derived = await org(api_client, owner, "Public")

    assert refused.status_code == 422
    assert derived["slug"].startswith("public-")


# -- the hierarchy ----------------------------------------------------------------------------------------


async def test_the_hierarchy_is_the_whole_branch_with_access_marked(
    api_client, registration, db_session, gate,  # noqa: F811
):
    _, owner = await make_account(api_client, registration, db_session, gate)
    member_account, member = await make_account(api_client, registration, db_session, gate)
    root = await org(api_client, owner, "Branch root")
    left = await org(api_client, owner, "Branch left", parent=root["id"])
    right = await org(api_client, owner, "Branch right", parent=root["id"])
    deep = await org(api_client, owner, "Branch deep", parent=left["id"])
    await org(api_client, owner, "Elsewhere")
    await add(api_client, owner, left["slug"], member_account, "MEMBER")

    seen = await api_client.get(f"/v1/organizations/{deep['slug']}/hierarchy", headers=member)

    assert seen.status_code == 200, seen.text
    nodes = {node["slug"]: node for node in seen.json()}
    assert set(nodes) == {root["slug"], left["slug"], right["slug"], deep["slug"]}
    assert [node["name"] for node in seen.json()] == ["Branch deep", "Branch left", "Branch right", "Branch root"]
    assert {slug: node["has_access"] for slug, node in nodes.items()} == {
        root["slug"]: False, left["slug"]: True, right["slug"]: False, deep["slug"]: True,
    }
    assert nodes[deep["slug"]]["effective_role"] == "MEMBER" and nodes[root["slug"]]["effective_role"] is None
    assert nodes[deep["slug"]]["parent_id"] == left["id"]
    assert all(node["has_access"] for node in (
        await api_client.get(f"/v1/organizations/{left['slug']}/hierarchy", headers=owner)
    ).json())
    # A member of the branch who cannot read this organization finds nothing.
    assert (await api_client.get(f"/v1/organizations/{right['slug']}/hierarchy", headers=member)).status_code == 404


# -- the caller's tree ------------------------------------------------------------------------------------


async def test_the_tree_nests_the_callers_organizations_with_the_source_of_each_role(
    api_client, registration, db_session, gate,  # noqa: F811
):
    _, owner = await make_account(api_client, registration, db_session, gate)
    member_account, member = await make_account(api_client, registration, db_session, gate)
    root = await org(api_client, owner, "Tree root")
    a = await org(api_client, owner, "Tree a", parent=root["id"])
    b = await org(api_client, owner, "Tree b", parent=root["id"])
    a1 = await org(api_client, owner, "Tree a1", parent=a["id"])
    a2 = await org(api_client, owner, "Tree a2", parent=a["id"])
    solo = await org(api_client, owner, "Tree solo")
    await add(api_client, owner, a["slug"], member_account, "VIEWER")
    await add(api_client, owner, a1["slug"], member_account, "ADMIN")
    await add(api_client, owner, solo["slug"], member_account, "MEMBER")

    flat = await api_client.get("/v1/organizations", headers=member)
    tree = await api_client.get("/v1/organizations", headers=member, params={"tree": "true"})

    assert [row["slug"] for row in flat.json()] == [a["slug"], a1["slug"], a2["slug"], solo["slug"]]
    assert flat.headers["x-total-count"] == "4"
    assert tree.headers["x-total-count"] == "2"
    top = {row["slug"]: row for row in tree.json()}
    assert set(top) == {a["slug"], solo["slug"]}
    assert top[a["slug"]]["effective_role"] == "VIEWER"
    assert top[a["slug"]]["role_source"]["slug"] == a["slug"]
    nested, inherited = top[a["slug"]]["children"]
    assert nested["slug"] == a1["slug"] and nested["effective_role"] == "ADMIN"
    assert nested["role_source"]["slug"] == a1["slug"] and nested["children"] == []
    # A role held above an organization names that organization as its source.
    assert inherited["slug"] == a2["slug"] and inherited["effective_role"] == "VIEWER"
    assert inherited["role_source"]["slug"] == a["slug"]
    assert b["slug"] not in tree.text and root["slug"] not in tree.text
    # The owner reaches everything from the root.
    owned = (await api_client.get("/v1/organizations", headers=owner, params={"tree": "true"})).json()
    by_slug = {row["slug"]: row for row in owned}
    assert set(by_slug) == {root["slug"], solo["slug"]}
    children = {row["slug"]: row for row in by_slug[root["slug"]]["children"]}
    assert set(children) == {a["slug"], b["slug"]}
    assert children[a["slug"]]["effective_role"] == "OWNER"
    paged = await api_client.get(
        "/v1/organizations", headers=owner, params={"tree": "true", "limit": 1, "offset": 1},
    )
    assert [row["slug"] for row in paged.json()] == [by_slug[sorted(by_slug, key=lambda s: by_slug[s]["name"])[1]]["slug"]]
    assert paged.headers["x-total-count"] == "2"

"""Permanent links, the zip of the versions, the version graph and follows (F2c G7).

As SPHERE: ``/v1/permalinks/compositions/{id}?version=`` resolves a composition's id to where the application shows
it, with an ETag, ``private, no-store`` and ``Vary`` on the credential, and the same 404 for a missing and an
unreadable composition; a version the caller does not read is left out. The download is a zip of every version the
caller reads. The graph has the composition's lane and one per source it was forked from, a source the caller does
not read keeping only its labels (for members). A reader follows a composition and each version sealed later tells
them, but not the author; anybody else gets 404.
"""

from __future__ import annotations

import io
import uuid
import zipfile

from sqlalchemy import select

from _b1_helpers import gate, make_account  # noqa: F401
from openbinding_gateway.db.models import Notification
from test_compositions_public_list import create, declared, patch, seal


async def org(client, headers, name: str) -> str:
    created = await client.post("/v1/organizations", headers=headers, json={"name": f"{name} {uuid.uuid4().hex[:6]}"})
    assert created.status_code == 201, created.text
    return created.json()["slug"]


async def composition_with_versions(client, headers, slug_org: str, slug: str, labels=("1.0.0", "1.1.0")) -> dict:
    base = await create(client, headers, slug_org, slug)
    for label in labels:
        await seal(client, headers, base, declared(slug, label))
    return (await client.get(base, headers=headers)).json() | {"base": base}


# -- permanent links --------------------------------------------------------------------------------------


async def test_a_permalink_resolves_for_readers_and_is_the_same_404_otherwise(
    api_client, registration, db_session, gate,  # noqa: F811
):
    _, owner = await make_account(api_client, registration, db_session, gate)
    _, stranger = await make_account(api_client, registration, db_session, gate)
    slug_org = await org(api_client, owner, "Linked")
    private = await composition_with_versions(api_client, owner, slug_org, "private-one")
    shown = await composition_with_versions(api_client, owner, slug_org, "shown-one")
    await patch(api_client, owner, shown["base"], visibility="public")
    url = "/v1/permalinks/compositions/{}"

    member = await api_client.get(url.format(private["id"]), headers=owner, params={"version": "1.0.0"})
    assert member.status_code == 200, member.text
    assert member.json() == {"location": f"/compositions/{slug_org}/private-one?version=1.0.0"}
    assert member.headers["cache-control"] == "private, no-store"
    assert "Authorization" in member.headers["vary"]
    again = await api_client.get(
        url.format(private["id"]), headers={**owner, "If-None-Match": member.headers["etag"]},
        params={"version": "1.0.0"},
    )
    assert again.status_code == 304
    anonymous = await api_client.get(url.format(shown["id"]), params={"version": "9.9.9"})
    assert anonymous.json() == {"location": f"/compositions/{slug_org}/shown-one"}
    hidden = await api_client.get(url.format(private["id"]), headers=stranger)
    missing = await api_client.get(url.format(uuid.uuid4()), headers=stranger)
    garbage = await api_client.get(url.format("not-an-id"))
    assert hidden.status_code == missing.status_code == garbage.status_code == 404
    assert hidden.json() == missing.json() == garbage.json()


# -- the zip of the versions ------------------------------------------------------------------------------


async def test_the_download_is_a_zip_of_every_version(api_client, registration, db_session, gate):  # noqa: F811
    _, owner = await make_account(api_client, registration, db_session, gate)
    _, stranger = await make_account(api_client, registration, db_session, gate)
    slug_org = await org(api_client, owner, "Zipped")
    made = await composition_with_versions(api_client, owner, slug_org, "zipped")
    empty = await create(api_client, owner, slug_org, "empty")

    got = await api_client.get(f"{made['base']}/download", headers=owner)

    assert got.status_code == 200, got.text
    assert got.headers["content-type"] == "application/zip"
    assert f'filename="{slug_org}-zipped-versions.zip"' in got.headers["content-disposition"]
    archive = zipfile.ZipFile(io.BytesIO(got.content))
    assert sorted(archive.namelist()) == ["zipped/1.0.0.yaml", "zipped/1.1.0.yaml"]
    assert archive.read("zipped/1.1.0.yaml").decode() == (
        await api_client.get(f"{made['base']}/versions/2/content", headers=owner)
    ).text
    assert (await api_client.get(f"{made['base']}/download", headers=stranger)).status_code == 404
    assert (await api_client.get(f"{empty}/download", headers=owner)).status_code == 404
    await patch(api_client, owner, made["base"], visibility="public")
    assert (await api_client.get(f"{made['base']}/download")).status_code == 200


# -- the version graph ------------------------------------------------------------------------------------


async def test_the_graph_draws_the_lane_and_its_sources(api_client, registration, db_session, gate):  # noqa: F811
    _, owner = await make_account(api_client, registration, db_session, gate)
    _, forker = await make_account(api_client, registration, db_session, gate)
    source_org = await org(api_client, owner, "Source")
    fork_org = await org(api_client, forker, "Forks")
    source = await composition_with_versions(api_client, owner, source_org, "origin")
    await patch(api_client, owner, source["base"], visibility="public")
    forked = await api_client.post(
        f"{source['base']}/fork", headers=forker,
        json={"targetOrganization": fork_org, "slug": "copy", "name": "Copy", "version": "1.1.0"},
    )
    assert forked.status_code == 201, forked.text
    copy = f"/v1/organizations/{fork_org}/compositions/copy"
    await seal(api_client, forker, copy, declared("copy", "2.0.0"))

    drawn = await api_client.get(f"{copy}/graph", headers=forker)

    assert drawn.status_code == 200, drawn.text
    body = drawn.json()
    assert body["truncated"] is False
    current, origin = body["lanes"]
    assert current["role"] == "current" and current["slug"] == "copy" and current["available"] is True
    assert [version["label"] for version in current["versions"]] == ["2.0.0", "1.1.0"]
    assert current["versions"][1]["forked_from"]["composition_id"] == source["id"]
    assert origin["role"] == "source" and origin["available"] is True and origin["slug"] == "origin"
    assert [version["label"] for version in origin["versions"]] == ["1.1.0", "1.0.0"]
    # The source made private again: a member of the fork keeps a lane with the labels only.
    await patch(api_client, owner, source["base"], visibility="private")
    hidden = (await api_client.get(f"{copy}/graph", headers=forker)).json()["lanes"][1]
    assert hidden["available"] is False and hidden["slug"] == "origin"
    assert hidden["versions"] == [{"id": None, "label": "1.1.0", "created_at": None, "forked_from": None}]
    # A reader who is not a member sees no lane of a source they do not read, nor the edge to it.
    await patch(api_client, forker, copy, visibility="public")
    public = (await api_client.get(f"{copy}/graph")).json()
    assert len(public["lanes"]) == 1 and all(version["forked_from"] is None for version in public["lanes"][0]["versions"])
    assert source_org not in (await api_client.get(f"{copy}/graph")).text


# -- follows ----------------------------------------------------------------------------------------------


async def test_a_follower_is_told_of_each_new_version_but_not_the_author(
    api_client, registration, db_session, gate,  # noqa: F811
):
    owner_account, owner = await make_account(api_client, registration, db_session, gate)
    follower_account, follower = await make_account(api_client, registration, db_session, gate)
    _, stranger = await make_account(api_client, registration, db_session, gate)
    slug_org = await org(api_client, owner, "Followed")
    made = await composition_with_versions(api_client, owner, slug_org, "watched", labels=("1.0.0",))
    url = f"/v1/composition-follows/{slug_org}/watched"

    assert (await api_client.put(url, headers=follower)).status_code == 404
    await patch(api_client, owner, made["base"], visibility="public")
    assert (await api_client.get(url, headers=follower)).json() == {"following": False}
    assert (await api_client.put(url, headers=follower)).json() == {"following": True}
    assert (await api_client.put(url, headers=follower)).json() == {"following": True}
    assert (await api_client.put(url, headers=owner)).json() == {"following": True}
    assert (await api_client.get(url, headers=follower)).json() == {"following": True}

    await seal(api_client, owner, made["base"], declared("watched", "1.1.0"))

    told = (await db_session.scalars(select(Notification).where(Notification.kind == "CompositionUpdated"))).all()
    assert [str(row.user_id) for row in told] == [follower_account["id"]]
    assert told[0].payload["version"] == "1.1.0" and told[0].payload["composition_slug"] == "watched"
    assert owner_account["id"] not in {str(row.user_id) for row in told}
    # Private again: the follower no longer reads it, is not told, and unfollowing answers 404 but unfollows.
    await patch(api_client, owner, made["base"], visibility="private")
    await seal(api_client, owner, made["base"], declared("watched", "1.2.0"))
    assert len((await db_session.scalars(select(Notification).where(Notification.kind == "CompositionUpdated"))).all()) == 1
    assert (await api_client.delete(url, headers=follower)).status_code == 404
    await patch(api_client, owner, made["base"], visibility="public")
    assert (await api_client.get(url, headers=follower)).json() == {"following": False}
    assert (await api_client.get(url, headers=stranger)).json() == {"following": False}
    assert (await api_client.get(url)).status_code == 401
    assert (await api_client.delete(url, headers=owner)).json() == {"following": False}

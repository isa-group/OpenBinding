"""An environment's feed: the adopted version's bytes, with a validator that moves only on adopt (F4 A6).

The answer table of the contract row by row (401, 403, 429, 404 for another environment's key, the composition's
parity for members, ``nothing_adopted``, 304, 200), the headers, and the invariants:

* I1 the body is the version content route's bytes;
* I2 the ETag is the adopted version's quoted content digest, and the adoption row's;
* I3 nothing but an adoption moves the ETag or the body;
* I4 every adoption moves it to the new version's digest, and A→B→A gives A's tag again;
* I5 no 304 where a refusal is due, whatever ``If-None-Match`` says;
* I6 a personal key without ``compositions:read`` is 403.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from _b1_helpers import gate, make_account, make_key, make_org  # noqa: F401
from _environment_api import code, declared, env, seal, team
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import CompositionAdoption, User

pytestmark = pytest.mark.asyncio


async def adopt(client, t, version, slug="production"):
    current = await client.get(f"{t.environments}/{slug}", headers=t.owner)
    adopted = await client.post(
        f"{t.environments}/{slug}/adopt", headers={**t.owner, "If-Match": current.headers["ETag"]},
        json={"version": version},
    )
    assert adopted.status_code == 200, adopted.text
    return adopted


async def feed_key(client, t, slug="production") -> dict:
    minted = await client.post(f"{t.environments}/{slug}/keys", headers=t.owner, json={})
    assert minted.status_code == 201, minted.text
    return {"X-API-Key": minted.json()["secret"]}


def feed_url(t, slug="production") -> str:
    return f"{t.environments}/{slug}/composition"


async def operated(client, registration, db_session, gate):  # noqa: F811
    t = await team(client, registration, db_session, gate)
    await env(client, t)
    await adopt(client, t, "1.0.0")
    return t, await feed_key(client, t)


async def test_a_feed_key_reads_the_adopted_bytes(api_client, registration, db_session, gate):  # noqa: F811
    t, key = await operated(api_client, registration, db_session, gate)
    v1 = t.versions["1.0.0"]

    read = await api_client.get(feed_url(t), headers=key)

    assert read.status_code == 200, read.text
    content = await api_client.get(f"{t.base}/versions/1.0.0/content", headers=t.owner)
    assert read.content == content.content  # I1
    assert read.headers["ETag"] == content.headers["ETag"] == f'"{v1["content_digest"]}"'  # I2
    adoption = await db_session.scalar(select(CompositionAdoption))
    assert read.headers["ETag"] == f'"{adoption.content_digest}"'
    assert read.headers["content-type"] == "application/yaml; charset=utf-8"
    assert read.headers["Cache-Control"] == "private, no-cache"
    assert read.headers["Vary"] == "Authorization, X-API-Key"
    assert read.headers["X-Content-Type-Options"] == "nosniff"
    assert read.headers["OpenBinding-Adoption"] == "1"
    assert read.headers["OpenBinding-Composition-Version"] == "1.0.0"
    assert "Last-Modified" not in read.headers and "access-control-allow-origin" not in read.headers

    bearer = await api_client.get(feed_url(t), headers={"Authorization": f"Bearer {key['X-API-Key']}"})
    assert bearer.status_code == 200 and bearer.content == read.content

    for value in (read.headers["ETag"], "*", f'"other", {read.headers["ETag"]}'):
        cached = await api_client.get(feed_url(t), headers={**key, "If-None-Match": value})
        assert cached.status_code == 304, value
        assert cached.content == b""
        for header in ("ETag", "Cache-Control", "Vary", "OpenBinding-Adoption", "OpenBinding-Composition-Version"):
            assert cached.headers[header] == read.headers[header]
    weak = await api_client.get(feed_url(t), headers={**key, "If-None-Match": f"W/{read.headers['ETag']}"})
    assert weak.status_code == 200


async def test_members_read_the_feed_too(api_client, registration, db_session, gate):  # noqa: F811
    t, _ = await operated(api_client, registration, db_session, gate)

    for headers in (t.viewer, t.owner, await make_key(api_client, t.viewer, ["compositions:read"])):
        assert (await api_client.get(feed_url(t), headers=headers)).status_code == 200

    without = await make_key(api_client, t.viewer, ["problems:read"])
    refused = await api_client.get(feed_url(t), headers=without)
    assert refused.status_code == 403 and code(refused) == "insufficient_api_key_permission"  # I6


async def test_the_answers_before_any_lookup(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    t, key = await operated(api_client, registration, db_session, gate)

    for url in (feed_url(t), "/v1/organizations/nobody/compositions/x/environments/y/composition"):
        anonymous = await api_client.get(url)
        assert anonymous.status_code == 401 and code(anonymous) == "unauthorized"
        assert anonymous.headers["WWW-Authenticate"]
        for bad in ("obe_00000000_" + "x" * 43, "obe_nonsense", "obk_00000000_nothing", "not-a-token"):
            refused = await api_client.get(url, headers={"X-API-Key": bad})
            assert refused.status_code == 401 and code(refused) == "unauthorized", bad

    monkeypatch.setattr(get_settings(), "feed_rate_per_minute", 3)
    statuses = [(await api_client.get(feed_url(t), headers=key)).status_code for _ in range(3)]
    limited = await api_client.get(feed_url(t), headers=key)
    assert statuses == [200, 200, 200]
    assert limited.status_code == 429 and code(limited) == "feed_rate_limited"
    assert 1 <= int(limited.headers["Retry-After"]) <= 60
    # Another credential has a budget of its own; the limit is counted before the path is looked at.
    assert (await api_client.get(feed_url(t), headers=t.owner)).status_code == 200
    elsewhere = await api_client.get("/v1/organizations/nobody/compositions/x/environments/y/composition", headers=key)
    assert elsewhere.status_code == 429


async def test_a_key_reads_only_its_own_environment(api_client, registration, db_session, gate):  # noqa: F811
    t, key = await operated(api_client, registration, db_session, gate)
    await env(api_client, t, "staging")
    await adopt(api_client, t, "1.1.0", "staging")
    staging_key = await feed_key(api_client, t, "staging")

    for url in (
        feed_url(t, "staging"),
        f"/v1/organizations/{t.org}/compositions/other/environments/production/composition",
        "/v1/organizations/no-such/compositions/tomato/environments/production/composition",
    ):
        refused = await api_client.get(url, headers=key)
        assert refused.status_code == 404 and refused.json()["detail"]["error"] == "Environment not found.", url
    assert (await api_client.get(feed_url(t, "staging"), headers=staging_key)).headers["OpenBinding-Composition-Version"] == "1.1.0"


async def test_member_parity_and_nothing_adopted(api_client, registration, db_session, gate):  # noqa: F811
    t, _ = await operated(api_client, registration, db_session, gate)
    await env(api_client, t, "staging")

    empty = await api_client.get(feed_url(t, "staging"), headers=t.owner)
    assert empty.status_code == 404 and code(empty) == "nothing_adopted"
    staging_key = await feed_key(api_client, t, "staging")
    assert code(await api_client.get(feed_url(t, "staging"), headers=staging_key)) == "nothing_adopted"

    private = await api_client.get(feed_url(t), headers=t.outsider)
    assert private.status_code == 404 and private.json()["detail"]["error"] == "Composition not found."
    assert (await api_client.patch(t.base, headers=t.owner, json={"visibility": "public"})).status_code == 200
    public = await api_client.get(feed_url(t), headers=t.outsider)
    assert public.status_code == 404 and public.json()["detail"]["error"] == "Environment not found."
    missing = await api_client.get(feed_url(t, "nothing"), headers=t.owner)
    assert missing.json()["detail"] == public.json()["detail"]


async def test_no_304_where_a_refusal_is_due(api_client, registration, db_session, gate):  # noqa: F811
    """I5: who may read is decided before the caller's copy is compared."""
    t, key = await operated(api_client, registration, db_session, gate)
    tag = (await api_client.get(feed_url(t), headers=key)).headers["ETag"]
    cached = {"If-None-Match": tag}
    await env(api_client, t, "staging")
    await adopt(api_client, t, "1.0.0", "staging")
    other_key = await feed_key(api_client, t, "staging")
    bounded = await make_key(api_client, t.viewer, ["compositions:read"])
    bounded_elsewhere = await api_client.post(
        "/v1/users/me/api-keys", headers=t.viewer,
        json={"name": "b", "permissions": ["compositions:read"], "engine_access": {"all": True, "engines": []},
              "boundary": {"slugs": ["other"]}},
    )
    assert bounded_elsewhere.status_code == 201, bounded_elsewhere.text
    assert (await api_client.get(feed_url(t), headers={**bounded, **cached})).status_code == 304

    refused = await api_client.get(feed_url(t), headers={"X-API-Key": bounded_elsewhere.json()["secret"], **cached})
    assert refused.status_code == 403 and code(refused) == "api_key_boundary"
    wrong = await api_client.get(feed_url(t), headers={**other_key, **cached})
    assert wrong.status_code == 404
    key_id = (await api_client.get(f"{t.environments}/production", headers=t.owner)).json()["keys"][0]["id"]
    assert (await api_client.delete(f"{t.environments}/production/keys/{key_id}", headers=t.owner)).status_code == 204
    revoked = await api_client.get(feed_url(t), headers={**key, **cached})
    assert revoked.status_code == 401
    removed = await api_client.delete(f"/v1/organizations/{t.org}/members/{t.ids['member']}", headers=t.owner)
    assert removed.status_code == 204
    assert (await api_client.get(feed_url(t), headers={**t.member, **cached})).status_code == 404
    user = await db_session.get(User, uuid.UUID(t.ids["viewer"]))
    user.is_active = False
    await db_session.commit()
    assert (await api_client.get(feed_url(t), headers={**t.viewer, **cached})).status_code == 401


async def test_only_an_adoption_moves_the_feed(api_client, registration, db_session, gate):  # noqa: F811
    """I3 and I4."""
    t, key = await operated(api_client, registration, db_session, gate)
    first = await api_client.get(feed_url(t), headers=key)

    async def unchanged():
        now = await api_client.get(feed_url(t), headers=key)
        assert now.status_code == 200
        assert now.headers["ETag"] == first.headers["ETag"] and now.content == first.content

    await seal(api_client, t.owner, t.base, declared("2.0.0", 10))
    await unchanged()
    for patch in ({"name": "Renamed"}, {"description": "d"}, {"visibility": "public"}, {"archived": True},
                  {"archived": False}):
        assert (await api_client.patch(t.base, headers=t.owner, json=patch)).status_code == 200
        await unchanged()
    for patch in ({"name": "P"}, {"description": "x"}, {"operator": t.ids["admin_username"]}, {"adoptRole": "MEMBER"},
                  {"expectedUsers": 1000}):
        assert (await api_client.patch(f"{t.environments}/production", headers=t.owner, json=patch)).status_code == 200
        await unchanged()
    minted = await api_client.post(f"{t.environments}/production/keys", headers=t.owner, json={})
    await unchanged()
    assert (await api_client.delete(
        f"{t.environments}/production/keys/{minted.json()['key']['id']}", headers=t.owner,
    )).status_code == 204
    await unchanged()
    target = await make_org(api_client, t.owner)
    forked = await api_client.post(
        f"{t.base}/fork", headers=t.owner, json={"version": "1.0.0", "targetOrganization": target["slug"]},
    )
    assert forked.status_code in (200, 201), forked.text
    await unchanged()
    await env(api_client, t, "staging")
    await adopt(api_client, t, "1.1.0", "staging")
    await unchanged()

    # I4: every adoption moves it to the new version's digest; A -> B -> A gives A's tag again.
    second = await adopt(api_client, t, "1.1.0")
    b = await api_client.get(feed_url(t), headers=key)
    assert b.headers["ETag"] == f'"{t.versions["1.1.0"]["content_digest"]}"' != first.headers["ETag"]
    assert b.headers["OpenBinding-Adoption"] == "2" and second.json()["adoption"]["feedEtag"] == b.headers["ETag"]
    await adopt(api_client, t, "1.0.0")
    back = await api_client.get(feed_url(t), headers=key)
    assert back.headers["ETag"] == first.headers["ETag"] and back.content == first.content
    assert back.headers["OpenBinding-Adoption"] == "3"


async def test_a_re_evaluation_on_a_new_basis_moves_neither_the_feed_nor_the_pinned_margins(
    api_client, registration, db_session, gate, sphere,  # noqa: F811
):
    """I3 for a new toolchain basis: the version gains a current evaluation (which reads the offering again), but the
    adoption keeps the evaluation it pinned, so the environment's margins and its feed stay as they were."""
    from _composition_helpers import OtherToolchain
    from compositions._sphere import BINDING, compositions, generated_problem
    from openbinding_gateway.integrations import bim

    headers, org = await generated_problem(api_client, registration, db_session, gate)
    base = compositions(org)
    derived = await api_client.post(
        f"{base}/derive", headers=headers,
        json={"revision": "tomatometer-email@2", "binding": BINDING, "version": "1.0.0",
              "offering": {"sphere": "sphere/tomatometer"}},
    )
    assert derived.status_code == 201, derived.text
    environments = f"{base}/environments"
    created = await api_client.post(environments, headers=headers, json={"slug": "production", "name": "P"})
    adopted = await api_client.post(
        f"{environments}/production/adopt", headers={**headers, "If-Match": created.headers["ETag"]},
        json={"version": "1.0.0"},
    )
    assert adopted.status_code == 200, adopted.text
    pinned = adopted.json()["environment"]["inEffect"]["evaluation"]["id"]
    key = {"X-API-Key": (await api_client.post(f"{environments}/production/keys", headers=headers, json={})).json()["secret"]}
    feed_before = await api_client.get(f"{environments}/production/composition", headers=key)
    margins_url = f"{base}/versions/1.0.0/margins?users=1000&evaluation={pinned}"
    margins_before = await api_client.get(margins_url, headers=headers)

    with bim.bim_override(OtherToolchain(bim.get_bim())):
        stored = await api_client.post(f"{base}/versions/1.0.0/evaluations", headers=headers)
        assert stored.status_code == 201, stored.text
        current = await api_client.get(f"{base}/versions/1.0.0/margins?users=1000", headers=headers)
        assert current.json()["evaluation"]["id"] != pinned  # the default follows the current evaluation
        feed_after = await api_client.get(f"{environments}/production/composition", headers=key)
        margins_after = await api_client.get(margins_url, headers=headers)
        view = (await api_client.get(f"{environments}/production", headers=headers)).json()

    assert feed_after.headers["ETag"] == feed_before.headers["ETag"] and feed_after.content == feed_before.content
    assert margins_after.json() == margins_before.json()
    assert view["inEffect"]["evaluation"]["id"] == pinned and view["inEffect"]["adoption"] == 1

"""Composition environments as an API resource: create, list, read, edit and delete them (F4 A3).

Every route needs a signed-in caller (401 before any lookup). A caller without a role gets the composition's 404
parity: "Composition not found." for a private or missing composition, "Environment not found." for every
environment route of a public one, the body a member gets for a missing environment. VIEWER reads, ADMIN writes.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from _b1_helpers import gate, make_key  # noqa: F401
from _environment_api import code, env, team
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import AuditEvent, User

pytestmark = pytest.mark.asyncio


async def test_an_admin_creates_reads_lists_edits_and_deletes_an_environment(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)

    created = await env(
        api_client, t, description="What runs", operator=t.ids["member_username"], adoptRole="MEMBER",
        expectedUsers=1000,
    )

    body = created.json()
    assert created.headers["ETag"] and created.headers["Cache-Control"] == "private, no-cache"
    assert body["slug"] == "production" and body["name"] == "Production" and body["description"] == "What runs"
    assert body["operator"] == {
        "username": t.ids["member_username"], "displayName": t.ids["member_username"], "member": True,
    }
    assert body["adoptRole"] == "MEMBER" and body["expectedUsers"] == 1000
    assert body["inEffect"] is None and body["keys"] == [] and body["keyCount"] == 0
    assert body["feed"] == {
        "path": f"/v1/organizations/{t.org}/compositions/tomato/environments/production/composition", "etag": None,
    }

    listed = await api_client.get(t.environments, headers=t.viewer)
    assert listed.status_code == 200
    assert [item["slug"] for item in listed.json()["environments"]] == ["production"]
    # Keys are listed for ADMIN only.
    assert listed.json()["environments"][0]["keys"] is None
    by_slug = await api_client.get(f"{t.environments}/production", headers=t.viewer)
    by_id = await api_client.get(f"{t.environments}/{body['id']}", headers=t.viewer)
    assert by_slug.status_code == by_id.status_code == 200 and by_slug.json() == by_id.json()
    assert by_slug.headers["ETag"] == created.headers["ETag"]

    edited = await api_client.patch(
        f"{t.environments}/production", headers={**t.admin, "If-Match": created.headers["ETag"]},
        json={"name": "Prod", "expectedUsers": None, "operator": None},
    )
    assert edited.status_code == 200, edited.text
    assert (edited.json()["name"], edited.json()["expectedUsers"], edited.json()["operator"]) == ("Prod", None, None)
    assert edited.headers["ETag"] != created.headers["ETag"]

    deleted = await api_client.delete(f"{t.environments}/production", headers=t.admin)
    assert deleted.status_code == 204
    gone = await api_client.get(f"{t.environments}/production", headers=t.owner)
    assert gone.status_code == 404 and gone.json()["detail"]["error"] == "Environment not found."

    audited = (await db_session.scalars(
        select(AuditEvent).where(AuditEvent.target_type == "CompositionEnvironment").order_by(AuditEvent.created_at)
    )).all()
    assert [row.action for row in audited] == [
        "composition.environment_created", "composition.environment_updated", "composition.environment_deleted",
    ]
    assert sorted(audited[1].detail["fields"]) == ["expectedUsers", "name", "operator"]
    assert audited[2].detail["environment"] == "production" and audited[2].detail["adoptions"] == 0


async def test_roles(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    await env(api_client, t)
    url = f"{t.environments}/production"

    for headers in (t.member, t.viewer):
        refused = [
            await api_client.post(t.environments, headers=headers, json={"slug": "x", "name": "X"}),
            await api_client.patch(url, headers=headers, json={"name": "X"}),
            # Only ADMIN saves expected users; anybody may change the figure on screen, which saves nothing.
            await api_client.patch(url, headers=headers, json={"expectedUsers": 10}),
            await api_client.delete(url, headers=headers),
        ]
        for response in refused:
            assert response.status_code == 403, response.text
            assert code(response) == "organization_forbidden"
        assert (await api_client.get(url, headers=headers)).status_code == 200
    assert (await api_client.post(t.environments, headers=t.admin, json={"slug": "staging", "name": "S"})).status_code == 201


async def test_parity_for_callers_who_are_not_members(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    created = await env(api_client, t)
    tag = created.headers["ETag"]
    url = f"{t.environments}/production"
    missing_composition = f"/v1/organizations/{t.org}/compositions/nothing/environments"

    def requests(base, target):
        return [
            ("GET", base, None, {}),
            ("POST", base, {"slug": "x", "name": "X"}, {}),
            ("GET", target, None, {}),
            ("PATCH", target, {"name": "X"}, {"If-Match": tag}),
            ("DELETE", target, None, {}),
        ]

    async def send(headers, method, path, body, extra):
        return await api_client.request(method, path, headers={**headers, **extra}, json=body)

    # A private composition: the composition's 404, the same body as a missing one.
    unknown = await api_client.get(missing_composition, headers=t.outsider)
    assert unknown.status_code == 404 and unknown.json()["detail"]["error"] == "Composition not found."
    for method, path, body, extra in requests(t.environments, url):
        response = await send(t.outsider, method, path, body, extra)
        assert response.status_code == 404, (method, path, response.text)
        assert response.json()["detail"] == unknown.json()["detail"]

    # A public composition: every environment route answers "Environment not found.", list included.
    made_public = await api_client.patch(t.base, headers=t.owner, json={"visibility": "public"})
    assert made_public.status_code == 200, made_public.text
    missing_environment = await api_client.get(f"{t.environments}/nothing", headers=t.owner)
    assert missing_environment.status_code == 404
    for method, path, body, extra in requests(t.environments, url):
        response = await send(t.outsider, method, path, body, extra)
        assert response.status_code == 404, (method, path, response.text)
        assert response.json()["detail"] == missing_environment.json()["detail"]
        assert response.json()["detail"]["error"] == "Environment not found."

    # No credential: 401 before any lookup, whatever exists.
    for path in (t.environments, url, missing_composition, "/v1/organizations/nobody/compositions/x/environments"):
        anonymous = await api_client.get(path)
        assert anonymous.status_code == 401 and code(anonymous) == "unauthorized"
        assert anonymous.headers["WWW-Authenticate"]


async def test_if_match(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    created = await env(api_client, t)
    url = f"{t.environments}/production"
    first = await api_client.patch(url, headers={**t.owner, "If-Match": created.headers["ETag"]}, json={"name": "A"})
    assert first.status_code == 200

    stale = await api_client.patch(url, headers={**t.owner, "If-Match": created.headers["ETag"]}, json={"name": "B"})
    assert stale.status_code == 412 and code(stale) == "precondition_failed"
    assert stale.headers["ETag"] == first.headers["ETag"]
    # Absent passes, as on every edit but adopt.
    assert (await api_client.patch(url, headers=t.owner, json={"name": "C"})).status_code == 200
    stale_delete = await api_client.delete(url, headers={**t.owner, "If-Match": created.headers["ETag"]})
    assert stale_delete.status_code == 412


async def test_the_slug_is_fixed_and_checked(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    await env(api_client, t)
    url = f"{t.environments}/production"

    renamed = await api_client.patch(url, headers=t.owner, json={"slug": "prod"})
    assert renamed.status_code == 422
    taken = await api_client.post(t.environments, headers=t.owner, json={"slug": "production", "name": "Again"})
    assert taken.status_code == 409 and code(taken) == "slug_conflict"
    for bad in ("Production", "2nd", "a_b", "p" * 41, ""):
        response = await api_client.post(t.environments, headers=t.owner, json={"slug": bad, "name": "X"})
        assert response.status_code == 422, bad
    null_name = await api_client.patch(url, headers=t.owner, json={"name": None})
    assert null_name.status_code == 422


async def test_the_operator_is_a_member(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)

    outsider = await api_client.post(
        t.environments, headers=t.owner, json={"slug": "p", "name": "P", "operator": t.ids["outsider_username"]},
    )
    nobody = await api_client.post(
        t.environments, headers=t.owner, json={"slug": "p", "name": "P", "operator": f"nobody{uuid.uuid4().hex[:6]}"},
    )
    assert outsider.status_code == nobody.status_code == 422
    assert code(outsider) == code(nobody) == "operator_not_member"

    created = await env(api_client, t, operator=t.ids["member_username"])
    assert created.json()["operator"]["member"] is True
    removed = await api_client.delete(f"/v1/organizations/{t.org}/members/{t.ids['member']}", headers=t.owner)
    assert removed.status_code == 204, removed.text
    # A member who leaves stays named, marked as no longer a member.
    view = (await api_client.get(f"{t.environments}/production", headers=t.owner)).json()
    assert view["operator"]["username"] == t.ids["member_username"] and view["operator"]["member"] is False


async def test_the_environment_limit(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    monkeypatch.setattr(get_settings(), "composition_environments_max", 2)
    t = await team(api_client, registration, db_session, gate, versions=False)
    await env(api_client, t, "a")
    await env(api_client, t, "b")

    refused = await api_client.post(t.environments, headers=t.owner, json={"slug": "c", "name": "C"})

    assert refused.status_code == 409 and code(refused) == "environment_limit"
    assert refused.json()["detail"]["limit"] == 2


async def test_personal_keys_need_the_composition_permissions(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    await env(api_client, t)
    reader = await make_key(api_client, t.owner, ["compositions:read"])
    writer = await make_key(api_client, t.owner, ["compositions:read", "compositions:write"])

    assert (await api_client.get(t.environments, headers=reader)).status_code == 200
    refused = await api_client.post(t.environments, headers=reader, json={"slug": "s", "name": "S"})
    assert refused.status_code == 403 and code(refused) == "insufficient_api_key_permission"
    assert (await api_client.post(t.environments, headers=writer, json={"slug": "s", "name": "S"})).status_code == 201


async def test_deleting_the_user_keeps_the_operator_named(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    await env(api_client, t, operator=t.ids["admin_username"])
    user = await db_session.get(User, uuid.UUID(t.ids["admin"]))
    user.is_active = False
    await db_session.commit()

    view = (await api_client.get(f"{t.environments}/production", headers=t.owner)).json()

    assert view["operator"]["member"] is False


async def test_deleting_an_environment_makes_its_pending_proposals_stale(api_client, registration, db_session, gate):  # noqa: F811
    """F6-B: a pending proposal whose ``adopt`` step names the environment can neither run nor dangle once it is gone;
    one adopting elsewhere stays pending."""
    from _environment_rows import World
    from _proposal_rows import proposal, step
    from openbinding_gateway.db.models import Proposal

    t = await team(api_client, registration, db_session, gate)
    production = (await env(api_client, t)).json()
    staging = (await env(api_client, t, slug="staging")).json()
    member = uuid.UUID(t.ids["member"])
    v1 = uuid.UUID(t.versions["1.0.0"]["id"])
    w = World(member, uuid.UUID(t.organization_id), uuid.UUID(t.composition_id), (v1,), (v1,), uuid.UUID(t.composition_id),
              v1, v1)
    doomed = await proposal(db_session, w)
    await step(db_session, doomed, params={"environment": production["id"], "version": str(v1)})
    elsewhere = await proposal(db_session, w, scope_key="conversation:x")
    await step(db_session, elsewhere, params={"environment": staging["id"], "version": str(v1)})
    await db_session.commit()

    deleted = await api_client.delete(f"{t.environments}/production", headers=t.admin)

    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    assert (await db_session.get(Proposal, doomed)).status == "stale"
    assert (await db_session.get(Proposal, elsewhere)).status == "pending"
    audit = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "composition.environment_deleted")
                                    .order_by(AuditEvent.created_at.desc()))
    assert audit.detail["staleProposals"] == 1

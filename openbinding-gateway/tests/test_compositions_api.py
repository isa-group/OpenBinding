"""The compositions of an organization: create, read, list, edit and delete them (F1 B7).

A composition the caller cannot read answers as a missing one: 404 for a non-member and for another
organization's composition, never 403. A member whose role is too weak for a write gets 403.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select

from _b1_helpers import make_account, put_member, gate  # noqa: F401,F811
from _problem_helpers import make_org
from openbinding_gateway.composition.document import KINDS
from openbinding_gateway.db.models import AuditEvent, Composition, CompositionKind
from openbinding_gateway.space_client import PlanCaps


def code(response) -> str:
    return response.json()["detail"]["code"]


async def owner(api_client, registration, db_session, gate):  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    return account, headers, await make_org(api_client, headers)


async def create(api_client, headers, org, slug, **fields):
    response = await api_client.post(
        f"/v1/organizations/{org}/compositions", headers=headers, json={"slug": slug, "name": slug.title(), **fields},
    )
    assert response.status_code == 201, response.text
    return response


def test_the_stored_kinds_are_the_language_kinds():
    assert tuple(kind.value for kind in CompositionKind) == KINDS


async def test_a_composition_is_created_read_edited_and_deleted(api_client, registration, db_session, gate):  # noqa: F811
    account, headers, org = await owner(api_client, registration, db_session, gate)
    base = f"/v1/organizations/{org}/compositions"

    created = await create(api_client, headers, org, "checkout", description="The checkout flow", kind="workflow")

    body = created.json()
    assert created.headers["ETag"]
    assert body["slug"] == "checkout" and body["name"] == "Checkout" and body["description"] == "The checkout flow"
    assert body["kind"] == "workflow" and body["archived"] is False
    assert body["organization"]["slug"] == org
    assert body["latest_version"] is None and body["version_count"] == 0
    assert body["created_by_id"] == account["id"]

    by_slug = await api_client.get(f"{base}/checkout", headers=headers)
    by_id = await api_client.get(f"{base}/{body['id']}", headers=headers)
    assert by_slug.status_code == by_id.status_code == 200
    assert by_slug.json() == by_id.json() == body
    assert by_slug.headers["ETag"] == created.headers["ETag"]

    edited = await api_client.patch(
        f"{base}/checkout", headers=headers, json={"name": "Checkout v2", "description": "", "archived": True},
    )
    assert edited.status_code == 200, edited.text
    assert (edited.json()["name"], edited.json()["description"], edited.json()["archived"]) == ("Checkout v2", "", True)
    assert edited.json()["kind"] == "workflow"
    assert edited.headers["ETag"] != created.headers["ETag"]

    deleted = await api_client.delete(f"{base}/checkout", headers=headers)
    assert deleted.status_code == 204, deleted.text
    assert (await api_client.get(f"{base}/checkout", headers=headers)).status_code == 404
    assert await db_session.scalar(select(func.count()).select_from(Composition)) == 0
    actions = (await db_session.scalars(select(AuditEvent.action).where(AuditEvent.target_type == "Composition"))).all()
    assert sorted(actions) == ["composition.created", "composition.deleted", "composition.updated"]


async def test_the_kind_defaults_to_application_and_cannot_be_edited(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    created = await create(api_client, headers, org, "plain")
    assert created.json()["kind"] == "application"

    refused = await api_client.patch(f"/v1/organizations/{org}/compositions/plain", headers=headers, json={"kind": "system"})
    unknown = await api_client.post(
        f"/v1/organizations/{org}/compositions", headers=headers, json={"slug": "x", "name": "X", "kind": "service"},
    )
    bad_slug = await api_client.post(
        f"/v1/organizations/{org}/compositions", headers=headers, json={"slug": "Not A Slug", "name": "X"},
    )

    assert refused.status_code == unknown.status_code == bad_slug.status_code == 422


async def test_the_list_filters_by_kind_text_and_archived_and_pages(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    base = f"/v1/organizations/{org}/compositions"
    await create(api_client, headers, org, "alpha", kind="workflow")
    await create(api_client, headers, org, "beta", name="Beta pipeline", kind="pipeline")
    await create(api_client, headers, org, "gamma")
    archived = await api_client.patch(f"{base}/gamma", headers=headers, json={"archived": True})
    assert archived.status_code == 200, archived.text

    async def slugs(**params):
        response = await api_client.get(base, headers=headers, params=params)
        assert response.status_code == 200, response.text
        return [item["slug"] for item in response.json()["compositions"]], response.json()["total"]

    assert await slugs() == (["alpha", "beta", "gamma"], 3)
    assert await slugs(kind="pipeline") == (["beta"], 1)
    assert await slugs(q="PIPE") == (["beta"], 1)
    assert await slugs(q="gam") == (["gamma"], 1)
    assert await slugs(q="%") == ([], 0)
    assert await slugs(archived="true") == (["gamma"], 1)
    assert await slugs(archived="false") == (["alpha", "beta"], 2)
    assert await slugs(limit=2) == (["alpha", "beta"], 3)
    assert await slugs(limit=2, offset=2) == (["gamma"], 3)
    page = await api_client.get(base, headers=headers, params={"limit": 2, "offset": 1})
    assert (page.json()["limit"], page.json()["offset"]) == (2, 1)
    assert (await api_client.get(base, headers=headers, params={"limit": 0})).status_code == 422
    assert (await api_client.get(base, headers=headers, params={"kind": "service"})).status_code == 422


async def test_a_taken_slug_is_a_409_and_another_organization_may_take_it(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    other = await make_org(api_client, headers)
    await create(api_client, headers, org, "same")

    again = await api_client.post(f"/v1/organizations/{org}/compositions", headers=headers, json={"slug": "same", "name": "S"})

    assert again.status_code == 409, again.text
    assert code(again) == "slug_conflict"
    await create(api_client, headers, other, "same")
    assert await db_session.scalar(select(func.count()).select_from(Composition)) == 2


async def test_creating_needs_the_repository_feature(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    real = gate.caps

    async def caps(user_id):
        base = await real(user_id)
        return PlanCaps(plan=base.plan, features={**base.features, "repository": False}, limits=base.limits)

    monkeypatch.setattr(gate, "caps", caps)
    refused = await api_client.post(f"/v1/organizations/{org}/compositions", headers=headers, json={"slug": "c", "name": "C"})

    assert refused.status_code == 403, refused.text
    assert code(refused) == "feature_not_entitled"
    assert await db_session.scalar(select(func.count()).select_from(Composition)) == 0


async def test_if_match_refuses_a_stale_tag_with_412_and_a_malformed_one_with_400(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers, org = await owner(api_client, registration, db_session, gate)
    url = f"/v1/organizations/{org}/compositions/guarded"
    tag = (await create(api_client, headers, org, "guarded")).headers["ETag"]

    first = await api_client.patch(url, headers={**headers, "If-Match": tag}, json={"name": "First"})
    stale = await api_client.patch(url, headers={**headers, "If-Match": tag}, json={"name": "Second"})
    malformed = await api_client.patch(url, headers={**headers, "If-Match": "not-a-tag"}, json={"name": "Third"})

    assert first.status_code == 200, first.text
    assert stale.status_code == 412, stale.text
    assert code(stale) == "precondition_failed"
    assert stale.headers["ETag"] == first.headers["ETag"]
    assert malformed.status_code == 400, malformed.text
    assert code(malformed) == "invalid_if_match"
    assert (await api_client.get(url, headers=headers)).json()["name"] == "First"


async def test_a_viewer_reads_a_member_writes_and_an_admin_deletes(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    viewer, viewer_headers = await make_account(api_client, registration, db_session, gate)
    member, member_headers = await make_account(api_client, registration, db_session, gate)
    admin, admin_headers = await make_account(api_client, registration, db_session, gate)
    await put_member(api_client, headers, org, viewer["id"], "VIEWER")
    await put_member(api_client, headers, org, member["id"], "MEMBER")
    await put_member(api_client, headers, org, admin["id"], "ADMIN")
    await create(api_client, headers, org, "shared")
    base = f"/v1/organizations/{org}/compositions"

    assert (await api_client.get(base, headers=viewer_headers)).json()["total"] == 1
    assert (await api_client.get(f"{base}/shared", headers=viewer_headers)).status_code == 200
    viewer_create = await api_client.post(base, headers=viewer_headers, json={"slug": "v", "name": "V"})
    viewer_edit = await api_client.patch(f"{base}/shared", headers=viewer_headers, json={"name": "V"})
    assert viewer_create.status_code == viewer_edit.status_code == 403
    assert code(viewer_create) == code(viewer_edit) == "organization_forbidden"

    assert (await api_client.post(base, headers=member_headers, json={"slug": "m", "name": "M"})).status_code == 201
    assert (await api_client.patch(f"{base}/m", headers=member_headers, json={"name": "Mine"})).status_code == 200
    member_delete = await api_client.delete(f"{base}/m", headers=member_headers)
    assert member_delete.status_code == 403 and code(member_delete) == "organization_forbidden"
    assert (await api_client.delete(f"{base}/m", headers=admin_headers)).status_code == 204


async def test_an_unreadable_composition_answers_as_a_missing_one(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    created = await create(api_client, headers, org, "private")
    tag = created.headers["ETag"]
    _, outsider_headers, elsewhere = await owner(api_client, registration, db_session, gate)
    base = f"/v1/organizations/{org}/compositions"
    missing_org = f"/v1/organizations/no-such-{uuid.uuid4().hex[:8]}/compositions"

    # A non-member: every route answers as the organization did not exist, before any If-Match handling.
    outsider = [
        await api_client.get(base, headers=outsider_headers),
        await api_client.post(base, headers=outsider_headers, json={"slug": "x", "name": "X"}),
        await api_client.patch(f"{base}/private", headers={**outsider_headers, "If-Match": tag}, json={"name": "X"}),
        await api_client.patch(f"{base}/private", headers={**outsider_headers, "If-Match": "bad"}, json={"name": "X"}),
        await api_client.delete(f"{base}/private", headers=outsider_headers),
    ]
    unknown = await api_client.get(missing_org, headers=outsider_headers)
    for response in outsider:
        assert response.status_code == 404, response.text
        assert response.json()["detail"] == unknown.json()["detail"]
        assert "ETag" not in response.headers
    # The reads, open to a public composition, answer a private one as they answer a missing one, whose
    # organization is missing too (test_compositions_public.py).
    reads = [
        await api_client.get(f"{base}/private", headers=outsider_headers),
        await api_client.get(f"{base}/{created.json()['id']}", headers=outsider_headers),
    ]
    unknown_read = await api_client.get(f"{missing_org}/private", headers=outsider_headers)
    for response in reads:
        assert response.status_code == 404, response.text
        assert response.content == unknown_read.content
        assert "ETag" not in response.headers

    # Another organization's composition, by slug or id, through an organization the caller can read.
    foreign = f"/v1/organizations/{elsewhere}/compositions"
    assert (await api_client.get(f"{foreign}/private", headers=outsider_headers)).status_code == 404
    assert (await api_client.get(f"{foreign}/{created.json()['id']}", headers=outsider_headers)).status_code == 404
    assert (await api_client.delete(f"{foreign}/{created.json()['id']}", headers=outsider_headers)).status_code == 404
    assert (await api_client.get(f"{base}/private", headers=headers)).status_code == 200


async def test_an_anonymous_caller_finds_no_organization_that_publishes_nothing(
    api_client, registration, db_session, gate,  # noqa: F811
):
    _, headers, org = await owner(api_client, registration, db_session, gate)
    await create(api_client, headers, org, "private")

    # The list is open to anybody, for an organization's public compositions only (F2c G6, Q8).
    assert (await api_client.get(f"/v1/organizations/{org}/compositions")).status_code == 404
    assert (await api_client.post(f"/v1/organizations/{org}/compositions", json={"slug": "x", "name": "X"})).status_code == 401


async def test_the_list_filters_on_the_problem_a_version_links(api_client, registration, db_session, gate):  # noqa: F811
    from _b3_links import an_organization_with_links

    world = await an_organization_with_links(api_client, registration, db_session, gate)
    url = f"/v1/organizations/{world.org}/compositions"

    async def slugs(**params):
        response = await api_client.get(url, params=params, headers=world.headers)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["total"] == len(body["compositions"])
        return [row["slug"] for row in body["compositions"]]

    assert await slugs() == ["plain", "shop"]
    assert await slugs(problem=world.linked.slug) == ["shop"]
    assert await slugs(problem=str(world.linked.id)) == ["shop"]
    assert await slugs(problem=world.other.slug) == []
    assert await slugs(problem="nowhere") == []
    assert await slugs(problem=str(uuid.uuid4())) == []
    assert await slugs(problem=world.linked.slug, archived=True) == []


async def test_a_composition_with_environments_is_not_deleted(api_client, registration, db_session, gate):  # noqa: F811
    """D-h: an application may read one of its environments; a person deletes them first."""
    from _environment_rows import environment
    from _environment_rows import World

    account, headers, org = await owner(api_client, registration, db_session, gate)
    base = f"/v1/organizations/{org}/compositions"
    body = (await create(api_client, headers, org, "tomato")).json()
    w = World(uuid.UUID(account["id"]), uuid.UUID(body["organization"]["id"]), uuid.UUID(body["id"]),
              (), (), uuid.uuid4(), uuid.uuid4(), uuid.uuid4())
    await environment(db_session, w, "staging")
    await environment(db_session, w, "production")
    await db_session.commit()

    refused = await api_client.delete(f"{base}/tomato", headers=headers)

    assert refused.status_code == 409 and code(refused) == "composition_in_operation"
    assert refused.json()["detail"]["environments"] == ["production", "staging"]
    assert (await api_client.get(f"{base}/tomato", headers=headers)).status_code == 200

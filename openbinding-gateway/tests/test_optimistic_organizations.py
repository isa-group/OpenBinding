"""ETag / If-Match / 412 on updateOrganization, updateProject and updateBindingCase."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select, update

from openbinding_gateway import space_client
from openbinding_gateway.core import revision
from openbinding_gateway.db.models import AuditEvent, BindingCase, Organization, Project, utcnow
from _pricing import fake_pricing_gate, largest_plan
from test_collaboration_platform import account

LARGER_PLAN = largest_plan()


@pytest_asyncio.fixture
async def resources(api_client, registration):
    """An organization, a project and a case owned by one account, with that account's headers.

    Also a viewer, an admin (neither is the owner) and an outsider with no membership.
    """
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    owner, headers = await account(api_client, registration)
    gate.plans[uuid.UUID(owner["id"])] = LARGER_PLAN
    viewer, viewer_headers = await account(api_client, registration)
    admin, admin_headers = await account(api_client, registration)
    _, outsider = await account(api_client, registration)
    slug = f"lab-{uuid.uuid4().hex[:8]}"
    org = await api_client.post("/v1/organizations", headers=headers, json={"slug": slug, "name": "Lab"})
    assert org.status_code == 201, org.text
    base = f"/v1/organizations/{slug}"
    for member, role in ((viewer, "VIEWER"), (admin, "ADMIN")):
        added = await api_client.put(
            f"{base}/members/{member['id']}", headers=headers, json={"user_id": member["id"], "role": role}
        )
        assert added.status_code == 200, added.text
    project = await api_client.post(
        f"/v1/organizations/{slug}/projects", headers=headers, json={"slug": "routing", "name": "Routing"}
    )
    assert project.status_code == 201, project.text
    case = await api_client.post(
        f"/v1/organizations/{slug}/projects/routing/cases", headers=headers, json={"slug": "base", "name": "Base"}
    )
    assert case.status_code == 201, case.text
    yield {
        "headers": headers,
        "gate": gate,
        "viewer": viewer_headers,
        "admin": admin_headers,
        "outsider": outsider,
        "owner_id": owner["id"],
        "viewer_id": viewer["id"],
        "admin_id": admin["id"],
        "member_url": f"{base}/members/{viewer['id']}",
        "org": {"url": base, "model": Organization, "id": org.json()["id"], "change": {"name": "Renamed"}},
        "project": {
            "url": f"{base}/projects/routing", "model": Project, "id": project.json()["id"],
            "change": {"description": "Edited"},
        },
        "case": {
            "url": f"{base}/projects/routing/cases/base", "model": BindingCase, "id": case.json()["id"],
            "change": {"description": "Edited"},
        },
    }
    space_client.set_gate(previous)


KINDS = ["org", "project", "case"]


async def current_tag(client, resource, headers) -> str:
    response = await client.get(resource["url"], headers=headers)
    assert response.status_code == 200, response.text
    return response.headers["ETag"]


async def moved_on(client, resource, headers) -> str:
    """A tag that is stale: the one held before an edit that really changes the row."""
    tag = await current_tag(client, resource, headers)
    field = next(iter(resource["change"]))
    edited = await client.patch(resource["url"], headers=headers, json={field: f"Moved {uuid.uuid4().hex[:8]}"})
    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != tag
    return tag


async def audit_events(db_session) -> int:
    return await db_session.scalar(select(func.count()).select_from(AuditEvent))


def missing_url(kind: str, resource) -> str:
    return resource["url"][: resource["url"].rindex("/")] + "/missing" if kind != "org" else "/v1/organizations/missing"


# [utest->req~gateway-api-optimistic-concurrency-covered~1]
# [utest->req~gateway-api-optimistic-concurrency-etag-format~1]
# [utest->req~gateway-api-optimistic-concurrency-etag-on-read~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_get_carries_a_strong_etag(api_client, resources, kind) -> None:
    tag = await current_tag(api_client, resources[kind], resources["headers"])

    assert tag.startswith('"') and not tag.startswith("W/")
    assert await current_tag(api_client, resources[kind], resources["headers"]) == tag


# [utest->req~gateway-api-optimistic-concurrency-etag-on-write~1]
# [utest->req~gateway-api-optimistic-concurrency-revision-bump~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_patch_with_the_current_etag_succeeds_and_returns_a_new_one(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]
    tag = await current_tag(api_client, resource, headers)

    edited = await api_client.patch(resource["url"], headers={**headers, "If-Match": tag}, json=resource["change"])

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != tag
    assert edited.headers["ETag"] == await current_tag(api_client, resource, headers)


# [utest->req~gateway-api-optimistic-concurrency-precondition-failed~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed-etag~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed-unchanged~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_replaying_the_old_etag_is_412_with_the_current_one(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]
    old = await current_tag(api_client, resource, headers)
    first = await api_client.patch(resource["url"], headers={**headers, "If-Match": old}, json=resource["change"])
    assert first.status_code == 200, first.text
    current = first.headers["ETag"]

    second = await api_client.patch(
        resource["url"], headers={**headers, "If-Match": old}, json={"name": "Lost update"}
    )

    assert second.status_code == 412, second.text
    assert second.json()["detail"]["code"] == "precondition_failed"
    assert second.headers["ETag"] == current
    assert await current_tag(api_client, resource, headers) == current
    stored = await api_client.get(resource["url"], headers=headers)
    assert stored.json()["name"] != "Lost update"


# [utest->req~gateway-api-optimistic-concurrency-if-match-absent~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_without_if_match_the_edit_still_succeeds(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]

    edited = await api_client.patch(resource["url"], headers=headers, json=resource["change"])

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] == await current_tag(api_client, resource, headers)


# [utest->req~gateway-api-optimistic-concurrency-if-match-any~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_wildcard_matches_any_existing_row(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]

    edited = await api_client.patch(resource["url"], headers={**headers, "If-Match": "*"}, json=resource["change"])

    assert edited.status_code == 200, edited.text


# [utest->req~gateway-api-optimistic-concurrency-if-match-weak~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_weak_tag_never_matches(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]
    tag = await current_tag(api_client, resource, headers)

    refused = await api_client.patch(resource["url"], headers={**headers, "If-Match": f"W/{tag}"}, json=resource["change"])

    assert refused.status_code == 412, refused.text
    assert refused.headers["ETag"] == tag


# [utest->req~gateway-api-optimistic-concurrency-invalid-if-match~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_malformed_if_match_is_400(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]

    refused = await api_client.patch(resource["url"], headers={**headers, "If-Match": "not a tag"}, json=resource["change"])

    assert refused.status_code == 400, refused.text
    assert refused.json()["detail"]["code"] == "invalid_if_match"


# [utest->req~gateway-api-optimistic-concurrency-order-access~1]
@pytest.mark.parametrize("who", ["viewer", "outsider"])
@pytest.mark.parametrize("kind", KINDS)
async def test_unauthorised_caller_gets_403_not_412(api_client, resources, kind, who) -> None:
    resource = resources[kind]

    refused = await api_client.patch(
        resource["url"], headers={**resources[who], "If-Match": '"stale"'}, json=resource["change"]
    )

    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"]["code"] == "organization_forbidden"
    assert "ETag" not in refused.headers


# [utest->req~gateway-api-optimistic-concurrency-order-access~1]
async def test_a_stranger_gets_404_for_an_organization_that_does_not_exist(api_client, resources) -> None:
    refused = await api_client.patch(
        "/v1/organizations/missing", headers={**resources["outsider"], "If-Match": '"stale"'}, json={"name": "X"}
    )

    assert refused.status_code == 404, refused.text
    assert refused.json()["detail"]["code"] == "not_found"
    assert "ETag" not in refused.headers


# [utest->req~gateway-api-optimistic-concurrency-order-access~1]
async def test_an_admin_who_is_not_the_owner_is_refused_the_sponsor_before_the_tag(api_client, resources) -> None:
    resource, admin = resources["org"], resources["admin"]
    stale = await moved_on(api_client, resource, resources["headers"])

    refused = await api_client.patch(
        resource["url"], headers={**admin, "If-Match": stale}, json={"billing_sponsor_user_id": resources["admin_id"]}
    )
    renamed = await api_client.patch(resource["url"], headers={**admin, "If-Match": stale}, json={"name": "Admin"})

    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"]["code"] == "organization_forbidden"
    assert "ETag" not in refused.headers
    # The same admin and tag are fine for the edits an admin may make: only the sponsor is the owner's.
    assert renamed.status_code == 412, renamed.text


# [utest->req~gateway-api-optimistic-concurrency-order-access~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_missing_resource_is_404_not_412(api_client, resources, kind) -> None:
    resource = resources[kind]
    url = resource["url"][: resource["url"].rindex("/")] + "/missing" if kind != "org" else "/v1/organizations/missing"

    refused = await api_client.patch(url, headers={**resources["headers"], "If-Match": '"stale"'}, json=resource["change"])

    assert refused.status_code == 404, refused.text


# [utest->req~gateway-api-optimistic-concurrency-order-access~1]
# [utest->req~gateway-api-optimistic-concurrency-invalid-if-match~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_a_malformed_if_match_on_a_missing_resource_is_404(api_client, resources, kind) -> None:
    resource = resources[kind]
    url = missing_url(kind, resource)

    refused = await api_client.patch(url, headers={**resources["headers"], "If-Match": "not a tag"}, json=resource["change"])

    assert refused.status_code == 404, refused.text
    assert refused.json()["detail"]["code"] == "not_found"
    assert "ETag" not in refused.headers


# [utest->req~gateway-api-optimistic-concurrency-order-state~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed~1]
async def test_stale_tag_beats_business_validation(api_client, resources) -> None:
    resource, headers = resources["org"], resources["headers"]
    tag = await current_tag(api_client, resource, headers)
    await api_client.patch(resource["url"], headers=headers, json={"name": "Moved on"})

    # Both a stale tag and an invalid request (ambiguous parent): the stale tag is reported.
    stale = await api_client.patch(
        resource["url"], headers={**headers, "If-Match": tag},
        json={"move_to_root": True, "parent_id": str(uuid.uuid4())},
    )
    current = await current_tag(api_client, resource, headers)
    invalid = await api_client.patch(
        resource["url"], headers={**headers, "If-Match": current},
        json={"move_to_root": True, "parent_id": str(uuid.uuid4())},
    )

    assert stale.status_code == 412, stale.text
    assert invalid.status_code == 422, invalid.text
    assert invalid.json()["code"] == "ambiguous_parent"


# [utest->req~gateway-api-optimistic-concurrency-order-state~1]
async def test_sponsor_rule_still_runs_after_authorisation(api_client, registration, resources) -> None:
    resource, headers = resources["org"], resources["headers"]
    other, _ = await account(api_client, registration)
    tag = await current_tag(api_client, resource, headers)

    refused = await api_client.patch(
        resource["url"], headers={**headers, "If-Match": tag}, json={"billing_sponsor_user_id": other["id"]}
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "sponsor_must_be_caller"


# [utest->req~gateway-api-optimistic-concurrency-order-state~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed~1]
async def test_a_stale_tag_beats_the_sponsor_rule(api_client, resources) -> None:
    resource, headers = resources["org"], resources["headers"]
    stale = await moved_on(api_client, resource, headers)
    body = {"billing_sponsor_user_id": resources["admin_id"]}

    refused = await api_client.patch(resource["url"], headers={**headers, "If-Match": stale}, json=body)
    retried = await api_client.patch(
        resource["url"], headers={**headers, "If-Match": refused.headers["ETag"]}, json=body
    )

    assert refused.status_code == 412, refused.text
    assert retried.status_code == 422, retried.text
    assert retried.json()["code"] == "sponsor_must_be_caller"


# [utest->req~gateway-api-optimistic-concurrency-order-state~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed~1]
async def test_a_stale_tag_beats_an_acyclic_move_refusal(api_client, resources) -> None:
    resource, headers = resources["org"], resources["headers"]
    child = await api_client.post(
        "/v1/organizations", headers=headers,
        json={"slug": f"sub-{uuid.uuid4().hex[:8]}", "name": "Sub", "parent_id": resource["id"]},
    )
    assert child.status_code == 201, child.text
    stale = await moved_on(api_client, resource, headers)
    body = {"parent_id": child.json()["id"]}

    refused = await api_client.patch(resource["url"], headers={**headers, "If-Match": stale}, json=body)
    cycle = await api_client.patch(resource["url"], headers={**headers, "If-Match": refused.headers["ETag"]}, json=body)

    assert refused.status_code == 412, refused.text
    assert cycle.status_code == 409, cycle.text
    assert cycle.json()["code"] == "organization_cycle"


# [utest->req~gateway-api-optimistic-concurrency-order-state~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_a_body_that_fails_validation_is_refused_before_a_stale_tag(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]

    refused = await api_client.patch(resource["url"], headers={**headers, "If-Match": '"stale"'}, json={"name": 5})

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "validation_error"
    assert "ETag" not in refused.headers


# [utest->req~gateway-api-optimistic-concurrency-atomic~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed-etag~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_a_writer_that_commits_between_read_and_write_loses(
    api_client, resources, kind, db_session, monkeypatch
) -> None:
    """The guarded UPDATE, not the earlier comparison, is what refuses the second writer."""
    resource, headers = resources[kind], resources["headers"]
    model = resource["model"]
    tag = await current_tag(api_client, resource, headers)
    original_execute = db_session.execute
    landed: list[bool] = []

    async def execute(statement, *args, **kwargs):
        # The other writer commits after the comparison has passed and before the claim.
        if getattr(statement, "is_update", False) and not landed:
            landed.append(True)
            await original_execute(
                update(model)
                .where(model.id == uuid.UUID(resource["id"]))
                .values(updated_at=utcnow() + timedelta(days=1))
                .execution_options(synchronize_session=False)
            )
        return await original_execute(statement, *args, **kwargs)

    monkeypatch.setattr(db_session, "execute", execute)
    loser = await api_client.patch(resource["url"], headers={**headers, "If-Match": tag}, json={"name": "Loser"})
    monkeypatch.setattr(db_session, "execute", original_execute)

    assert landed
    assert loser.status_code == 412, loser.text
    assert loser.json()["detail"]["code"] == "precondition_failed"
    assert loser.headers["ETag"] != tag
    assert loser.headers["ETag"] == await current_tag(api_client, resource, headers)
    stored = await api_client.get(resource["url"], headers=headers)
    assert stored.json()["name"] != "Loser"


# [utest->req~gateway-api-optimistic-concurrency-atomic~1]
# [utest->req~gateway-api-optimistic-concurrency-if-match-any~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_wildcard_is_not_refused_by_a_concurrent_bump(api_client, resources, kind, db_session, monkeypatch) -> None:
    resource, headers = resources[kind], resources["headers"]
    model = resource["model"]
    original_execute = db_session.execute
    landed: list[bool] = []

    async def execute(statement, *args, **kwargs):
        if getattr(statement, "is_update", False) and not landed:
            landed.append(True)
            await original_execute(
                update(model)
                .where(model.id == uuid.UUID(resource["id"]))
                .values(updated_at=utcnow() + timedelta(days=1))
                .execution_options(synchronize_session=False)
            )
        return await original_execute(statement, *args, **kwargs)

    monkeypatch.setattr(db_session, "execute", execute)
    edited = await api_client.patch(resource["url"], headers={**headers, "If-Match": "*"}, json=resource["change"])

    assert landed
    assert edited.status_code == 200, edited.text


# [utest->req~gateway-api-optimistic-concurrency-revision-bump~1]
# [utest->req~gateway-api-optimistic-concurrency-etag-on-write~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_a_no_op_edit_with_if_match_still_returns_a_new_valid_etag(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]
    tag = await current_tag(api_client, resource, headers)

    unguarded = await api_client.patch(resource["url"], headers=headers, json={})
    guarded = await api_client.patch(resource["url"], headers={**headers, "If-Match": unguarded.headers["ETag"]}, json={})

    assert unguarded.status_code == guarded.status_code == 200
    assert unguarded.headers["ETag"] == tag
    assert guarded.headers["ETag"] not in (tag, "")
    assert guarded.headers["ETag"] == await current_tag(api_client, resource, headers)


# [utest->req~gateway-api-optimistic-concurrency-order-state~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed~1]
async def test_stale_tag_is_reported_on_project_and_case_whatever_the_edit(api_client, resources) -> None:
    headers = resources["headers"]
    project, case = resources["project"], resources["case"]
    stale_project = await current_tag(api_client, project, headers)
    stale_case = await current_tag(api_client, case, headers)
    await api_client.patch(project["url"], headers=headers, json={"description": "Moved on"})
    await api_client.patch(case["url"], headers=headers, json={"description": "Moved on"})

    # Going private is the edit that is checked against the sponsor's allowance.
    project_refusal = await api_client.patch(
        project["url"], headers={**headers, "If-Match": stale_project}, json={"visibility": "private"}
    )
    case_refusal = await api_client.patch(
        case["url"], headers={**headers, "If-Match": stale_case}, json={"name": "Late"}
    )

    assert project_refusal.status_code == 412, project_refusal.text
    assert case_refusal.status_code == 412, case_refusal.text


# [utest->req~gateway-api-optimistic-concurrency-order-access~1]
async def test_unauthorised_new_parent_is_refused_before_a_stale_tag(api_client, registration, resources) -> None:
    resource, headers = resources["org"], resources["headers"]
    _, stranger = await account(api_client, registration)
    foreign = await api_client.post(
        "/v1/organizations", headers=stranger, json={"slug": f"far-{uuid.uuid4().hex[:8]}", "name": "Far"}
    )
    assert foreign.status_code == 201, foreign.text

    refused = await api_client.patch(
        resource["url"], headers={**headers, "If-Match": '"stale"'}, json={"parent_id": foreign.json()["id"]}
    )
    missing = await api_client.patch(
        resource["url"], headers={**headers, "If-Match": '"stale"'}, json={"parent_id": str(uuid.uuid4())}
    )

    assert refused.status_code == 403, refused.text
    assert missing.status_code == 404, missing.text


# [utest->req~gateway-api-optimistic-concurrency-openapi~1]
def test_openapi_documents_if_match_and_both_failures() -> None:
    from openbinding_gateway.main import app

    paths = app.openapi()["paths"]
    for path, operation in [
        ("/v1/organizations/{org}", "updateOrganization"),
        ("/v1/organizations/{org}/projects/{project}", "updateProject"),
        ("/v1/organizations/{org}/projects/{project}/cases/{case}", "updateBindingCase"),
    ]:
        patch = paths[path]["patch"]
        assert patch["operationId"] == operation
        header = [p for p in patch["parameters"] if p["name"] == "If-Match"]
        assert len(header) == 1 and header[0]["in"] == "header" and header[0]["required"] is False
        assert {"400", "412"} <= set(patch["responses"])
        assert "ETag" in patch["responses"]["200"]["headers"]
        assert "ETag" in patch["responses"]["412"]["headers"]
        assert "content" in patch["responses"]["200"]  # the response model survives the merge


# [utest->req~gateway-api-optimistic-concurrency-openapi~1]
def test_openapi_declares_the_etag_of_the_reads() -> None:
    from openbinding_gateway.main import app

    paths = app.openapi()["paths"]
    for path in [
        "/v1/organizations/{org}",
        "/v1/organizations/{org}/projects/{project}",
        "/v1/organizations/{org}/projects/{project}/cases/{case}",
    ]:
        ok = paths[path]["get"]["responses"]["200"]
        assert "ETag" in ok["headers"]
        assert "content" in ok


# [utest->req~gateway-api-optimistic-concurrency-revision-bump~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_the_etag_changes_even_when_the_clock_is_behind_the_held_revision(
    api_client, resources, kind, db_session
) -> None:
    """The row's revision is in the future (clock skew): a guarded edit must still move it forward."""
    resource, headers = resources[kind], resources["headers"]
    model = resource["model"]
    future = utcnow() + timedelta(days=3)
    await db_session.execute(
        update(model)
        .where(model.id == uuid.UUID(resource["id"]))
        .values(updated_at=future)
        .execution_options(synchronize_session=False)
    )
    await db_session.commit()
    held = await current_tag(api_client, resource, headers)

    edited = await api_client.patch(resource["url"], headers={**headers, "If-Match": held}, json=resource["change"])

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != held
    assert edited.headers["ETag"] == await current_tag(api_client, resource, headers)
    stored = await db_session.scalar(select(model.updated_at).where(model.id == uuid.UUID(resource["id"])))
    assert revision.normalise(stored) > revision.normalise(future)


# [utest->req~gateway-api-optimistic-concurrency-atomic~1]
async def test_a_row_deleted_between_load_and_claim_is_404_not_500(
    api_client, resources, db_session, monkeypatch
) -> None:
    resource, headers = resources["case"], resources["headers"]
    tag = await current_tag(api_client, resource, headers)
    original_execute = db_session.execute
    deleted: list[bool] = []

    async def execute(statement, *args, **kwargs):
        if getattr(statement, "is_update", False) and not deleted:
            deleted.append(True)
            await original_execute(delete(BindingCase).where(BindingCase.id == uuid.UUID(resource["id"])))
        return await original_execute(statement, *args, **kwargs)

    monkeypatch.setattr(db_session, "execute", execute)
    gone = await api_client.patch(resource["url"], headers={**headers, "If-Match": tag}, json={"name": "Late"})
    monkeypatch.setattr(db_session, "execute", original_execute)

    assert deleted
    assert gone.status_code == 404, gone.text
    assert gone.json()["detail"]["code"] == "not_found"
    assert "ETag" not in gone.headers


# [utest->req~gateway-api-optimistic-concurrency-invalid-if-match~1]
async def test_repeated_if_match_fields_use_the_first(api_client, resources) -> None:
    resource, headers = resources["org"], resources["headers"]
    tag = await current_tag(api_client, resource, headers)
    fields = [*headers.items(), ("If-Match", tag), ("If-Match", '"stale"')]

    first_wins = await api_client.patch(resource["url"], headers=fields, json=resource["change"])
    fields = [*headers.items(), ("If-Match", '"stale"'), ("If-Match", first_wins.headers["ETag"])]
    stale_first = await api_client.patch(resource["url"], headers=fields, json=resource["change"])

    assert first_wins.status_code == 200, first_wins.text
    assert stale_first.status_code == 412, stale_first.text


# [utest->req~gateway-api-optimistic-concurrency-invalid-if-match~1]
async def test_an_if_match_over_the_length_cap_is_400(api_client, resources) -> None:
    resource, headers = resources["org"], resources["headers"]
    long = ", ".join(['"a"'] * 700)

    refused = await api_client.patch(resource["url"], headers={**headers, "If-Match": long}, json=resource["change"])

    assert len(long) > 2048
    assert refused.status_code == 400, refused.text
    assert refused.json()["detail"]["code"] == "invalid_if_match"


# [utest->req~gateway-api-optimistic-concurrency-precondition-failed~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed-etag~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_the_412_document_is_complete(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]
    stale = await moved_on(api_client, resource, headers)

    refused = await api_client.patch(resource["url"], headers={**headers, "If-Match": stale}, json=resource["change"])

    assert refused.status_code == 412, refused.text
    assert refused.headers["content-type"].split(";")[0] == "application/json"
    body = refused.json()
    assert body["status"] == 412
    assert body["code"] == "precondition_failed"
    assert body["title"] == "precondition_failed"
    assert body["detail"]["code"] == "precondition_failed"
    assert body["detail"]["error"]
    assert refused.headers["ETag"] == await current_tag(api_client, resource, headers)


# [utest->req~gateway-api-optimistic-concurrency-precondition-failed-unchanged~1]
# [utest->req~gateway-api-optimistic-concurrency-invalid-if-match~1]
@pytest.mark.parametrize("header", ['"stale"', "not a tag"], ids=["412", "400"])
@pytest.mark.parametrize("kind", KINDS)
async def test_a_refused_precondition_changes_nothing(api_client, resources, kind, header, db_session) -> None:
    resource, headers = resources[kind], resources["headers"]
    body = {**resource["change"], "name": "Refused"}
    if kind == "org":
        destination = await api_client.post(
            "/v1/organizations", headers=headers, json={"slug": f"dest-{uuid.uuid4().hex[:8]}", "name": "Dest"}
        )
        assert destination.status_code == 201, destination.text
        body["parent_id"] = destination.json()["id"]
    before = await api_client.get(resource["url"], headers=headers)
    events = await audit_events(db_session)

    refused = await api_client.patch(resource["url"], headers={**headers, "If-Match": header}, json=body)

    assert refused.status_code == (412 if header == '"stale"' else 400), refused.text
    after = await api_client.get(resource["url"], headers=headers)
    # The view carries the sponsor and the parent of an organization, the owning organization of the rest.
    assert after.json() == before.json()
    assert after.headers["ETag"] == before.headers["ETag"]
    assert await audit_events(db_session) == events


# [utest->req~gateway-api-optimistic-concurrency-precondition-failed-unchanged~1]
# [utest->req~gateway-api-optimistic-concurrency-order-state~1]
@pytest.mark.parametrize("header", ['"stale"', "not a tag"], ids=["412", "400"])
async def test_a_refused_precondition_leaves_the_sponsor_alone(
    api_client, registration, resources, header, db_session
) -> None:
    resource, headers = resources["org"], resources["headers"]
    second, second_headers = await account(api_client, registration)
    promoted = await api_client.put(
        f"{resource['url']}/members/{second['id']}", headers=headers, json={"user_id": second["id"], "role": "OWNER"}
    )
    assert promoted.status_code == 200, promoted.text
    before = await api_client.get(resource["url"], headers=headers)
    events = await audit_events(db_session)

    refused = await api_client.patch(
        resource["url"], headers={**second_headers, "If-Match": header}, json={"billing_sponsor_user_id": second["id"]}
    )

    assert refused.status_code == (412 if header == '"stale"' else 400), refused.text
    after = await api_client.get(resource["url"], headers=headers)
    assert after.json()["billing_sponsor_user_id"] == before.json()["billing_sponsor_user_id"] == resources["owner_id"]
    assert after.headers["ETag"] == before.headers["ETag"]
    assert await audit_events(db_session) == events


# [utest->req~gateway-api-optimistic-concurrency-if-match-list~1]
@pytest.mark.parametrize("form", ['"stale", {tag}', '"stale" ,{tag} ', ", {tag},"], ids=["list", "spaces", "empty-elements"])
@pytest.mark.parametrize("kind", KINDS)
async def test_a_list_naming_the_current_tag_is_accepted(api_client, resources, kind, form) -> None:
    resource, headers = resources[kind], resources["headers"]
    tag = await current_tag(api_client, resource, headers)

    edited = await api_client.patch(
        resource["url"], headers={**headers, "If-Match": form.format(tag=tag)}, json=resource["change"]
    )

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != tag


# [utest->req~gateway-api-optimistic-concurrency-if-match-any~1]
# [utest->req~gateway-api-optimistic-concurrency-revision-bump~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_a_wildcard_edit_changes_the_stored_value_and_the_etag(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]
    tag = await current_tag(api_client, resource, headers)
    field, value = next(iter(resource["change"].items()))

    edited = await api_client.patch(resource["url"], headers={**headers, "If-Match": "*"}, json=resource["change"])

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != tag
    stored = await api_client.get(resource["url"], headers=headers)
    assert stored.json()[field] == value
    assert stored.headers["ETag"] == edited.headers["ETag"]


# [utest->req~gateway-api-optimistic-concurrency-if-match-absent~1]
@pytest.mark.parametrize("kind", KINDS)
async def test_without_if_match_twice_both_edits_apply_and_the_second_stays(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]
    field = next(iter(resource["change"]))

    first = await api_client.patch(resource["url"], headers=headers, json={field: "One"})
    second = await api_client.patch(resource["url"], headers=headers, json={field: "Two"})

    assert first.status_code == second.status_code == 200
    assert second.headers["ETag"] != first.headers["ETag"]
    assert (await api_client.get(resource["url"], headers=headers)).json()[field] == "Two"


# [utest->req~gateway-api-optimistic-concurrency-etag-on-read~1]
async def test_a_refused_read_carries_no_etag(api_client, resources) -> None:
    owner, outsider = resources["headers"], resources["outsider"]
    project, case = resources["project"], resources["case"]

    refusals = [
        (await api_client.get(resources["org"]["url"], headers=outsider), 403),
        (await api_client.get("/v1/organizations/missing", headers=owner), 404),
        (await api_client.get(missing_url("project", project), headers=owner), 404),
        (await api_client.get(missing_url("case", case), headers=owner), 404),
    ]

    for response, expected in refusals:
        assert response.status_code == expected, response.text
        assert "ETag" not in response.headers


# [utest->req~gateway-api-optimistic-concurrency-covered~1]
async def test_a_member_upsert_ignores_if_match_and_carries_no_etag(api_client, resources) -> None:
    viewer = resources["viewer_id"]

    upserted = await api_client.put(
        resources["member_url"], headers={**resources["headers"], "If-Match": "0"},
        json={"user_id": viewer, "role": "VIEWER"},
    )

    assert upserted.status_code == 200, upserted.text
    assert upserted.json()["user_id"] == viewer
    assert "ETag" not in upserted.headers


# [utest->req~gateway-api-optimistic-concurrency-order-state~1]
async def test_a_refusal_after_the_claim_leaves_the_etag_unchanged(api_client, resources, db_session) -> None:
    """The shared test session never rolls back on an error, so the request-scoped rollback is done by hand.

    What this pins is that the claim does not commit by itself: the bump is only ever visible through the
    transaction of the refused request, and it is gone with that transaction.
    """
    resource, headers = resources["org"], resources["headers"]
    child = await api_client.post(
        "/v1/organizations", headers=headers,
        json={"slug": f"sub-{uuid.uuid4().hex[:8]}", "name": "Sub", "parent_id": resource["id"]},
    )
    assert child.status_code == 201, child.text
    refusals = [
        ({"billing_sponsor_user_id": resources["admin_id"]}, 422),
        ({"parent_id": child.json()["id"]}, 409),
    ]

    for body, expected in refusals:
        await db_session.commit()
        current = await current_tag(api_client, resource, headers)

        refused = await api_client.patch(resource["url"], headers={**headers, "If-Match": current}, json=body)

        assert refused.status_code == expected, refused.text
        assert await current_tag(api_client, resource, headers) != current  # the claim did happen
        await db_session.rollback()
        assert await current_tag(api_client, resource, headers) == current

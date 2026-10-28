"""ETag / If-Match / 412 on updateOrganization, updateProject and updateBindingCase."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
import pytest_asyncio
from sqlalchemy import update

from openbinding_gateway import space_client
from openbinding_gateway.db.models import BindingCase, Organization, Project, utcnow
from _pricing import fake_pricing_gate, largest_plan
from test_collaboration_platform import account

LARGER_PLAN = largest_plan()


@pytest_asyncio.fixture
async def resources(api_client, registration):
    """An organization, a project and a case owned by one account, with that account's headers."""
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    owner, headers = await account(api_client, registration)
    gate.plans[uuid.UUID(owner["id"])] = LARGER_PLAN
    slug = f"lab-{uuid.uuid4().hex[:8]}"
    org = await api_client.post("/v1/organizations", headers=headers, json={"slug": slug, "name": "Lab"})
    assert org.status_code == 201, org.text
    project = await api_client.post(
        f"/v1/organizations/{slug}/projects", headers=headers, json={"slug": "routing", "name": "Routing"}
    )
    assert project.status_code == 201, project.text
    case = await api_client.post(
        f"/v1/organizations/{slug}/projects/routing/cases", headers=headers, json={"slug": "base", "name": "Base"}
    )
    assert case.status_code == 201, case.text
    base = f"/v1/organizations/{slug}"
    yield {
        "headers": headers,
        "gate": gate,
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


@pytest.mark.parametrize("kind", KINDS)
async def test_get_carries_a_strong_etag(api_client, resources, kind) -> None:
    tag = await current_tag(api_client, resources[kind], resources["headers"])

    assert tag.startswith('"') and not tag.startswith("W/")
    assert await current_tag(api_client, resources[kind], resources["headers"]) == tag


@pytest.mark.parametrize("kind", KINDS)
async def test_patch_with_the_current_etag_succeeds_and_returns_a_new_one(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]
    tag = await current_tag(api_client, resource, headers)

    edited = await api_client.patch(resource["url"], headers={**headers, "If-Match": tag}, json=resource["change"])

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != tag
    assert edited.headers["ETag"] == await current_tag(api_client, resource, headers)


@pytest.mark.parametrize("kind", KINDS)
async def test_replaying_the_old_etag_is_412_with_the_current_one(api_client, resources, kind, db_session) -> None:
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


@pytest.mark.parametrize("kind", KINDS)
async def test_without_if_match_the_edit_still_succeeds(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]

    edited = await api_client.patch(resource["url"], headers=headers, json=resource["change"])

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] == await current_tag(api_client, resource, headers)


@pytest.mark.parametrize("kind", KINDS)
async def test_wildcard_matches_any_existing_row(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]

    edited = await api_client.patch(resource["url"], headers={**headers, "If-Match": "*"}, json=resource["change"])

    assert edited.status_code == 200, edited.text


@pytest.mark.parametrize("kind", KINDS)
async def test_weak_tag_never_matches(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]
    tag = await current_tag(api_client, resource, headers)

    refused = await api_client.patch(resource["url"], headers={**headers, "If-Match": f"W/{tag}"}, json=resource["change"])

    assert refused.status_code == 412, refused.text
    assert refused.headers["ETag"] == tag


@pytest.mark.parametrize("kind", KINDS)
async def test_malformed_if_match_is_400(api_client, resources, kind) -> None:
    resource, headers = resources[kind], resources["headers"]

    refused = await api_client.patch(resource["url"], headers={**headers, "If-Match": "not a tag"}, json=resource["change"])

    assert refused.status_code == 400, refused.text
    assert refused.json()["detail"]["code"] == "invalid_if_match"


@pytest.mark.parametrize("kind", KINDS)
async def test_unauthorised_caller_gets_403_not_412(api_client, registration, resources, kind) -> None:
    resource = resources[kind]
    _, outsider = await account(api_client, registration)

    refused = await api_client.patch(
        resource["url"], headers={**outsider, "If-Match": '"stale"'}, json=resource["change"]
    )

    assert refused.status_code in (403, 404), refused.text
    assert "ETag" not in refused.headers


@pytest.mark.parametrize("kind", KINDS)
async def test_missing_resource_is_404_not_412(api_client, resources, kind) -> None:
    resource = resources[kind]
    url = resource["url"][: resource["url"].rindex("/")] + "/missing" if kind != "org" else "/v1/organizations/missing"

    refused = await api_client.patch(url, headers={**resources["headers"], "If-Match": '"stale"'}, json=resource["change"])

    assert refused.status_code == 404, refused.text


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


async def test_sponsor_rule_still_runs_after_authorisation(api_client, registration, resources) -> None:
    resource, headers = resources["org"], resources["headers"]
    other, _ = await account(api_client, registration)
    tag = await current_tag(api_client, resource, headers)

    refused = await api_client.patch(
        resource["url"], headers={**headers, "If-Match": tag}, json={"billing_sponsor_user_id": other["id"]}
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "sponsor_must_be_caller"


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
        assert any(p["name"] == "If-Match" and p["in"] == "header" for p in patch["parameters"])
        assert {"400", "412"} <= set(patch["responses"])

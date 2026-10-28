"""ETag / If-Match / 412 on updateStudy (a study has no single-resource GET: the tag comes from the PATCH)."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
import pytest_asyncio
from sqlalchemy import func, select, update

from _repo import REPO_ROOT
from _pricing import fake_pricing_gate
from test_collaboration_platform import account

from bim_core.package import load_package
from openbinding_gateway import space_client
from openbinding_gateway.db.models import AuditEvent, Study, utcnow
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services.engines import engine_ref

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}


@pytest_asyncio.fixture
async def lab(api_client, registration):
    """An organization with a project and one study, owned by one account, plus a viewer and an outsider."""
    previous = space_client.get_gate()
    space_client.set_gate(fake_pricing_gate())
    _, headers = await account(api_client, registration)
    viewer, viewer_headers = await account(api_client, registration)
    _, outsider = await account(api_client, registration)
    slug = f"lab-{uuid.uuid4().hex[:8]}"
    assert (await api_client.post("/v1/organizations", headers=headers, json={"slug": slug, "name": "Lab"})).status_code == 201
    base = f"/v1/organizations/{slug}"
    added = await api_client.put(
        f"{base}/members/{viewer['id']}", headers=headers, json={"user_id": viewer["id"], "role": "VIEWER"}
    )
    assert added.status_code == 200, added.text
    project = await api_client.post(
        f"{base}/projects", headers=headers, json={"slug": "routing", "name": "Routing", "visibility": "private"}
    )
    assert project.status_code == 201, project.text
    await api_client.post(f"{base}/projects/routing/cases", headers=headers, json={"slug": "checkout", "name": "Checkout"})
    package = load_package(EXAMPLE)
    snapshot = await api_client.post(
        "/v1/instances", headers={**headers, "Content-Type": "application/vnd.bim+zip"}, content=package.to_zip()
    )
    revision = await api_client.post(
        f"{base}/projects/routing/cases/checkout/revisions", headers=headers,
        json={"document": package.instance(), "source_snapshot_id": snapshot.json()["id"]},
    )
    assert revision.status_code == 201, revision.text
    reference = engine_ref(routes._manifest("random-search"), "bim.builtin")
    study = await api_client.post(
        f"{base}/projects/routing/studies", headers=headers,
        json={
            "slug": "compare", "name": "Compare",
            "definition": {
                "case_revision_ids": [revision.json()["id"]],
                "engines": [{**reference, "mode": "seeded", "optimization": dict(OPTIMIZATION)}],
                "parameter_sets": [{}], "seeds": [1],
            },
        },
    )
    assert study.status_code == 201, study.text
    yield {
        "url": f"{base}/projects/routing/studies/compare", "id": study.json()["id"],
        "headers": headers, "viewer": viewer_headers, "outsider": outsider,
    }
    space_client.set_gate(previous)


async def first_tag(client, lab) -> str:
    """No GET exists: an unguarded PATCH that changes nothing reports the current ETag."""
    response = await client.patch(lab["url"], headers=lab["headers"], json={})
    assert response.status_code == 200, response.text
    return response.headers["ETag"]


async def updated_events(db_session) -> int:
    return await db_session.scalar(select(func.count()).select_from(AuditEvent).where(AuditEvent.action == "study.updated"))


async def all_events(db_session) -> int:
    return await db_session.scalar(select(func.count()).select_from(AuditEvent))


async def stored_study(db_session, lab) -> Study:
    stored = await db_session.get(Study, uuid.UUID(lab["id"]))
    await db_session.refresh(stored)
    return stored


async def moved_on(client, lab) -> str:
    """A tag that is stale: the one held before an edit that really changes the study."""
    tag = await first_tag(client, lab)
    edited = await client.patch(
        lab["url"], headers=lab["headers"], json={"description": f"Moved {uuid.uuid4().hex[:8]}"}
    )
    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != tag
    return tag


# [utest->req~gateway-api-optimistic-concurrency-etag-on-write~1]
# [utest->req~gateway-api-optimistic-concurrency-revision-bump~1]
async def test_patch_with_the_current_etag_succeeds_and_returns_a_new_one(api_client, lab) -> None:
    tag = await first_tag(api_client, lab)

    edited = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": tag}, json={"description": "Edited"})

    assert edited.status_code == 200, edited.text
    assert edited.json()["description"] == "Edited"
    assert edited.headers["ETag"] not in ("", tag)


# [utest->req~gateway-api-optimistic-concurrency-precondition-failed~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed-etag~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed-unchanged~1]
async def test_replaying_the_old_etag_is_412_with_the_current_one(api_client, lab, db_session) -> None:
    old = await first_tag(api_client, lab)
    first = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": old}, json={"name": "Winner"})
    assert first.status_code == 200, first.text
    events = await updated_events(db_session)

    second = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": old}, json={"name": "Lost update"})

    assert second.status_code == 412, second.text
    assert second.json()["detail"]["code"] == "precondition_failed"
    # The 200 ETag of the PATCH is the one a later 412 reports for the same revision.
    assert second.headers["ETag"] == first.headers["ETag"]
    assert await updated_events(db_session) == events
    stored = await db_session.get(Study, uuid.UUID(lab["id"]))
    await db_session.refresh(stored)
    assert stored.name == "Winner"


# [utest->req~gateway-api-optimistic-concurrency-if-match-absent~1]
async def test_without_if_match_the_edit_still_succeeds(api_client, lab) -> None:
    edited = await api_client.patch(lab["url"], headers=lab["headers"], json={"description": "Edited"})

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"]
    again = await api_client.patch(lab["url"], headers=lab["headers"], json={})
    assert again.headers["ETag"] == edited.headers["ETag"]


# [utest->req~gateway-api-optimistic-concurrency-if-match-any~1]
async def test_wildcard_matches_any_existing_study(api_client, lab) -> None:
    edited = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": "*"}, json={"description": "Edited"})

    assert edited.status_code == 200, edited.text


# [utest->req~gateway-api-optimistic-concurrency-if-match-weak~1]
async def test_weak_tag_never_matches(api_client, lab) -> None:
    tag = await first_tag(api_client, lab)

    refused = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": f"W/{tag}"}, json={"name": "Weak"})

    assert refused.status_code == 412, refused.text
    assert refused.headers["ETag"] == tag


# [utest->req~gateway-api-optimistic-concurrency-invalid-if-match~1]
async def test_malformed_if_match_is_400(api_client, lab) -> None:
    refused = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": "not a tag"}, json={"name": "X"})

    assert refused.status_code == 400, refused.text
    assert refused.json()["detail"]["code"] == "invalid_if_match"


# [utest->req~gateway-api-optimistic-concurrency-order-access~1]
@pytest.mark.parametrize("who", ["viewer", "outsider"])
async def test_viewer_and_outsider_get_403_not_412(api_client, lab, who) -> None:
    refused = await api_client.patch(
        lab["url"], headers={**lab[who], "If-Match": '"stale"'}, json={"name": "Nope"}
    )

    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"]["code"] == "organization_forbidden"
    assert "ETag" not in refused.headers


# [utest->req~gateway-api-optimistic-concurrency-order-access~1]
async def test_unknown_study_is_404_not_412(api_client, lab) -> None:
    url = lab["url"][: lab["url"].rindex("/")] + "/missing"

    refused = await api_client.patch(url, headers={**lab["headers"], "If-Match": '"stale"'}, json={"name": "X"})

    assert refused.status_code == 404, refused.text


# [utest->req~gateway-api-optimistic-concurrency-order-access~1]
# [utest->req~gateway-api-optimistic-concurrency-invalid-if-match~1]
async def test_a_malformed_if_match_on_an_unknown_study_is_404(api_client, lab) -> None:
    url = lab["url"][: lab["url"].rindex("/")] + "/missing"

    refused = await api_client.patch(url, headers={**lab["headers"], "If-Match": "not a tag"}, json={"name": "X"})

    assert refused.status_code == 404, refused.text
    assert refused.json()["detail"]["code"] == "not_found"
    assert "ETag" not in refused.headers


# [utest->req~gateway-api-optimistic-concurrency-order-state~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed~1]
async def test_stale_tag_beats_foreign_study_version(api_client, lab) -> None:
    stale = await first_tag(api_client, lab)
    moved = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": stale}, json={"name": "Moved on"})
    assert moved.status_code == 200, moved.text
    body = {"definition_version_id": str(uuid.uuid4())}

    refused = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": stale}, json=body)
    current = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": moved.headers["ETag"]}, json=body)

    assert refused.status_code == 412, refused.text
    assert current.status_code == 422, current.text
    assert current.json()["code"] == "foreign_study_version"


# [utest->req~gateway-api-optimistic-concurrency-order-state~1]
async def test_a_body_that_fails_validation_is_refused_before_a_stale_tag(api_client, lab) -> None:
    refused = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": '"stale"'}, json={"name": 5})

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "validation_error"
    assert "ETag" not in refused.headers


# [utest->req~gateway-api-optimistic-concurrency-atomic~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed-etag~1]
async def test_a_writer_that_commits_between_read_and_write_loses(api_client, lab, db_session, monkeypatch) -> None:
    """The guarded UPDATE, not the earlier comparison, is what refuses the second writer."""
    tag = await first_tag(api_client, lab)
    original_execute = db_session.execute
    landed: list[bool] = []

    async def execute(statement, *args, **kwargs):
        # The other writer commits after the comparison has passed and before the claim.
        if getattr(statement, "is_update", False) and not landed:
            landed.append(True)
            await original_execute(
                update(Study)
                .where(Study.id == uuid.UUID(lab["id"]))
                .values(updated_at=utcnow() + timedelta(days=1))
                .execution_options(synchronize_session=False)
            )
        return await original_execute(statement, *args, **kwargs)

    monkeypatch.setattr(db_session, "execute", execute)
    loser = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": tag}, json={"name": "Loser"})
    monkeypatch.setattr(db_session, "execute", original_execute)

    assert landed
    assert loser.status_code == 412, loser.text
    assert loser.json()["detail"]["code"] == "precondition_failed"
    assert loser.headers["ETag"] != tag
    stored = await db_session.get(Study, uuid.UUID(lab["id"]))
    await db_session.refresh(stored)
    assert stored.name != "Loser"


# [utest->req~gateway-api-optimistic-concurrency-precondition-failed~1]
# [utest->req~gateway-api-optimistic-concurrency-precondition-failed-etag~1]
async def test_the_412_document_is_complete(api_client, lab) -> None:
    stale = await moved_on(api_client, lab)

    refused = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": stale}, json={"name": "X"})
    current = await first_tag(api_client, lab)

    assert refused.status_code == 412, refused.text
    assert refused.headers["content-type"].split(";")[0] == "application/json"
    body = refused.json()
    assert body["status"] == 412
    assert body["code"] == "precondition_failed"
    assert body["title"] == "precondition_failed"
    assert body["detail"]["code"] == "precondition_failed"
    assert body["detail"]["error"]
    assert refused.headers["ETag"] == current


# [utest->req~gateway-api-optimistic-concurrency-precondition-failed-unchanged~1]
# [utest->req~gateway-api-optimistic-concurrency-invalid-if-match~1]
@pytest.mark.parametrize("header", ['"stale"', "not a tag"], ids=["412", "400"])
async def test_a_refused_precondition_changes_nothing(api_client, lab, db_session, header) -> None:
    tag = await first_tag(api_client, lab)
    before = await stored_study(db_session, lab)
    name, description, archived = before.name, before.description, before.archived
    events = await all_events(db_session)

    refused = await api_client.patch(
        lab["url"], headers={**lab["headers"], "If-Match": header},
        json={"name": "Refused", "description": "Refused", "archived": True},
    )

    assert refused.status_code == (412 if header == '"stale"' else 400), refused.text
    after = await stored_study(db_session, lab)
    assert (after.name, after.description, after.archived) == (name, description, archived)
    assert await all_events(db_session) == events
    assert await first_tag(api_client, lab) == tag


# [utest->req~gateway-api-optimistic-concurrency-if-match-list~1]
@pytest.mark.parametrize("form", ['"stale", {tag}', '"stale" ,{tag} ', ", {tag},"], ids=["list", "spaces", "empty-elements"])
async def test_a_list_naming_the_current_tag_is_accepted(api_client, lab, form) -> None:
    tag = await first_tag(api_client, lab)

    edited = await api_client.patch(
        lab["url"], headers={**lab["headers"], "If-Match": form.format(tag=tag)}, json={"description": "Edited"}
    )

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != tag


# [utest->req~gateway-api-optimistic-concurrency-if-match-any~1]
# [utest->req~gateway-api-optimistic-concurrency-revision-bump~1]
async def test_a_wildcard_edit_changes_the_stored_value_and_the_etag(api_client, lab, db_session) -> None:
    tag = await first_tag(api_client, lab)

    edited = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": "*"}, json={"description": "Edited"})

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != tag
    assert (await stored_study(db_session, lab)).description == "Edited"
    assert await first_tag(api_client, lab) == edited.headers["ETag"]


# [utest->req~gateway-api-optimistic-concurrency-if-match-absent~1]
async def test_without_if_match_twice_both_edits_apply_and_the_second_stays(api_client, lab, db_session) -> None:
    first = await api_client.patch(lab["url"], headers=lab["headers"], json={"description": "One"})
    second = await api_client.patch(lab["url"], headers=lab["headers"], json={"description": "Two"})

    assert first.status_code == second.status_code == 200
    assert second.headers["ETag"] != first.headers["ETag"]
    assert (await stored_study(db_session, lab)).description == "Two"


# [utest->req~gateway-api-optimistic-concurrency-order-state~1]
async def test_a_refusal_after_the_claim_leaves_the_etag_unchanged(api_client, lab, db_session) -> None:
    """The shared test session never rolls back on an error, so the request-scoped rollback is done by hand.

    What this pins is that the claim does not commit by itself: the bump is only ever visible through the
    transaction of the refused request, and it is gone with that transaction.
    """
    await db_session.commit()
    current = await first_tag(api_client, lab)
    await db_session.commit()

    refused = await api_client.patch(
        lab["url"], headers={**lab["headers"], "If-Match": current}, json={"definition_version_id": str(uuid.uuid4())}
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "foreign_study_version"
    assert await first_tag(api_client, lab) != current  # the claim did happen
    await db_session.rollback()
    assert await first_tag(api_client, lab) == current


# [utest->req~gateway-api-optimistic-concurrency-openapi~1]
def test_openapi_documents_if_match_and_both_failures() -> None:
    from openbinding_gateway.main import app

    patch = app.openapi()["paths"]["/v1/organizations/{org}/projects/{project}/studies/{study}"]["patch"]
    assert patch["operationId"] == "updateStudy"
    header = [p for p in patch["parameters"] if p["name"] == "If-Match"]
    assert len(header) == 1 and header[0]["in"] == "header" and header[0]["required"] is False
    assert {"400", "412"} <= set(patch["responses"])
    assert "ETag" in patch["responses"]["200"]["headers"]
    assert "ETag" in patch["responses"]["412"]["headers"]
    assert "content" in patch["responses"]["200"]  # the response model survives the merge

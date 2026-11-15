"""ETag / If-Match / 412 on updateComposition; the tag comes from getComposition, createComposition or the PATCH.

Authorisation comes before the precondition: a viewer gets 403 and a non-member 404 (an unreadable
composition answers as a missing one), never a 412 that would reveal the resource's revision.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
import pytest_asyncio
from sqlalchemy import func, select, update

from _b1_helpers import make_account, put_member, gate  # noqa: F401,F811
from _problem_helpers import make_org
from openbinding_gateway.db.models import AuditEvent, Composition, utcnow


@pytest_asyncio.fixture
async def lab(api_client, registration, db_session, gate):  # noqa: F811
    """An organization with one composition, owned by one account, plus a viewer and an outsider."""
    _, headers = await make_account(api_client, registration, db_session, gate)
    viewer, viewer_headers = await make_account(api_client, registration, db_session, gate)
    _, outsider_headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)
    assert (await put_member(api_client, headers, org, viewer["id"], "VIEWER")).status_code == 200
    created = await api_client.post(
        f"/v1/organizations/{org}/compositions", headers=headers, json={"slug": "checkout", "name": "Checkout"},
    )
    assert created.status_code == 201, created.text
    return {
        "url": f"/v1/organizations/{org}/compositions/checkout", "id": created.json()["id"],
        "created_tag": created.headers["ETag"],
        "headers": headers, "viewer": viewer_headers, "outsider": outsider_headers,
    }


async def first_tag(client, lab) -> str:
    """The ETag getComposition reports; an unguarded PATCH that changes nothing reports the same one."""
    response = await client.get(lab["url"], headers=lab["headers"])
    assert response.status_code == 200, response.text
    unchanged = await client.patch(lab["url"], headers=lab["headers"], json={})
    assert unchanged.headers["ETag"] == response.headers["ETag"]
    return response.headers["ETag"]


async def stored(db_session, lab) -> Composition:
    row = await db_session.get(Composition, uuid.UUID(lab["id"]))
    await db_session.refresh(row)
    return row


async def updated_events(db_session) -> int:
    return await db_session.scalar(
        select(func.count()).select_from(AuditEvent).where(AuditEvent.action == "composition.updated")
    )


async def test_the_tag_of_the_create_is_the_tag_of_the_read(api_client, lab) -> None:
    assert await first_tag(api_client, lab) == lab["created_tag"]


async def test_patch_with_the_current_etag_succeeds_and_returns_a_new_one(api_client, lab) -> None:
    tag = await first_tag(api_client, lab)

    edited = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": tag}, json={"description": "Edited"})

    assert edited.status_code == 200, edited.text
    assert edited.json()["description"] == "Edited"
    assert edited.headers["ETag"] not in ("", tag)
    assert await first_tag(api_client, lab) == edited.headers["ETag"]


async def test_replaying_the_old_etag_is_412_with_the_current_one(api_client, lab, db_session) -> None:
    old = await first_tag(api_client, lab)
    first = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": old}, json={"name": "Winner"})
    assert first.status_code == 200, first.text
    events = await updated_events(db_session)

    second = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": old}, json={"name": "Lost update"})

    assert second.status_code == 412, second.text
    assert second.json()["detail"]["code"] == "precondition_failed"
    assert second.headers["ETag"] == first.headers["ETag"]
    assert await updated_events(db_session) == events
    assert (await stored(db_session, lab)).name == "Winner"


async def test_without_if_match_the_edit_still_succeeds(api_client, lab) -> None:
    edited = await api_client.patch(lab["url"], headers=lab["headers"], json={"archived": True})

    assert edited.status_code == 200, edited.text
    assert edited.json()["archived"] is True
    assert edited.headers["ETag"]


async def test_wildcard_matches_and_a_weak_tag_never_does(api_client, lab) -> None:
    tag = await first_tag(api_client, lab)

    weak = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": f"W/{tag}"}, json={"name": "Weak"})
    wildcard = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": "*"}, json={"name": "Any"})

    assert weak.status_code == 412, weak.text
    assert weak.headers["ETag"] == tag
    assert wildcard.status_code == 200, wildcard.text
    assert wildcard.headers["ETag"] != tag


async def test_malformed_if_match_is_400(api_client, lab) -> None:
    refused = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": "not a tag"}, json={"name": "X"})

    assert refused.status_code == 400, refused.text
    assert refused.json()["detail"]["code"] == "invalid_if_match"


async def test_a_viewer_gets_403_and_an_outsider_404_never_412(api_client, lab) -> None:
    viewer = await api_client.patch(lab["url"], headers={**lab["viewer"], "If-Match": '"stale"'}, json={"name": "Nope"})
    outsider = await api_client.patch(lab["url"], headers={**lab["outsider"], "If-Match": '"stale"'}, json={"name": "Nope"})

    assert viewer.status_code == 403, viewer.text
    assert viewer.json()["detail"]["code"] == "organization_forbidden"
    assert outsider.status_code == 404, outsider.text
    assert outsider.json()["detail"]["code"] == "not_found"
    assert "ETag" not in viewer.headers and "ETag" not in outsider.headers


async def test_an_unknown_composition_is_404_even_with_a_malformed_if_match(api_client, lab) -> None:
    url = lab["url"][: lab["url"].rindex("/")] + "/missing"

    stale = await api_client.patch(url, headers={**lab["headers"], "If-Match": '"stale"'}, json={"name": "X"})
    malformed = await api_client.patch(url, headers={**lab["headers"], "If-Match": "not a tag"}, json={"name": "X"})

    assert stale.status_code == malformed.status_code == 404
    assert "ETag" not in malformed.headers


async def test_a_body_that_fails_validation_is_refused_before_a_stale_tag(api_client, lab) -> None:
    refused = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": '"stale"'}, json={"name": 5})

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "validation_error"
    assert "ETag" not in refused.headers


@pytest.mark.parametrize("header", ['"stale"', "not a tag"], ids=["412", "400"])
async def test_a_refused_precondition_changes_nothing(api_client, lab, db_session, header) -> None:
    tag = await first_tag(api_client, lab)
    before = await stored(db_session, lab)
    name, description, archived = before.name, before.description, before.archived
    events = await db_session.scalar(select(func.count()).select_from(AuditEvent))

    refused = await api_client.patch(
        lab["url"], headers={**lab["headers"], "If-Match": header},
        json={"name": "Refused", "description": "Refused", "archived": True},
    )

    assert refused.status_code == (412 if header == '"stale"' else 400), refused.text
    after = await stored(db_session, lab)
    assert (after.name, after.description, after.archived) == (name, description, archived)
    assert await db_session.scalar(select(func.count()).select_from(AuditEvent)) == events
    assert await first_tag(api_client, lab) == tag


async def test_a_writer_that_commits_between_read_and_write_loses(api_client, lab, db_session, monkeypatch) -> None:
    """The guarded UPDATE, not the earlier comparison, is what refuses the second writer."""
    tag = await first_tag(api_client, lab)
    original_execute = db_session.execute
    landed: list[bool] = []

    async def execute(statement, *args, **kwargs):
        if getattr(statement, "is_update", False) and not landed:
            landed.append(True)
            await original_execute(
                update(Composition)
                .where(Composition.id == uuid.UUID(lab["id"]))
                .values(updated_at=utcnow() + timedelta(days=1))
                .execution_options(synchronize_session=False)
            )
        return await original_execute(statement, *args, **kwargs)

    monkeypatch.setattr(db_session, "execute", execute)
    loser = await api_client.patch(lab["url"], headers={**lab["headers"], "If-Match": tag}, json={"name": "Loser"})
    monkeypatch.setattr(db_session, "execute", original_execute)

    assert landed
    assert loser.status_code == 412, loser.text
    assert loser.headers["ETag"] != tag
    assert (await stored(db_session, lab)).name != "Loser"


def test_openapi_documents_if_match_and_both_failures() -> None:
    from openbinding_gateway.main import app

    patch = app.openapi()["paths"]["/v1/organizations/{org}/compositions/{composition}"]["patch"]
    assert patch["operationId"] == "updateComposition"
    header = [p for p in patch["parameters"] if p["name"] == "If-Match"]
    assert len(header) == 1 and header[0]["in"] == "header" and header[0]["required"] is False
    assert {"400", "412"} <= set(patch["responses"])
    assert "ETag" in patch["responses"]["200"]["headers"]
    assert "ETag" in patch["responses"]["412"]["headers"]
    assert "content" in patch["responses"]["200"]

"""ETag / If-Match / 412 on updateOwnProfile and updateNotificationPreferences (one shared revision)."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
import pytest_asyncio
from sqlalchemy import update

from openbinding_gateway.db.models import User, utcnow
from test_collaboration_platform import account

PROFILE = "/v1/users/me"
PREFERENCES = "/v1/notifications/preferences"
NEW_PASSWORD = "a-brand-new-passphrase"


@pytest_asyncio.fixture
async def holder(api_client, registration):
    details = registration()
    user, headers = await account(api_client, registration, **details)
    return {"details": details, "id": user["id"], "headers": headers}


async def tag_of(client, url, headers) -> str:
    response = await client.get(url, headers=headers)
    assert response.status_code == 200, response.text
    return response.headers["ETag"]


async def edit_profile(client, holder, tag=None, **fields):
    headers = dict(holder["headers"])
    if tag is not None:
        headers["If-Match"] = tag
    body = {"current_password": holder["details"]["password"], **fields}
    return await client.patch(PROFILE, headers=headers, json=body)


async def edit_preferences(client, holder, tag=None, **fields):
    headers = dict(holder["headers"])
    if tag is not None:
        headers["If-Match"] = tag
    return await client.put(PREFERENCES, headers=headers, json={"inbox": False, **fields})


async def login_status(client, identifier, password) -> int:
    return (
        await client.post("/v1/auth/login", json={"username_or_email": identifier, "password": password})
    ).status_code


async def test_both_gets_carry_the_same_strong_etag(api_client, holder) -> None:
    profile = await tag_of(api_client, PROFILE, holder["headers"])
    preferences = await tag_of(api_client, PREFERENCES, holder["headers"])

    assert profile.startswith('"') and not profile.startswith("W/")
    assert profile == preferences


async def test_profile_edit_with_the_current_tag_returns_the_new_one(api_client, holder) -> None:
    tag = await tag_of(api_client, PROFILE, holder["headers"])

    edited = await edit_profile(api_client, holder, tag, new_password=NEW_PASSWORD)

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != tag
    assert edited.headers["ETag"] == await tag_of(api_client, PROFILE, holder["headers"])
    assert edited.headers["ETag"] == await tag_of(api_client, PREFERENCES, holder["headers"])


async def test_email_edit_returns_the_tag_a_following_get_reports(api_client, holder) -> None:
    tag = await tag_of(api_client, PROFILE, holder["headers"])

    edited = await edit_profile(api_client, holder, tag, email=f"new{uuid.uuid4().hex[:8]}@example.org")

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != tag
    assert edited.headers["ETag"] == await tag_of(api_client, PROFILE, holder["headers"])


async def test_preferences_put_with_the_current_tag_returns_the_new_one(api_client, holder) -> None:
    tag = await tag_of(api_client, PREFERENCES, holder["headers"])

    edited = await edit_preferences(api_client, holder, tag)

    assert edited.status_code == 200, edited.text
    assert edited.headers["ETag"] != tag
    assert edited.headers["ETag"] == await tag_of(api_client, PREFERENCES, holder["headers"])
    assert edited.headers["ETag"] == await tag_of(api_client, PROFILE, holder["headers"])


async def test_replaying_an_old_profile_tag_is_412_and_changes_nothing(api_client, holder) -> None:
    old = await tag_of(api_client, PROFILE, holder["headers"])
    first = await edit_profile(api_client, holder, old, new_password=NEW_PASSWORD)
    assert first.status_code == 200, first.text
    current = first.headers["ETag"]
    lost = f"lost{uuid.uuid4().hex[:8]}@example.org"

    second = await api_client.patch(
        PROFILE,
        headers={**holder["headers"], "If-Match": old},
        json={"current_password": NEW_PASSWORD, "email": lost},
    )

    assert second.status_code == 412, second.text
    assert second.json()["detail"]["code"] == "precondition_failed"
    assert second.headers["ETag"] == current
    assert await tag_of(api_client, PROFILE, holder["headers"]) == current
    assert (await api_client.get(PROFILE, headers=holder["headers"])).json()["email"] != lost
    assert await login_status(api_client, lost, NEW_PASSWORD) == 401
    assert await login_status(api_client, holder["details"]["email"], NEW_PASSWORD) == 200


async def test_replaying_an_old_preferences_tag_is_412_and_changes_nothing(api_client, holder) -> None:
    old = await tag_of(api_client, PREFERENCES, holder["headers"])
    first = await edit_preferences(api_client, holder, old)
    assert first.status_code == 200, first.text

    second = await edit_preferences(api_client, holder, old, inbox=True, email_job_failures=True)

    assert second.status_code == 412, second.text
    assert second.json()["detail"]["code"] == "precondition_failed"
    assert second.headers["ETag"] == first.headers["ETag"]
    stored = (await api_client.get(PREFERENCES, headers=holder["headers"])).json()
    assert stored["inbox"] is False and stored["email_job_failures"] is False


async def test_without_if_match_both_edits_still_succeed(api_client, holder) -> None:
    profile = await edit_profile(api_client, holder, new_password=NEW_PASSWORD)
    preferences = await edit_preferences(api_client, holder)

    assert profile.status_code == 200, profile.text
    assert preferences.status_code == 200, preferences.text
    assert preferences.headers["ETag"] == await tag_of(api_client, PROFILE, holder["headers"])


async def test_wildcard_matches(api_client, holder) -> None:
    profile = await edit_profile(api_client, holder, "*", new_password=NEW_PASSWORD)
    preferences = await edit_preferences(api_client, holder, "*")

    assert profile.status_code == 200, profile.text
    assert preferences.status_code == 200, preferences.text


async def test_weak_tag_never_matches(api_client, holder) -> None:
    tag = await tag_of(api_client, PROFILE, holder["headers"])

    profile = await edit_profile(api_client, holder, f"W/{tag}", new_password=NEW_PASSWORD)
    preferences = await edit_preferences(api_client, holder, f"W/{tag}")

    assert profile.status_code == preferences.status_code == 412
    assert profile.headers["ETag"] == preferences.headers["ETag"] == tag


async def test_malformed_if_match_is_400(api_client, holder) -> None:
    profile = await edit_profile(api_client, holder, "not a tag", new_password=NEW_PASSWORD)
    preferences = await edit_preferences(api_client, holder, "not a tag")

    for refused in (profile, preferences):
        assert refused.status_code == 400, refused.text
        assert refused.json()["detail"]["code"] == "invalid_if_match"


async def test_no_credentials_is_401_not_412_or_400(api_client) -> None:
    for tag in ('"stale"', "not a tag"):
        profile = await api_client.patch(
            PROFILE, headers={"If-Match": tag}, json={"current_password": "x", "new_password": NEW_PASSWORD}
        )
        preferences = await api_client.put(PREFERENCES, headers={"If-Match": tag}, json={"inbox": False})

        assert profile.status_code == preferences.status_code == 401
        assert "ETag" not in profile.headers and "ETag" not in preferences.headers


async def test_wrong_current_password_is_401_before_a_stale_tag(api_client, holder) -> None:
    refused = await api_client.patch(
        PROFILE,
        headers={**holder["headers"], "If-Match": '"stale"'},
        json={"current_password": "not-the-password", "new_password": NEW_PASSWORD},
    )

    assert refused.status_code == 401, refused.text
    assert refused.json()["detail"]["code"] == "invalid_credentials"


async def test_stale_tag_beats_already_registered_and_weak_password(api_client, holder, registration) -> None:
    other, _ = await account(api_client, registration)
    tag = await tag_of(api_client, PROFILE, holder["headers"])
    assert (await edit_preferences(api_client, holder)).status_code == 200  # makes the tag stale

    taken = await edit_profile(api_client, holder, tag, email=other["email"])
    weak = await edit_profile(api_client, holder, tag, new_password="short")
    current = await tag_of(api_client, PROFILE, holder["headers"])
    taken_now = await edit_profile(api_client, holder, current, email=other["email"])
    # The test session is shared, so the claim of the refused 409 edit is not rolled back: read again.
    current = await tag_of(api_client, PROFILE, holder["headers"])
    weak_now = await edit_profile(api_client, holder, current, new_password="short")

    assert taken.status_code == weak.status_code == 412
    assert taken_now.status_code == 409, taken_now.text
    assert weak_now.status_code == 422, weak_now.text


async def test_the_revision_is_shared_between_profile_and_preferences(api_client, holder) -> None:
    profile_tag = await tag_of(api_client, PROFILE, holder["headers"])
    assert (await edit_preferences(api_client, holder, profile_tag)).status_code == 200

    stale_profile = await edit_profile(api_client, holder, profile_tag, new_password=NEW_PASSWORD)
    assert stale_profile.status_code == 412, stale_profile.text

    preferences_tag = await tag_of(api_client, PREFERENCES, holder["headers"])
    assert (await edit_profile(api_client, holder, preferences_tag, new_password=NEW_PASSWORD)).status_code == 200
    stale_preferences = await edit_preferences(api_client, holder, preferences_tag)
    assert stale_preferences.status_code == 412, stale_preferences.text


async def test_an_empty_profile_patch_keeps_the_etag(api_client, holder) -> None:
    tag = await tag_of(api_client, PROFILE, holder["headers"])

    plain = await api_client.patch(PROFILE, headers=holder["headers"], json={})
    matching = await api_client.patch(PROFILE, headers={**holder["headers"], "If-Match": tag}, json={})

    assert plain.status_code == matching.status_code == 200
    assert plain.headers["ETag"] == matching.headers["ETag"] == tag
    assert await tag_of(api_client, PROFILE, holder["headers"]) == tag


async def test_an_empty_profile_patch_with_a_stale_or_bad_tag_is_refused(api_client, holder) -> None:
    tag = await tag_of(api_client, PROFILE, holder["headers"])
    assert (await edit_preferences(api_client, holder)).status_code == 200
    current = await tag_of(api_client, PROFILE, holder["headers"])

    stale = await api_client.patch(PROFILE, headers={**holder["headers"], "If-Match": tag}, json={})
    bad = await api_client.patch(PROFILE, headers={**holder["headers"], "If-Match": "nope"}, json={})

    assert stale.status_code == 412, stale.text
    assert stale.headers["ETag"] == current
    assert bad.status_code == 400, bad.text
    assert await tag_of(api_client, PROFILE, holder["headers"]) == current


@pytest.mark.parametrize("target", ["profile", "preferences"])
async def test_a_writer_that_commits_between_read_and_write_loses(
    api_client, holder, db_session, monkeypatch, target
) -> None:
    """The guarded UPDATE, not the earlier comparison, is what refuses the second writer."""
    tag = await tag_of(api_client, PROFILE, holder["headers"])
    original_execute = db_session.execute
    landed: list[bool] = []

    async def execute(statement, *args, **kwargs):
        if getattr(statement, "is_update", False) and not landed:
            landed.append(True)
            await original_execute(
                update(User)
                .where(User.id == uuid.UUID(holder["id"]))
                .values(updated_at=utcnow() + timedelta(days=1))
                .execution_options(synchronize_session=False)
            )
        return await original_execute(statement, *args, **kwargs)

    monkeypatch.setattr(db_session, "execute", execute)
    if target == "profile":
        loser = await edit_profile(api_client, holder, tag, new_password=NEW_PASSWORD)
    else:
        loser = await edit_preferences(api_client, holder, tag)
    monkeypatch.setattr(db_session, "execute", original_execute)

    assert landed
    assert loser.status_code == 412, loser.text
    assert loser.json()["detail"]["code"] == "precondition_failed"
    assert loser.headers["ETag"] != tag
    assert loser.headers["ETag"] == await tag_of(api_client, PROFILE, holder["headers"])
    if target == "profile":
        assert await login_status(api_client, holder["details"]["username"], NEW_PASSWORD) == 401
    else:
        stored = (await api_client.get(PREFERENCES, headers=holder["headers"])).json()
        assert stored["inbox"] is True


def test_openapi_documents_if_match_etag_and_both_failures() -> None:
    from openbinding_gateway.main import app

    paths = app.openapi()["paths"]
    for path, method, operation in [
        (PROFILE, "patch", "updateOwnProfile"),
        (PREFERENCES, "put", "updateNotificationPreferences"),
    ]:
        edit = paths[path][method]
        assert edit["operationId"] == operation
        assert any(p["name"] == "If-Match" and p["in"] == "header" for p in edit["parameters"])
        assert {"400", "412"} <= set(edit["responses"])

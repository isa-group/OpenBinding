"""Registering, signing in, and what happens to a session afterwards.

These are the first tests in the suite that go over HTTP, because status codes
and refusals are the subject rather than an incidental detail of it.
"""

from __future__ import annotations

import pytest


async def register(client, details) -> dict:
    response = await client.post("/v1/auth/register", json=details)
    assert response.status_code == 201, response.text
    return response.json()


async def login(client, details) -> dict:
    response = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_a_new_account_starts_active_on_the_free_plan(api_client, registration):
    details = registration()

    profile = await register(api_client, details)

    assert profile["username"] == details["username"]
    assert profile["role"] == "user"
    assert profile["is_active"] is True
    assert profile["plan"] == "FREE"


async def test_registration_never_echoes_the_password(api_client, registration):
    details = registration()

    response = await api_client.post("/v1/auth/register", json=details)

    assert details["password"] not in response.text
    assert "password_hash" not in response.json()


async def test_the_email_is_stored_lower_cased(api_client, registration):
    details = registration(email="MiXeD.Case@Example.ORG")

    profile = await register(api_client, details)

    assert profile["email"] == "mixed.case@example.org"


@pytest.mark.parametrize("field", ["username", "email"])
async def test_a_taken_identifier_is_refused(api_client, registration, field):
    first = registration()
    await register(api_client, first)
    second = registration(**{field: first[field]})

    response = await api_client.post("/v1/auth/register", json=second)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "already_registered"


async def test_the_conflict_does_not_say_which_identifier_was_taken(api_client, registration):
    # Otherwise an unauthenticated caller can ask this endpoint whether a given
    # person has an account here.
    first = registration()
    await register(api_client, first)

    response = await api_client.post("/v1/auth/register", json=registration(email=first["email"]))

    message = response.json()["detail"]["error"].lower()
    assert "username" in message and "email" in message


async def test_a_short_password_is_refused(api_client, registration):
    response = await api_client.post("/v1/auth/register", json=registration(password="short"))

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "weak_password"


async def test_signing_in_returns_a_usable_pair(api_client, registration):
    details = registration()
    await register(api_client, details)

    tokens = await login(api_client, details)

    assert tokens["token_type"] == "bearer"
    assert tokens["expires_in"] > 0
    assert tokens["access_token"] and tokens["refresh_token"]
    assert tokens["access_token"] != tokens["refresh_token"]


async def test_signing_in_by_email_works_too(api_client, registration):
    details = registration()
    await register(api_client, details)

    response = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["email"].upper(), "password": details["password"]},
    )

    assert response.status_code == 200


async def test_a_wrong_password_is_refused(api_client, registration):
    details = registration()
    await register(api_client, details)

    response = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": "not-the-password"},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "invalid_credentials"


async def test_an_unknown_account_is_refused_the_same_way(api_client):
    # Same code and same message as a wrong password: this endpoint does not
    # report whether an account exists.
    response = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": "nobody-at-all", "password": "not-the-password"},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "invalid_credentials"


async def test_the_access_token_identifies_its_holder(api_client, registration):
    details = registration()
    profile = await register(api_client, details)
    tokens = await login(api_client, details)

    response = await api_client.get(
        "/v1/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
    )

    assert response.status_code == 200
    assert response.json()["id"] == profile["id"]


async def test_the_profile_needs_a_credential(api_client):
    response = await api_client.get("/v1/users/me")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "unauthorized"
    assert "bearer" in response.headers.get("www-authenticate", "").lower()


async def test_a_refresh_token_is_not_an_access_token(api_client, registration):
    # The long-lived token must not open the doors the short-lived one opens,
    # which is the entire reason they are separate kinds.
    details = registration()
    await register(api_client, details)
    tokens = await login(api_client, details)

    response = await api_client.get(
        "/v1/users/me", headers={"Authorization": f"Bearer {tokens['refresh_token']}"}
    )

    assert response.status_code == 401


async def test_refreshing_returns_a_new_pair(api_client, registration):
    details = registration()
    await register(api_client, details)
    tokens = await login(api_client, details)

    response = await api_client.post(
        "/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )

    assert response.status_code == 200
    assert response.json()["refresh_token"] != tokens["refresh_token"]


async def test_a_refresh_token_cannot_be_used_twice(api_client, registration):
    # Rotation is what makes a stolen refresh token survivable: whoever uses it
    # second is locked out and has to sign in again.
    details = registration()
    await register(api_client, details)
    tokens = await login(api_client, details)
    await api_client.post("/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})

    response = await api_client.post(
        "/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "invalid_token"


async def test_a_made_up_refresh_token_is_refused(api_client):
    response = await api_client.post("/v1/auth/refresh", json={"refresh_token": "not.a.token"})

    assert response.status_code == 401


async def test_signing_out_ends_the_session(api_client, registration):
    details = registration()
    await register(api_client, details)
    tokens = await login(api_client, details)

    logout = await api_client.post(
        "/v1/auth/logout", json={"refresh_token": tokens["refresh_token"]}
    )
    reuse = await api_client.post(
        "/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )

    assert logout.status_code == 204
    assert reuse.status_code == 401


async def test_signing_out_with_rubbish_still_answers_the_same(api_client):
    # Otherwise logging out becomes a way to ask whether a token was real.
    response = await api_client.post("/v1/auth/logout", json={"refresh_token": "not.a.token"})

    assert response.status_code == 204


async def test_a_deactivated_account_stops_being_able_to_call(api_client, registration, db_session):
    from sqlalchemy import select

    from openbinding_gateway.db.models import User

    details = registration()
    await register(api_client, details)
    tokens = await login(api_client, details)

    user = (
        await db_session.execute(select(User).where(User.username == details["username"]))
    ).scalars().one()
    user.is_active = False
    await db_session.flush()

    response = await api_client.get(
        "/v1/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
    )

    # The token is still perfectly valid and unexpired; the account is not.
    assert response.status_code == 401


async def test_changing_the_password_requires_the_current_one(api_client, registration):
    details = registration()
    await register(api_client, details)
    tokens = await login(api_client, details)
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    response = await api_client.patch(
        "/v1/users/me", headers=headers, json={"new_password": "a-brand-new-passphrase"}
    )

    assert response.status_code == 401


async def test_the_password_can_be_changed_and_the_new_one_works(api_client, registration):
    details = registration()
    await register(api_client, details)
    tokens = await login(api_client, details)
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    changed = await api_client.patch(
        "/v1/users/me",
        headers=headers,
        json={"current_password": details["password"], "new_password": "a-brand-new-passphrase"},
    )
    signed_in = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": "a-brand-new-passphrase"},
    )

    assert changed.status_code == 200
    assert signed_in.status_code == 200

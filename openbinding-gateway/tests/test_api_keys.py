"""API keys: minting, using, and taking back.

The point of these is that the API channel and the web channel end up at the
same account. Most of what is asserted here is about the secret never coming
back out, and about a key being usable exactly where a session token is.
"""

from __future__ import annotations

import pytest

from openbinding_gateway.security import apikeys


async def account(client, registration) -> tuple[dict, str]:
    """A registered account and a session token for it."""
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text

    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), tokens.json()["access_token"]


async def mint_key(client, token, name="a key") -> dict:
    response = await client.post(
        "/v1/users/me/api-keys",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_a_minted_key_carries_its_own_prefix():
    minted = apikeys.mint()

    assert minted.secret.startswith(minted.prefix + "_")
    assert apikeys.prefix_of(minted.secret) == minted.prefix
    assert apikeys.looks_like_api_key(minted.secret)


def test_the_stored_hash_is_not_the_key():
    minted = apikeys.mint()

    assert minted.secret_hash != minted.secret
    assert minted.secret not in minted.secret_hash
    assert apikeys.matches(minted.secret, minted.secret_hash)


def test_two_keys_are_never_the_same():
    assert apikeys.mint().secret != apikeys.mint().secret


@pytest.mark.parametrize("credential", ["", "obk_", "obk_abc", "not-a-key", "eyJhbGciOi.x.y"])
def test_things_that_are_not_keys_are_not_mistaken_for_them(credential):
    assert apikeys.prefix_of(credential) is None


def test_a_session_token_is_not_mistaken_for_a_key():
    # Both arrive in the same header, so this is what keeps the gateway from
    # trying to look a JWT up in the key table.
    assert not apikeys.looks_like_api_key("eyJhbGciOiJIUzI1NiJ9.payload.signature")


async def test_the_secret_is_returned_once_and_never_again(api_client, registration):
    _, token = await account(api_client, registration)
    headers = {"Authorization": f"Bearer {token}"}

    created = await mint_key(api_client, token)
    listed = await api_client.get("/v1/users/me/api-keys", headers=headers)

    assert created["secret"].startswith("obk_")
    assert "secret" not in listed.json()["api_keys"][0]
    assert created["secret"] not in listed.text


async def test_a_key_works_where_a_session_token_does(api_client, registration):
    profile, token = await account(api_client, registration)
    created = await mint_key(api_client, token)

    response = await api_client.get(
        "/v1/users/me", headers={"X-API-Key": created["secret"]}
    )

    assert response.status_code == 200
    assert response.json()["id"] == profile["id"]


async def test_a_key_also_works_as_a_bearer_credential(api_client, registration):
    # Scripts reach for the Authorization header out of habit; the obk_ marker
    # is what lets that work without ambiguity.
    profile, token = await account(api_client, registration)
    created = await mint_key(api_client, token)

    response = await api_client.get(
        "/v1/users/me", headers={"Authorization": f"Bearer {created['secret']}"}
    )

    assert response.status_code == 200
    assert response.json()["id"] == profile["id"]


async def test_a_wrong_key_is_refused(api_client, registration):
    _, token = await account(api_client, registration)
    created = await mint_key(api_client, token)
    tampered = created["secret"][:-4] + "aaaa"

    response = await api_client.get("/v1/users/me", headers={"X-API-Key": tampered})

    assert response.status_code == 401


async def test_a_key_with_an_unknown_prefix_is_refused(api_client):
    response = await api_client.get(
        "/v1/users/me", headers={"X-API-Key": "obk_deadbeef_nothing-here"}
    )

    assert response.status_code == 401


async def test_using_a_key_records_that_it_was_used(api_client, registration):
    _, token = await account(api_client, registration)
    created = await mint_key(api_client, token)

    await api_client.get("/v1/users/me", headers={"X-API-Key": created["secret"]})
    listed = await api_client.get(
        "/v1/users/me/api-keys", headers={"Authorization": f"Bearer {token}"}
    )

    assert listed.json()["api_keys"][0]["last_used_at"] is not None


async def test_a_revoked_key_stops_working(api_client, registration):
    _, token = await account(api_client, registration)
    headers = {"Authorization": f"Bearer {token}"}
    created = await mint_key(api_client, token)

    revoked = await api_client.delete(f"/v1/users/me/api-keys/{created['id']}", headers=headers)
    response = await api_client.get("/v1/users/me", headers={"X-API-Key": created["secret"]})

    assert revoked.status_code == 204
    assert response.status_code == 401


async def test_a_revoked_key_leaves_the_list(api_client, registration):
    _, token = await account(api_client, registration)
    headers = {"Authorization": f"Bearer {token}"}
    created = await mint_key(api_client, token)

    await api_client.delete(f"/v1/users/me/api-keys/{created['id']}", headers=headers)
    listed = await api_client.get("/v1/users/me/api-keys", headers=headers)

    assert listed.json()["api_keys"] == []


async def test_you_cannot_revoke_somebody_elses_key(api_client, registration):
    _, mine = await account(api_client, registration)
    _, theirs = await account(api_client, registration)
    their_key = await mint_key(api_client, theirs)

    response = await api_client.delete(
        f"/v1/users/me/api-keys/{their_key['id']}",
        headers={"Authorization": f"Bearer {mine}"},
    )

    # 404 rather than 403: whether that key exists is none of this caller's
    # business either.
    assert response.status_code == 404


async def test_a_key_belongs_to_one_account_only(api_client, registration):
    mine, my_token = await account(api_client, registration)
    theirs, their_token = await account(api_client, registration)
    my_key = await mint_key(api_client, my_token)

    response = await api_client.get("/v1/users/me", headers={"X-API-Key": my_key["secret"]})

    assert response.json()["id"] == mine["id"] != theirs["id"]


async def test_minting_a_key_needs_an_account(api_client):
    response = await api_client.post("/v1/users/me/api-keys", json={"name": "a key"})

    assert response.status_code == 401

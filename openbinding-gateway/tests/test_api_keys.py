"""API keys: minting, using, and taking back.

The point of these is that the API channel and the web channel end up at the
same account. Most of what is asserted here is about the secret never coming
back out, and about a key being usable exactly where a session token is.
"""

from __future__ import annotations

import pytest
import pytest_asyncio

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


# -- The allowance ----------------------------------------------------------


@pytest_asyncio.fixture
async def gate():
    from openbinding_gateway import space_client
    from openbinding_gateway.space_client import FakePricingGate

    installed = FakePricingGate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


async def test_the_plan_bounds_how_many_keys_you_may_hold(api_client, registration, gate):
    """apiKeysLimit was in the pricing and nothing read it.

    Two on the free plan, ten on PRO - published in the plans page, carried
    through the pricing token, and never once compared against anything, so a
    free account could mint keys without end.
    """
    _, token = await account(api_client, registration)
    await mint_key(api_client, token, "one")
    await mint_key(api_client, token, "two")

    refused = await api_client.post(
        "/v1/users/me/api-keys",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": "three"},
    )

    assert refused.status_code == 402
    detail = refused.json()["detail"]
    assert detail["code"] == "quota_exceeded"
    assert detail["quota"]["limit_id"] == "apiKeysLimit"
    assert detail["quota"]["limit"] == 2


async def test_revoking_one_frees_the_allowance(api_client, registration, gate):
    # The count is of *live* keys, so a revoked one is not held against you.
    _, token = await account(api_client, registration)
    first = await mint_key(api_client, token, "one")
    await mint_key(api_client, token, "two")

    await api_client.delete(
        f"/v1/users/me/api-keys/{first['id']}",
        headers={"Authorization": f"Bearer {token}"},
    )
    again = await api_client.post(
        "/v1/users/me/api-keys",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": "three"},
    )

    assert again.status_code == 201


async def test_a_larger_plan_allows_more(api_client, registration, gate):
    import uuid as _uuid

    profile, token = await account(api_client, registration)
    gate.plans[_uuid.UUID(profile["id"])] = "PRO"

    for n in range(3):
        assert (
            await api_client.post(
                "/v1/users/me/api-keys",
                headers={"Authorization": f"Bearer {token}"},
                json={"name": f"key {n}"},
            )
        ).status_code == 201


async def test_keys_can_still_be_minted_while_the_pricing_service_is_down(
    api_client, registration, gate
):
    # Locking somebody out of their own account because SPACE is restarting is
    # a bigger harm than one key over an allowance.
    _, token = await account(api_client, registration)
    gate.unavailable = True

    created = await api_client.post(
        "/v1/users/me/api-keys",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": "while it is down"},
    )

    assert created.status_code == 201

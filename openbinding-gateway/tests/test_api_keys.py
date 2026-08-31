"""API keys: minting, using, and taking back.

The point of these is that the API channel and the web channel end up at the
same account. Most of what is asserted here is about the secret never coming
back out, and about a key being usable exactly where a session token is.
"""

from __future__ import annotations

import json
import uuid

import pytest
import pytest_asyncio

from openbinding_gateway.security import apikeys

from _repo import REPO_ROOT


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


def key_payload(
    name="a key",
    *,
    permissions=None,
    all_engines=True,
    engines=None,
) -> dict:
    return {
        "name": name,
        "permissions": permissions or ["account:read"],
        "engine_access": {
            "all": all_engines,
            "engines": engines or [],
        },
    }


async def mint_key(
    client,
    token,
    name="a key",
    *,
    permissions=None,
    all_engines=True,
    engines=None,
) -> dict:
    response = await client.post(
        "/v1/users/me/api-keys",
        headers={"Authorization": f"Bearer {token}"},
        json=key_payload(
            name,
            permissions=permissions,
            all_engines=all_engines,
            engines=engines,
        ),
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
    assert created["permissions"] == ["account:read"]
    assert created["engine_access"] == {"all": True, "engines": []}
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
    response = await api_client.post(
        "/v1/users/me/api-keys", json=key_payload()
    )

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

    Ten on the free plan and unlimited on PRO, counted from active rows in the
    gateway database.
    """
    _, token = await account(api_client, registration)
    for number in range(10):
        await mint_key(api_client, token, f"key {number}")

    refused = await api_client.post(
        "/v1/users/me/api-keys",
        headers={"Authorization": f"Bearer {token}"},
        json=key_payload("eleven"),
    )

    assert refused.status_code == 402
    detail = refused.json()["detail"]
    assert detail["code"] == "quota_exceeded"
    assert detail["quota"]["limit_id"] == "apiKeysLimit"
    assert detail["quota"]["limit"] == 10


async def test_revoking_one_frees_the_allowance(api_client, registration, gate):
    # The count is of *live* keys, so a revoked one is not held against you.
    _, token = await account(api_client, registration)
    first = await mint_key(api_client, token, "one")
    for number in range(1, 10):
        await mint_key(api_client, token, f"key {number}")

    await api_client.delete(
        f"/v1/users/me/api-keys/{first['id']}",
        headers={"Authorization": f"Bearer {token}"},
    )
    again = await api_client.post(
        "/v1/users/me/api-keys",
        headers={"Authorization": f"Bearer {token}"},
        json=key_payload("replacement"),
    )

    assert again.status_code == 201


async def test_a_larger_plan_allows_more(api_client, registration, gate):
    import uuid as _uuid

    profile, token = await account(api_client, registration)
    gate.plans[_uuid.UUID(profile["id"])] = "PRO"

    for n in range(12):
        assert (
            await api_client.post(
                "/v1/users/me/api-keys",
                headers={"Authorization": f"Bearer {token}"},
                json=key_payload(f"key {n}"),
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
        json=key_payload("while it is down"),
    )

    assert created.status_code == 201


# -- Granular authorization -------------------------------------------------


async def test_a_key_without_the_route_permission_is_refused(api_client, registration):
    _, token = await account(api_client, registration)
    created = await mint_key(
        api_client,
        token,
        permissions=["instances:write"],
        all_engines=False,
    )

    response = await api_client.get(
        "/v1/users/me", headers={"X-API-Key": created["secret"]}
    )

    assert response.status_code == 403
    detail = response.json()["detail"]
    assert detail["code"] == "insufficient_api_key_permission"
    assert detail["missing_permissions"] == ["account:read"]


@pytest.mark.parametrize(
    "permission",
    [
        "engines:read",
        "engines:execute",
        "engines:register",
        "engines:publish",
        "engines:moderate",
        "instances:analyze",
        "jobs:read",
    ],
)
async def test_engine_permissions_require_an_explicit_engine_boundary(
    api_client, registration, permission
):
    _, token = await account(api_client, registration)

    response = await api_client.post(
        "/v1/users/me/api-keys",
        headers={"Authorization": f"Bearer {token}"},
        json=key_payload(
            permissions=[permission], all_engines=False, engines=[]
        ),
    )

    assert response.status_code == 422


async def test_selected_engines_filter_catalog_and_exact_reads(api_client, registration):
    _, token = await account(api_client, registration)
    session_headers = {"Authorization": f"Bearer {token}"}
    catalog = (await api_client.get("/v1/engines", headers=session_headers)).json()["engines"]
    assert len(catalog) > 1
    selected = catalog[0]["ref"]
    denied = catalog[1]["ref"]
    created = await mint_key(
        api_client,
        token,
        permissions=["engines:read"],
        all_engines=False,
        engines=[selected],
    )
    key_headers = {"X-API-Key": created["secret"]}

    filtered = await api_client.get("/v1/engines", headers=key_headers)
    hidden = await api_client.get(
        f"/v1/engines/{denied['name']}",
        params={
            "namespace": denied["namespace"],
            "version": denied["version"],
            "digest": denied["digest"],
        },
        headers=key_headers,
    )

    assert [engine["ref"] for engine in filtered.json()["engines"]] == [selected]
    assert hidden.status_code == 404


async def test_selected_engine_key_cannot_create_an_unselected_revision(
    api_client, registration
):
    profile, token = await account(api_client, registration)
    session_headers = {"Authorization": f"Bearer {token}"}
    catalog = (await api_client.get("/v1/engines", headers=session_headers)).json()[
        "engines"
    ]
    selected = catalog[0]["ref"]
    limited = await mint_key(
        api_client,
        token,
        permissions=["engines:register"],
        all_engines=False,
        engines=[selected],
    )
    candidate = json.loads(
        (REPO_ROOT / "schemas/bim/v1/manifests/random-search.json").read_text(
            encoding="utf-8"
        )
    )
    candidate["metadata"].update(
        namespace=profile["username"], name="new-private-engine", version="1.0.0"
    )

    refused = await api_client.post(
        "/v1/engines",
        headers={"X-API-Key": limited["secret"]},
        json=candidate,
    )
    unrestricted = await mint_key(
        api_client,
        token,
        permissions=["engines:register"],
        all_engines=True,
    )
    created = await api_client.post(
        "/v1/engines",
        headers={"X-API-Key": unrestricted["secret"]},
        json=candidate,
    )

    assert refused.status_code == 403
    assert refused.json()["title"] == "engine_not_granted"
    assert created.status_code == 201, created.text


async def test_selected_engine_boundary_applies_to_deployment_management(
    api_client, registration, db_session
):
    from openbinding_gateway.db.models import EngineRegistrationRevision

    profile, token = await account(api_client, registration)
    session_headers = {"Authorization": f"Bearer {token}"}
    catalog = (await api_client.get("/v1/engines", headers=session_headers)).json()[
        "engines"
    ]
    assert len(catalog) > 1
    selected = catalog[0]["ref"]
    denied = catalog[1]["ref"]
    key = await mint_key(
        api_client,
        token,
        permissions=["engines:register"],
        all_engines=False,
        engines=[selected],
    )
    deployment_digest = f"sha256-{'f' * 64}"
    row = EngineRegistrationRevision(
        owner_id=uuid.UUID(profile["id"]),
        namespace=profile["username"],
        name="other-engine-deployment",
        version="1.0.0",
        manifest_digest=deployment_digest,
        engine_digest=denied["digest"],
        document={"spec": {"engine": denied}},
        endpoint="https://engine.example",
        protocol_digest=f"sha256-{'e' * 64}",
        mappings={},
        auth_scheme="none",
        verification_report={"status": "pending", "checks": []},
        publication_status="private",
        is_active=True,
    )
    db_session.add(row)
    await db_session.flush()

    response = await api_client.post(
        "/v1/engine-registrations/other-engine-deployment/deactivate",
        params={
            "namespace": profile["username"],
            "version": "1.0.0",
            "digest": deployment_digest,
        },
        headers={"X-API-Key": key["secret"]},
    )

    assert response.status_code == 404
    assert row.is_active is True


async def test_a_child_key_cannot_exceed_its_parent(api_client, registration):
    _, token = await account(api_client, registration)
    parent = await mint_key(
        api_client,
        token,
        permissions=["keys:write", "account:read"],
        all_engines=False,
    )

    response = await api_client.post(
        "/v1/users/me/api-keys",
        headers={"X-API-Key": parent["secret"]},
        json=key_payload(
            "escalated",
            permissions=["keys:write", "account:write"],
            all_engines=False,
        ),
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "api_key_escalation"


async def test_non_admin_cannot_mint_administration_permissions(
    api_client, registration
):
    _, token = await account(api_client, registration)

    response = await api_client.post(
        "/v1/users/me/api-keys",
        headers={"Authorization": f"Bearer {token}"},
        json=key_payload(
            permissions=["admin:accounts:read"], all_engines=False
        ),
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "permission_not_grantable"


async def test_admin_permission_never_replaces_the_account_role(
    api_client, registration, db_session
):
    from openbinding_gateway.db.models import ApiKey

    _, token = await account(api_client, registration)
    created = await mint_key(
        api_client,
        token,
        permissions=["account:read"],
        all_engines=False,
    )
    row = await db_session.get(ApiKey, uuid.UUID(created["id"]))
    row.grants = {
        "permissions": ["admin:accounts:read"],
        "allEngines": False,
        "engines": [],
    }
    await db_session.flush()

    response = await api_client.get(
        "/v1/admin/users", headers={"X-API-Key": created["secret"]}
    )

    assert response.status_code == 403


async def test_an_admin_can_issue_a_read_only_admin_key(
    api_client, registration, db_session
):
    from openbinding_gateway.db.models import User, UserRole

    profile, token = await account(api_client, registration)
    user = await db_session.get(User, uuid.UUID(profile["id"]))
    user.role = UserRole.ADMIN
    await db_session.flush()
    created = await mint_key(
        api_client,
        token,
        permissions=["admin:accounts:read"],
        all_engines=False,
    )

    listing = await api_client.get(
        "/v1/admin/users", headers={"X-API-Key": created["secret"]}
    )
    mutation = await api_client.patch(
        f"/v1/admin/users/{profile['id']}",
        headers={"X-API-Key": created["secret"]},
        json={"is_active": True},
    )

    assert listing.status_code == 200
    assert mutation.status_code == 403
    assert mutation.json()["detail"]["code"] == "insufficient_api_key_permission"

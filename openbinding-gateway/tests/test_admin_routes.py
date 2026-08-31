"""What an administrator can and cannot do to somebody else's account.

Half of these are about the guard rather than the feature. An administration
endpoint that an ordinary account can reach is worse than no endpoint, and the
one that changes plans is the only reason the paid plan works at all - there is
no payment gateway, so an upgrade *is* an administrator performing a novation.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio

from openbinding_gateway import space_client
from openbinding_gateway.db.models import User, UserRole
from openbinding_gateway.space_client import FakePricingGate


@pytest_asyncio.fixture
async def gate():
    installed = FakePricingGate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


async def account(client, registration, db_session=None, *, admin=False) -> tuple[dict, dict]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text

    if admin:
        from sqlalchemy import select

        user = (
            await db_session.execute(select(User).where(User.username == details["username"]))
        ).scalars().one()
        user.role = UserRole.ADMIN
        await db_session.flush()

    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), {"Authorization": f"Bearer {tokens.json()['access_token']}"}


# -- The guard --------------------------------------------------------------


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/v1/admin/users"),
        ("patch", "/v1/admin/users/{id}"),
        ("post", "/v1/admin/users/{id}/plan"),
        ("get", "/v1/admin/users/{id}/usage"),
        ("post", "/v1/admin/users/{id}/usage/resync"),
    ],
)
async def test_an_ordinary_account_is_refused(api_client, registration, gate, method, path):
    profile, headers = await account(api_client, registration)

    url = path.format(id=profile["id"])
    response = await (
        api_client.get(url, headers=headers)
        if method == "get"
        else getattr(api_client, method)(url, headers=headers, json={})
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "forbidden"


async def test_a_visitor_is_refused(api_client, gate):
    response = await api_client.get("/v1/admin/users")

    assert response.status_code == 401


# -- Seeing accounts --------------------------------------------------------


async def test_an_administrator_sees_the_accounts(api_client, registration, gate, db_session):
    await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.get("/v1/admin/users", headers=admin)

    assert response.status_code == 200
    assert response.json()["total"] >= 2


async def test_the_listing_never_carries_a_password_hash(
    api_client, registration, gate, db_session
):
    await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.get("/v1/admin/users", headers=admin)

    assert "password" not in response.text.lower()


async def test_accounts_can_be_searched(api_client, registration, gate, db_session):
    wanted, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.get(
        f"/v1/admin/users?search={wanted['username']}", headers=admin
    )

    assert response.json()["total"] == 1
    assert response.json()["users"][0]["id"] == wanted["id"]


async def test_the_listing_is_paged(api_client, registration, gate, db_session):
    # A screen that fetches every account works until it does not.
    for _ in range(3):
        await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.get("/v1/admin/users?limit=2", headers=admin)

    assert len(response.json()["users"]) == 2
    assert response.json()["total"] >= 4


async def test_the_listing_reports_how_many_keys_are_in_use(
    api_client, registration, gate, db_session
):
    profile, headers = await account(api_client, registration)
    await api_client.post(
        "/v1/users/me/api-keys",
        headers=headers,
        json={
            "name": "k",
            "permissions": ["account:read"],
            "engine_access": {"all": False, "engines": []},
        },
    )
    _, admin = await account(api_client, registration, db_session, admin=True)

    listing = await api_client.get(f"/v1/admin/users?search={profile['username']}", headers=admin)

    assert listing.json()["users"][0]["api_key_count"] == 1


# -- Changing accounts ------------------------------------------------------


async def test_an_account_can_be_deactivated(api_client, registration, gate, db_session):
    profile, theirs = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    changed = await api_client.patch(
        f"/v1/admin/users/{profile['id']}", headers=admin, json={"is_active": False}
    )
    after = await api_client.get("/v1/users/me", headers=theirs)

    assert changed.json()["is_active"] is False
    # Their token is still valid and unexpired; the account is not.
    assert after.status_code == 401


async def test_an_account_can_be_promoted(api_client, registration, gate, db_session):
    profile, theirs = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    await api_client.patch(
        f"/v1/admin/users/{profile['id']}", headers=admin, json={"role": "admin"}
    )
    now_allowed = await api_client.get("/v1/admin/users", headers=theirs)

    assert now_allowed.status_code == 200


async def test_an_administrator_cannot_deactivate_themselves(
    api_client, registration, gate, db_session
):
    # Always a mistake, and a gateway whose last administrator locked
    # themselves out needs database access to recover.
    profile, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.patch(
        f"/v1/admin/users/{profile['id']}", headers=admin, json={"is_active": False}
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "cannot_demote_self"


async def test_an_administrator_cannot_demote_themselves(
    api_client, registration, gate, db_session
):
    profile, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.patch(
        f"/v1/admin/users/{profile['id']}", headers=admin, json={"role": "user"}
    )

    assert response.status_code == 409


async def test_an_unknown_account_is_not_found(api_client, registration, gate, db_session):
    _, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.patch(
        f"/v1/admin/users/{uuid.uuid4()}", headers=admin, json={"is_active": False}
    )

    assert response.status_code == 404


# -- Plans ------------------------------------------------------------------


async def test_an_account_can_be_moved_to_the_paid_plan(
    api_client, registration, gate, db_session
):
    # The whole reason PRO works: there is no payment gateway, so an upgrade
    # is an administrator performing a novation.
    profile, theirs = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    changed = await api_client.post(
        f"/v1/admin/users/{profile['id']}/plan", headers=admin, json={"plan": "PRO"}
    )
    usage = await api_client.get("/v1/users/me/usage", headers=theirs)

    assert changed.json()["plan"] == "PRO"
    assert usage.json()["plan"] == "PRO"
    assert usage.json()["caps"]["max_timeout_s"] == 1800


async def test_the_novation_happens_before_the_cache_is_updated(
    api_client, registration, gate, db_session
):
    # If the contract cannot be changed, nothing should claim it was.
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    gate.unavailable = True

    response = await api_client.post(
        f"/v1/admin/users/{profile['id']}/plan", headers=admin, json={"plan": "PRO"}
    )
    gate.unavailable = False
    listing = await api_client.get(f"/v1/admin/users?search={profile['username']}", headers=admin)

    assert response.status_code == 503
    assert listing.json()["users"][0]["plan"] == "FREE"


async def test_an_account_can_be_moved_back(api_client, registration, gate, db_session):
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    await api_client.post(
        f"/v1/admin/users/{profile['id']}/plan", headers=admin, json={"plan": "PRO"}
    )
    back = await api_client.post(
        f"/v1/admin/users/{profile['id']}/plan", headers=admin, json={"plan": "FREE"}
    )

    assert back.json()["plan"] == "FREE"


# -- Usage ------------------------------------------------------------------


async def test_an_administrator_sees_the_same_usage_the_holder_does(
    api_client, registration, gate, db_session
):
    profile, theirs = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    gate.spend(uuid.UUID(profile["id"]), "tasksLimit", 5)

    mine = await api_client.get("/v1/users/me/usage", headers=theirs)
    seen = await api_client.get(f"/v1/admin/users/{profile['id']}/usage", headers=admin)

    assert mine.json() == seen.json()


async def test_a_key_can_be_taken_back(api_client, registration, gate, db_session):
    # For when one has leaked and its owner is unreachable.
    profile, theirs = await account(api_client, registration)
    key = await api_client.post(
        "/v1/users/me/api-keys",
        headers=theirs,
        json={
            "name": "k",
            "permissions": ["account:read"],
            "engine_access": {"all": False, "engines": []},
        },
    )
    _, admin = await account(api_client, registration, db_session, admin=True)

    revoked = await api_client.delete(
        f"/v1/admin/users/{profile['id']}/api-keys/{key.json()['id']}", headers=admin
    )
    still_works = await api_client.get(
        "/v1/users/me", headers={"X-API-Key": key.json()["secret"]}
    )

    assert revoked.status_code == 204
    assert still_works.status_code == 401


async def test_resyncing_reports_no_drift_when_there_is_none(
    api_client, registration, gate, db_session
):
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)

    response = await api_client.post(
        f"/v1/admin/users/{profile['id']}/usage/resync", headers=admin
    )

    assert response.json()["corrected_by"] == 0
    assert response.json()["slots_in_flight"] == 0


async def test_resyncing_frees_a_slot_nothing_is_holding(
    api_client, registration, gate, db_session
):
    # The escape hatch for a slot the reconciler cannot see: recorded against
    # an account that has nothing running.
    profile, _ = await account(api_client, registration)
    _, admin = await account(api_client, registration, db_session, admin=True)
    gate.spend(uuid.UUID(profile["id"]), "concurrentTasksLimit", 1)

    response = await api_client.post(
        f"/v1/admin/users/{profile['id']}/usage/resync", headers=admin
    )
    usage = await gate.usage(uuid.UUID(profile["id"]))

    assert response.json()["slots_recorded"] == 1
    assert response.json()["corrected_by"] == -1
    assert usage.limits["concurrentTasksLimit"].used == 0

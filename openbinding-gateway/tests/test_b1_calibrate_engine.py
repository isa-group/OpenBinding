"""B1 #3: calibrating the shared routing model is for platform administrators only."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from _b1_helpers import gate, make_account, make_key  # noqa: F401
from openbinding_gateway.db.models import EngineProfileSurrogate, User, UserRole

ENDPOINT = "/v1/generator/calibrate-engine"
OBSERVATIONS = [
    {
        "workload_features": {"S": 10.0, "D_constr": 1, "N_tasks": 10, "N_cap": 5, "D_obj": 1, "T_budget": 60},
        "latency": 1.2,
        "quality": 0.95,
        "success": True,
    },
    {
        "workload_features": {"S": 20.0, "D_constr": 1, "N_tasks": 20, "N_cap": 5, "D_obj": 1, "T_budget": 60},
        "latency": 3.4,
        "quality": 0.91,
        "success": True,
    },
]


def payload(engine: str) -> dict:
    return {"engine": engine, "mode": "b1-mode", "observations": OBSERVATIONS}


async def stored(db_session, engine: str):
    return (
        await db_session.execute(
            select(EngineProfileSurrogate).where(EngineProfileSurrogate.engine == engine)
        )
    ).scalars().all()


async def test_anonymous_callers_are_unauthenticated(api_client, db_session):
    response = await api_client.post(ENDPOINT, json=payload("b1-anonymous"))
    assert response.status_code == 401, response.text
    assert response.json()["detail"]["code"] == "unauthorized"
    assert await stored(db_session, "b1-anonymous") == []


async def test_regular_accounts_are_refused_and_nothing_changes(api_client, registration, db_session, gate):
    _, headers = await make_account(api_client, registration, db_session, gate)

    response = await api_client.post(ENDPOINT, json=payload("b1-regular"), headers=headers)

    assert response.status_code == 403, response.text
    assert response.json()["detail"]["code"] == "platform_admin_required"
    assert await stored(db_session, "b1-regular") == []


async def test_a_platform_administrator_calibrates_and_is_recorded(api_client, registration, db_session, gate):
    admin, headers = await make_account(api_client, registration, db_session, gate, admin=True)

    response = await api_client.post(ENDPOINT, json=payload("b1-admin"), headers=headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["engine"], body["mode"], body["sample_count"], body["status"]) == (
        "b1-admin", "b1-mode", 2, "calibrated"
    )
    rows = await stored(db_session, "b1-admin")
    assert len(rows) == 1
    assert rows[0].metadata_info == {"calibrated_by": admin["email"]}


async def test_the_shared_model_is_untouched_by_a_refused_call(api_client, registration, db_session, gate):
    admin, admin_headers = await make_account(api_client, registration, db_session, gate, admin=True)
    _, user_headers = await make_account(api_client, registration, db_session, gate)
    assert (await api_client.post(ENDPOINT, json=payload("b1-shared"), headers=admin_headers)).status_code == 200
    before = (await stored(db_session, "b1-shared"))[0].sample_count

    refused = await api_client.post(
        ENDPOINT,
        json={"engine": "b1-shared", "mode": "b1-mode", "observations": OBSERVATIONS[:1]},
        headers=user_headers,
    )

    assert refused.status_code == 403
    await db_session.refresh((await stored(db_session, "b1-shared"))[0])
    assert (await stored(db_session, "b1-shared"))[0].sample_count == before == 2


@pytest.mark.parametrize(
    ("permissions", "expected"),
    [
        (["instances:write"], "insufficient_api_key_permission"),
        (["instances:read", "instances:write", "engines:moderate"], "insufficient_api_key_permission"),
        (["admin:accounts:read"], "insufficient_api_key_permission"),
    ],
)
async def test_api_keys_without_the_admin_permission_are_refused(
    api_client, registration, db_session, gate, permissions, expected
):
    # An administrator's own key still needs the admin permission to be granted.
    _, headers = await make_account(api_client, registration, db_session, gate, admin=True)
    key = await make_key(api_client, headers, permissions)

    response = await api_client.post(ENDPOINT, json=payload("b1-key-refused"), headers=key)

    assert response.status_code == 403, response.text
    assert response.json()["detail"]["code"] == expected
    assert "admin:accounts:write" in response.json()["detail"]["missing_permissions"]
    assert await stored(db_session, "b1-key-refused") == []


async def test_an_admin_key_works_and_a_user_cannot_mint_one(api_client, registration, db_session, gate):
    _, admin_headers = await make_account(api_client, registration, db_session, gate, admin=True)
    _, user_headers = await make_account(api_client, registration, db_session, gate)

    key = await make_key(api_client, admin_headers, ["admin:accounts:write"])
    allowed = await api_client.post(ENDPOINT, json=payload("b1-key-ok"), headers=key)
    minted = await api_client.post(
        "/v1/users/me/api-keys",
        headers=user_headers,
        json={"name": "escalation", "permissions": ["admin:accounts:write"],
              "engine_access": {"all": True, "engines": []}, "boundary": {}},
    )

    assert allowed.status_code == 200, allowed.text
    assert len(await stored(db_session, "b1-key-ok")) == 1
    assert minted.status_code == 403
    assert minted.json()["detail"]["code"] == "permission_not_grantable"


async def test_a_regular_users_key_with_admin_permission_is_still_refused_by_role(
    api_client, registration, db_session, gate
):
    """A key minted while the account was an administrator does not outlive the role."""
    admin, admin_headers = await make_account(api_client, registration, db_session, gate, admin=True)
    key = await make_key(api_client, admin_headers, ["admin:accounts:write"])
    user = await db_session.get(User, uuid.UUID(admin["id"]))
    user.role = UserRole.USER
    await db_session.flush()

    response = await api_client.post(ENDPOINT, json=payload("b1-demoted"), headers=key)

    assert response.status_code == 403, response.text
    assert response.json()["detail"]["code"] == "platform_admin_required"
    assert await stored(db_session, "b1-demoted") == []


def test_the_other_generator_endpoints_stay_open_to_any_caller():
    """Documented in the router: only calibration touches shared state."""
    from openbinding_gateway.access.dependencies import get_current_user, get_optional_user, require_platform_admin
    from openbinding_gateway.main import app

    def calls(dependant):
        found = {dependant.call}
        for dependency in dependant.dependencies:
            found |= calls(dependency)
        return found

    guards = {}
    for included in app.routes:
        original_router = getattr(included, "original_router", None)
        for route in original_router.routes if original_router is not None else [included]:
            path = getattr(route, "path", "")
            if path.startswith("/v1/generator/"):
                guards[path] = calls(route.dependant)
    assert set(guards) == {
        "/v1/generator/instances",
        "/v1/generator/corpus",
        "/v1/generator/convert-legacy",
        "/v1/generator/calibrate-engine",
    }
    assert require_platform_admin in guards["/v1/generator/calibrate-engine"]
    for path, found in guards.items():
        if path != "/v1/generator/calibrate-engine":
            assert get_optional_user in found
            assert require_platform_admin not in found and get_current_user not in found

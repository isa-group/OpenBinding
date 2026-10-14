"""The plan's numeric ``federatedEngines``: how many registrations one owner may have active.

Only the *feature* of that name was applied before. The number is held where it can be
measured without keeping any count of its own: activating a registration counts the owner's
registrations that are active now, like the ``apiKeys`` and structure limits count rows. A
deactivated one stops counting, so nothing accumulates. An absent limit is zero (the
convention for plan allowances: unknown is never room); an unlimited one sets none.

The plan is the fixture's or a synthetic ``PlanCaps``; no SPACE is involved.
"""

from __future__ import annotations

import uuid

from test_engine_registry_service import (
    key_of,
    make_user,
    refused,
    register,
    settings_with_key,
    stored,
    verifier,
)
from test_usage_limits import set_plan
from test_v1_lifecycle_rbac import (
    _builtin_engine_ref,
    _register_and_login,
    _registration_document,
)

from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services import engines
from openbinding_gateway.services.engine_registry import change_registration


async def activate(session, owner, summary, *, max_active, seen=None):
    return await change_registration(
        key_of(summary), owner, session, action="activate", settings=settings_with_key(),
        verify=verifier(seen), max_active=max_active,
    )


async def two_registrations(session, owner):
    return await register(session, owner), await register(session, owner)


# -- The service ------------------------------------------------------------------------


async def test_activating_past_the_limit_is_a_402_with_a_quota_and_verifies_nothing(db_session):
    owner = await make_user(db_session)
    first, second = await two_registrations(db_session, owner)
    await activate(db_session, owner, first, max_active=1)
    seen: list = []

    problem = await refused(activate(db_session, owner, second, max_active=1, seen=seen))

    assert (problem.status, problem.code) == (402, "quota_exceeded")
    assert problem.extra == {
        "quota": {
            "limit_id": "federatedEngines", "state": "exhausted", "unit": "engine", "source": "plan",
            "limit": 1, "used": 1,
        }
    }
    assert seen == []  # the deployment was not even contacted
    assert (await stored(db_session, second)).is_active is False
    assert (await stored(db_session, first)).is_active is True


async def test_a_deactivated_registration_frees_its_place_and_nothing_accumulates(db_session):
    owner = await make_user(db_session)
    first, second = await two_registrations(db_session, owner)

    for summary, other in ((first, second), (second, first), (first, second), (second, first)):
        await activate(db_session, owner, summary, max_active=1)
        assert (await refused(activate(db_session, owner, other, max_active=1))).code == "quota_exceeded"
        await change_registration(
            key_of(summary), owner, db_session, action="deactivate", settings=settings_with_key(), max_active=1
        )

    assert (await stored(db_session, first)).is_active is False
    assert (await stored(db_session, second)).is_active is False


async def test_activating_one_that_is_active_already_is_not_a_second_place(db_session):
    owner = await make_user(db_session)
    summary = await register(db_session, owner)
    await activate(db_session, owner, summary, max_active=1)

    again = await activate(db_session, owner, summary, max_active=1)

    assert again["active"] is True


async def test_no_limit_sets_none_and_another_owners_registrations_do_not_count(db_session):
    owner, other = await make_user(db_session), await make_user(db_session)
    mine = [await register(db_session, owner) for _ in range(3)]
    theirs = await register(db_session, other)

    for summary in mine:
        await activate(db_session, owner, summary, max_active=None)
    await activate(db_session, other, theirs, max_active=1)

    for summary in mine:
        assert (await stored(db_session, summary)).is_active is True


async def test_a_limit_of_zero_refuses_every_activation(db_session):
    owner = await make_user(db_session)
    summary = await register(db_session, owner)

    problem = await refused(activate(db_session, owner, summary, max_active=0))

    assert (problem.status, problem.extra["quota"]["limit"], problem.extra["quota"]["used"]) == (402, 0, 0)


async def test_the_other_actions_are_not_held_to_the_limit(db_session):
    owner = await make_user(db_session)
    first, second = await two_registrations(db_session, owner)
    await activate(db_session, owner, first, max_active=None)
    await activate(db_session, owner, second, max_active=None)

    # Deactivating, with a limit already below what is active, is not refused.
    deactivated = await change_registration(
        key_of(first), owner, db_session, action="deactivate", settings=settings_with_key(), max_active=0
    )

    assert deactivated["active"] is False


# -- Through the route --------------------------------------------------------------------


async def test_the_route_applies_the_plan_limit_and_states_the_quota(api_client, db_session, registration, monkeypatch):
    monkeypatch.setattr(routes, "validate_endpoint", lambda endpoint, **_kwargs: None)

    async def verified(document, credential, engine_document):
        return (
            {"protocol": "bim-engine/v1", "protocolDigest": engines.protocol_digest(), "status": "verified",
             "checks": [], "durationMs": 0.0},
            {"openapi": "3.1.0", "paths": {}},
            "sha256-" + "e" * 64,
        )

    monkeypatch.setattr(routes, "_verify_registration", verified)
    details = registration()
    headers = await _register_and_login(api_client, details)
    engine = await _builtin_engine_ref(api_client, headers)
    references = []
    for version in ("1.0.0", "2.0.0"):
        name = f"deployment-{uuid.uuid4().hex[:8]}"
        created = await api_client.post(
            "/v1/engine-registrations", headers=headers,
            json=_registration_document(namespace=details["username"], name=name, version=version, engine=engine),
        )
        assert created.status_code == 201, created.text
        references.append((name, {"namespace": details["username"], "version": version, "digest": created.json()["digest"]}))

    # The fixture's default plan declares one federated engine.
    (first, first_ref), (second, second_ref) = references
    ok = await api_client.post(f"/v1/engine-registrations/{first}/activate", params=first_ref, headers=headers)
    over = await api_client.post(f"/v1/engine-registrations/{second}/activate", params=second_ref, headers=headers)

    assert ok.status_code == 200, ok.text
    assert over.status_code == 402, over.text
    assert over.json()["code"] == "quota_exceeded"
    assert over.json()["quota"] == {
        "limit_id": "federatedEngines", "state": "exhausted", "unit": "engine", "source": "plan",
        "limit": 1, "used": 1,
    }

    # A plan with more room lets the second one in.
    set_plan(federatedEngines=3)
    assert (await api_client.post(
        f"/v1/engine-registrations/{second}/activate", params=second_ref, headers=headers
    )).status_code == 200

"""The entitlement service: the one reader of an account's plan.

The service is exercised over the fake SPACE the rest of the suite uses.  The
last tests pin that the routes migrated onto it still answer exactly what they
answered when each one read the gate itself.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from _pricing import caps_for, fake_pricing_gate, largest_plan, pricing_catalog
from openbinding_gateway import space_client
from openbinding_gateway.access import policy
from openbinding_gateway.core.public_errors import PRICING_UNAVAILABLE
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.models.errors import api_error
from openbinding_gateway.services.entitlements import (
    UPLOAD_CEILING_BYTES,
    EntitlementService,
    EntitlementsUnavailable,
    entitlement_service,
    get_entitlements,
)
from openbinding_gateway.space_client import PricingUnavailable

#: What the fake pricing service says when it is switched off: it belongs in the log, never in a response.
REASON = "The fake pricing service is switched off."
DEFAULT_PLAN = pricing_catalog().default_plan
LARGER_PLAN = largest_plan()
#: A fixture feature the default plan does not grant.
DENIED_FEATURE = "advancedAnalytics"


@pytest.fixture
def gate():
    installed = fake_pricing_gate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


def detail_of(error: HTTPException) -> dict:
    return error.detail


# -- Reading the plan -------------------------------------------------------


async def test_caps_for_returns_the_contract_of_the_account(gate):
    user_id = uuid.uuid4()
    gate.plans[user_id] = LARGER_PLAN

    caps = await entitlement_service.caps_for(user_id)

    assert caps == caps_for(LARGER_PLAN)


async def test_an_account_without_a_contract_gets_the_default_plan(gate):
    assert (await entitlement_service.caps_for(uuid.uuid4())).plan == DEFAULT_PLAN


async def test_caps_for_raises_a_domain_exception_when_pricing_is_unavailable(gate, caplog):
    gate.unavailable = True

    with pytest.raises(EntitlementsUnavailable) as raised:
        await entitlement_service.caps_for(uuid.uuid4())

    assert str(raised.value) == PRICING_UNAVAILABLE.detail
    assert REASON not in str(raised.value)
    assert (raised.value.status, raised.value.code) == (503, "pricing_unavailable")
    assert isinstance(raised.value.__cause__, PricingUnavailable)
    # The reason the pricing service gave is kept for the operator, in the log.
    assert REASON in caplog.text
    # Callers that only know PricingUnavailable (retrying ones) still catch it.
    assert isinstance(raised.value, PricingUnavailable)


async def test_caps_or_503_is_the_stable_pricing_unavailable_response(gate, caplog):
    gate.unavailable = True

    with pytest.raises(HTTPException) as raised:
        await entitlement_service.caps_or_503(uuid.uuid4())

    assert raised.value.status_code == 503
    assert detail_of(raised.value) == {
        "code": "pricing_unavailable",
        "error": PRICING_UNAVAILABLE.detail,
    }


async def test_caps_or_503_can_prefix_a_fixed_sentence_but_never_the_reason(gate, caplog):
    gate.unavailable = True

    with pytest.raises(HTTPException) as raised:
        await entitlement_service.caps_or_503(uuid.uuid4(), prefix="Entitlements cannot be read right now: ")

    assert detail_of(raised.value)["error"] == (
        f"Entitlements cannot be read right now: {PRICING_UNAVAILABLE.detail}"
    )
    assert REASON not in str(detail_of(raised.value))
    assert REASON in caplog.text


async def test_the_gate_is_resolved_on_every_call(gate):
    user_id = uuid.uuid4()
    first = await entitlement_service.caps_for(user_id)
    replacement = fake_pricing_gate()
    replacement.plans[user_id] = LARGER_PLAN
    space_client.set_gate(replacement)

    assert first.plan == DEFAULT_PLAN
    assert (await entitlement_service.caps_for(user_id)).plan == LARGER_PLAN


async def test_a_service_can_be_given_its_own_gate_provider():
    isolated = fake_pricing_gate()
    isolated.unavailable = True
    service = EntitlementService(lambda: isolated)

    with pytest.raises(EntitlementsUnavailable):
        await service.caps_for(uuid.uuid4())


def test_the_dependency_hands_out_the_shared_service():
    assert get_entitlements() is entitlement_service


# -- Features ---------------------------------------------------------------


def test_a_granted_feature_passes():
    assert entitlement_service.feature_refusal(caps_for(DEFAULT_PLAN), "runs") is None
    entitlement_service.require_feature(caps_for(DEFAULT_PLAN), "runs")


def test_a_denied_feature_is_the_stable_403():
    assert not caps_for(DEFAULT_PLAN).allows(DENIED_FEATURE)

    with pytest.raises(HTTPException) as raised:
        entitlement_service.require_feature(caps_for(DEFAULT_PLAN), DENIED_FEATURE)

    assert raised.value.status_code == 403
    assert detail_of(raised.value) == {
        "code": "feature_not_entitled",
        "error": "The current plan does not entitle this feature.",
    }


def test_a_denied_feature_can_carry_the_callers_wording():
    with pytest.raises(HTTPException) as raised:
        entitlement_service.require_feature(
            caps_for(DEFAULT_PLAN), DENIED_FEATURE, detail="The current plan does not entitle studies."
        )

    assert detail_of(raised.value)["error"] == "The current plan does not entitle studies."


# -- Decisions delegate to access.policy ------------------------------------


def test_ceilings_and_clamps_are_the_policys():
    caps = caps_for(DEFAULT_PLAN)
    over = {"time_budget_ms": int(caps.limit("maxRunMinutes")) * 60_000 + 1, "iterations": 5}

    assert entitlement_service.clamp_options(over, caps) == policy.clamp_options(over, caps)
    assert entitlement_service.payload_ceiling(1 << 40) == policy.payload_ceiling_bytes(1 << 40)
    assert entitlement_service.solve_timeout(caps, 1e9) == policy.solve_timeout_s(caps, 1e9)


def test_a_plan_without_run_minutes_is_the_pricing_misconfigured_503():
    with pytest.raises(HTTPException) as raised:
        entitlement_service.solve_timeout(space_client.PlanCaps(plan="X"), 1800.0)

    assert raised.value.status_code == 503
    assert detail_of(raised.value)["code"] == policy.PRICING_MISCONFIGURED


def test_the_upload_limit_is_the_package_setting_capped_by_the_platform():
    assert entitlement_service.upload_limit() == min(UPLOAD_CEILING_BYTES, get_settings().max_package_bytes)


# -- The storage quota (maxRepositoryStorage, MB = 10**6 bytes) ---------------


async def test_storage_quota_counts_the_incoming_bytes_but_reports_what_is_stored(gate):
    megabytes = caps_for(DEFAULT_PLAN).limit("maxRepositoryStorage")
    limit = int(megabytes * 10**6)

    async def stored() -> int:
        return limit - 10

    await entitlement_service.enforce_storage_quota(uuid.uuid4(), 10, stored)
    with pytest.raises(HTTPException) as raised:
        await entitlement_service.enforce_storage_quota(uuid.uuid4(), 11, stored)

    assert raised.value.status_code == 402
    assert detail_of(raised.value) == {
        "code": "quota_exceeded",
        "error": f"Your plan allows {megabytes:g} MB of stored problems; this upload would exceed it.",
        "quota": {
            "limit_id": "maxRepositoryStorage", "limit": megabytes, "used": round((limit - 10) / 10**6, 6),
            "unit": "MB", "source": "plan", "used_bytes": limit - 10, "incoming_bytes": 11,
        },
    }


async def test_storage_is_not_measured_when_the_plan_is_unlimited():
    class Unbounded:
        async def caps(self, user_id):
            return space_client.PlanCaps(plan="X", features={}, limits={"maxRepositoryStorage": float("inf")})

    async def stored() -> int:
        raise AssertionError("an unlimited plan must not pay for the storage query")

    service = EntitlementService(lambda: Unbounded())
    await service.enforce_storage_quota(uuid.uuid4(), 1 << 40, stored)


async def test_storage_with_unreadable_pricing_is_the_503(gate):
    gate.unavailable = True

    async def stored() -> int:
        return 0

    with pytest.raises(HTTPException) as raised:
        await entitlement_service.enforce_storage_quota(uuid.uuid4(), 1, stored)

    assert raised.value.status_code == 503


# -- The migrated routes answer what they always did ------------------------


async def register(client, registration) -> tuple[dict, dict]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), {"Authorization": f"Bearer {tokens.json()['access_token']}"}


async def test_the_profile_and_usage_routes_report_the_service_caps(api_client, registration, gate):
    profile, headers = await register(api_client, registration)
    caps = await entitlement_service.caps_for(uuid.UUID(profile["id"]))

    me = await api_client.get("/v1/users/me", headers=headers)
    usage = await api_client.get("/v1/users/me/usage", headers=headers)

    assert me.status_code == 200 and me.json()["plan"] == caps.plan
    assert usage.json() == {
        "plan": caps.plan,
        "contract_pending": False,
        "features": caps.features,
        "capabilities": caps.http_view()["capabilities"],
    }


async def test_the_usage_route_keeps_its_503_wording(api_client, registration, gate, caplog):
    _, headers = await register(api_client, registration)
    gate.unavailable = True

    response = await api_client.get("/v1/users/me/usage", headers=headers)

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "pricing_unavailable",
        "error": f"Entitlements cannot be read right now: {PRICING_UNAVAILABLE.detail}",
    }
    assert REASON not in response.text
    assert REASON in caplog.text


async def test_the_profile_answers_while_pricing_is_unavailable(api_client, registration, gate):
    profile, headers = await register(api_client, registration)
    gate.unavailable = True

    me = await api_client.get("/v1/users/me", headers=headers)

    assert me.status_code == 200, me.text
    assert me.json()["id"] == profile["id"]
    assert me.json()["plan"] == DEFAULT_PLAN  # the plan recorded at registration, read from the database


async def test_a_route_503_equals_what_the_inline_translation_produced(gate):
    gate.unavailable = True
    user_id = uuid.uuid4()

    # The translation every migrated site wrote by hand before the service existed,
    # now with the fixed sentence instead of the text the pricing service gave.
    with pytest.raises(PricingUnavailable) as legacy:
        await space_client.get_gate().caps(user_id)
    assert REASON in str(legacy.value)
    expected = api_error(503, "pricing_unavailable", PRICING_UNAVAILABLE.detail)

    with pytest.raises(HTTPException) as actual:
        await entitlement_service.caps_or_503(user_id)

    assert (actual.value.status_code, actual.value.detail, actual.value.headers) == (
        expected.status_code,
        expected.detail,
        expected.headers,
    )

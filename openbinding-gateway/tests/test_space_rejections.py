"""How the SPACE adapter reports an answer it cannot use.

The 1.x client raises on a non-2xx answer. ``SpacePricingGate._call`` is the one
seam that maps it: a status with which SPACE refuses the request itself (400, 404,
409, 422) is a ``SubscriptionRejected``; credentials, throttling, server errors and
a missing connection are ``PricingUnavailable``. Neither message carries the host.
"""

from __future__ import annotations

import uuid

import pytest

from openbinding_gateway.core.settings import Settings
from openbinding_gateway.services.entitlements import EntitlementService, EntitlementsUnavailable
from openbinding_gateway.space_client import (
    PricingUnavailable,
    SpacePricingGate,
    SubscriptionRejected,
)
from space_client import SpaceError

HOST = "space.internal.example"
VERSION = "0.1.0"
REJECTED = [400, 404, 409, 422]
UNAVAILABLE = [401, 403, 429, 500, 502, 503]


class ApiError(SpaceError):
    """An answer from SPACE carrying its HTTP status, as the client raises it."""

    def __init__(self, status_code: int):
        super().__init__(f"Space answered {status_code} to POST https://{HOST}/api/v1/contracts")
        self.status_code = status_code


class Recorder:
    """Stands in for the client; ``failure`` is raised by every contract call."""

    def __init__(self, failure: BaseException | None = None):
        self.failure = failure
        self.calls: list[str] = []
        self.features = self._Features(self)
        self.contracts = self._Contracts(self)

    class _Features:
        def __init__(self, outer):
            self._outer = outer

        def generate_user_pricing_token(self, user_id):
            self._outer.calls.append("token")
            return "header.e30.signature"

    class _Contracts:
        def __init__(self, outer):
            self._outer = outer

        def _answer(self, name):
            self._outer.calls.append(name)
            if self._outer.failure is not None:
                raise self._outer.failure
            return {
                "contractedServices": {"openbinding": VERSION},
                "subscriptionPlans": {"openbinding": "BASIC"},
                "subscriptionAddOns": {},
                "billingPeriod": {},
            }

        def get_contract(self, user_id):
            return self._answer("get_contract")

        def add_contract(self, contract):
            self._answer("add_contract")
            self._outer.added = contract

        def update_contract_subscription(self, user_id, subscription):
            return self._answer("novate")


def gate_over(recorder: Recorder) -> SpacePricingGate:
    return SpacePricingGate(Settings(_env_file=None, space_pricing_version=VERSION), client=recorder)


async def outcome(awaitable) -> BaseException | None:
    """The exception an operation raised, or None; assertions then fail as AssertionError."""
    try:
        await awaitable
    except Exception as error:  # noqa: BLE001 - the type is what the test asserts
        return error
    return None


def assert_rejected(error: BaseException | None) -> None:
    assert isinstance(error, SubscriptionRejected), f"expected SubscriptionRejected, got {error!r}"
    assert HOST not in str(error)


def assert_unavailable(error: BaseException | None) -> None:
    assert isinstance(error, PricingUnavailable), f"expected PricingUnavailable, got {error!r}"
    assert not isinstance(error, SubscriptionRejected), f"an outage reported as a rejection: {error!r}"
    assert HOST not in str(error)


@pytest.mark.parametrize("status", REJECTED)
async def test_a_contract_space_rejects_raises_a_rejection(status):
    gate = gate_over(Recorder(ApiError(status)))

    assert_rejected(await outcome(gate.create_contract(uuid.uuid4(), "BASIC", "someone@example.org")))


@pytest.mark.parametrize("status", REJECTED)
async def test_a_novation_space_rejects_raises_a_rejection(status):
    gate = gate_over(Recorder(ApiError(status)))

    assert_rejected(await outcome(gate.change_subscription(uuid.uuid4(), "BASIC", {}, VERSION)))


@pytest.mark.parametrize("status", UNAVAILABLE)
async def test_other_statuses_are_an_outage_not_a_rejection(status):
    gate = gate_over(Recorder(ApiError(status)))

    assert_unavailable(await outcome(gate.create_contract(uuid.uuid4(), "BASIC", "someone@example.org")))
    assert_unavailable(await outcome(gate.change_subscription(uuid.uuid4(), "BASIC", {}, VERSION)))


@pytest.mark.parametrize(
    "failure",
    [
        SpaceError(f"Could not reach Space at https://{HOST}: refused"),
        ConnectionRefusedError(f"connect to {HOST} refused"),
    ],
)
async def test_no_connection_is_an_outage_not_a_rejection(failure):
    gate = gate_over(Recorder(failure))

    assert_unavailable(await outcome(gate.create_contract(uuid.uuid4(), "BASIC", "someone@example.org")))


async def test_a_created_contract_is_not_read_back():
    recorder = Recorder()

    await gate_over(recorder).create_contract(uuid.uuid4(), "BASIC", "someone@example.org")

    assert recorder.calls == ["add_contract"], recorder.calls


async def test_a_created_contract_has_no_phone():
    recorder = Recorder()

    await gate_over(recorder).create_contract(uuid.uuid4(), "BASIC", "someone@example.org")

    assert recorder.added.user_contact.phone is None, repr(recorder.added.user_contact.phone)


# -- ``_call`` also wraps ``get_contract``: a 404 there is now a rejection ------------------------


async def test_reading_a_missing_contract_raises_a_rejection():
    gate = gate_over(Recorder(ApiError(404)))

    assert_rejected(await outcome(gate.subscription(uuid.uuid4())))


async def test_caps_for_a_missing_contract_is_still_pricing_unavailable():
    gate = gate_over(Recorder(ApiError(404)))
    error = await outcome(gate.caps(uuid.uuid4()))

    # It is a PricingUnavailable (the base class every caller catches), and a rejection.
    assert isinstance(error, SubscriptionRejected), f"expected SubscriptionRejected, got {error!r}"
    assert isinstance(error, PricingUnavailable)


async def test_the_entitlement_service_answers_a_missing_contract_with_its_unavailable_error():
    gate = gate_over(Recorder(ApiError(404)))
    service = EntitlementService(lambda: gate)

    error = await outcome(service.caps_for(uuid.uuid4()))

    assert isinstance(error, EntitlementsUnavailable), f"expected EntitlementsUnavailable, got {error!r}"
    assert HOST not in str(error)

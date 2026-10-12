"""The SPACE adapter: how the gateway's vocabulary maps onto the client's.

The fake gate proves the gateway's own logic. These prove the translation, and
the translation is where the surprises were - every one of the behaviours
asserted below was learned by watching SPACE refuse something, and
each would fail silently rather than loudly if it regressed:

* plan ceilings come from the pricing token, because a contract records only
  what has been consumed, never the allowance;
* a contract the client quietly refused is read back and reported;
* the gateway only reads and manages contracts - it consumes nothing.
"""

from __future__ import annotations

import base64
import json
import uuid

import pytest

from _pricing import largest_plan, pricing_catalog
from openbinding_gateway.core.settings import Settings
from openbinding_gateway.space_client import FakePricingGate, PricingGate, PricingUnavailable, SpacePricingGate

CATALOG = pricing_catalog()
DEFAULT_PLAN = CATALOG.default_plan
LARGER_PLAN = largest_plan()
API_KEYS = "apiKeys"
MAX_TIMEOUT = "maxTimeoutSeconds"
MAX_PAYLOAD = "maxPayloadBytes"
MISSING = object()


def contract_for(
    plan: str = DEFAULT_PLAN,
    *,
    version: str = CATALOG.version,
    add_ons: dict[str, int] | None = None,
    end_date: str | None = None,
) -> dict:
    return {
        "contractedServices": {"openbinding": version},
        "subscriptionPlans": {"openbinding": plan},
        "subscriptionAddOns": {"openbinding": add_ons or {}},
        "billingPeriod": {"endDate": end_date} if end_date else {},
    }


def a_token(limits=None, features=None) -> str:
    """A pricing token shaped like the ones SPACE issues."""
    claims = {
        "pricingContext": {
            "features": {f"openbinding-{k}": v for k, v in (features or {}).items()},
            "usageLimits": {f"openbinding-{k}": v for k, v in (limits or {}).items()},
        },
    }
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


class Recorder:
    """Stands in for the client, remembering how it was called."""

    def __init__(self, *, token=None, contract=MISSING, explode=False):
        self.calls: list[tuple] = []
        self._token = token
        self._contract = contract_for() if contract is MISSING else contract
        self._explode = explode
        self.features = self._Features(self)
        self.contracts = self._Contracts(self)

    def _record(self, name, *args):
        if self._explode:
            raise RuntimeError("connection refused")
        self.calls.append((name, *args))

    class _Features:
        def __init__(self, outer):
            self._outer = outer

        def generate_user_pricing_token(self, user_id):
            self._outer._record("token", user_id)
            return self._outer._token

    class _Contracts:
        def __init__(self, outer):
            self._outer = outer

        def get_contract(self, user_id):
            self._outer._record("get_contract", user_id)
            return self._outer._contract

        def add_contract(self, contract):
            self._outer._record("add_contract", contract)
            # A working SPACE has the contract afterwards, and the gate reads it
            # back to tell "created" from "silently refused" - which the real
            # client cannot express, since it returns None either way.
            self._outer._contract = contract
            return contract

        def update_contract_subscription(self, user_id, subscription):
            self._outer._record("novate", user_id, subscription)
            return subscription


@pytest.fixture(autouse=True)
def a_pristine_environment(monkeypatch):
    """Defaults are what a deployment gets when it sets nothing.

    Importing ``main`` runs ``load_dotenv()``, which puts the developer's own
    ``.env`` into the process environment - so once somebody configured SPACE
    locally, these tests started asserting against their machine rather than
    against the defaults. Clearing the keys under test is the only way the
    question stays the intended one.
    """
    for name in (
        "SPACE_ENABLED",
        "SPACE_URL",
        "SPACE_API_KEY",
        "SPACE_FAIL_MODE",
        "SPACE_TIMEOUT_MS",
        "FEDERATION_SECRET_KEY",
        "FEDERATION_REQUIRE_HTTPS",
    ):
        monkeypatch.delenv(name, raising=False)


def gate_over(recorder: Recorder) -> SpacePricingGate:
    async def resolve(version: str):
        if version != CATALOG.version:
            raise AssertionError(f"unexpected catalog version {version}")
        return CATALOG

    return SpacePricingGate(
        Settings(_env_file=None), client=recorder, catalog_resolver=resolve
    )


@pytest.fixture
def user_id() -> uuid.UUID:
    return uuid.uuid4()


def test_it_refuses_to_start_without_a_url_or_key():
    # Failing at construction beats failing on the first solve of the day.
    with pytest.raises(ValueError):
        SpacePricingGate(Settings(_env_file=None, space_enabled=True))


@pytest.mark.parametrize("gate_class", [PricingGate, SpacePricingGate, FakePricingGate])
def test_no_gate_offers_to_evaluate_or_consume(gate_class):
    consuming = [name for name in dir(gate_class) if any(word in name for word in ("usage", "evaluat", "revert"))]

    assert consuming == []


async def test_ceilings_come_from_the_pricing_token(user_id):
    # A contract records consumption only; the allowance lives in the pricing,
    # and the token is where the two meet.
    recorder = Recorder(
        token=a_token(limits={MAX_TIMEOUT: 1800, MAX_PAYLOAD: 512 * 1024 * 1024})
    )

    caps = await gate_over(recorder).caps(user_id)

    assert caps.limit("maxTimeoutSeconds") == 1800
    assert caps.limit("maxPayloadBytes") == 512 * 1024 * 1024


async def test_features_come_from_the_pricing_token(user_id):
    recorder = Recorder(token=a_token(features={"solve": True, "studies": False}))

    caps = await gate_over(recorder).caps(user_id)

    assert caps.allows("solve") is True
    assert caps.allows("studies") is False
    assert caps.allows("federatedEngines") is False  # absent fails closed


async def test_missing_ceilings_fail_closed(user_id):
    recorder = Recorder(token=a_token(limits={API_KEYS: 100}))

    caps = await gate_over(recorder).caps(user_id)

    assert caps.limit("maxTimeoutSeconds") == 0
    assert caps.limit("maxIterations") == 0


async def test_api_key_cap_is_one_on_basic_and_unlimited_on_pro(user_id):
    basic = Recorder(token=a_token(limits={API_KEYS: 1}))
    pro = Recorder(
        token=a_token(limits={API_KEYS: None}),
        contract=contract_for(LARGER_PLAN),
    )

    assert (await gate_over(basic).caps(user_id)).limit("apiKeys") == 1
    assert (await gate_over(pro).caps(user_id)).limit("apiKeys") is None


async def test_an_account_with_no_token_is_pricing_unavailable(user_id):
    with pytest.raises(PricingUnavailable, match="entitlements"):
        await gate_over(Recorder(token=None)).caps(user_id)


async def test_the_plan_comes_from_the_contract(user_id):
    recorder = Recorder(
        token=a_token(limits={MAX_TIMEOUT: 100}),
        contract=contract_for(LARGER_PLAN),
    )

    assert (await gate_over(recorder).caps(user_id)).plan == LARGER_PLAN


async def test_a_contract_is_created_for_the_service_and_plan(user_id):
    recorder = Recorder()

    await gate_over(recorder).create_contract(
        user_id, DEFAULT_PLAN, "someone@example.org", CATALOG.version
    )

    contract = recorder.calls[0][1]
    assert contract.subscription_plans == {"openbinding": DEFAULT_PLAN}
    assert contract.user_contact.email == "someone@example.org"


async def test_a_contract_that_space_quietly_refused_is_an_error(user_id):
    """The failure mode that produced accounts with no contract at all.

    ``add_contract`` returns None whether SPACE created the contract or refused
    it - the client turns a 400 into a quiet None. So when the plans were
    renamed and the gateway kept asking for a pricing version that no longer
    declared them, SPACE answered "Plan BASIC for service openbinding not found"
    and registration reported success for days.

    Reading the contract back is what tells the two apart.
    """
    recorder = Recorder(contract=None)
    recorder.contracts.add_contract = lambda contract: None  # accepted nothing

    with pytest.raises(PricingUnavailable) as error:
        await gate_over(recorder).create_contract(
            user_id, DEFAULT_PLAN, "someone@example.org", CATALOG.version
        )

    # The message has to name the likely cause, because the API says nothing.
    assert "pricing version" in str(error.value)


async def test_a_contract_requires_an_explicit_pricing_version(user_id):
    with pytest.raises(PricingUnavailable, match="exact LIVE pricing version"):
        await gate_over(Recorder()).create_contract(
            user_id, DEFAULT_PLAN, "someone@example.org"
        )


async def test_a_new_contract_spells_out_an_empty_phone(user_id):
    # Left unset the client serialises it as null, and SPACE rejects that with
    # "phone must be a string". An empty string satisfies both.
    recorder = Recorder()

    await gate_over(recorder).create_contract(
        user_id, DEFAULT_PLAN, "someone@example.org", CATALOG.version
    )

    assert recorder.calls[0][1].user_contact.phone == ""


async def test_changing_plan_novates_the_subscription(user_id):
    recorder = Recorder()

    await gate_over(recorder).change_plan(user_id, LARGER_PLAN, CATALOG.version)

    name, user, subscription = next(call for call in recorder.calls if call[0] == "novate")
    assert (name, user) == ("novate", str(user_id))
    assert subscription.subscription_plans == {"openbinding": LARGER_PLAN}


async def test_an_expired_contract_is_novated_to_live_with_plan_and_add_ons_preserved(user_id):
    add_on_name, add_on = next(iter(CATALOG.add_ons.items()))
    plan = next(iter(add_on.available_for))
    selected = {add_on_name: add_on.minimum}
    recorder = Recorder(
        contract=contract_for(
            plan,
            version="previous-version",
            add_ons=selected,
            end_date="2020-01-01T00:00:00Z",
        )
    )

    changed = await gate_over(recorder).migrate_due_contract(user_id, CATALOG.version)

    assert changed is True
    subscription = next(call[2] for call in recorder.calls if call[0] == "novate")
    assert subscription.contracted_services == {"openbinding": CATALOG.version}
    assert subscription.subscription_plans == {"openbinding": plan}
    assert subscription.subscription_add_ons == {"openbinding": selected}


async def test_a_contract_is_not_migrated_before_its_renewal(user_id):
    recorder = Recorder(
        contract=contract_for(
            version="previous-version", end_date="2999-01-01T00:00:00Z"
        )
    )

    changed = await gate_over(recorder).migrate_due_contract(user_id, CATALOG.version)

    assert changed is False
    assert all(call[0] != "novate" for call in recorder.calls)


async def test_a_pricing_token_is_returned(user_id):
    token = a_token(limits={MAX_TIMEOUT: 100})

    assert await gate_over(Recorder(token=token)).pricing_token(user_id) == token


async def test_a_pricing_token_that_never_arrives_is_an_outage(user_id):
    with pytest.raises(PricingUnavailable):
        await gate_over(Recorder(token=None)).pricing_token(user_id)


async def test_an_unreachable_space_is_an_outage_not_a_refusal(user_id):
    # The difference decides what SPACE_FAIL_MODE does; a refusal is never
    # negotiable, an outage might be.
    with pytest.raises(PricingUnavailable):
        await gate_over(Recorder(explode=True)).caps(user_id)


async def test_entries_belonging_to_another_service_are_ignored(user_id):
    # One SPACE instance serves several services, and one token can carry all
    # of them.
    claims = {
        "pricingContext": {
            "usageLimits": {f"openbinding-{MAX_TIMEOUT}": 100, "petclinic-maxPets": 7},
            "features": {},
        },
    }
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    recorder = Recorder(token=f"h.{payload}.s")

    caps = await gate_over(recorder).caps(user_id)

    assert MAX_TIMEOUT in caps.limits
    assert "maxPets" not in caps.limits

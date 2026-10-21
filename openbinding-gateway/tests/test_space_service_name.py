"""``SPACE_SERVICE_NAME``: the one name the gateway asks SPACE about.

Production uses ``openbinding``. A development deployment points the same code
at its own SPACE service (``openbinding-dev``); because one SPACE organization
does not isolate credentials, the only protection is that every call carries the
configured name and never the production one. These tests drive the real SPACE
adapter over a recorder that fails the moment a call mentions ``openbinding``
while another service is configured.
"""

from __future__ import annotations

import base64
import json
import logging
import uuid

import pytest
from pydantic import ValidationError

from openbinding_gateway import space_client
from openbinding_gateway.core.settings import DEFAULT_SPACE_SERVICE_NAME, Settings
from openbinding_gateway.space_client import SpacePricingGate, feature_id

PRODUCTION = "openbinding"
DEV = "openbinding-dev"
PLAN = "BASIC"
OTHER_PLAN = "PRO"
VERSION = "0.1.0"
API_KEY = "never-logged-api-key"


def a_token(service: str, features: dict[str, bool], limits: dict[str, float]) -> str:
    """A pricing token shaped like SPACE's: names qualified by service, other services included."""
    claims = {
        "pricingContext": {
            "features": {f"{service}-{k}": v for k, v in features.items()}
            | {"openbinding-productionOnly": True},
            "usageLimits": {f"{service}-{k}": v for k, v in limits.items()}
            | {"openbinding-productionLimit": 1},
        },
    }
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


class ServiceRecorder:
    """Stands in for SPACE's client, holding one contract per service name."""

    def __init__(self, service: str):
        self.service = service
        self.calls: list[tuple] = []
        self.contract = {
            "contractedServices": {service: VERSION, PRODUCTION: "9.9.9"},
            "subscriptionPlans": {service: PLAN, PRODUCTION: "PRODUCTION-PLAN"},
            "subscriptionAddOns": {service: {"seats": 2}, PRODUCTION: {"seats": 99}},
            "billingPeriod": {},
        }
        self.features = self._Features(self)
        self.contracts = self._Contracts(self)

    class _Features:
        def __init__(self, outer: "ServiceRecorder"):
            self._outer = outer

        def generate_user_pricing_token(self, user_id):
            self._outer.calls.append(("token", user_id))
            return a_token(self._outer.service, {"solve": True, "export": False}, {"maxJobs": 7})

    class _Contracts:
        def __init__(self, outer: "ServiceRecorder"):
            self._outer = outer

        def get_contract(self, user_id):
            self._outer.calls.append(("get_contract", user_id))
            return self._outer.contract

        def add_contract(self, contract):
            self._outer.calls.append(("add_contract", contract))
            self._outer.contract = {
                "contractedServices": dict(contract.contracted_services),
                "subscriptionPlans": dict(contract.subscription_plans),
                "subscriptionAddOns": {},
                "billingPeriod": {},
            }
            return contract

        def update_contract_subscription(self, user_id, subscription):
            self._outer.calls.append(("novate", user_id, subscription))
            return subscription


def gate_for(service: str | None, recorder: ServiceRecorder, monkeypatch) -> SpacePricingGate:
    monkeypatch.delenv("SPACE_SERVICE_NAME", raising=False)
    options = {} if service is None else {"space_service_name": service}
    return SpacePricingGate(Settings(_env_file=None, space_pricing_version=VERSION, **options), client=recorder)


@pytest.fixture(autouse=True)
def a_pristine_environment(monkeypatch):
    for name in ("SPACE_ENABLED", "SPACE_URL", "SPACE_API_KEY", "SPACE_PRICING_VERSION", "SPACE_SERVICE_NAME"):
        monkeypatch.delenv(name, raising=False)


def services_in(*mappings) -> set[str]:
    return {key for mapping in mappings for key in mapping}


# -- the configured name reaches every call ------------------------------------------------------


async def test_caps_read_only_the_configured_service(monkeypatch):
    recorder = ServiceRecorder(DEV)
    caps = await gate_for(DEV, recorder, monkeypatch).caps(uuid.uuid4())

    assert caps.plan == PLAN  # not the production plan sitting in the same contract
    assert caps.features == {"solve": True, "export": False}  # the production-only names are dropped
    assert caps.limits == {"maxJobs": 7.0}
    assert [call[0] for call in recorder.calls] == ["token", "get_contract"]


async def test_the_subscription_snapshot_is_the_configured_services(monkeypatch):
    snapshot = await gate_for(DEV, ServiceRecorder(DEV), monkeypatch).subscription(uuid.uuid4())

    assert (snapshot.plan, snapshot.pricing_version, snapshot.add_ons) == (PLAN, VERSION, {"seats": 2})


async def test_a_new_contract_is_created_for_the_configured_service_only(monkeypatch):
    recorder = ServiceRecorder(DEV)
    await gate_for(DEV, recorder, monkeypatch).create_contract(uuid.uuid4(), PLAN, "someone@example.org")

    contract = next(call[1] for call in recorder.calls if call[0] == "add_contract")
    assert contract.contracted_services == {DEV: VERSION}
    assert contract.subscription_plans == {DEV: PLAN}
    assert PRODUCTION not in services_in(contract.contracted_services, contract.subscription_plans)


async def test_a_refused_contract_names_the_configured_service(monkeypatch):
    recorder = ServiceRecorder(DEV)
    recorder.contracts.add_contract = lambda contract: setattr(recorder, "contract", None)

    with pytest.raises(space_client.PricingUnavailable) as error:
        await gate_for(DEV, recorder, monkeypatch).create_contract(uuid.uuid4(), PLAN, "someone@example.org")

    assert f"'{DEV}'" in str(error.value)


async def test_a_novation_targets_the_configured_service_and_keeps_its_add_ons(monkeypatch):
    recorder = ServiceRecorder(DEV)
    await gate_for(DEV, recorder, monkeypatch).change_plan(uuid.uuid4(), OTHER_PLAN)

    subscription = next(call[2] for call in recorder.calls if call[0] == "novate")
    assert subscription.contracted_services == {DEV: VERSION}
    assert subscription.subscription_plans == {DEV: OTHER_PLAN}
    assert subscription.subscription_add_ons == {DEV: {"seats": 2}}


async def test_no_operation_ever_mentions_the_production_service(monkeypatch):
    recorder = ServiceRecorder(DEV)
    gate = gate_for(DEV, recorder, monkeypatch)
    user_id = uuid.uuid4()

    await gate.caps(user_id)
    await gate.subscription(user_id)
    await gate.create_contract(user_id, PLAN, "someone@example.org")
    await gate.change_subscription(user_id, OTHER_PLAN, {"seats": 1})
    await gate.pricing_token(user_id)

    sent = [
        call[-1]
        for call in recorder.calls
        if call[0] in ("add_contract", "novate")
    ]
    assert len(sent) == 2
    for model in sent:
        assert PRODUCTION not in services_in(
            model.contracted_services, model.subscription_plans, model.subscription_add_ons or {}
        )


def test_feature_identifiers_carry_the_configured_service_name():
    assert feature_id("solve", DEV) == "openbinding-dev-solve"
    assert feature_id("solve") == "openbinding-solve"


# -- the default is unchanged --------------------------------------------------------------------


def test_the_default_service_name_is_openbinding(monkeypatch):
    monkeypatch.delenv("SPACE_SERVICE_NAME", raising=False)
    assert DEFAULT_SPACE_SERVICE_NAME == PRODUCTION
    assert Settings(_env_file=None).space_service_name == PRODUCTION


async def test_without_configuration_the_gate_still_speaks_to_openbinding(monkeypatch):
    recorder = ServiceRecorder(PRODUCTION)
    recorder.contract = {
        "contractedServices": {PRODUCTION: VERSION},
        "subscriptionPlans": {PRODUCTION: PLAN},
        "subscriptionAddOns": {},
        "billingPeriod": {},
    }
    gate = gate_for(None, recorder, monkeypatch)

    assert (await gate.caps(uuid.uuid4())).plan == PLAN
    await gate.create_contract(uuid.uuid4(), PLAN, "someone@example.org")
    contract = next(call[1] for call in recorder.calls if call[0] == "add_contract")
    assert contract.contracted_services == {PRODUCTION: VERSION}


def test_the_service_name_is_read_from_the_environment(monkeypatch):
    monkeypatch.setenv("SPACE_SERVICE_NAME", DEV)
    assert Settings(_env_file=None).space_service_name == DEV


# -- validation ----------------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["openbinding-dev", "openbinding", "ab", "a_b-1", "0service", "x" * 63])
def test_valid_service_names_are_accepted(name):
    assert Settings(_env_file=None, space_service_name=name).space_service_name == name


@pytest.mark.parametrize(
    "name", ["", "a", "OpenBinding", "-dev", "_dev", "has space", "dev.service", "dev/service", "é-dev", "x" * 64, "dev\n"]
)
def test_invalid_service_names_are_rejected(name):
    with pytest.raises(ValidationError, match="SPACE_SERVICE_NAME"):
        Settings(_env_file=None, space_service_name=name)


def test_an_invalid_environment_value_stops_the_start(monkeypatch):
    monkeypatch.setenv("SPACE_SERVICE_NAME", "Not Valid")
    with pytest.raises(ValidationError, match="SPACE_SERVICE_NAME"):
        Settings(_env_file=None)


@pytest.mark.parametrize("app_env", ["dev", "test", "prod"])
def test_the_name_is_not_restricted_by_the_environment(app_env, monkeypatch):
    extra = {"space_enabled": True, "gateway_jwt_secret": "s" * 32, "cors_allow_origins": "https://example.org"}
    for name in (PRODUCTION, DEV):
        settings = Settings(_env_file=None, app_env=app_env, space_service_name=name, **extra)
        assert settings.space_service_name == name


# -- start-up log --------------------------------------------------------------------------------


@pytest.mark.parametrize("service", [DEV, PRODUCTION])
def test_start_up_logs_the_effective_service_name_and_no_key(service, monkeypatch, caplog):
    monkeypatch.setattr(space_client, "SpacePricingGate", lambda settings: object())
    # Running alembic in-process (applies ``fileConfig``) disables every logger that existed then.
    monkeypatch.setattr(space_client.logger, "disabled", False)
    settings = Settings(
        _env_file=None,
        space_enabled=True,
        space_url="https://space.example.org",
        space_api_key=API_KEY,
        space_service_name=service,
    )

    with caplog.at_level(logging.INFO, logger=space_client.logger.name):
        space_client.build_gate(settings)

    text = "\n".join(record.getMessage() for record in caplog.records)
    assert f"SPACE service name: {service}" in text
    assert API_KEY not in text and "space.example.org" not in text

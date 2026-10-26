"""The names the gateway uses from ``space-python-client`` still exist, offline.

Nothing here talks to SPACE: the installed package is introspected, the models
are built with the arguments the gateway passes, and no client is created. A
client upgrade that renames or reshapes a name the gateway relies on fails here
first, and the recorded SPHERE pricing fixture is checked against the pricing
document it was derived from.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.metadata
import inspect
import json
import math
from pathlib import Path

import pytest
import yaml

from space_client import AsyncSpaceClient, SpaceClientFactory, SpaceError
from space_client.modules import contract_module, feature_module
from space_client.types.models import (
    BillingPeriodToCreate,
    Contract,
    ContractToCreate,
    Subscription,
    UsageLevel,
    UserContact,
)
from space_client.types.space_event import SpaceEvent

DISTRIBUTION = "space-python-client"
# The range declared in pyproject.toml; kept literal so a drift is a visible diff.
DECLARED_RANGE = ">=1.0,<2.0"

TESTS = Path(__file__).resolve().parent
PRICING_YAML = TESTS.parent.parent / "docs" / "pricing" / "openbinding-0.2.0.yml"
PRICING_FIXTURE = TESTS / "fixtures" / "pricing" / "sphere_public_pricing_0.2.0.json"
# Digest of the file as committed in this tree (the fixture was derived from it).
PRICING_SHA256 = "4b9c7203c2771991be54c11bddf1fee5fc385c8cc5fa28b21e6d06b37d5b75b1"

# Names the M4.2 plan needs beyond today's gateway code and the installed client
# provides (verified below). Absent from 1.0.0: a dedicated usage-level read
# (usage levels come back inside ``Contract.usage_levels``) and any batch
# usage-level read.
AVAILABLE_FOR_M4_2 = {
    "AsyncSpaceClient.on",
    "AsyncSpaceClient.remove_listener",
    "AsyncSpaceClient.connect",
    "AsyncSpaceClient.disconnect",
    "SpaceEvent.pricing_created",
    "SpaceEvent.pricing_archived",
    "SpaceEvent.pricing_actived",
    "SpaceEvent.service_disabled",
    "SpaceEvent.synchronized",
    "SpaceEvent.error",
    "AsyncContractModule.update_contract_usage_levels",
    "AsyncContractModule.update_contract_subscription_by_group_id",
    "AsyncFeatureModule.evaluate",
    "AsyncFeatureModule.revert_evaluation",
    "Contract.usage_levels",
    "UsageLevel.consumed",
    "UsageLevel.reset_time_stamp",
}


def _bind(function, *args, **kwargs) -> None:
    """Raise TypeError unless ``function`` accepts exactly these arguments."""
    inspect.signature(function).bind(*args, **kwargs)


def _field_names(model) -> set[str]:
    return set(inspect.signature(model).parameters)


def test_installed_version_satisfies_declared_range():
    installed = importlib.metadata.version(DISTRIBUTION)
    # ">=1.0,<2.0" is exactly "major version 1"; no extra dependency to parse it.
    assert installed.split(".")[0] == "1", (
        f"{DISTRIBUTION} {installed} is outside {DECLARED_RANGE}"
    )


def test_declared_range_matches_pyproject():
    text = (TESTS.parent / "pyproject.toml").read_text(encoding="utf-8")
    assert f'"{DISTRIBUTION}{DECLARED_RANGE}"' in text


def test_factory_and_error_names():
    assert inspect.isclass(SpaceError) and issubclass(SpaceError, Exception)
    assert callable(SpaceClientFactory.connect_async)
    # The gateway calls connect_async(url, api_key, timeout_ms) positionally.
    _bind(SpaceClientFactory.connect_async, "https://space.invalid", "key", 1000)
    # It is synchronous: it returns the client, which the gateway never awaits.
    assert not inspect.iscoroutinefunction(SpaceClientFactory.connect_async)


@pytest.mark.parametrize(
    ("module", "cls", "method", "args"),
    [
        (feature_module, "AsyncFeatureModule", "generate_user_pricing_token", ("user",)),
        (contract_module, "AsyncContractModule", "get_contract", ("user",)),
        (contract_module, "AsyncContractModule", "add_contract", (object(),)),
        (contract_module, "AsyncContractModule", "update_contract_subscription", ("user", object())),
        (contract_module, "AsyncContractModule", "remove_contract", ("user",)),
    ],
)
def test_async_client_methods_the_gateway_calls(module, cls, method, args):
    function = getattr(getattr(module, cls), method)
    _bind(function, None, *args)
    # Module methods hand back the awaitable of the async runner, so the client
    # is awaited at the gateway's single seam.
    assert inspect.iscoroutinefunction(getattr(module, cls)._run)


def test_client_exposes_both_modules_and_an_awaited_close():
    assert inspect.iscoroutinefunction(AsyncSpaceClient.close)
    _bind(AsyncSpaceClient.close, None)
    wiring = inspect.getsource(AsyncSpaceClient.__init__)
    assert "self.contracts = AsyncContractModule(" in wiring
    assert "self.features = AsyncFeatureModule(" in wiring


def test_sync_modules_are_not_the_async_ones():
    # The gateway awaits what it calls; a sync module would return plain values.
    assert not inspect.iscoroutinefunction(contract_module.ContractModule._run)
    assert not inspect.iscoroutinefunction(feature_module.FeatureModule._run)


def test_model_constructors_accept_what_the_gateway_passes():
    contact = UserContact(user_id="u", username="u", email="a@b.c", phone="")
    period = BillingPeriodToCreate(auto_renew=True, renewal_days=30)
    ContractToCreate(
        user_contact=contact,
        billing_period=period,
        contracted_services={"openbinding": "0.2.0"},
        subscription_plans={"openbinding": "FREE"},
        subscription_add_ons={},
    )
    Subscription(
        contracted_services={"openbinding": "0.2.0"},
        subscription_plans={"openbinding": "FREE"},
        subscription_add_ons={"openbinding": {"extra": 1}},
    )
    assert _field_names(UserContact) >= {"user_id", "username", "email", "phone"}
    assert _field_names(BillingPeriodToCreate) >= {"auto_renew", "renewal_days"}
    assert _field_names(ContractToCreate) >= {
        "user_contact",
        "billing_period",
        "contracted_services",
        "subscription_plans",
        "subscription_add_ons",
    }
    assert _field_names(Subscription) == {
        "contracted_services",
        "subscription_plans",
        "subscription_add_ons",
    }


def test_contract_fields_the_gateway_reads():
    # ``_attribute`` in space.py reads these names from the returned contract.
    assert _field_names(Contract) >= {
        "contracted_services",
        "subscription_plans",
        "subscription_add_ons",
        "billing_period",
    }
    assert "end_date" in _field_names(importlib.import_module("space_client.types.models").BillingPeriod)


def test_m4_2_names_are_available():
    """The explicit list of names M4.2 may build on, present in the installed client."""
    classes = {
        "AsyncSpaceClient": AsyncSpaceClient,
        "AsyncContractModule": contract_module.AsyncContractModule,
        "AsyncFeatureModule": feature_module.AsyncFeatureModule,
    }
    missing = []
    for name in sorted(AVAILABLE_FOR_M4_2):
        owner, attribute = name.split(".")
        if owner == "SpaceEvent":
            found = attribute in {member.value for member in SpaceEvent}
        elif owner == "Contract":
            found = attribute in _field_names(Contract)
        elif owner == "UsageLevel":
            found = attribute in _field_names(UsageLevel)
        else:
            found = callable(getattr(classes[owner], attribute, None))
        if not found:
            missing.append(name)
    assert not missing, f"missing from the installed client: {missing}"


def test_m4_2_usage_and_event_signatures():
    _bind(
        contract_module.AsyncContractModule.update_contract_usage_levels,
        None,
        "user",
        "openbinding",
        {"solverHours": 1.5},
    )
    _bind(feature_module.AsyncFeatureModule.evaluate, None, "user", "feature", {"solverHours": 1})
    _bind(AsyncSpaceClient.on, None, "pricing_created", lambda payload: None)


def _unlimited_as_null(value):
    if isinstance(value, float) and math.isinf(value):
        return None
    if isinstance(value, dict):
        return {key: _unlimited_as_null(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_unlimited_as_null(item) for item in value]
    return value


def test_pricing_source_digest():
    assert hashlib.sha256(PRICING_YAML.read_bytes()).hexdigest() == PRICING_SHA256


def test_pricing_fixture_embeds_the_pricing_document():
    fixture = json.loads(PRICING_FIXTURE.read_text(encoding="utf-8"))
    document = yaml.safe_load(PRICING_YAML.read_text(encoding="utf-8"))
    assert fixture["pricing"] == _unlimited_as_null(document)
    # The metadata the gateway's SPHERE client reads.
    assert fixture["slug"] == "openbinding"
    assert fixture["version"] == document["version"] == fixture["pricing"]["version"]
    assert fixture["private"] is False
    assert fixture["yaml"].endswith(".yml")

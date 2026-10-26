"""The names the gateway uses from ``space-python-client`` still exist, offline.

Nothing here talks to SPACE. The installed package is introspected, the models are
built with the arguments the gateway passes, and one ``AsyncSpaceClient`` is built
against ``https://space.invalid``: its constructor opens no connection (the WebSocket
opens only in ``connect()``, HTTP only when a call is awaited), and every call made
on it below is closed before it is awaited. A client upgrade that renames or
reshapes a name the gateway relies on fails here first. The pricing fixture
(``fixtures/pricing``) is checked against the docs pricing it was derived from.

Limit: event registration cannot be observed through the public API (``on`` ignores
an unknown event name silently and the callbacks are private state), so the event
names are checked against ``SpaceEvent`` and ``on`` is only shown to accept them.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import inspect
import json
from pathlib import Path

import pytest
import yaml

from space_client import AsyncSpaceClient, SpaceClientFactory, SpaceConnectionOptions, SpaceError
from space_client.modules import contract_module, feature_module
from space_client.types.models import (
    BillingPeriod,
    BillingPeriodToCreate,
    Contract,
    ContractToCreate,
    FeatureEvaluationResult,
    Subscription,
    UsageLevel,
    UserContact,
)
from space_client.types.space_event import SpaceEvent

DISTRIBUTION = "space-python-client"
# The range declared in pyproject.toml; kept literal so a drift is a visible diff.
DECLARED_RANGE = ">=1.0,<2.0"
# The version in uv.lock; bump it with the lock in the same change.
LOCKED_VERSION = "1.0.0"

TESTS = Path(__file__).resolve().parent
DOCS_YAML = TESTS.parent.parent / "docs" / "pricing" / "openbinding-0.2.0.yml"
FIXTURES = TESTS / "fixtures" / "pricing"
YAML_COPY = FIXTURES / "openbinding-0.2.0.yml"
MANIFEST = FIXTURES / "manifest.json"

# The events M4.2 listens to (the client's spelling, ``pricing_actived`` included).
M4_2_EVENTS = (
    "synchronized",
    "pricing_created",
    "pricing_actived",
    "pricing_archived",
    "service_disabled",
)

# Names the M4.2 plan needs beyond today's gateway code and the installed client
# provides (verified below). Absent from 1.0.0: a dedicated usage-level read
# (usage levels come back inside ``Contract.usage_levels``) and any batch
# usage-level read.
AVAILABLE_FOR_M4_2 = {
    "AsyncSpaceClient.on",
    "AsyncSpaceClient.remove_listener",
    "AsyncSpaceClient.remove_all_listeners",
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


def _contract_to_create() -> ContractToCreate:
    return ContractToCreate(
        user_contact=UserContact(user_id="u", username="u", email="a@b.c", phone=""),
        billing_period=BillingPeriodToCreate(auto_renew=True, renewal_days=30),
        contracted_services={"openbinding": "0.2.0"},
        subscription_plans={"openbinding": "FREE"},
        subscription_add_ons={},
    )


def _subscription() -> Subscription:
    return Subscription(
        contracted_services={"openbinding": "0.2.0"},
        subscription_plans={"openbinding": "FREE"},
        subscription_add_ons={"openbinding": {"extra": 1}},
    )


@pytest.fixture
def client():
    """An offline client: building it opens no socket and sends no request."""
    built = AsyncSpaceClient(SpaceConnectionOptions(url="https://space.invalid", api_key="k"))
    yield built
    asyncio.run(built.close())


def test_installed_version_satisfies_declared_range():
    installed = importlib.metadata.version(DISTRIBUTION)
    # ">=1.0,<2.0" is exactly "major version 1"; no extra dependency to parse it.
    assert installed.split(".")[0] == "1", f"{DISTRIBUTION} {installed} is outside {DECLARED_RANGE}"


def test_installed_version_is_the_locked_one():
    # The bindings below were checked against this release; move it with uv.lock.
    assert importlib.metadata.version(DISTRIBUTION) == LOCKED_VERSION


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


def test_client_exposes_the_async_modules(client):
    assert isinstance(client.contracts, contract_module.AsyncContractModule)
    assert isinstance(client.features, feature_module.AsyncFeatureModule)
    assert inspect.iscoroutinefunction(AsyncSpaceClient.close)
    _bind(AsyncSpaceClient.close, None)


@pytest.mark.parametrize(
    ("module", "method", "make_args"),
    [
        ("features", "generate_user_pricing_token", lambda: ("user",)),
        ("contracts", "get_contract", lambda: ("user",)),
        ("contracts", "add_contract", lambda: (_contract_to_create(),)),
        ("contracts", "update_contract_subscription", lambda: ("user", _subscription())),
        ("contracts", "remove_contract", lambda: ("user",)),
    ],
)
def test_async_client_methods_the_gateway_calls(client, module, method, make_args):
    # The gateway awaits these at its single seam: each call must hand back an awaitable.
    call = getattr(getattr(client, module), method)(*make_args())
    try:
        assert inspect.isawaitable(call)
    finally:
        if inspect.iscoroutine(call):
            call.close()  # never awaited, so nothing is sent


def test_model_constructors_accept_what_the_gateway_passes():
    _contract_to_create()
    _subscription()
    assert _field_names(UserContact) >= {"user_id", "username", "email", "phone"}
    assert _field_names(BillingPeriodToCreate) >= {"auto_renew", "renewal_days"}
    assert _field_names(ContractToCreate) >= {
        "user_contact",
        "billing_period",
        "contracted_services",
        "subscription_plans",
        "subscription_add_ons",
    }
    assert _field_names(Subscription) >= {
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
    assert "end_date" in _field_names(BillingPeriod)


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


def test_m4_2_usage_and_evaluation_signatures():
    contracts = contract_module.AsyncContractModule
    features = feature_module.AsyncFeatureModule
    _bind(contracts.update_contract_usage_levels, None, "u", "openbinding", {"solverHours": 1.5})
    _bind(contracts.update_contract_subscription_by_group_id, None, "group", _subscription())
    _bind(features.evaluate, None, "u", "f", expected_consumption={"solverHours": 1})
    _bind(features.revert_evaluation, None, "u", "f", revert_to_latest=True)


def test_m4_2_result_fields():
    # The evaluation outcome M4.2 reads; ``used`` and ``limit`` are keyed by usage limit.
    assert _field_names(FeatureEvaluationResult) >= {"eval", "used", "limit", "error"}
    annotation = inspect.signature(Contract).parameters["usage_levels"].annotation
    # Annotations are strings under ``from __future__ import annotations``.
    assert "UsageLevel" in str(annotation)


def test_m4_2_events_register_on_the_client(client):
    for name in M4_2_EVENTS:
        assert SpaceEvent.from_string(name) is not None, name
        client.on(name, lambda payload: None)
    client.remove_listener(M4_2_EVENTS[0])
    client.remove_all_listeners()


def test_pricing_yaml_copy_is_the_docs_file():
    assert YAML_COPY.read_bytes() == DOCS_YAML.read_bytes(), (
        f"{YAML_COPY} differs from {DOCS_YAML}: refresh it with "
        f"`cp {DOCS_YAML} {YAML_COPY}` and set contentHash in manifest.json "
        "to the new sha256 (see fixtures/pricing/README.md)"
    )


def test_pricing_manifest_matches_the_yaml_copy():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    document = yaml.safe_load(YAML_COPY.read_text(encoding="utf-8"))
    versions = {entry["versionId"]: entry for entry in manifest["versions"]}
    assert manifest["latestVersionId"] in versions
    latest = versions[manifest["latestVersionId"]]
    assert latest["contentHash"] == hashlib.sha256(YAML_COPY.read_bytes()).hexdigest()
    assert latest["version"] == document["version"]
    assert manifest["permanentUrl"].endswith(f"/p/{manifest['pricingId']}")


def test_pricing_yaml_has_the_expected_shape():
    document = yaml.safe_load(YAML_COPY.read_text(encoding="utf-8"))
    assert len(document["features"]) == 7
    assert len(document["usageLimits"]) == 12
    assert set(document["plans"]) == {"FREE", "RESEARCH", "LAB"}

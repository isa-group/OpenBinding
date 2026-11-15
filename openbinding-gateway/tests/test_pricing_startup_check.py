"""The startup check: the gateway refuses to start on a pricing it cannot enforce.

``main.check_pricing`` runs in the lifespan right after the gate is installed. It reads the
published pricing through the gate (SPACE, or the package copy under the open gate), stops
the start when the document lacks an entitlement id the gateway reads, and, with SPACE
enabled, requires ``SPACE_ORGANIZATION_ID`` and the ``pricing-token-jwks`` capability: under
``APP_ENV=prod`` their absence (or an unreachable SPACE) stops the start, elsewhere it warns.
"""

from __future__ import annotations

import logging

import pytest
import yaml
from pydantic import ValidationError

from _fake_space import FakePricingGate, PricingCatalog
from _fake_space_http import VERSION, JwksSpace, gate_over, settings_for
from _pricing import PRICING_YAML
from _space_tokens import ORGANIZATION
from openbinding_gateway import main, space_client
from openbinding_gateway.core.settings import Settings
from openbinding_gateway.space_client import PricingUnavailable

PRODUCTION = {
    "app_env": "prod",
    "space_enabled": True,
    "space_url": "https://space.invalid",
    "space_api_key": "k",
    "gateway_jwt_secret": "x" * 64,
    "cors_allow_origins": "https://openbinding.example.org",
}


def catalog_without(limit: str | None = None, *, not_numeric: str | None = None) -> PricingCatalog:
    document = yaml.safe_load(PRICING_YAML.read_bytes())
    if limit is not None:
        del document["usageLimits"][limit]
        for plan in document["plans"].values():
            plan["usageLimits"].pop(limit, None)
    if not_numeric is not None:
        document["usageLimits"][not_numeric]["valueType"] = "TEXT"
    return PricingCatalog.parse(yaml.safe_dump(document).encode())


async def start(settings: Settings) -> None:
    async with main._lifespan(settings):
        pass


@pytest.fixture
def logs(caplog):
    caplog.set_level(logging.INFO, logger=main.__name__)
    logging.getLogger(main.__name__).disabled = False
    return caplog


async def test_a_pricing_without_max_run_minutes_stops_the_start(monkeypatch):
    monkeypatch.setattr(space_client, "build_gate", lambda *_: FakePricingGate(catalog_without("maxRunMinutes")))

    with pytest.raises(RuntimeError, match=r"pricing 0\.2\.0 lacks: usageLimit maxRunMinutes"):
        await start(Settings(_env_file=None))
    # The start failed whole: no gate is left installed.
    with pytest.raises(RuntimeError, match="No pricing gate is installed"):
        space_client.get_gate()


async def test_a_limit_that_is_not_numeric_stops_the_start(monkeypatch):
    monkeypatch.setattr(space_client, "build_gate", lambda *_: FakePricingGate(catalog_without(not_numeric="maxApiKeys")))

    with pytest.raises(RuntimeError, match=r"usageLimit maxApiKeys \(valueType NUMERIC\)"):
        await start(Settings(_env_file=None))


async def test_the_open_gate_checks_the_package_copy_and_passes(logs):
    await start(Settings(_env_file=None, space_enabled=False))

    assert "Pricing startup check passed: pricing 0.2.0" in logs.text


async def test_space_serves_the_yaml_end_to_end(monkeypatch, logs):
    space = JwksSpace()
    gate = await gate_over(space)
    monkeypatch.setattr(space_client, "build_gate", lambda *_: gate)

    await start(settings_for(space_enabled=True, space_url="https://space.invalid", space_api_key="k"))

    assert space.fetches(f"/api/v1/services/openbinding/pricings/{VERSION}") == 1
    assert "Pricing startup check passed: pricing 0.2.0" in logs.text


async def test_without_a_configured_version_the_version_for_new_contracts_is_checked(monkeypatch, logs):
    space = JwksSpace()
    gate = await gate_over(space, settings_for(space_pricing_version=None))
    monkeypatch.setattr(space_client, "build_gate", lambda *_: gate)

    await start(settings_for(space_enabled=True, space_url="https://space.invalid", space_api_key="k", space_pricing_version=None))

    assert space.fetches("/api/v1/services/openbinding/pricings/new-contracts") == 1
    assert "Pricing startup check passed" in logs.text


async def test_space_serving_a_pricing_that_lacks_an_id_stops_the_start(monkeypatch):
    text = PRICING_YAML.read_text(encoding="utf-8").replace("  maxStudyCells:\n", "  maxStudyCellz:\n", 1)
    space = JwksSpace(yaml_text=text)
    gate = await gate_over(space)
    monkeypatch.setattr(space_client, "build_gate", lambda *_: gate)

    with pytest.raises(RuntimeError, match="lacks: usageLimit maxStudyCells"):
        await start(settings_for(space_enabled=True, space_url="https://space.invalid", space_api_key="k"))


# -- SPACE that cannot verify its tokens: prod refuses, dev warns ------------------


async def test_a_space_without_published_keys_fails_production_and_warns_in_development(logs):
    space = JwksSpace(capabilities="pricing-yaml,contract-version")
    gate = await gate_over(space)

    with pytest.raises(RuntimeError, match="pricing-token-jwks"):
        await main.check_pricing(Settings(_env_file=None, space_organization_id=ORGANIZATION, **PRODUCTION), gate)

    await main.check_pricing(settings_for(space_enabled=True), gate)
    assert "pricing-token-jwks" in logs.text and "starts anyway" in logs.text


def test_production_with_space_and_no_organization_does_not_even_configure():
    with pytest.raises(ValidationError, match="SPACE_ORGANIZATION_ID"):
        Settings(_env_file=None, **PRODUCTION)


async def test_a_missing_organization_fails_production_and_warns_in_development(logs):
    space = JwksSpace()
    gate = await gate_over(space)
    production = Settings.model_construct(**{**Settings(_env_file=None).model_dump(), **PRODUCTION, "space_organization_id": None})

    with pytest.raises(RuntimeError, match="SPACE_ORGANIZATION_ID"):
        await main.check_pricing(production, gate)

    await main.check_pricing(settings_for(space_enabled=True, space_organization_id=None), gate)
    assert "SPACE_ORGANIZATION_ID is not set" in logs.text


class Unreachable(FakePricingGate):
    async def pricing_document(self) -> str:
        raise PricingUnavailable("SPACE is not reachable (ConnectError)")

    async def publishes_token_keys(self) -> bool:
        return False


async def test_an_unreachable_space_fails_production_and_warns_in_development(logs):
    gate = Unreachable()

    with pytest.raises(RuntimeError, match="cannot be read"):
        await main.check_pricing(Settings(_env_file=None, space_organization_id=ORGANIZATION, **PRODUCTION), gate)

    await main.check_pricing(settings_for(space_enabled=True), gate)
    assert "the published pricing cannot be read" in logs.text

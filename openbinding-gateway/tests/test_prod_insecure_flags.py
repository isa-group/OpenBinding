"""Production refuses the switch that puts engine traffic on plain http.

``FEDERATION_REQUIRE_HTTPS=false`` is for a trusted development or lab network.
Like ``SPACE_ENABLED=false`` it must stop an ``APP_ENV=prod`` gateway from
starting instead of only logging a warning while it runs.
"""

from __future__ import annotations

import pytest

from openbinding_gateway.core.settings import Settings

PRODUCTION = dict(
    app_env="prod",
    space_enabled=True,
    space_organization_id="org-test",
    cors_allow_origins="https://openbinding.example.org",
    gateway_jwt_secret="x" * 64,
)


@pytest.fixture(autouse=True)
def a_pristine_environment(monkeypatch):
    for name in (
        "APP_ENV",
        "FEDERATION_REQUIRE_HTTPS",
        "GATEWAY_JWT_SECRET",
        "SPACE_ENABLED",
        "CORS_ALLOW_ORIGINS",
    ):
        monkeypatch.delenv(name, raising=False)


def settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


def test_production_with_secure_defaults_starts():
    configured = settings(**PRODUCTION)

    assert configured.federation_require_https is True


def test_production_refuses_to_federate_over_plain_http():
    with pytest.raises(ValueError, match=r"FEDERATION_REQUIRE_HTTPS is false while APP_ENV=prod"):
        settings(**PRODUCTION, federation_require_https=False)


def test_the_refusal_also_applies_to_the_environment_variables(monkeypatch):
    monkeypatch.setenv("FEDERATION_REQUIRE_HTTPS", "false")

    with pytest.raises(ValueError, match=r"FEDERATION_REQUIRE_HTTPS"):
        settings(**PRODUCTION)


@pytest.mark.parametrize("environment", ["dev", "test"])
def test_development_and_test_may_use_plain_http(environment):
    configured = settings(app_env=environment, federation_require_https=False)

    assert configured.federation_require_https is False

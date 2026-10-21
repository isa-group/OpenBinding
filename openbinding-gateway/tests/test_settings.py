"""The configuration object, and the two rules it now owns.

Configuration used to be read at its point of use, which meant the CORS
wildcard rule lived in ``main`` and the engine URL table lived in the registry.
Moving them here is only safe if they still decide the same things, so that is
what these tests pin: the defaults a deployment relies on, and the wildcard
rule that quietly turns credentialed requests off.
"""

from __future__ import annotations

import pytest

from openbinding_gateway.core.settings import Settings



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
        "SPACE_PRICING_VERSION",
        "SPACE_DEFAULT_PLAN",
        "SPACE_TIMEOUT_MS",
        "FEDERATION_SECRET_KEY",
        "FEDERATION_REQUIRE_HTTPS",
    ):
        monkeypatch.delenv(name, raising=False)


def settings(**overrides) -> Settings:
    """A Settings that ignores any .env lying around the working directory."""
    return Settings(_env_file=None, **overrides)


def test_the_defaults_are_the_compose_service_names():
    # These are what a deployment gets when it sets nothing, so a change here
    # changes every stack that relies on the defaults.
    assert settings().engine_urls == {
        "minizinc-csp": "http://engine-minizinc:3000",
        "random-search": "http://engine-random-search:8080",
        "many-heuristic": "http://engine-many-heuristic:8080",
        "evolutionary-heuristics": "http://engine-evolutionary-heuristics:8080",
    }


def test_the_solve_timeout_defaults_to_half_an_hour():
    assert settings().engine_solve_timeout_s == 1800.0


def test_origins_are_split_and_stripped():
    assert settings(cors_allow_origins="http://a, http://b ").cors_origin_list == [
        "http://a",
        "http://b",
    ]


def test_an_empty_origin_entry_is_dropped():
    assert settings(cors_allow_origins="http://a,,").cors_origin_list == ["http://a"]


@pytest.mark.parametrize("origins", ["*", "*,http://a", "http://a,*"])
def test_a_wildcard_origin_forbids_credentials(origins):
    # Browsers reject wildcard-plus-credentials outright, so the gateway does
    # not offer a configuration that only looks like it works.
    assert settings(cors_allow_origins=origins, cors_allow_credentials=True).cors_credentials_allowed is False


def test_named_origins_keep_the_configured_credentials_setting():
    assert settings(cors_allow_origins="http://a", cors_allow_credentials=True).cors_credentials_allowed is True
    assert settings(cors_allow_origins="http://a", cors_allow_credentials=False).cors_credentials_allowed is False


def test_the_signing_secret_has_no_default(monkeypatch):
    # A well-known default here would be worse than a missing one: it would
    # let a deployment ship working authentication that anyone can forge.
    # (The suite exports one of its own, so it has to be taken away first.)
    monkeypatch.delenv("GATEWAY_JWT_SECRET", raising=False)

    assert settings().gateway_jwt_secret is None


def test_space_is_off_until_it_is_configured():
    configured = settings()
    assert configured.space_enabled is False
    assert configured.space_url is None


def test_anonymous_error_events_are_limited_by_default_and_not_negative():
    assert settings().anonymous_error_events_per_minute == 30
    assert settings(anonymous_error_events_per_minute=0).anonymous_error_events_per_minute == 0
    with pytest.raises(ValueError):
        settings(anonymous_error_events_per_minute=-1)


def test_no_failure_mode_switch_remains():
    # An unreachable SPACE always fails closed (503 pricing_unavailable): there
    # is no fail-open switch to configure. (The retired destructive key is
    # covered by the static guard on retired names.)
    assert "space_fail_mode" not in Settings.model_fields


def test_the_pricing_version_and_default_plan_are_plain_configuration():
    configured = settings()
    assert configured.space_pricing_version is None
    assert configured.space_default_plan is None
    pinned = settings(space_pricing_version="0.1.0", space_default_plan="BASIC")
    assert (pinned.space_pricing_version, pinned.space_default_plan) == ("0.1.0", "BASIC")


def test_production_refuses_to_start_without_space():
    with pytest.raises(ValueError, match=r"SPACE_ENABLED is false while APP_ENV=prod"):
        settings(app_env="prod", cors_allow_origins="https://openbinding.example.org")


def test_production_starts_with_space_and_development_may_run_without_it():
    prod = settings(
        app_env="prod", space_enabled=True, cors_allow_origins="https://openbinding.example.org"
    )
    assert prod.space_enabled is True
    for environment in ("dev", "test"):
        assert settings(app_env=environment).space_enabled is False


def test_an_unrelated_environment_variable_is_not_a_configuration_error(monkeypatch):
    # The process environment carries far more than this class describes -
    # PATH, the compose variables, whatever the shell exports - and none of
    # that should stop the gateway from starting.
    monkeypatch.setenv("SOME_VARIABLE_THE_GATEWAY_DOES_NOT_KNOW", "x")

    assert settings().engine_solve_timeout_s == 1800.0

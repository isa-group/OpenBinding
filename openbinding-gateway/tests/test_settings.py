"""The configuration object, and the two rules it now owns.

Configuration used to be read at its point of use, which meant the CORS
wildcard rule lived in ``main`` and the engine URL table lived in the registry.
Moving them here is only safe if they still decide the same things, so that is
what these tests pin: the defaults a deployment relies on, and the wildcard
rule that quietly turns credentialed requests off.
"""

from __future__ import annotations

import pytest

from openbinding_gateway.composition import ids
from openbinding_gateway.core.settings import SPHERE_REGISTRY_ALIAS, Settings



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
        "SPHERE_REGISTRIES",
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


def test_the_work_budget_is_on_by_default():
    configured = settings()
    assert configured.work_rate_limit_window_s == 60
    assert configured.work_rate_limit_compile_requests > 0
    assert configured.work_rate_limit_signed_in_multiplier > 1


def test_the_work_budget_may_be_switched_off_but_not_be_negative():
    field = "work_rate_limit_compile_requests"
    assert getattr(settings(**{field: 0}), field) == 0
    with pytest.raises(ValueError):
        settings(**{field: -1})


@pytest.mark.parametrize(
    "field", ["work_rate_limit_window_s", "work_rate_limit_signed_in_multiplier"]
)
def test_the_work_window_and_multiplier_must_be_positive(field):
    with pytest.raises(ValueError):
        settings(**{field: 0})


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
        app_env="prod", space_enabled=True, space_organization_id="org-test",
        cors_allow_origins="https://openbinding.example.org",
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


# -- SPHERE registries ----------------------------------------------------


def test_no_sphere_registry_is_defined_by_default():
    configured = settings()
    assert configured.sphere_registries == {}
    assert configured.sphere_registry_aliases == frozenset()


def test_sphere_registries_are_read_from_json_in_the_environment(monkeypatch):
    monkeypatch.setenv(
        "SPHERE_REGISTRIES",
        '{"lab": {"url": "https://sphere.lab.local", "api_key": "s3cr3t-key"}, "onprem": {"url": "https://sphere.example"}}',
    )
    configured = settings()
    assert configured.sphere_registry_aliases == frozenset({"lab", "onprem"})
    assert configured.sphere_registries["lab"].url.host == "sphere.lab.local"
    assert configured.sphere_registries["lab"].api_key.get_secret_value() == "s3cr3t-key"
    assert configured.sphere_registries["onprem"].api_key is None


def test_a_sphere_registry_is_reached_over_https_only():
    with pytest.raises(ValueError, match="https"):
        settings(sphere_registries={"lab": {"url": "http://sphere.lab.local"}})


@pytest.mark.parametrize("alias", ["Lab", "-lab", "lab-", "la_b", "l" * 33, ""])
def test_a_sphere_registry_alias_a_document_could_not_name_is_refused(alias):
    with pytest.raises(ValueError, match="alias"):
        settings(sphere_registries={alias: {"url": "https://sphere.lab.local"}})


def test_a_sphere_registry_with_an_unknown_key_is_refused():
    with pytest.raises(ValueError):
        settings(sphere_registries={"lab": {"url": "https://sphere.lab.local", "token": "x"}})


def test_the_registry_key_never_shows_in_repr():
    configured = settings(sphere_registries={"lab": {"url": "https://sphere.lab.local", "api_key": "s3cr3t-key"}})
    assert "s3cr3t-key" not in repr(configured)
    assert "s3cr3t-key" not in str(configured.sphere_registries)
    assert "s3cr3t-key" not in repr(configured.model_dump())


def test_the_registry_alias_pattern_is_the_language_s():
    assert SPHERE_REGISTRY_ALIAS.pattern == ids.ALIAS.pattern


def test_the_composition_slots_and_the_read_budget_have_defaults():
    configured = settings()
    assert (configured.composition_language_slots, configured.composition_evaluation_slots) == (4, 2)
    assert configured.work_rate_limit_read_requests == 60
    with pytest.raises(ValueError):
        settings(composition_language_slots=0)

"""The public origins are checked at startup: ``PUBLIC_BASE_URL``, ``FRONTEND_URL``, ``CORS_ALLOW_ORIGINS``.

A browser ignores a malformed origin without saying why (a CORS entry with a path
never matches ``Origin``, a redirect to a URL with a comma goes nowhere), so the
gateway refuses to start with one and names the variable.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from openbinding_gateway.core.settings import DEV_CORS_ORIGINS, Settings, get_settings

ENV_NAMES = ("PUBLIC_BASE_URL", "FRONTEND_URL", "CORS_ALLOW_ORIGINS", "APP_ENV")

VALID_ORIGINS = [
    "http://example.org",
    "https://example.org",
    "https://example.org:8443",
    "http://localhost",
    "http://localhost:5173",
    "http://127.0.0.1:8000",
    "http://[::1]:5173",
    "https://sub.example.org",
]

INVALID_ORIGINS = [
    "example.org",
    "localhost:5173",
    "//example.org",
    "ftp://example.org",
    "https://example.org/app",
    "https://example.org//",
    "https://example.org?x=1",
    "https://example.org/?x=1",
    "https://example.org#top",
    "https://*.example.org",
    "https://example.org,https://other.example.org",
    "https://example.org other",
    "https://",
    "https:",
    "http://",
    "https://user@example.org",
    "https://user:secret@example.org",
    "https://example.org:",
    "https://example.org:port",
]


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch):
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


# -- PUBLIC_BASE_URL and FRONTEND_URL ---------------------------------------


@pytest.mark.parametrize("field", ["public_base_url", "frontend_url"])
@pytest.mark.parametrize("value", VALID_ORIGINS)
def test_a_well_formed_url_is_accepted(field, value):
    assert getattr(settings(**{field: value}), field) == value


@pytest.mark.parametrize("field", ["public_base_url", "frontend_url"])
@pytest.mark.parametrize("value", ["https://example.org/", "http://localhost:5173/"])
def test_one_trailing_slash_is_tolerated_in_the_urls(field, value):
    assert getattr(settings(**{field: value}), field) == value


@pytest.mark.parametrize(
    ("field", "variable"),
    [("public_base_url", "PUBLIC_BASE_URL"), ("frontend_url", "FRONTEND_URL")],
)
@pytest.mark.parametrize("value", [*INVALID_ORIGINS, "", " ", "*", "/", "https://*"])
def test_a_malformed_url_is_refused_naming_the_variable(field, variable, value):
    with pytest.raises(ValidationError) as failure:
        settings(**{field: value})

    message = str(failure.value)
    assert variable in message
    assert repr(value) in message
    assert "scheme://host[:port]" in message
    assert "for example https://" in message


# -- CORS_ALLOW_ORIGINS ----------------------------------------------------


@pytest.mark.parametrize("value", VALID_ORIGINS)
def test_a_well_formed_cors_origin_is_accepted(value):
    assert settings(cors_allow_origins=value).cors_origin_list == [value]


def test_a_list_of_well_formed_origins_is_accepted_with_spaces_and_blanks():
    configured = settings(cors_allow_origins=" https://a.example , ,http://localhost:5173,")

    assert configured.cors_origin_list == ["https://a.example", "http://localhost:5173"]


@pytest.mark.parametrize(
    "value",
    [
        *(item for item in INVALID_ORIGINS if "," not in item),  # a comma is the list separator
        "https://example.org/",
        "http://localhost:5173/",
    ],
)
def test_a_malformed_cors_origin_is_refused_naming_the_variable(value):
    with pytest.raises(ValidationError) as failure:
        settings(cors_allow_origins=f"https://ok.example,{value}")

    message = str(failure.value)
    assert "CORS_ALLOW_ORIGINS" in message
    assert "scheme://host[:port]" in message
    assert "for example https://" in message


@pytest.mark.parametrize("value", ["https://example.org/", "http://localhost:5173/"])
def test_a_trailing_slash_is_refused_in_cors_and_the_value_is_shown(value):
    with pytest.raises(ValidationError) as failure:
        settings(cors_allow_origins=value)

    assert repr(value) in str(failure.value)
    assert "no trailing '/'" in str(failure.value)


@pytest.mark.parametrize("value", ["https://*.example.org", "https://example.*", "*.example.org"])
@pytest.mark.parametrize("app_env", ["dev", "test", "prod"])
def test_a_wildcard_inside_an_entry_is_always_refused(app_env, value):
    with pytest.raises(ValidationError) as failure:
        settings(app_env=app_env, space_enabled=True, cors_allow_origins=value)

    assert "CORS_ALLOW_ORIGINS" in str(failure.value)
    assert repr(value) in str(failure.value)


@pytest.mark.parametrize("app_env", ["dev", "test"])
def test_a_bare_wildcard_is_tolerated_outside_production(app_env):
    assert settings(app_env=app_env, cors_allow_origins="*").cors_origin_list == ["*"]


def test_a_bare_wildcard_is_refused_in_production_by_the_closed_list_rule():
    with pytest.raises(ValidationError, match=r"CORS_ALLOW_ORIGINS contains '\*' while APP_ENV=prod"):
        settings(app_env="prod", space_enabled=True, cors_allow_origins="*")


def test_a_bare_wildcard_next_to_a_malformed_entry_is_still_checked_outside_production():
    with pytest.raises(ValidationError, match="CORS_ALLOW_ORIGINS"):
        settings(app_env="dev", cors_allow_origins="*,https://example.org/app")


def test_an_empty_cors_list_outside_production_is_still_accepted():
    assert settings(cors_allow_origins="").cors_origin_list == []


# -- Defaults and the environment -------------------------------------------


def test_the_defaults_are_valid():
    configured = Settings(_env_file=None)

    assert configured.public_base_url == "http://localhost:8000"
    assert configured.frontend_url == "http://localhost:5173"


def test_the_development_cors_origins_are_valid():
    assert len(settings(cors_allow_origins=DEV_CORS_ORIGINS).cors_origin_list) == 4


def test_a_malformed_value_in_the_environment_stops_startup(monkeypatch):
    monkeypatch.setenv("FRONTEND_URL", "openbinding.example.org")
    get_settings.cache_clear()

    with pytest.raises(ValidationError, match="FRONTEND_URL"):
        get_settings()

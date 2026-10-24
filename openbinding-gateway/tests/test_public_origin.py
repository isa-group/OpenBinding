"""The public origins are checked at startup.

``PUBLIC_BASE_URL``, ``FRONTEND_URL`` and the entries of ``CORS_ALLOW_ORIGINS``
end up in links and in the ``Access-Control-Allow-Origin`` comparison. A browser
ignores a malformed origin without saying why, so the gateway refuses to start
and names the variable. Userinfo in the value is masked in the message, which
must not leak it anywhere else either (pydantic's echo of the input included).
"""

from __future__ import annotations

import traceback

import pytest
from pydantic import ValidationError

from openbinding_gateway.core.settings import DEV_CORS_ORIGINS, Settings, get_settings

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
    "https://zed@example.org",
    "https://zed:secret@example.org",
    "https://admin:s3cr3t-pw@example.org",
    "http://ops:hunter2@example.org:8080",
    "http://[::1]x",
    "http://[1.2.3.4]",
    "https://example.org:",
    "https://example.org:port",
    "https://example.org:70000",
    "https://example.org:65536",
    "https://example.org:0",
    "http://::1:8000",
    "http://[::1",
    "https://under_score.example.org",
]

URL_FIELDS = [
    ("public_base_url", "PUBLIC_BASE_URL"),
    ("frontend_url", "FRONTEND_URL"),
]

HINTS = ("scheme://host[:port]", "for example https://")


@pytest.fixture(autouse=True)
def a_pristine_environment(monkeypatch):
    for name in ("PUBLIC_BASE_URL", "FRONTEND_URL", "CORS_ALLOW_ORIGINS", "APP_ENV"):
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def settings(**overrides) -> Settings:
    """A Settings that ignores any .env lying around the working directory."""
    return Settings(_env_file=None, **overrides)


def prod(**overrides) -> Settings:
    """A production Settings that is valid in everything but what a test overrides."""
    base = {
        "app_env": "prod",
        "space_enabled": True,
        "gateway_jwt_secret": "x" * 40,
        "cors_allow_origins": "https://openbinding.example.org",
    }
    base.update(overrides)
    return settings(**base)


def shown(value: str) -> str:
    """The value as the error must show it: what lies between ``://`` and the last ``@`` is masked."""
    if "@" not in value:
        return value
    at = value.rindex("@")
    start = value.index("://") + 3 if "://" in value[:at] else 0
    return value[:start] + "***" + value[at:]


def assert_message(excinfo, name: str, value: str) -> str:
    text = str(excinfo.value)
    assert name in text
    assert repr(shown(value)) in text
    traced = "".join(traceback.format_exception(excinfo.value))
    context = repr(excinfo.value.__context__) + str(excinfo.value.__context__)
    for literal in ("secret", "s3cr3t-pw", "hunter2", "admin:", "ops:", "zed:"):
        for where in (text, traced, context):
            assert literal not in where
    for hint in HINTS:
        assert hint in text
    return text


# [utest->req~gateway-api-public-origin-format~1]
@pytest.mark.parametrize("field,_name", URL_FIELDS)
@pytest.mark.parametrize("value", VALID_ORIGINS)
def test_a_well_formed_url_is_accepted(field, _name, value):
    assert getattr(settings(**{field: value}), field) == value


# [utest->req~gateway-api-public-origin-format~1]
@pytest.mark.parametrize("field,_name", URL_FIELDS)
@pytest.mark.parametrize("value", ["https://example.org/", "http://localhost:5173/", "HTTPS://example.org"])
def test_a_url_tolerates_one_trailing_slash_and_any_scheme_case(field, _name, value):
    assert getattr(settings(**{field: value}), field) == value


# [utest->req~gateway-api-public-origin-format~1]
# [utest->req~gateway-api-origin-error-masking~1]
@pytest.mark.parametrize("field,name", URL_FIELDS)
@pytest.mark.parametrize("value", INVALID_ORIGINS + ["", " ", "*", "/", "https://*"])
def test_a_malformed_url_stops_the_process_and_names_the_variable(field, name, value):
    with pytest.raises(ValidationError) as excinfo:
        settings(**{field: value})
    assert_message(excinfo, name, value)


# [utest->req~gateway-api-cors-origin-format~1]
@pytest.mark.parametrize("value", VALID_ORIGINS)
def test_a_well_formed_cors_entry_is_accepted(value):
    assert settings(cors_allow_origins=value).cors_origin_list == [value]


# [utest->req~gateway-api-cors-origin-format~1]
def test_cors_entries_are_stripped_and_empty_parts_ignored():
    configured = settings(cors_allow_origins=" https://a.example , ,http://localhost:5173,")
    assert configured.cors_origin_list == ["https://a.example", "http://localhost:5173"]


# [utest->req~gateway-api-cors-origin-format~1]
# [utest->req~gateway-api-origin-error-masking~1]
@pytest.mark.parametrize(
    "value",
    [v for v in INVALID_ORIGINS if "," not in v] + ["https://example.org/", "http://localhost:5173/"],
)
def test_a_malformed_cors_entry_stops_the_process_and_names_the_variable(value):
    with pytest.raises(ValidationError) as excinfo:
        settings(cors_allow_origins=f"https://ok.example,{value}")
    assert_message(excinfo, "CORS_ALLOW_ORIGINS", value)


# [utest->req~gateway-api-cors-origin-format~1]
# [utest->req~gateway-api-origin-error-masking~1]
def test_a_cors_entry_with_a_trailing_slash_is_refused_and_shown_as_written():
    with pytest.raises(ValidationError) as excinfo:
        settings(cors_allow_origins="http://localhost:5173,https://openbinding.example.org/")
    text = str(excinfo.value)
    assert "CORS_ALLOW_ORIGINS" in text
    assert repr("https://openbinding.example.org/") in text
    assert "no trailing '/'" in text


# [utest->req~gateway-api-cors-origin-format~1]
@pytest.mark.parametrize("app_env", ["dev", "test", "prod"])
@pytest.mark.parametrize("value", ["https://*.example.org", "https://example.*", "*.example.org"])
def test_a_wildcard_inside_a_cors_entry_is_refused_in_every_environment(app_env, value):
    overrides = {"app_env": app_env, "cors_allow_origins": value}
    if app_env == "prod":
        overrides.update(space_enabled=True, gateway_jwt_secret="x" * 40)
    with pytest.raises(ValidationError) as excinfo:
        settings(**overrides)
    text = str(excinfo.value)
    assert "CORS_ALLOW_ORIGINS" in text
    assert repr(value) in text


# [utest->req~gateway-api-cors-origin-format~1]
@pytest.mark.parametrize("app_env", ["dev", "test"])
def test_a_bare_wildcard_passes_the_format_check_outside_production(app_env):
    assert settings(app_env=app_env, cors_allow_origins="*").cors_origin_list == ["*"]


# [utest->req~gateway-api-cors-origin-format~1]
def test_a_bare_wildcard_in_production_keeps_its_own_message():
    with pytest.raises(ValidationError, match=r"CORS_ALLOW_ORIGINS contains '\*' while APP_ENV=prod"):
        prod(cors_allow_origins="*")


# [utest->req~gateway-api-cors-origin-format~1]
def test_a_wildcard_next_to_a_malformed_entry_is_refused():
    with pytest.raises(ValidationError, match="CORS_ALLOW_ORIGINS"):
        settings(app_env="dev", cors_allow_origins="*,https://example.org/app")


# [utest->req~gateway-api-cors-origin-format~1]
def test_an_empty_cors_list_is_accepted_outside_production():
    assert settings(cors_allow_origins="").cors_origin_list == []


# [utest->req~gateway-api-public-origin-format~1]
def test_a_production_configuration_accepts_a_url_with_one_trailing_slash():
    assert prod(public_base_url="https://openbinding.example.org/").public_base_url.endswith("/")


# [utest->req~gateway-api-public-origin-format~1]
def test_the_defaults_are_well_formed():
    configured = settings()
    assert configured.public_base_url == "http://localhost:8000"
    assert configured.frontend_url == "http://localhost:5173"
    assert len(settings(cors_allow_origins=DEV_CORS_ORIGINS).cors_origin_list) == 4
    assert len(configured.cors_origin_list) == 4


# [utest->req~gateway-api-public-origin-format~1]
def test_a_malformed_origin_in_the_environment_stops_get_settings(monkeypatch):
    monkeypatch.setenv("FRONTEND_URL", "openbinding.example.org")
    with pytest.raises(ValidationError, match="FRONTEND_URL"):
        get_settings()


# [utest->req~gateway-api-origin-error-masking~1]
@pytest.mark.parametrize("field", ["public_base_url", "frontend_url", "cors_allow_origins"])
def test_userinfo_with_reserved_characters_is_masked_completely(field):
    value = "https://zed:pa/ss?w@example.org"
    with pytest.raises(ValidationError) as excinfo:
        settings(**{field: value})
    text = str(excinfo.value)
    assert "https://***@example.org" in text
    assert "pa/ss" not in text
    assert "zed" not in text


# [utest->req~gateway-api-origin-error-masking~1]
def test_a_value_without_userinfo_is_shown_unchanged():
    with pytest.raises(ValidationError) as excinfo:
        settings(frontend_url="https://openbinding.example.org/app?x=1")
    text = str(excinfo.value)
    assert "FRONTEND_URL" in text
    assert "'https://openbinding.example.org/app?x=1'" in text

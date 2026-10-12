"""Authentication: two static bearer tokens from a file, constant-time comparison, fail closed."""

from __future__ import annotations

import logging

import pytest
from service_support import BASE_URL, TOKEN_NEW, TOKEN_OLD, bearer
from starlette.testclient import TestClient

from bim_service import auth
from bim_service.app import create_app
from bim_service.settings import BimServiceSettings, ServiceConfigError

CAPABILITIES = "/bim/v1/capabilities"


def anonymous_client(**kwargs) -> TestClient:
    settings = BimServiceSettings(allow_anonymous_dev=True, **kwargs)
    return TestClient(create_app(settings), base_url=BASE_URL, raise_server_exceptions=False)


def test_a_request_without_a_token_is_refused(client) -> None:
    response = client.get(CAPABILITIES, headers={"Authorization": ""})
    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["www-authenticate"].startswith("Bearer")
    body = response.json()
    assert body["code"] == "unauthorized"
    assert body["type"] == "urn:bim-toolchain:problem:unauthorized"
    assert body["status"] == 401


@pytest.mark.parametrize(
    "header",
    [
        "Bearer",
        "Bearer ",
        "Basic " + TOKEN_NEW,
        TOKEN_NEW,
        "Bearer " + TOKEN_NEW[:-1],
        "Bearer " + TOKEN_NEW + "x",
        "Bearer " + TOKEN_NEW.upper(),
        "Bearer short",
    ],
)
def test_anything_but_an_accepted_token_is_refused(client, header: str) -> None:
    assert client.get(CAPABILITIES, headers={"Authorization": header}).status_code == 401


@pytest.mark.parametrize("token", [TOKEN_OLD, TOKEN_NEW])
def test_both_tokens_are_accepted_during_a_rotation(client, token: str) -> None:
    assert client.get(CAPABILITIES, headers=bearer(token)).status_code == 200


def test_the_scheme_is_case_insensitive(client) -> None:
    assert client.get(CAPABILITIES, headers={"Authorization": f"bearer {TOKEN_OLD}"}).status_code == 200


def test_an_unknown_path_is_refused_before_it_is_found_missing(client) -> None:
    assert client.get("/bim/v1/nothing", headers={"Authorization": ""}).status_code == 401
    assert client.get("/elsewhere", headers={"Authorization": ""}).status_code == 401
    assert client.get("/bim/v1/nothing").status_code == 404


def test_health_and_readiness_need_no_token_and_reveal_nothing(client) -> None:
    for path, expected in (("/healthz", {"status": "ok"}), ("/readyz", {"status": "ready"})):
        response = client.get(path, headers={"Authorization": ""})
        assert response.status_code == 200
        assert response.json() == expected


def test_the_tenant_header_never_authorizes(client) -> None:
    response = client.get(CAPABILITIES, headers={"Authorization": "", "X-BIM-Tenant": "acme"})
    assert response.status_code == 401


def test_every_accepted_token_is_compared_in_constant_time(client, monkeypatch) -> None:
    calls: list[int] = []
    real = auth.hmac.compare_digest

    def spy(left, right):
        calls.append(1)
        return real(left, right)

    monkeypatch.setattr(auth.hmac, "compare_digest", spy)
    assert client.get(CAPABILITIES, headers=bearer(TOKEN_OLD)).status_code == 200
    assert len(calls) == 2  # no early exit when the first token matches
    calls.clear()
    assert client.get(CAPABILITIES, headers=bearer("x" * 40)).status_code == 401
    assert len(calls) == 2


def test_tokens_never_reach_the_logs(client, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    client.get(CAPABILITIES, headers=bearer(TOKEN_OLD))
    client.get(CAPABILITIES, headers=bearer("wrong-" + TOKEN_NEW))
    client.get(CAPABILITIES, headers={"Authorization": ""})
    assert "request method=GET" in caplog.text
    for secret in (TOKEN_OLD, TOKEN_NEW, "wrong-" + TOKEN_NEW):
        assert secret not in caplog.text
    assert "Bearer" not in caplog.text


# --- starting ---------------------------------------------------------------------------------------


def test_the_service_does_not_start_without_a_tokens_file() -> None:
    with pytest.raises(ServiceConfigError, match="BIM_SERVICE_TOKENS_FILE"):
        create_app(BimServiceSettings())


def test_a_missing_tokens_file_stops_the_start(tmp_path) -> None:
    with pytest.raises(ServiceConfigError, match="cannot be read"):
        create_app(BimServiceSettings(tokens_file=str(tmp_path / "absent")))


def test_a_directory_is_not_a_tokens_file(tmp_path) -> None:
    with pytest.raises(ServiceConfigError):
        create_app(BimServiceSettings(tokens_file=str(tmp_path)))


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ("short-token\n", "fewer than 32"),
        (f"{TOKEN_OLD}\nshort\n", "line 2"),
        ("", "no token"),
        ("\n\n  \n", "no token"),
        (f"{TOKEN_OLD}\n{TOKEN_NEW}\n{'z' * 40}\n", "more than 2"),
        (f"{TOKEN_OLD}\n{TOKEN_OLD}\n", "repeats"),
        ("with a space inside the token of length 40", "printable ASCII"),
        ("é" * 40, "printable ASCII"),
    ],
)
def test_a_tokens_file_that_is_not_acceptable_stops_the_start(tmp_path, content: str, message: str) -> None:
    path = tmp_path / "tokens"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(ServiceConfigError, match=message) as raised:
        create_app(BimServiceSettings(tokens_file=str(path)))
    assert TOKEN_OLD not in str(raised.value) and TOKEN_NEW not in str(raised.value)


def test_a_single_token_is_enough(tmp_path) -> None:
    path = tmp_path / "tokens"
    path.write_text(TOKEN_NEW + "\r\n", encoding="utf-8")
    client = TestClient(create_app(BimServiceSettings(tokens_file=str(path))), base_url=BASE_URL)
    assert client.get(CAPABILITIES, headers=bearer(TOKEN_NEW)).status_code == 200
    assert client.get(CAPABILITIES, headers=bearer(TOKEN_OLD)).status_code == 401


def test_anonymous_mode_needs_the_explicit_flag_and_warns(caplog) -> None:
    caplog.set_level(logging.WARNING)
    client = anonymous_client()
    assert client.get(CAPABILITIES).status_code == 200
    assert "WITHOUT authentication" in caplog.text


def test_the_anonymous_flag_does_not_excuse_a_broken_tokens_file(tmp_path) -> None:
    path = tmp_path / "tokens"
    path.write_text("short\n", encoding="utf-8")
    with pytest.raises(ServiceConfigError):
        create_app(BimServiceSettings(tokens_file=str(path), allow_anonymous_dev=True))


def test_an_open_tokens_file_is_reported(tmp_path, caplog) -> None:
    path = tmp_path / "tokens"
    path.write_text(TOKEN_NEW + "\n", encoding="utf-8")
    path.chmod(0o644)
    caplog.set_level(logging.WARNING)
    create_app(BimServiceSettings(tokens_file=str(path)))
    assert "readable by every user" in caplog.text


# --- settings ---------------------------------------------------------------------------------------


def test_settings_come_from_bim_service_variables_and_tokens_only_from_a_file() -> None:
    settings = BimServiceSettings.from_env({
        "BIM_SERVICE_TOKENS_FILE": "/run/secrets/tokens",
        "BIM_SERVICE_MAX_BODY_BYTES": "1000",
        "BIM_SERVICE_MAX_CONCURRENCY": "3",
        "BIM_SERVICE_OPERATION_TIMEOUT_SECONDS": "2.5",
        "BIM_SERVICE_LOG_LEVEL": "debug",
        "BIM_MAX_ENTRIES": "7",
        "BIM_SERVICE_PORT": "tcp://10.0.0.1:8080",  # injected by Kubernetes for a Service named bim-service
        "BIM_SERVICE_TOKEN": TOKEN_NEW,  # there is no such setting: a token in the environment is not read
    })
    assert settings.tokens_file == "/run/secrets/tokens"
    assert (settings.max_body_bytes, settings.max_concurrency, settings.operation_timeout_seconds) == (1000, 3, 2.5)
    assert settings.log_level == "DEBUG"
    assert settings.limits.max_entries == 7
    assert not hasattr(settings, "token") and not hasattr(settings, "tokens")


@pytest.mark.parametrize(("value", "expected"), [("1", True), ("true", False), ("0", False), ("", False), ("yes", False)])
def test_only_the_literal_1_enables_anonymous_access(value: str, expected: bool) -> None:
    assert BimServiceSettings.from_env({"BIM_SERVICE_ALLOW_ANONYMOUS_DEV": value}).allow_anonymous_dev is expected


@pytest.mark.parametrize(
    "environ",
    [
        {"BIM_SERVICE_MAX_BODY_BYTES": "many"},
        {"BIM_SERVICE_MAX_BODY_BYTES": "0"},
        {"BIM_SERVICE_MAX_CONCURRENCY": "-1"},
        {"BIM_SERVICE_OPERATION_TIMEOUT_SECONDS": "soon"},
        {"BIM_MAX_ENTRIES": "lots"},
    ],
)
def test_an_invalid_setting_is_a_configuration_error(environ) -> None:
    with pytest.raises(ServiceConfigError):
        BimServiceSettings.from_env(environ)


def test_create_app_reads_the_environment_it_is_given(tokens_path) -> None:
    app = create_app(environ={"BIM_SERVICE_TOKENS_FILE": str(tokens_path), "BIM_SERVICE_MAX_CONCURRENCY": "2"})
    assert app.state.settings.max_concurrency == 2
    with pytest.raises(ServiceConfigError):
        create_app(environ={})

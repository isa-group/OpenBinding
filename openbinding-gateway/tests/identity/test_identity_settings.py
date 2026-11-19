"""AUTH_PROVIDER and the SCORETech Identity client fail closed at startup (port of SPHERE's config tests)."""

from __future__ import annotations

import asyncio
import logging

import pytest
from pydantic import ValidationError

from openbinding_gateway.core.logging import JsonFormatter
from openbinding_gateway.core.settings import Settings
from openbinding_gateway.db.bootstrap import ensure_administrator
from openbinding_gateway.modules.identity.application import startup_warnings

from ._settings import CLIENT_SECRET, ISSUER, scoretech_settings, scoretech_values


def refused(**overrides) -> str:
    with pytest.raises(ValidationError) as error:
        scoretech_settings(**overrides)
    return str(error.value)


def test_local_is_the_default_and_needs_nothing_else() -> None:
    settings = Settings(_env_file=None)
    assert settings.auth_provider == "local"
    assert settings.scoretech_identity_required_permission == "openbinding:access"
    assert settings.session_max_s == 604800 and settings.session_idle_s == 43200


def test_an_unknown_mode_is_refused() -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, auth_provider="cas")


def test_a_complete_scoretech_configuration_starts() -> None:
    settings = scoretech_settings()
    assert settings.identity_issuer == ISSUER
    assert settings.identity_callback_url == "https://openbinding.test/api/v1/auth/identity/callback"
    assert settings.identity_login_url == "https://openbinding.test/api/v1/auth/identity/login"
    assert settings.identity_account_url == "https://identity.test/identity/account/#public-profile"
    assert settings.identity_secure_cookies is True


@pytest.mark.parametrize(
    ("field", "name"),
    [
        ("scoretech_identity_issuer", "SCORETECH_IDENTITY_ISSUER"),
        ("scoretech_identity_client_id", "SCORETECH_IDENTITY_CLIENT_ID"),
        ("scoretech_identity_client_secret", "SCORETECH_IDENTITY_CLIENT_SECRET"),
    ],
)
def test_scoretech_without_issuer_client_or_secret_is_refused(field, name) -> None:
    assert name in refused(**{field: None})
    assert name in refused(**{field: ""})


@pytest.mark.parametrize(
    "issuer",
    [
        "http://identity.test/identity/auth/realms/score",
        "https://user:pw@identity.test/identity/auth/realms/score",
        "https://identity.test/identity/auth/realms/score?x=1",
        "https://identity.test/identity/auth/realms/score#f",
        "https://identity.test/identity/auth/realms/score/",
        "ftp://identity.test/identity/auth/realms/score",
    ],
)
def test_an_unsafe_issuer_is_refused(issuer) -> None:
    assert "SCORETECH_IDENTITY_ISSUER" in refused(scoretech_identity_issuer=issuer)


def test_an_issuer_without_a_realm_is_refused() -> None:
    assert "/realms/" in refused(scoretech_identity_issuer="https://identity.test/oidc")


@pytest.mark.parametrize("host", ["localhost:18000", "127.0.0.1:18000", "[::1]:18000"])
def test_http_is_allowed_on_loopback_only(host) -> None:
    settings = scoretech_settings(
        scoretech_identity_issuer=f"http://{host}/identity/auth/realms/score",
        frontend_url="http://localhost:18198",
        public_base_url="http://localhost:18198",
    )
    assert settings.identity_secure_cookies is False


@pytest.mark.parametrize(
    "callback",
    [
        "https://elsewhere.test/api/v1/auth/identity/callback",
        "https://openbinding.test/api/v1/auth/cas/callback",
        "http://openbinding.test/api/v1/auth/identity/callback",
    ],
)
def test_a_callback_on_another_origin_or_path_is_refused(callback) -> None:
    assert "SCORETECH_IDENTITY_CALLBACK_URL" in refused(scoretech_identity_callback_url=callback)


def test_public_base_url_on_another_origin_is_refused() -> None:
    assert "PUBLIC_BASE_URL" in refused(public_base_url="https://api.openbinding.test")


def test_frontend_over_plain_http_off_loopback_is_refused() -> None:
    assert "FRONTEND_URL" in refused(frontend_url="http://openbinding.test", public_base_url="http://openbinding.test")


def test_a_transport_must_keep_the_realm_and_match_the_issuer_scheme() -> None:
    assert scoretech_settings(scoretech_identity_transport_url="https://keycloak.test/identity/auth/realms/score")
    assert "SCORETECH_IDENTITY_TRANSPORT_URL" in refused(
        scoretech_identity_transport_url="http://keycloak.test/identity/auth/realms/score"
    )
    assert "SCORETECH_IDENTITY_TRANSPORT_URL" in refused(
        scoretech_identity_transport_url="https://keycloak.test/identity/auth/realms/other"
    )
    lab = scoretech_settings(
        scoretech_identity_issuer="http://localhost:18000/identity/auth/realms/score",
        scoretech_identity_transport_url="http://keycloak:8080/identity/auth/realms/score",
        frontend_url="http://localhost:18198",
        public_base_url="http://localhost:18198",
    )
    assert lab.scoretech_identity_transport_url


def test_an_account_url_with_userinfo_or_query_is_refused() -> None:
    assert "SCORETECH_IDENTITY_ACCOUNT_URL" in refused(scoretech_identity_account_url="https://identity.test/account/?x=1")
    assert "SCORETECH_IDENTITY_ACCOUNT_URL" in refused(scoretech_identity_account_url="http://identity.test/account/")


def test_the_memory_store_is_refused_in_production() -> None:
    with pytest.raises(ValidationError, match="IDENTITY_STORE_BACKEND"):
        Settings(
            _env_file=None,
            app_env="prod",
            identity_store_backend="memory",
            gateway_jwt_secret="x" * 40,
            cors_allow_origins="https://openbinding.test",
            space_enabled=True,
            space_organization_id="org",
        )


@pytest.mark.parametrize("mode", ["local", "scoretech"])
def test_exposed_recovery_tokens_are_refused_in_production_in_both_modes(mode) -> None:
    extra = scoretech_values(app_env="prod") if mode == "scoretech" else {"app_env": "prod"}
    extra.update(
        expose_recovery_tokens=True,
        identity_store_backend="redis",
        gateway_jwt_secret="x" * 40,
        cors_allow_origins="https://openbinding.test",
        space_enabled=True,
        space_organization_id="org",
    )
    with pytest.raises(ValidationError, match="EXPOSE_RECOVERY_TOKENS"):
        Settings(_env_file=None, **extra)


def test_seed_default_admin_is_refused_in_scoretech() -> None:
    assert "SEED_DEFAULT_ADMIN" in refused(seed_default_admin=True)


def test_scoretech_needs_a_usable_credential_key() -> None:
    assert "SECRETS_FERNET_KEYS" in refused(secrets_fernet_keys=None)
    assert "SECRETS_FERNET_KEYS" in refused(secrets_fernet_keys="not-a-fernet-key")
    from openbinding_gateway.security.secrets import generate_key

    assert scoretech_settings(secrets_fernet_keys=None, federation_secret_key=generate_key())


@pytest.mark.parametrize(
    ("value", "fragment"),
    [
        ("https://web.test/path", "AUTH_TRUSTED_ORIGINS"),
        ("http://web:8080", "scheme"),
    ],
)
def test_trusted_origins_are_exact_and_follow_the_frontend_scheme(value, fragment) -> None:
    assert fragment in refused(auth_trusted_origins=value)


def test_trusted_origins_over_http_are_refused_in_production() -> None:
    with pytest.raises(ValidationError, match="AUTH_TRUSTED_ORIGINS"):
        Settings(
            _env_file=None,
            app_env="prod",
            frontend_url="http://localhost:18199",
            auth_trusted_origins="http://web:8080",
            gateway_jwt_secret="x" * 40,
            cors_allow_origins="https://openbinding.test",
            space_enabled=True,
            space_organization_id="org",
        )


def test_the_lab_trusted_origin_pair_is_accepted() -> None:
    settings = Settings(_env_file=None, frontend_url="http://localhost:18199", auth_trusted_origins="http://web:8080")
    assert settings.trusted_browser_origins == {"http://localhost:18199", "http://web:8080"}


def test_bootstrap_password_settings_are_ignored_in_scoretech_with_one_warning(caplog) -> None:
    settings = scoretech_settings(
        bootstrap_admin_username="operator", bootstrap_admin_password="a-long-password", bootstrap_admin_email="o@example.invalid"
    )
    with caplog.at_level(logging.WARNING):
        assert asyncio.run(ensure_administrator(None, settings)) is False  # type: ignore[arg-type]
    warnings = [record for record in caplog.records if "bootstrap_admin_ignored" in record.getMessage()]
    assert len(warnings) == 1


def test_local_in_production_warns_once_and_starts() -> None:
    settings = Settings(
        _env_file=None,
        app_env="prod",
        gateway_jwt_secret="x" * 40,
        cors_allow_origins="https://openbinding.test",
        space_enabled=True,
        space_organization_id="org",
    )
    warnings = startup_warnings(settings)
    assert len(warnings) == 1 and warnings[0].startswith("auth_provider_local_in_production")
    assert startup_warnings(scoretech_settings()) == []


def test_the_secret_never_appears_in_repr_or_a_log_line() -> None:
    settings = scoretech_settings()
    assert CLIENT_SECRET not in repr(settings)
    assert CLIENT_SECRET not in str(settings.model_dump())
    formatter = JsonFormatter(secrets=(settings.scoretech_identity_client_secret.get_secret_value(),))
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "secret is %s", (CLIENT_SECRET,), None)
    assert CLIENT_SECRET not in formatter.format(record)


def test_a_validation_error_does_not_echo_the_secret() -> None:
    message = refused(**{"scoretech_identity_issuer": "not a url", "scoretech_identity_client_secret": CLIENT_SECRET})
    assert CLIENT_SECRET not in message

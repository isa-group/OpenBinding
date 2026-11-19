"""Settings of a SCORETech-mode gateway for the identity tests (never the real issuer)."""

from __future__ import annotations

from openbinding_gateway.core.settings import Settings
from openbinding_gateway.security.secrets import generate_key

ISSUER = "https://identity.test/identity/auth/realms/score"
TRANSPORT = "https://keycloak.test/identity/auth/realms/score"
CLIENT_ID = "ob-test-client"
CLIENT_SECRET = "fixture-local-only-client-secret-0001"
FRONTEND = "https://openbinding.test"
FERNET_KEY = generate_key()


def scoretech_values(**overrides) -> dict:
    values = dict(
        app_env="test",
        auth_provider="scoretech",
        scoretech_identity_issuer=ISSUER,
        scoretech_identity_client_id=CLIENT_ID,
        scoretech_identity_client_secret=CLIENT_SECRET,
        frontend_url=FRONTEND,
        public_base_url=FRONTEND,
        secrets_fernet_keys=FERNET_KEY,
        identity_store_backend="memory",
        gateway_jwt_secret="identity-tests-secret-that-is-long-enough",
    )
    values.update(overrides)
    return values


def scoretech_settings(**overrides) -> Settings:
    return Settings(_env_file=None, **scoretech_values(**overrides))

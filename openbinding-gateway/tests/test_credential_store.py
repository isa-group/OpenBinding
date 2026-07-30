"""Credentials for other people's engines: kept, used, never handed back.

The contrast with ``security.apikeys`` is the point. A key this gateway issues
is hashed, because recognising one is all that is ever needed. A credential for
somebody else's engine has to be presented on every solve, so it has to be
readable - which means encryption, which means a key, which means a deployment
without one cannot store these at all rather than storing them in the clear.
"""

from __future__ import annotations

import pytest

from openbinding_gateway.security.secrets import (
    CredentialStore,
    SecretsUnavailable,
    generate_key,
)


@pytest.fixture
def store() -> CredentialStore:
    return CredentialStore(generate_key())


def test_a_credential_survives_a_round_trip(store):
    assert store.decrypt(store.encrypt("sk-live-1234")) == "sk-live-1234"


def test_the_stored_form_does_not_contain_the_secret(store):
    # The whole reason for the column being ciphertext: a database read must
    # not hand over a working credential for a third party's service.
    assert "sk-live-1234" not in store.encrypt("sk-live-1234")


def test_the_same_secret_encrypts_differently_each_time(store):
    # Otherwise equal ciphertexts would reveal that two engines share a key.
    assert store.encrypt("same") != store.encrypt("same")


def test_a_credential_from_another_key_will_not_decrypt():
    token = CredentialStore(generate_key()).encrypt("sk-live-1234")

    with pytest.raises(SecretsUnavailable) as error:
        CredentialStore(generate_key()).decrypt(token)

    # The operator needs to know this is a key problem they can act on, not a
    # bug: after a rotation the owner has to re-enter the credential.
    assert "rotated" in str(error.value)


def test_tampering_is_detected(store):
    token = store.encrypt("sk-live-1234")
    tampered = token[:-4] + ("aaaa" if not token.endswith("aaaa") else "bbbb")

    with pytest.raises(SecretsUnavailable):
        store.decrypt(tampered)


def test_unicode_survives(store):
    assert store.decrypt(store.encrypt("clé-secrète-ñ")) == "clé-secrète-ñ"


# -- A deployment with no key ----------------------------------------------


def test_without_a_key_nothing_is_stored_rather_than_stored_in_the_clear():
    store = CredentialStore(None)

    assert store.available is False
    with pytest.raises(SecretsUnavailable) as error:
        store.encrypt("sk-live-1234")

    assert "FEDERATION_SECRET_KEY" in str(error.value)


def test_without_a_key_a_stored_credential_cannot_be_read_either():
    with pytest.raises(SecretsUnavailable):
        CredentialStore(None).decrypt("anything")


def test_a_key_that_is_not_a_key_fails_at_construction_not_at_first_use():
    # Discovering this on the first solve of the day is worse than discovering
    # it at startup.
    with pytest.raises(SecretsUnavailable) as error:
        CredentialStore("not-a-fernet-key")

    assert "generate one" in str(error.value).lower()


def test_a_configured_deployment_says_it_can_store_credentials(store):
    assert store.available is True


def test_the_store_can_be_built_from_settings():
    from openbinding_gateway.core.settings import Settings

    key = generate_key()
    store = CredentialStore.from_settings(Settings(federation_secret_key=key))

    assert store.decrypt(store.encrypt("x")) == "x"

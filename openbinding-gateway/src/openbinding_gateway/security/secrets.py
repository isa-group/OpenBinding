"""Keeping the credentials people register with their engines.

An API key this gateway issues is hashed, because nothing ever needs it back -
a hash is enough to recognise one. A credential for *somebody else's* engine is
the opposite: the gateway has to present it on every solve, so it has to be
able to read it. That rules out hashing and leaves encryption, which means a
key, which means a deployment that has not set one cannot store these at all.

Fernet rather than raw AES: it is authenticated, it carries its own timestamp
and version, and it is the one primitive in ``cryptography`` that is difficult
to hold wrongly.

The asymmetry with the API keys module is deliberate and worth stating, because
the two look similar and are not: **a credential can be replaced but never
read back through the API**. Decryption exists for the request path only.
"""

from __future__ import annotations

from typing import Optional, Sequence, Union

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from ..core.settings import Settings


class SecretsUnavailable(RuntimeError):
    """No key is configured, so credentials cannot be handled.

    Raised rather than falling back to storing anything in the clear. A
    deployment that has set neither ``SECRETS_FERNET_KEYS`` nor
    ``FEDERATION_SECRET_KEY`` can still run federated engines that need no
    credential; it simply cannot keep one.
    """


def parse_keys(value: Union[None, str, Sequence[str]]) -> list[str]:
    """The keys in a comma-separated string (or sequence), in order, blanks dropped."""
    if value is None:
        return []
    items = value.split(",") if isinstance(value, str) else list(value)
    return [item.strip() for item in items if item and item.strip()]


class CredentialStore:
    """Encrypts and decrypts third-party credentials.

    Several keys may be configured (``MultiFernet``): the first one encrypts,
    every one decrypts, so rotating means putting the new key first and
    retiring the old one once nothing is encrypted with it.

    Constructed from settings rather than reading them itself, so a test can
    hand it a key without touching the environment.
    """

    def __init__(self, keys: Union[None, str, Sequence[str]]) -> None:
        self._fernet: Optional[MultiFernet] = None
        parsed = parse_keys(keys)
        if parsed:
            try:
                self._fernet = MultiFernet([Fernet(key.encode("utf-8")) for key in parsed])
            except (ValueError, TypeError) as error:
                raise SecretsUnavailable(
                    "SECRETS_FERNET_KEYS holds a key that is not a valid Fernet key. Generate one with "
                    "`python -c \"from cryptography.fernet import Fernet; "
                    'print(Fernet.generate_key().decode())"`.'
                ) from error

    @classmethod
    def from_settings(cls, settings: Settings) -> "CredentialStore":
        keys = parse_keys(settings.secrets_fernet_keys)
        legacy = (settings.federation_secret_key or "").strip()
        if legacy and legacy not in keys:
            # Read-compatible: whatever the single key encrypted before still
            # decrypts. It encrypts only when no list is configured.
            keys.append(legacy)
        return cls(keys)

    @property
    def available(self) -> bool:
        """Whether this deployment can store credentials at all."""
        return self._fernet is not None

    def encrypt(self, secret: str) -> str:
        """Ciphertext for storage. Raises if no key is configured."""
        if self._fernet is None:
            raise SecretsUnavailable(
                "This gateway has no SECRETS_FERNET_KEYS (or legacy FEDERATION_SECRET_KEY), so it "
                "cannot store a credential for an engine. Register an engine that needs none, or "
                "configure a key."
            )
        return self._fernet.encrypt(secret.encode("utf-8")).decode("ascii")

    def decrypt(self, token: str) -> str:
        """The credential, for the request path only.

        A token that will not decrypt is a rotated or corrupted key rather than
        a programming error, so it is reported as something the operator can
        act on.
        """
        if self._fernet is None:
            raise SecretsUnavailable(
                "This gateway has no SECRETS_FERNET_KEYS (or legacy FEDERATION_SECRET_KEY), so it "
                "cannot read the credential stored for this engine."
            )
        try:
            return self._fernet.decrypt(token.encode("ascii")).decode("utf-8")
        except (InvalidToken, ValueError) as error:
            raise SecretsUnavailable(
                "A stored credential could not be decrypted with any configured "
                "key (SECRETS_FERNET_KEYS / FEDERATION_SECRET_KEY). If the key was rotated "
                "out, the owner has to re-enter it."
            ) from error


def generate_key() -> str:
    """A fresh Fernet key, for ``.env`` and for tests."""
    return Fernet.generate_key().decode("ascii")

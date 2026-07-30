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

from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from ..core.settings import Settings


class SecretsUnavailable(RuntimeError):
    """No key is configured, so credentials cannot be handled.

    Raised rather than falling back to storing anything in the clear. A
    deployment that has not set ``FEDERATION_SECRET_KEY`` can still run
    federated engines that need no credential; it simply cannot keep one.
    """


class CredentialStore:
    """Encrypts and decrypts third-party credentials.

    Constructed from settings rather than reading them itself, so a test can
    hand it a key without touching the environment.
    """

    def __init__(self, key: Optional[str]) -> None:
        self._fernet: Optional[Fernet] = None
        if key:
            try:
                self._fernet = Fernet(key.encode("utf-8"))
            except (ValueError, TypeError) as error:
                raise SecretsUnavailable(
                    "FEDERATION_SECRET_KEY is not a valid Fernet key. Generate one with "
                    "`python -c \"from cryptography.fernet import Fernet; "
                    'print(Fernet.generate_key().decode())"`.'
                ) from error

    @classmethod
    def from_settings(cls, settings: Settings) -> "CredentialStore":
        return cls(settings.federation_secret_key)

    @property
    def available(self) -> bool:
        """Whether this deployment can store credentials at all."""
        return self._fernet is not None

    def encrypt(self, secret: str) -> str:
        """Ciphertext for storage. Raises if no key is configured."""
        if self._fernet is None:
            raise SecretsUnavailable(
                "This gateway has no FEDERATION_SECRET_KEY, so it cannot store a "
                "credential for an engine. Register an engine that needs none, or "
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
                "This gateway has no FEDERATION_SECRET_KEY, so it cannot read the "
                "credential stored for this engine."
            )
        try:
            return self._fernet.decrypt(token.encode("ascii")).decode("utf-8")
        except (InvalidToken, ValueError) as error:
            raise SecretsUnavailable(
                "A stored credential could not be decrypted with the configured "
                "FEDERATION_SECRET_KEY. If the key was rotated, the owner has to "
                "re-enter it."
            ) from error


def generate_key() -> str:
    """A fresh Fernet key, for ``.env`` and for tests."""
    return Fernet.generate_key().decode("ascii")

"""Personal API keys: how they are minted, stored and recognised.

A key looks like ``obk_<prefix>_<secret>``. The three parts each earn their
place: ``obk_`` makes a leaked key identifiable at a glance - by its owner, by a
secret scanner, and by the gateway when it has to tell a key from a session
token in the same header - the prefix names a row without being enough to use
it, and the secret is 256 bits of randomness.

Only a SHA-256 of the whole key is stored. That is deliberately not argon2:
password hashing is slow on purpose because passwords are guessable, and this
secret is not - it is uniformly random, so there is nothing to guess and no
reason to spend 100 ms of CPU on every API request proving it.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from typing import Optional

PREFIX_MARKER = "obk"
#: Bytes of randomness in the secret half.
SECRET_BYTES = 32
#: Hex characters in the lookup prefix. Eight is plenty to make collisions
#: negligible while staying short enough to show in a list.
PREFIX_HEX_CHARS = 8


@dataclass(frozen=True)
class MintedKey:
    """A freshly minted key: what to show once, and what to keep."""

    #: The whole key. Shown to its owner exactly once and never stored.
    secret: str
    #: The lookup half, stored in the clear.
    prefix: str
    #: What actually goes in the database.
    secret_hash: str


def hash_key(full_key: str) -> str:
    return hashlib.sha256(full_key.encode("utf-8")).hexdigest()


def mint() -> MintedKey:
    prefix = f"{PREFIX_MARKER}_{secrets.token_hex(PREFIX_HEX_CHARS // 2)}"
    full_key = f"{prefix}_{secrets.token_urlsafe(SECRET_BYTES)}"
    return MintedKey(secret=full_key, prefix=prefix, secret_hash=hash_key(full_key))


def looks_like_api_key(credential: str) -> bool:
    """Whether this credential is one of ours rather than a session token.

    The two arrive in the same header, so something has to decide which
    resolution to attempt. The marker is what makes that decidable without
    trying both and hoping.
    """
    return credential.startswith(f"{PREFIX_MARKER}_")


def prefix_of(credential: str) -> Optional[str]:
    """The lookup prefix inside a key, or ``None`` if it is not shaped like one."""
    parts = credential.split("_")
    if len(parts) < 3 or parts[0] != PREFIX_MARKER:
        return None
    if not parts[1]:
        return None
    return f"{PREFIX_MARKER}_{parts[1]}"


def matches(credential: str, stored_hash: str) -> bool:
    """Whether a presented key is the one this hash was made from.

    Compared in constant time. The prefix already narrowed this to a single
    row, so the comparison is only ever against one candidate - but a timing
    difference here would still leak, one byte at a time, what that row holds.
    """
    return hmac.compare_digest(hash_key(credential), stored_hash)

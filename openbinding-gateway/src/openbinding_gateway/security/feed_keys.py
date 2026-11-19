"""Environment feed keys: the credential an application reads one composition environment's feed with.

A feed key looks like ``obe_<prefix>_<secret>``: the same entropy, SHA-256 storage and constant-time comparison as
a personal API key (``security.apikeys``), but a different marker. A feed key belongs to an environment, not to a
person, carries no permission list and opens nothing but that environment's feed: ``access.dependencies`` refuses
it everywhere else (401 ``environment_key_elsewhere``), and the log filter redacts it. The marker makes a leaked key
recognisable at a glance as "one environment's feed, read-only", to its owner and to secret scanners.
"""

from __future__ import annotations

import secrets
from typing import Optional

from .apikeys import PREFIX_HEX_CHARS, SECRET_BYTES, MintedKey, hash_key, matches

FEED_KEY_MARKER = "obe"

__all__ = ["FEED_KEY_MARKER", "MintedKey", "looks_like_feed_key", "matches", "mint", "prefix_of"]


def mint() -> MintedKey:
    """A new feed key: the whole key (shown once), its lookup prefix and the hash that is stored."""
    prefix = f"{FEED_KEY_MARKER}_{secrets.token_hex(PREFIX_HEX_CHARS // 2)}"
    full_key = f"{prefix}_{secrets.token_urlsafe(SECRET_BYTES)}"
    return MintedKey(secret=full_key, prefix=prefix, secret_hash=hash_key(full_key))


def looks_like_feed_key(credential: str) -> bool:
    """Whether a credential carries the feed-key marker (it is then never tried as a token or a personal key)."""
    return credential.startswith(f"{FEED_KEY_MARKER}_")


def prefix_of(credential: str) -> Optional[str]:
    """The lookup prefix inside a feed key, or ``None`` if it is not shaped like one."""
    parts = credential.split("_")
    if len(parts) < 3 or parts[0] != FEED_KEY_MARKER or not parts[1]:
        return None
    return f"{FEED_KEY_MARKER}_{parts[1]}"

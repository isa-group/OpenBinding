"""Idempotency fingerprint of a job submission."""

from __future__ import annotations

from typing import Any

from ..v1.canonical import digest

V2_PREFIX = "v2:"


def request_fingerprint(*, source_digest: str, body: Any, configuration: Any) -> str:
    """Fingerprint what the client SENT, not what the gateway resolved.

    The engine picked by ``auto`` and the options trimmed by the caller's plan
    are deliberately excluded: they may change between two identical
    submissions and must not turn a retry into a conflict.

    The result is ``v2:`` plus a ``sha256-`` digest (74 characters), which fits
    ``String(80)``.
    """
    return V2_PREFIX + digest({"source": source_digest, "body": body, "configuration": configuration})


def is_request_fingerprint(value: str | None) -> bool:
    """True for fingerprints written by this algorithm (False for legacy rows)."""
    return value is not None and value.startswith(V2_PREFIX)

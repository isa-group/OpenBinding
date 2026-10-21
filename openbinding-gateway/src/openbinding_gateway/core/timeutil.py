"""Timestamp formats that are part of a contract rather than a convenience."""

from __future__ import annotations

from datetime import datetime, timezone


def utc_timestamp_z(now: datetime | None = None) -> str:
    """``YYYY-MM-DDTHH:mm:ssZ``: UTC, 24 hours, whole seconds, no fraction.

    The format of the ``createdAt`` field of a pricing document. ``now`` must be
    timezone-aware (it is converted to UTC); a naive value is refused rather
    than guessed at, because the process timezone is not what the caller meant.
    Without ``now`` the current time is used.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    elif now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("utc_timestamp_z needs a timezone-aware datetime")
    return now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

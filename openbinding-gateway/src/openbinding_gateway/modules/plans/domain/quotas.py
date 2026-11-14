"""Per-account quotas of pricing 0.2.0, as pure checks.

The callers count (problems owned, bytes stored) inside the transaction that
holds the account's row lock, then ask here whether one more fits. A limit the
plan does not declare is zero (``PlanCaps.limit`` fails closed); an unlimited
one (``inf``) never refuses.
"""

from __future__ import annotations

from typing import Optional, Protocol

from . import entitlement_map as ids
from .refusal import Refusal

#: Problem code of every quota refusal (402).
QUOTA_EXCEEDED = "quota_exceeded"


class Caps(Protocol):
    def limit(self, identifier: str) -> Optional[float]: ...


def _refusal(limit_id: str, limit: float, used: float, detail: str) -> Refusal:
    return Refusal(
        402,
        QUOTA_EXCEEDED,
        detail,
        extra={
            "quota": {
                "limit_id": limit_id,
                "limit": limit,
                "used": used,
                "unit": ids.LIMIT_UNITS.get(limit_id),
                "source": "plan",
            }
        },
    )


def problems_quota(count: int, caps: Caps) -> Optional[Refusal]:
    """The refusal for creating one more problem when the account owns ``count``, or ``None``."""
    allowance = caps.limit(ids.MAX_PROBLEMS)
    if allowance is None or count + 1 <= allowance:
        return None
    return _refusal(
        ids.MAX_PROBLEMS,
        allowance,
        count,
        f"Your plan allows {int(allowance)} problem{'' if allowance == 1 else 's'}, and you own {count}.",
    )


def storage_quota(bytes_used: int, incoming: int, caps: Caps) -> Optional[Refusal]:
    """The refusal for storing ``incoming`` more bytes on top of ``bytes_used``, or ``None``.

    The allowance is ``maxRepositoryStorage`` in MB (10**6 bytes). ``limit`` and
    ``used`` (what is stored already) are reported in MB, and the exact byte
    counts beside them.
    """
    allowance = caps.limit(ids.MAX_REPOSITORY_STORAGE)
    if allowance is None or bytes_used + incoming <= ids.storage_mb_to_bytes(allowance):
        return None
    refusal = _refusal(
        ids.MAX_REPOSITORY_STORAGE,
        allowance,
        round(bytes_used / ids.BYTES_PER_MB, 6),
        f"Your plan allows {allowance:g} MB of stored problems; this upload would exceed it.",
    )
    refusal.extra["quota"]["used_bytes"] = bytes_used
    refusal.extra["quota"]["incoming_bytes"] = incoming
    return refusal

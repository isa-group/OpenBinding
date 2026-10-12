"""The rejections every entry point reports for a plan or a technical limit.

Only two kinds live here: a plan that does not include a feature (403) and the
technical concurrency limit (429, retryable). Complexity, payload and timeout
ceilings are decided by ``access.policy``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..space_client import PlanCaps

CONCURRENCY_RETRY_AFTER = "15"

DEFAULT_CONCURRENCY_DETAIL = "Concurrency limit exceeded."
DEFAULT_NOT_ENTITLED_DETAIL = "The current plan does not entitle this feature."


@dataclass(frozen=True)
class Refusal:
    """A transport-neutral rejection: callers render it as a response or an exception."""

    status: int
    code: str
    detail: str
    extra: dict[str, Any] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)


def feature_refusal(
    caps: PlanCaps,
    feature: str,
    *,
    default_not_entitled_detail: str = DEFAULT_NOT_ENTITLED_DETAIL,
) -> Refusal | None:
    """The 403 for a plan that lacks ``feature``, or ``None`` when it has it."""
    if caps.allows(feature):
        return None
    return Refusal(403, "feature_not_entitled", default_not_entitled_detail)


def concurrency_refusal(limit: int, active: int) -> Refusal:
    """The retryable 429 for an account that already has ``limit`` jobs in flight."""
    return Refusal(
        429,
        "concurrency_limit_exceeded",
        DEFAULT_CONCURRENCY_DETAIL,
        extra={"concurrency": {"limit": limit, "active": active}},
        headers={"Retry-After": CONCURRENCY_RETRY_AFTER},
    )

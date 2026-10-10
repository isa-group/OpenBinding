"""Turn a refused pricing verdict into the rejection every entry point reports."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..space_client import Verdict

CONCURRENCY_LIMIT_ID = "concurrentJobs"
CONCURRENCY_RETRY_AFTER = "15"

DEFAULT_CONCURRENCY_DETAIL = "Concurrency limit exceeded."
DEFAULT_QUOTA_DETAIL = "Solve quota exhausted."
DEFAULT_NOT_ENTITLED_DETAIL = "The current plan does not entitle this feature."


@dataclass(frozen=True)
class Refusal:
    """A transport-neutral rejection: callers render it as a response or an exception."""

    status: int
    code: str
    detail: str
    extra: dict[str, Any] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)


def refusal_for_verdict(
    verdict: Verdict,
    *,
    default_quota_detail: str = DEFAULT_QUOTA_DETAIL,
    default_not_entitled_detail: str = DEFAULT_NOT_ENTITLED_DETAIL,
) -> Refusal:
    """Map a verdict that is not ``allowed`` to its rejection.

    ``concurrentJobs`` is a retryable 429; any other exhausted limit is a 402
    that names the limit; a refusal without a limit means the plan lacks the
    feature (403).
    """
    limit = verdict.limit
    if limit is None:
        return Refusal(403, "feature_not_entitled", verdict.reason or default_not_entitled_detail)
    if limit.limit_id == CONCURRENCY_LIMIT_ID:
        return Refusal(
            429,
            "concurrency_limit_exceeded",
            verdict.reason or DEFAULT_CONCURRENCY_DETAIL,
            extra={"concurrency": {"limit_id": CONCURRENCY_LIMIT_ID, "limit": limit.limit, "used": limit.used}},
            headers={"Retry-After": CONCURRENCY_RETRY_AFTER},
        )
    return Refusal(
        402,
        "quota_exceeded",
        verdict.reason or default_quota_detail,
        extra={
            "quota": {
                "limit_id": limit.limit_id,
                "limit": limit.limit,
                "used": limit.used,
                "unit": limit.unit,
                "renews_at": limit.renews_at,
            }
        },
    )

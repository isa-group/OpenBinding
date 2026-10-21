"""The rejections every entry point reports for a plan or a technical limit.

Only two kinds live here: a plan that does not include a feature (403) and the
simultaneous-jobs limit (429, retryable), which is the lower of the plan's
``concurrentJobs`` and the deployment's cap. Complexity, payload and timeout
ceilings are decided by ``access.policy``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..space_client import PlanCaps

CONCURRENCY_RETRY_AFTER = "15"

#: The identifier SPACE's pricing gives the plan's simultaneous-jobs limit; the technical cap reports under it.
CONCURRENCY_LIMIT_ID = "concurrentJobs"

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


@dataclass(frozen=True)
class ConcurrencyLimit:
    """How many jobs one account may have in flight, and which limit set the number."""

    limit: int
    #: ``plan`` when the plan's ``concurrentJobs`` is lower than the deployment's cap; ``technical`` otherwise
    #: (the cap holds whatever the plan says, so it is the one reached when both are equal).
    source: str


def concurrency_limit(caps: PlanCaps | None, technical: int) -> ConcurrencyLimit:
    """The simultaneous-jobs limit of an account: the lower of its plan's ``concurrentJobs`` and ``technical``.

    ``technical`` is ``MAX_CONCURRENT_JOBS_PER_USER`` and always applies. The
    plan lowers it only with a usable finite value; a fraction is rounded down.
    A plan that does not declare ``concurrentJobs``, or declares it unlimited
    (SPACE's ``null``), or declares something that is not a non-negative number,
    leaves the technical cap in force: an unknown limit is never read as
    unlimited and never as slots that happen to be free. A declared ``0`` is a
    limit of zero (nothing may run), not an unknown one.
    """
    if caps is not None and CONCURRENCY_LIMIT_ID in caps.limits:
        raw = caps.limits[CONCURRENCY_LIMIT_ID]
        try:
            declared = math.nan if isinstance(raw, bool) else float(raw)
        except (TypeError, ValueError, OverflowError):
            declared = math.nan
        if math.isfinite(declared) and declared >= 0 and math.floor(declared) < technical:
            return ConcurrencyLimit(math.floor(declared), "plan")
    return ConcurrencyLimit(technical, "technical")


def concurrency_refusal(limit: int, active: int, source: str = "technical") -> Refusal:
    """The retryable 429 for an account that already has ``limit`` jobs in flight.

    ``concurrency`` names the limit like the 402 ``quota`` does (``limit_id``,
    ``limit``, ``used``, ``unit``, ``source``); ``active`` is the same count as
    ``used``, kept for the clients that read it. A concurrency limit is a ceiling
    on simultaneous jobs, not a balance: a slot is free again the moment a job ends.
    """
    return Refusal(
        429,
        "concurrency_limit_exceeded",
        DEFAULT_CONCURRENCY_DETAIL,
        extra={
            "concurrency": {
                "limit_id": CONCURRENCY_LIMIT_ID,
                "limit": limit,
                "used": active,
                "active": active,
                "unit": "job",
                "source": source,
            }
        },
        headers={"Retry-After": CONCURRENCY_RETRY_AFTER},
    )

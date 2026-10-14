"""The port through which the gateway would read SPACE's native usage counters (class B).

``taskStarts``, ``federatedTaskStarts``, ``solverSeconds`` and ``studyRuns`` are
counters that accumulate over a billing period. The gateway keeps **no** such
count: no ledger, no balance, no table, no event log. If SPACE measures them,
it is the source, and this module is the only thing the gateway knows about it:
one read-only question, "what does SPACE say about this counter for this
account?", with a defined answer for every way that can go.

Nothing implements this port against the real SPACE yet (SPACE is on hold, and
the 1.x client has no call for it that anyone has verified). Until a source is
installed with ``set_usage_source`` nothing here is consulted and the counters
are not enforced: a plan that declares them does not make them effective.

What a reading means (the gateway decides, the source only reports):

* ``available``: the counter has room (or the plan sets no limit). Go on.
* ``exhausted``: the limit is reached. Refused with 402 ``usage_limit_exceeded``.
  A reading that says ``available`` but whose ``used`` is not below its ``limit``
  is exhausted too: the numbers win over the label.
* ``unknown``: the source could not say (unreachable, malformed, not reported,
  NaN, negative, the wrong counter). Refused with 503 ``usage_limit_unknown``,
  retryable. Unknown is never read as available and never as unlimited.

Retries and replays do not count twice because the gateway never counts: it asks
before it creates a job, and an idempotent replay returns the existing job before
the question is asked (``services/job_submission.py``). What the source counts,
and from which event, is SPACE's to define; see ``docs/qa/USAGE_LIMITS.md``.
"""

from __future__ import annotations

import enum
import math
import uuid
from dataclasses import dataclass
from typing import Optional, Protocol, runtime_checkable

from .entitlements import Refusal

#: The counters this port knows, with the unit each is measured in.
COUNTER_UNITS: dict[str, str] = {
    "taskStarts": "task",
    "federatedTaskStarts": "task",
    "solverSeconds": "second",
    "studyRuns": "run",
}

EXHAUSTED_CODE = "usage_limit_exceeded"
UNKNOWN_CODE = "usage_limit_unknown"
RETRY_AFTER = "15"


class UsageState(str, enum.Enum):
    AVAILABLE = "available"
    EXHAUSTED = "exhausted"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class UsageReading:
    """What a source reports for one counter of one account in the current period."""

    counter: str
    state: UsageState
    used: Optional[float] = None
    #: ``None`` is "no limit" for an available reading and "not reported" for the others.
    limit: Optional[float] = None

    @classmethod
    def available(cls, counter: str, used: float = 0.0, limit: Optional[float] = None) -> "UsageReading":
        return cls(counter, UsageState.AVAILABLE, used, limit)

    @classmethod
    def exhausted(cls, counter: str, used: Optional[float] = None, limit: Optional[float] = None) -> "UsageReading":
        return cls(counter, UsageState.EXHAUSTED, used, limit)

    @classmethod
    def unknown(cls, counter: str) -> "UsageReading":
        return cls(counter, UsageState.UNKNOWN)


@runtime_checkable
class UsageCounterSource(Protocol):
    """Read-only access to the usage SPACE has measured. Implementations must not write."""

    async def reading(self, user_id: uuid.UUID, counter: str) -> UsageReading:
        """The state of ``counter`` for ``user_id``; raise only for a failure to ask (it becomes ``unknown``)."""


class UnreportedUsage:
    """A source that knows nothing: every counter is ``unknown``. For tests of the fail-closed path."""

    async def reading(self, user_id: uuid.UUID, counter: str) -> UsageReading:
        return UsageReading.unknown(counter)


_source: Optional[UsageCounterSource] = None


def set_usage_source(source: Optional[UsageCounterSource]) -> None:
    """Install the source (``None`` removes it: nothing is consulted and nothing is enforced)."""
    global _source
    _source = source


def get_usage_source() -> Optional[UsageCounterSource]:
    return _source


def _number(value: object) -> Optional[float]:
    """``value`` as a finite non-negative float, else ``None``."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and number >= 0 else None


def sanitize(reading: object, counter: str) -> UsageReading:
    """``reading`` if it is a well-formed reading of ``counter``, else ``unknown``."""
    if not isinstance(reading, UsageReading) or reading.counter != counter or not isinstance(reading.state, UsageState):
        return UsageReading.unknown(counter)
    used = None if reading.used is None else _number(reading.used)
    if reading.used is not None and used is None:
        return UsageReading.unknown(counter)
    if reading.limit is None:
        limit = None
    elif isinstance(reading.limit, float) and math.isinf(reading.limit) and reading.limit > 0:
        limit = None  # SPACE's unlimited
    else:
        limit = _number(reading.limit)
        if limit is None:
            return UsageReading.unknown(counter)
    return UsageReading(counter, reading.state, used, limit)


async def read(source: UsageCounterSource, user_id: uuid.UUID, counter: str) -> UsageReading:
    """Ask ``source``; a failure to answer, or an answer that makes no sense, is ``unknown``."""
    try:
        return sanitize(await source.reading(user_id, counter), counter)
    except Exception:  # noqa: BLE001 - whatever went wrong, the answer is "not known", never "available"
        return UsageReading.unknown(counter)


def _quota(reading: UsageReading, state: str) -> dict[str, object]:
    quota: dict[str, object] = {
        "limit_id": reading.counter,
        "state": state,
        "unit": COUNTER_UNITS.get(reading.counter, ""),
        "source": "space",
    }
    if reading.limit is not None:
        quota["limit"] = reading.limit
    if reading.used is not None:
        quota["used"] = reading.used
    return quota


def refusal_for(reading: UsageReading) -> Optional[Refusal]:
    """The refusal a (sanitized) reading calls for, or ``None`` to go on."""
    if reading.state is UsageState.UNKNOWN:
        return Refusal(
            503,
            UNKNOWN_CODE,
            "The usage of this account could not be read, so the limit cannot be checked. Nothing was started.",
            extra={"quota": _quota(reading, "unknown")},
            headers={"Retry-After": RETRY_AFTER},
        )
    spent = reading.limit is not None and reading.used is not None and reading.used >= reading.limit
    if reading.state is UsageState.EXHAUSTED or spent:
        return Refusal(
            402,
            EXHAUSTED_CODE,
            "The plan limit for this kind of usage has been reached.",
            extra={"quota": _quota(reading, "exhausted")},
        )
    return None


async def usage_refusal(user_id: uuid.UUID, *counters: str) -> Optional[Refusal]:
    """The first refusal among ``counters`` according to the installed source; ``None`` when none is installed."""
    source = _source
    if source is None:
        return None
    for counter in counters:
        refusal = refusal_for(await read(source, user_id, counter))
        if refusal is not None:
            return refusal
    return None


async def job_start_refusal(user_id: uuid.UUID, *, federated: bool) -> Optional[Refusal]:
    """The refusal for starting one more job: its task-start counter, then the solver seconds."""
    return await usage_refusal(user_id, "federatedTaskStarts" if federated else "taskStarts", "solverSeconds")

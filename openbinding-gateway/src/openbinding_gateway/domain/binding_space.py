"""The size of a binding space, held against the limits that bound it.

What is measured is the **estimated** size of the search space: the product, over
the service tasks of an instance, of how many candidates are eligible for each
(``analysis.bindingSpaceCardinality`` of BIM, with ``bindingSpaceLog10`` and
``bindingSpaceBreakdown`` beside it). It ignores constraints, so it bounds the
work an engine *might* have to search; it is not a count of what a job actually
evaluated, and nothing here reads such a count.

The cardinality travels as a **decimal string** and is compared as one. A
``float`` log10 is kept only as a display value and as the fallback when the
string is missing: summing logarithms is not exact (``log10(5) + log10(2)`` can
land on either side of ``1.0``), so a limit decided on it would wrongly accept or
refuse an instance whose size is exactly the limit. Python also refuses to turn
an ``int`` of more than ``sys.get_int_max_str_digits()`` digits (4300 by default)
into text, so nothing here calls ``int(text)`` or ``str(int)`` on a cardinality
without a guard.

Which limit applies to a request (the rules, in order):

1. ``maxInstanceComplexityLog10`` of the plan, as SPACE delivers it. A finite
   value is a ceiling in log10 units; an infinite one (SPACE's ``null``) means the
   plan sets none; an absent, negative or non-numeric one means the gateway does
   **not know** the limit.
2. ``MAX_BINDING_SPACE_LOG10``, a technical safeguard of this deployment (off by
   default). It always applies on top of the plan, and it stands in for a limit
   the plan does not declare.
3. An unknown limit with no technical safeguard refuses the instance. Unknown is
   never read as unlimited, and never as a quota that happens to be available.

Nothing is charged or reserved here: this module only decides, before the caller
has written anything.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Mapping, Optional

from .entitlements import Refusal

if TYPE_CHECKING:
    from ..space_client import PlanCaps

#: The identifier SPACE knows the plan's ceiling by.
LIMIT_ID = "maxInstanceComplexityLog10"
UNIT = "log10 combinations"

#: Over the ceiling the plan declares (402, the status this refusal has always had; nothing is billed).
EXCEEDED = "instance_complexity_too_large"
#: Over the technical safeguard of this deployment (422): a larger plan would not help.
OVER_TECHNICAL = "binding_space_over_technical_limit"
#: The plan declares no usable ceiling and no technical safeguard stands in for it (403).
LIMIT_UNKNOWN = "binding_space_limit_unknown"
#: A ceiling applies but the analysis carries no readable size (422).
UNMEASURED = "binding_space_unmeasured"

#: Every code a binding-space refusal can carry.
REFUSAL_CODES = frozenset({EXCEEDED, OVER_TECHNICAL, LIMIT_UNKNOWN, UNMEASURED})

#: A cardinality longer than this is reported by its digit count and log10 only.
REPORTED_DIGITS = 40

_CHUNK = 10**18
_HEAD_DIGITS = 17


def decimal_digits(value: int) -> str:
    """``str(value)`` for a non-negative integer of any size.

    ``str`` raises ``ValueError`` above the interpreter's integer-to-text digit limit;
    ``divmod`` has no such limit, so the digits are produced in 18-digit chunks.
    """
    if value < 0:
        raise ValueError("a cardinality is not negative")
    try:
        return str(value)
    except ValueError:
        chunks: list[str] = []
        while value:
            value, rest = divmod(value, _CHUNK)
            chunks.append(f"{rest:018d}")
        return "".join(reversed(chunks)).lstrip("0") or "0"


def parse_cardinality(value: Any) -> Optional[str]:
    """The canonical decimal digits of a cardinality, or ``None`` when ``value`` is not one.

    Accepts a non-negative ``int`` or a string of ASCII digits (BIM's wire format).
    Floats, booleans, signs, spaces and empty strings are not a cardinality.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return decimal_digits(value) if value >= 0 else None
    if isinstance(value, str) and value.isascii() and value.isdigit():
        return value.lstrip("0") or "0"
    return None


def log10_of(digits: str) -> float:
    """``log10`` of a canonical decimal string, exact to ``float`` precision at any length."""
    if digits == "0":
        return 0.0
    head = digits[:_HEAD_DIGITS]
    return math.log10(int(head)) + (len(digits) - len(head))


def cardinality_exceeds(digits: str, ceiling_log10: float) -> bool:
    """Whether the cardinality ``digits`` is greater than ``10 ** ceiling_log10``.

    Exact when the ceiling is a whole number (the unit of the plans): ``10**9``
    is within a ceiling of 9 and ``10**9 + 1`` is not, with no logarithm
    involved. For a fractional ceiling the comparison is on the log10 of the
    leading 17 digits, so it is exact to ``float`` precision (about 1e-16): an
    instance whose log10 is within that distance of the ceiling can fall on
    either side. A cardinality of zero (a task with no eligible candidate) is
    never above a ceiling.
    """
    if digits == "0":
        return False
    count = len(digits)
    whole = math.floor(ceiling_log10)
    if whole >= count:
        # 10 ** ceiling >= 10 ** count > cardinality.
        return False
    if ceiling_log10 < count - 1:
        # 10 ** ceiling < 10 ** (count - 1) <= cardinality.
        return True
    # count - 1 <= ceiling < count: the cardinality and 10 ** ceiling share their magnitude.
    if ceiling_log10 == whole:
        return digits != "1" + "0" * whole
    head = digits[:_HEAD_DIGITS]
    return math.log10(int(head) / 10 ** (len(head) - 1)) > ceiling_log10 - whole


@dataclass(frozen=True)
class BindingSpace:
    """What an analysis says about the size of a binding space (an estimate, see the module docstring)."""

    #: Exact canonical decimal digits, or ``None`` when the analysis has no readable cardinality.
    cardinality: Optional[str]
    #: The float log10 BIM reported, or ``None`` when absent or not a finite non-negative number.
    log10: Optional[float]

    @classmethod
    def from_analysis(cls, analysis: Any) -> "BindingSpace":
        """Read ``bindingSpaceCardinality`` and ``bindingSpaceLog10``; anything unreadable becomes ``None``."""
        if not isinstance(analysis, Mapping):
            return cls(None, None)
        raw = analysis.get("bindingSpaceLog10")
        log10 = (
            float(raw)
            if isinstance(raw, (int, float)) and not isinstance(raw, bool) and math.isfinite(raw) and raw >= 0
            else None
        )
        return cls(parse_cardinality(analysis.get("bindingSpaceCardinality")), log10)

    @property
    def measured(self) -> bool:
        return self.cardinality is not None or self.log10 is not None

    @property
    def log10_estimate(self) -> Optional[float]:
        """log10 of the size: derived from the exact cardinality when there is one, else BIM's float."""
        return log10_of(self.cardinality) if self.cardinality is not None else self.log10

    def exceeds(self, ceiling_log10: float) -> bool:
        """Whether the size is above ``ceiling_log10``; an unmeasured space is the caller's to handle."""
        if self.cardinality is not None:
            return cardinality_exceeds(self.cardinality, ceiling_log10)
        return self.log10 is not None and self.log10 > ceiling_log10

    def as_report(self) -> dict[str, Any]:
        """A bounded, JSON-safe description for a refusal (never the whole of a huge cardinality)."""
        digits = self.cardinality
        estimate = self.log10_estimate
        return {
            "kind": "estimate",
            "log10": None if estimate is None else round(estimate, 6),
            "digits": None if digits is None else len(digits),
            "cardinality": digits if digits is not None and len(digits) <= REPORTED_DIGITS else None,
        }


def _plan_ceiling(caps: "PlanCaps") -> tuple[str, Optional[float]]:
    """``("declared", ceiling)``, ``("unlimited", None)`` or ``("unknown", None)`` for the plan's limit."""
    if LIMIT_ID not in caps.limits:
        return "unknown", None
    try:
        value = float(caps.limits[LIMIT_ID])
    except (TypeError, ValueError):
        return "unknown", None
    if math.isnan(value) or value < 0:
        return "unknown", None
    if math.isinf(value):
        return "unlimited", None
    return "declared", value


def _quota(state: str, ceiling: Optional[float], source: str, space: Optional[BindingSpace]) -> dict[str, Any]:
    """The ``quota`` member of a refusal: the shape the frontend already reads for a 402 (``limit_id``, ``limit``, ``used``)."""
    quota: dict[str, Any] = {"limit_id": LIMIT_ID, "state": state, "unit": UNIT, "source": source}
    if ceiling is not None:
        quota["limit"] = ceiling
    if space is not None and space.log10_estimate is not None:
        quota["used"] = round(space.log10_estimate, 6)
    return quota


def check(
    space: BindingSpace,
    caps: "PlanCaps",
    *,
    technical_log10: Optional[float] = None,
) -> Optional[Refusal]:
    """The refusal for ``space`` under ``caps`` and the deployment's safeguard, or ``None`` to go on.

    ``technical_log10`` is ``MAX_BINDING_SPACE_LOG10`` (``None`` when unset).
    """
    technical = (
        technical_log10
        if technical_log10 is not None and math.isfinite(technical_log10) and technical_log10 >= 0
        else None
    )
    state, declared = _plan_ceiling(caps)
    if declared is not None:
        if technical is not None and technical < declared:
            ceiling, source = technical, "technical"
        else:
            ceiling, source = declared, "plan"
    elif technical is not None:
        ceiling, source = technical, "technical"
    elif state == "unlimited":
        return None
    else:
        return Refusal(
            403,
            LIMIT_UNKNOWN,
            "The plan does not declare a limit for the size of the binding space, so this instance cannot be accepted.",
            extra={"quota": _quota("unknown", None, "none", space if space.measured else None)},
        )

    if not space.measured:
        return Refusal(
            422,
            UNMEASURED,
            "The size of the binding space could not be measured, so it cannot be checked against the limit.",
            extra={"quota": _quota("unmeasured", ceiling, source, None)},
        )
    if not space.exceeds(ceiling):
        return None
    extra = {"quota": _quota("exhausted", ceiling, source, space), "binding_space": space.as_report()}
    if source == "technical":
        return Refusal(
            422,
            OVER_TECHNICAL,
            "instance binding space exceeds the limit of this deployment",
            extra=extra,
        )
    return Refusal(402, EXCEEDED, "instance binding space exceeds the caller plan limit", extra=extra)

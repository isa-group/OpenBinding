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

Which limit applies: ``MAX_BINDING_SPACE_LOG10``, a setting of the deployment
(20 by default). Pricing 0.2.0 declares no size limit, so no plan raises or
lowers it, and a larger plan never helps.

Nothing is charged or reserved here: this module only decides, before the caller
has written anything.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from .entitlements import Refusal

#: The name the refusals give the limit: the setting that sets it.
LIMIT_ID = "MAX_BINDING_SPACE_LOG10"
UNIT = "log10 combinations"

#: Over the ceiling of this deployment (422): a larger plan would not help.
OVER_TECHNICAL = "binding_space_over_technical_limit"
#: The analysis carries no readable size (422).
UNMEASURED = "binding_space_unmeasured"

#: Every code a binding-space refusal can carry.
REFUSAL_CODES = frozenset({OVER_TECHNICAL, UNMEASURED})

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


def _quota(state: str, ceiling: float, space: Optional[BindingSpace]) -> dict[str, Any]:
    """The ``quota`` member of a refusal: the shape the frontend already reads (``limit_id``, ``limit``, ``used``)."""
    quota: dict[str, Any] = {"limit_id": LIMIT_ID, "state": state, "unit": UNIT, "source": "technical", "limit": ceiling}
    if space is not None and space.log10_estimate is not None:
        quota["used"] = round(space.log10_estimate, 6)
    return quota


def check(space: BindingSpace, *, technical_log10: float) -> Optional[Refusal]:
    """The refusal for ``space`` under ``MAX_BINDING_SPACE_LOG10`` (``technical_log10``), or ``None`` to go on."""
    if not space.measured:
        return Refusal(
            422,
            UNMEASURED,
            "The size of the binding space could not be measured, so it cannot be checked against the limit.",
            extra={"quota": _quota("unmeasured", technical_log10, None)},
        )
    if not space.exceeds(technical_log10):
        return None
    return Refusal(
        422,
        OVER_TECHNICAL,
        "instance binding space exceeds the limit of this deployment",
        extra={"quota": _quota("exhausted", technical_log10, space), "binding_space": space.as_report()},
    )

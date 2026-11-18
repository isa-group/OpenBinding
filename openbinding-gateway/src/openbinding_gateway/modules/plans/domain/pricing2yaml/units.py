"""Reading Pricing2Yaml ``unit`` strings: the billing period of a price and whether it is per seat.

``period_of`` reads ``…/month``, ``month``, ``per month``, ``…/year``, ``year``, ``…/week`` and ``week``
(any case); anything else has no period. An add-on whose unit has no period (``1000 emails``, ``email``,
``100 validations``) is metered: it is paid per quantity used, not per period, and ``metered_quantity``
reads the leading number of its unit.
"""

from __future__ import annotations

import re

_PERIODS = {
    "month": "month", "months": "month", "monthly": "month", "mo": "month",
    "year": "year", "years": "year", "yearly": "year", "annual": "year", "annually": "year", "yr": "year",
    "week": "week", "weeks": "week", "weekly": "week",
}
_LEADING_NUMBER = re.compile(r"^\s*(\d+(?:\.\d+)?)\b")


def period_of(unit: str | None) -> str | None:
    """``month``, ``year``, ``week`` or ``None`` (no period: a one-off or per-quantity unit)."""
    if not unit:
        return None
    text = unit.strip().lower()
    if "/" in text:
        last = text.rsplit("/", 1)[1].strip()
        return _PERIODS.get(last)
    if text.startswith("per "):
        return _PERIODS.get(text[4:].strip())
    return _PERIODS.get(text)


def per_seat(unit: str | None) -> bool:
    """True for a price per user or seat (``user/month``, ``seat/month``, ``sales seat/month``)."""
    if not unit:
        return False
    head = unit.strip().lower().split("/", 1)[0]
    return re.search(r"\b(?:user|seat)s?\b", head) is not None


def metered_quantity(unit: str | None) -> float:
    """The quantity one unit of a metered add-on stands for (``1000 emails`` -> 1000, ``email`` -> 1)."""
    match = _LEADING_NUMBER.match(unit or "")
    return float(match.group(1)) if match else 1.0


def is_metered(unit: str | None) -> bool:
    """A unit with no period: the add-on is paid per quantity used."""
    return bool(unit and unit.strip()) and period_of(unit) is None

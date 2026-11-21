"""Upstream events (F6): their vocabulary, their state machine and SPHERE's version order.

Pure. An upstream event records that a pricing a composition reads changed, classified once and never rewritten:

* ``Category``: ``no_impact``, ``values_changed``, ``binding_invalid`` (rebinding recommended) or
  ``offering_changed``; the first rule of ``PRECEDENCE`` that applies decides it.
* ``Reason``: why, as codes with detail, in precedence order.
* ``State``: ``open`` -> ``reviewed`` -> ``resolved`` (``TRANSITIONS``); an offering event never resolves.
* ``Note``: the sentences every diff may carry, as codes the screens turn into words.

``at_least_as_new`` follows SPHERE's order (the manifest's, newest first by ``createdAt``), never the highest label.
"""

from __future__ import annotations

from collections.abc import Sequence
from enum import Enum


class Category(str, Enum):
    NO_IMPACT = "no_impact"
    VALUES_CHANGED = "values_changed"
    BINDING_INVALID = "binding_invalid"
    OFFERING_CHANGED = "offering_changed"


class Subject(str, Enum):
    BINDING = "binding"
    OFFERING = "offering"


class State(str, Enum):
    OPEN = "open"
    REVIEWED = "reviewed"
    RESOLVED = "resolved"


class Reason(str, Enum):
    # 1. The source cannot be read (``detail``: family_not_found, version_withdrawn).
    SOURCE_UNAVAILABLE = "source_unavailable"
    # 2. The new version does not normalise (``detail``: the normaliser's code).
    PRICING_UNREADABLE = "pricing_unreadable"
    # 3. Rebinding recommended, per entry.
    PLAN_REMOVED = "plan_removed"
    PLAN_PRIVATE = "plan_private"
    PRICE_NOT_NUMERIC = "price_not_numeric"
    ADDON_REMOVED = "addon_removed"
    ADDON_UNAVAILABLE = "addon_unavailable"
    ADDON_NOT_SUBSCRIPTION = "addon_not_subscription"
    CURRENCY_CHANGED = "currency_changed"
    BILLING_MISSING = "billing_missing"
    VALUE_UNMAPPED = "value_unmapped"
    REQUIREMENT_UNMET = "requirement_unmet"
    # Offering events.
    OFFERING_UNAVAILABLE = "offering_unavailable"


#: The reasons that make a binding event ``binding_invalid``, in precedence order.
PRECEDENCE: tuple[Reason, ...] = (
    Reason.SOURCE_UNAVAILABLE,
    Reason.PRICING_UNREADABLE,
    Reason.PLAN_REMOVED,
    Reason.PLAN_PRIVATE,
    Reason.PRICE_NOT_NUMERIC,
    Reason.ADDON_REMOVED,
    Reason.ADDON_UNAVAILABLE,
    Reason.ADDON_NOT_SUBSCRIPTION,
    Reason.CURRENCY_CHANGED,
    Reason.BILLING_MISSING,
    Reason.VALUE_UNMAPPED,
    Reason.REQUIREMENT_UNMET,
)


class Note(str, Enum):
    VALUES_NOT_REEVALUATED = "values_not_reevaluated"
    NO_DIRECT_MAPPING = "no_direct_mapping"
    NO_VALUE_ORIGINS = "no_value_origins"
    UNLIMITED_SENTINEL = "unlimited_sentinel"
    DOMAIN_MAY_CHANGE = "domain_may_change"
    BASELINE_UNAVAILABLE = "baseline_unavailable"


#: The state moves an UPDATE may make (the database trigger enforces the same table).
TRANSITIONS: dict[State, frozenset[State]] = {
    State.OPEN: frozenset({State.REVIEWED, State.RESOLVED}),
    State.REVIEWED: frozenset({State.RESOLVED}),
    State.RESOLVED: frozenset(),
}

#: How bad a category is, for the worst of several (badges, notification subjects).
SEVERITY: dict[Category, int] = {
    Category.NO_IMPACT: 0,
    Category.OFFERING_CHANGED: 1,
    Category.VALUES_CHANGED: 2,
    Category.BINDING_INVALID: 3,
}

#: The words a notification subject uses for a category.
WORDS: dict[Category, str] = {
    Category.NO_IMPACT: "no impact",
    Category.OFFERING_CHANGED: "offering changed",
    Category.VALUES_CHANGED: "values changed",
    Category.BINDING_INVALID: "rebinding recommended",
}

#: The prefix of a ``new_ref`` that records a confirmed disappearance (``gone:<epoch>``).
GONE = "gone"


def worst(categories: Sequence[str | Category]) -> Category | None:
    found = [Category(c) for c in categories]
    return max(found, key=lambda c: SEVERITY[c]) if found else None


def may_move(old: State | str, new: State | str) -> bool:
    old, new = State(old), State(new)
    return old == new or new in TRANSITIONS[old]


def at_least_as_new(pinned: str | None, new: str, order: Sequence[str]) -> bool:
    """Whether ``pinned`` is ``new`` or newer by SPHERE's order (``order``: every listed version id, newest first).

    True when they are the same; when both are listed and ``pinned`` comes first; or when ``new`` is no longer
    listed (withdrawn) and ``pinned`` is today's latest.
    """
    if pinned is None:
        return False
    if pinned == new:
        return True
    if pinned in order and new in order:
        return order.index(pinned) < order.index(new)
    if new not in order and order and pinned == order[0]:
        return True
    return False

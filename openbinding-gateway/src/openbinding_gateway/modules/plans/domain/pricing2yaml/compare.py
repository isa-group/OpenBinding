# Adapted from javiercavlop/pricing-renderer v0.2.0 src/core/compare.ts, compare-values.ts, compare-sides.ts (MIT),
# Copyright (c) 2026 Francisco Javier Cavero (THIRD_PARTY_NOTICES.md); ported to Python over this normaliser.
"""One selection of a pricing compared across two versions, as pricing-renderer's ``compareSelections`` does.

Pure; the one comparison the F6 classifier uses. The same plan (and add-ons, billing period and seats) is read on
both sides through ``effective``; what differs is reported in the renderer's terms:

* ``plan``: whether the plan is still declared (``known``) on each side;
* ``addOns``: ``added``, ``removedByUser``, ``removedByReconciliation`` (``not-in-version``,
  ``unavailable-for-plan`` or ``dependency-removed``) and ``quantityChanged``;
* ``features``: ``gained``, ``lost``, ``changed`` and ``unchanged``, decided by ``hasCapability``;
* ``usageLimits``: each changed limit with ``before``, ``after``, ``direction`` and a ``delta`` between numbers;
* ``price``: ``before``, ``after`` and ``difference``, or ``differenceOmitted`` (``quote`` or ``currency``), and
  ``billingPeriodChanged``;
* ``catalog``: plans, add-ons, features and limits declared on one side only.

Numbers are ``Decimal`` strings (no float reaches a diff). Two differences from the renderer are deliberate and
documented: the normaliser reads a NUMERIC value of at least ``1e8`` as ``Unlimited`` (pricing4ts's sentinel), so
two such numbers compare equal (the comparison lists them in ``sentinel``); and a per-seat part (``user/month``)
is priced for ``seats`` seats, which the renderer has no notion of (equal to it for one seat).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from ..money import exact, money_context, quantize6
from . import units
from .effective import Effective, effective
from .model import Fixed, Label, NormalisedPricing, Unlimited, Value


@dataclass(frozen=True)
class Selection:
    """A plan with add-ons (id -> quantity), a billing period (the pricing's default when ``None``) and seats."""

    plan: str
    add_ons: Mapping[str, float] = field(default_factory=dict)
    billing: str | None = None
    seats: int = 1

    @staticmethod
    def of(plan: str, add_ons: Any = (), billing: str | None = None, seats: int | None = None) -> Selection:
        """``add_ons`` as a list of names (quantity 1 each) or a mapping of quantities."""
        if isinstance(add_ons, Mapping):
            quantities = {str(k): float(v) for k, v in add_ons.items()}
        else:
            quantities = {str(name): 1.0 for name in add_ons or ()}
        return Selection(plan, quantities, billing, int(seats or 1))


def number(value: float | int | Decimal) -> str:
    """A number as a diff writes it: its exact decimal, without exponent and without trailing zeros."""
    d = exact(value) if not isinstance(value, Decimal) else value
    text = format(d.normalize(), "f")
    return "0" if text in ("-0", "0") else text


def compared(value: Value) -> dict[str, Any]:
    """``toComparedValue``: ``none``, ``boolean``, ``number``, ``unlimited``, ``text`` or ``json``."""
    if value is None:
        return {"kind": "none"}
    if isinstance(value, Unlimited):
        return {"kind": "unlimited"}
    if isinstance(value, bool):
        return {"kind": "boolean", "value": value}
    if isinstance(value, (int, float)):
        return {"kind": "number", "value": number(value)}
    if isinstance(value, str):
        return {"kind": "text", "value": value}
    return {"kind": "json", "value": value}


def has_capability(value: Mapping[str, Any]) -> bool:
    kind = value["kind"]
    if kind == "none":
        return False
    if kind == "boolean":
        return bool(value["value"])
    if kind == "number":
        return Decimal(value["value"]) != 0
    if kind == "text":
        return value["value"] != ""
    return True


_LIMIT_RANK = {"none": 0, "number": 1, "unlimited": 2}


def limit_direction(before: Mapping[str, Any], after: Mapping[str, Any]) -> str:
    if before["kind"] == "number" and after["kind"] == "number":
        return "increased" if Decimal(after["value"]) > Decimal(before["value"]) else "decreased"
    b, a = _LIMIT_RANK.get(before["kind"]), _LIMIT_RANK.get(after["kind"])
    if b is None or a is None:
        return "changed"
    return "increased" if a > b else "decreased"


@dataclass(frozen=True)
class _Side:
    pricing: NormalisedPricing
    known: bool
    result: Effective | None
    requested: frozenset[str]


def _side(pricing: NormalisedPricing, selection: Selection) -> _Side:
    requested = frozenset(name for name, quantity in selection.add_ons.items() if quantity > 0)
    if selection.plan not in pricing.plans:
        return _Side(pricing, False, None, requested)
    billing = selection.billing if any(b.id == selection.billing for b in pricing.billing) else None
    return _Side(pricing, True, effective(pricing, selection.plan, dict(selection.add_ons), billing), requested)


def _price(side: _Side, selection: Selection) -> dict[str, Any]:
    pricing = side.pricing
    if side.result is None:
        return {"subtotal": None, "requiresQuote": False, "currency": pricing.currency, "billing": None, "unit": None}
    result = side.result
    total = Decimal(0)
    quote = False
    labels: list[str] = []
    with money_context():
        for part in result.parts:
            if part.amount is None or isinstance(part.price, Label):
                quote = True
                labels.append(part.price.text if isinstance(part.price, Label) else part.id)
                continue
            unit = pricing.plans[part.id].unit if part.kind == "plan" else pricing.add_ons[part.id].unit
            seats = selection.seats if units.per_seat(unit) else 1
            total += exact(part.amount) * seats
    plan_unit = pricing.plans[result.plan].unit
    period = units.period_of(plan_unit)
    return {
        "subtotal": None if quote else str(quantize6(total)),
        "requiresQuote": quote or result.requires_quote,
        **({"quote": labels} if labels else {}),
        "currency": pricing.currency,
        "billing": result.billing.id,
        "unit": f"{pricing.currency}/{period}" if period else pricing.currency,
    }


def _value(side: _Side, kind: str, name: str) -> dict[str, Any]:
    definitions = side.pricing.features if kind == "feature" else side.pricing.usage_limits
    if name not in definitions or side.result is None:
        if name in definitions and side.result is None:
            return compared(definitions[name].default)
        return {"kind": "none"}
    values = side.result.features if kind == "feature" else side.result.limits
    return compared(values.get(name))


def _merged(before: Mapping[str, Any], after: Mapping[str, Any]) -> list[tuple[str, str]]:
    """After-pricing declaration order, then the ids only the before pricing declares (with their presence)."""
    out = [(name, "both" if name in before else "after-only") for name in after]
    out += [(name, "before-only") for name in before if name not in after]
    return out


def _removal_reason(after: NormalisedPricing, plan: str, name: str) -> str:
    add_on = after.add_ons.get(name)
    if add_on is None:
        return "not-in-version"
    offered = plan in add_on.available_for
    return "unavailable-for-plan" if add_on.available_for and not offered else "dependency-removed"


def _sentinel(side: _Side, kind: str, name: str) -> Any:
    if side.result is None:
        return None
    values = side.result.features if kind == "feature" else side.result.limits
    value = values.get(name)
    if isinstance(value, Unlimited) and isinstance(value.raw, (int, float)) and not isinstance(value.raw, bool):
        return value.raw
    return None


@dataclass(frozen=True)
class SelectionComparison:
    plan: dict[str, Any]
    add_ons: dict[str, Any]
    features: dict[str, Any]
    usage_limits: list[dict[str, Any]]
    price: dict[str, Any]
    catalog: dict[str, Any]
    #: Ids whose two values are both Unlimited from numbers that differ (the 1e8 sentinel).
    sentinel: tuple[str, ...] = ()

    @property
    def empty(self) -> bool:
        """Nothing the selection reads changed (the catalog and other plans do not count)."""
        price = self.price
        return (
            self.plan["before"]["known"] and self.plan["after"]["known"]
            and not any(self.add_ons[k] for k in ("added", "removedByUser", "removedByReconciliation", "quantityChanged"))
            and not (self.features["gained"] or self.features["lost"] or self.features["changed"])
            and not self.usage_limits
            and not price["billingPeriodChanged"]
            and (
                (price.get("differenceOmitted") is None and Decimal(price.get("difference") or "0") == 0)
                or (price.get("differenceOmitted") == "quote" and price["before"] == price["after"])
            )
        )

    def as_json(self) -> dict[str, Any]:
        return {
            "plan": self.plan,
            "addOns": self.add_ons,
            "features": self.features,
            "usageLimits": self.usage_limits,
            "price": self.price,
            "catalog": self.catalog,
            **({"sentinel": list(self.sentinel)} if self.sentinel else {}),
        }


def compare_selections(
    old: NormalisedPricing, new: NormalisedPricing, selection: Selection, after: Selection | None = None
) -> SelectionComparison:
    """``selection`` on ``old`` against ``after`` (the same selection by default) on ``new``."""
    after = after or selection
    before_side = _side(old, selection)
    after_side = _side(new, after)

    plan = {
        "before": {"id": selection.plan, "known": before_side.known,
                   "name": old.plans[selection.plan].display_name if before_side.known else None},
        "after": {"id": after.plan, "known": after_side.known,
                  "name": new.plans[after.plan].display_name if after_side.known else None},
        "changed": selection.plan != after.plan,
    }

    add_ons: dict[str, Any] = {"added": [], "removedByUser": [], "removedByReconciliation": [], "quantityChanged": [],
                               "unchanged": []}
    was = dict(before_side.result.add_ons) if before_side.result else {}
    now = dict(after_side.result.add_ons) if after_side.result else {}
    for name, presence in _merged(old.add_ons, new.add_ons):
        item = new.add_ons.get(name) or old.add_ons[name]
        base = {"id": name, "name": item.display_name, "presence": presence}
        if name in now and name not in was:
            add_ons["added"].append(base | {"quantity": number(now[name])})
        elif name in was and name not in now:
            removed = base | {"quantity": number(was[name])}
            if name in after_side.requested:
                add_ons["removedByReconciliation"].append(removed | {"reason": _removal_reason(new, after.plan, name)})
            else:
                add_ons["removedByUser"].append(removed)
        elif name in was and name in now:
            if was[name] == now[name]:
                add_ons["unchanged"].append(name)
            else:
                add_ons["quantityChanged"].append({
                    "id": name, "name": item.display_name, "before": number(was[name]), "after": number(now[name]),
                    "delta": number(exact(now[name]) - exact(was[name])),
                })

    features: dict[str, Any] = {"gained": [], "lost": [], "changed": [], "unchanged": []}
    sentinel: list[str] = []
    for name, presence in _merged(old.features, new.features):
        item = new.features.get(name) or old.features[name]
        b, a = _value(before_side, "feature", name), _value(after_side, "feature", name)
        if b == a or (not has_capability(b) and not has_capability(a)):
            if b == a and b["kind"] == "unlimited" and _sentinel(before_side, "feature", name) != _sentinel(
                after_side, "feature", name
            ):
                sentinel.append(name)
            features["unchanged"].append(name)
            continue
        entry = {"id": name, "name": item.display_name, "before": b, "after": a, "presence": presence}
        if not has_capability(b):
            features["gained"].append(entry)
        elif not has_capability(a):
            features["lost"].append(entry)
        else:
            features["changed"].append(entry)

    limits: list[dict[str, Any]] = []
    for name, presence in _merged(old.usage_limits, new.usage_limits):
        item = new.usage_limits.get(name) or old.usage_limits[name]
        b, a = _value(before_side, "limit", name), _value(after_side, "limit", name)
        if b == a:
            if b["kind"] == "unlimited" and _sentinel(before_side, "limit", name) != _sentinel(after_side, "limit", name):
                sentinel.append(name)
            continue
        entry = {"id": name, "name": item.display_name, "before": b, "after": a,
                 "direction": limit_direction(b, a), "presence": presence}
        if item.unit is not None:
            entry["unit"] = item.unit
        if b["kind"] == "number" and a["kind"] == "number":
            entry["delta"] = number(Decimal(a["value"]) - Decimal(b["value"]))
        limits.append(entry)

    price_before = _price(before_side, selection)
    price_after = _price(after_side, after)
    price: dict[str, Any] = {
        "before": price_before, "after": price_after,
        "billingPeriodChanged": price_before["billing"] != price_after["billing"],
    }
    if not (before_side.known and after_side.known):
        price["differenceOmitted"] = "plan"
    elif price_before["requiresQuote"] or price_after["requiresQuote"]:
        price["differenceOmitted"] = "quote"
    elif price_before["currency"] != price_after["currency"]:
        price["differenceOmitted"] = "currency"
    else:
        with money_context():
            price["difference"] = str(quantize6(Decimal(price_after["subtotal"]) - Decimal(price_before["subtotal"])))

    return SelectionComparison(plan, add_ons, features, limits, price, catalog_diff(old, new), tuple(sentinel))


def catalog_diff(old: NormalisedPricing, new: NormalisedPricing) -> dict[str, Any]:
    """Plans, add-ons, features and limits declared on one side only, in declaration order."""

    def only(a: Mapping[str, Any], b: Mapping[str, Any]) -> list[str]:
        return [name for name in a if name not in b]

    return {
        "onlyInBefore": {"plans": only(old.plans, new.plans), "addOns": only(old.add_ons, new.add_ons),
                         "features": only(old.features, new.features),
                         "usageLimits": only(old.usage_limits, new.usage_limits)},
        "onlyInAfter": {"plans": only(new.plans, old.plans), "addOns": only(new.add_ons, old.add_ons),
                        "features": only(new.features, old.features),
                        "usageLimits": only(new.usage_limits, old.usage_limits)},
    }


def _price_key(price: Any) -> Any:
    if isinstance(price, Fixed):
        return ("fixed", number(price.amount))
    if isinstance(price, Label):
        return ("label", price.text)
    return ("expression", None if price.value is None else number(price.value))


def identical_plan(old_plan: str, new_plan: str, old: NormalisedPricing, new: NormalisedPricing) -> bool:
    """Whether ``new_plan`` in ``new`` is ``old_plan`` in ``old`` under another name: the same price, unit, privacy,
    features and limits, and the same add-ons available for it (the ``renamedTo`` hint; never fuzzy)."""
    a, b = old.plans.get(old_plan), new.plans.get(new_plan)
    if a is None or b is None:
        return False
    if (_price_key(a.price), a.unit, a.private) != (_price_key(b.price), b.unit, b.private):
        return False
    if {k: compared(v) for k, v in a.features.items()} != {k: compared(v) for k, v in b.features.items()}:
        return False
    if {k: compared(v) for k, v in a.limits.items()} != {k: compared(v) for k, v in b.limits.items()}:
        return False
    available_a = sorted(n for n, add_on in old.add_ons.items() if old_plan in add_on.available_for)
    available_b = sorted(n for n, add_on in new.add_ons.items() if new_plan in add_on.available_for)
    return available_a == available_b

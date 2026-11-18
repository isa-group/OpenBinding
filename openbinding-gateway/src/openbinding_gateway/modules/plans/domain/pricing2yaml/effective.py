"""What one selection of a normalised pricing gives: its price parts and its feature and limit values.

Semantics of pricing-renderer v0.2.0 (``src/core/compare-values.ts`` ``effectiveValue``,
``src/core/resolve.ts`` and ``src/core/breakdown.ts``; MIT, Copyright (c) 2026 Francisco Javier Cavero):
a plan's value (its own or the default) is replaced by each selected add-on's override and extended by
``amount x quantity`` for each ``usageLimitsExtensions`` entry, in declaration order; an add-on that is not
available for the plan, or depends on a removed one, is removed; the price is the plan's plus each
add-on's, times the billing multiplier and the quantity, and a label price needs a quote.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

from .model import UNLIMITED_SENTINEL, Billing, Expression, Fixed, Label, NormalisedPricing, Price, Unlimited, Value


@dataclass(frozen=True)
class PricePart:
    kind: str  # "plan" or "addOn"
    id: str
    quantity: float
    price: Price
    #: The price of one unit before the billing multiplier (None when it has no number).
    unit_amount: float | None
    #: ``unit_amount x multiplier x quantity`` (None when it has no number).
    amount: float | None


@dataclass(frozen=True)
class Effective:
    plan: str
    billing: Billing
    add_ons: Mapping[str, float]
    removed: tuple[str, ...]
    parts: tuple[PricePart, ...]
    subtotal: float
    requires_quote: bool
    features: Mapping[str, Value]
    limits: Mapping[str, Value]


def add_on_quantity(minimum: float, maximum: float | None, step: float, requested: float) -> float:
    """pricing-renderer's ``normalizeAddOnQuantity``: the requested quantity on the min/step grid, capped."""
    top = math.inf
    if maximum is not None:
        steps = math.floor((maximum - minimum) / step + 1e-9)
        top = min(maximum, minimum + steps * step)
    stepped = minimum + math.floor((requested - minimum) / step + 0.5) * step
    return min(top, max(minimum, stepped))


def _amount(price: Price) -> float | None:
    if isinstance(price, Fixed):
        return price.amount
    if isinstance(price, Expression):
        return price.value
    return None


def _extend(current: Value, amount: float) -> Value:
    if isinstance(current, Unlimited):
        return current
    if isinstance(current, (int, float)) and not isinstance(current, bool):
        total = current + amount
    elif current is None:
        total = amount
    else:
        return current
    # An extended limit that reaches pricing4ts's sentinel is unlimited, like a value written that way.
    return Unlimited(total) if total >= UNLIMITED_SENTINEL else total


def effective(
    pricing: NormalisedPricing,
    plan: str,
    add_ons: Mapping[str, float] | None = None,
    billing: str | None = None,
) -> Effective:
    """The effective values and price of ``plan`` with ``add_ons`` (id -> quantity) for ``billing``."""
    chosen = pricing.plans[plan]
    period = next((b for b in pricing.billing if b.id == billing), None) if billing else None
    period = period or pricing.default_billing()
    requested = {name: q for name, q in (add_ons or {}).items() if name in pricing.add_ons and q > 0}
    removed: set[str] = {name for name in requested if plan not in pricing.add_ons[name].available_for}
    changed = True
    while changed:
        changed = False
        for name in requested:
            if name not in removed and any(d in removed for d in pricing.add_ons[name].depends_on):
                removed.add(name)
                changed = True
    selected = {name: q for name, q in requested.items() if name not in removed}

    features: dict[str, Value] = dict(chosen.features)
    limits: dict[str, Value] = dict(chosen.limits)
    quantities: dict[str, float] = {}
    for name, add_on in pricing.add_ons.items():
        if name not in selected:
            continue
        quantity = add_on_quantity(add_on.min_quantity, add_on.max_quantity, add_on.quantity_step, selected[name])
        quantities[name] = quantity
        features.update(add_on.features)
        for limit, value in add_on.limits.items():
            limits[limit] = value
        for limit, amount in add_on.extensions.items():
            limits[limit] = _extend(limits.get(limit), amount * quantity)

    parts = [PricePart("plan", plan, 1, chosen.price, _amount(chosen.price), None)]
    for name in pricing.add_ons:
        if name in quantities:
            add_on = pricing.add_ons[name]
            parts.append(PricePart("addOn", name, quantities[name], add_on.price, _amount(add_on.price), None))
    priced = []
    subtotal = 0.0
    requires_quote = False
    for part in parts:
        amount = None if part.unit_amount is None else part.unit_amount * period.multiplier * part.quantity
        if amount is None:
            requires_quote = True
        else:
            subtotal += amount
        priced.append(PricePart(part.kind, part.id, part.quantity, part.price, part.unit_amount, amount))
    return Effective(
        plan=plan,
        billing=period,
        add_ons=quantities,
        removed=tuple(name for name in pricing.add_ons if name in removed),
        parts=tuple(priced),
        subtotal=subtotal,
        requires_quote=requires_quote or any(isinstance(p.price, Label) for p in priced),
        features=features,
        limits=limits,
    )


def single_variants(pricing: NormalisedPricing) -> list[tuple[str, str | None]]:
    """Every plan alone and with each single subscription add-on available for it (metered ones excluded)."""
    variants: list[tuple[str, str | None]] = []
    for plan in pricing.plans:
        variants.append((plan, None))
        for name, add_on in pricing.add_ons.items():
            if add_on.metered or plan not in add_on.available_for or add_on.depends_on:
                continue
            variants.append((plan, name))
    return variants

"""The JSON views of a normalised pricing: ``summary`` (the wizard's lists) and ``as_json`` (the goldens)."""

from __future__ import annotations

from typing import Any

from . import units
from .effective import Effective
from .model import Expression, Fixed, Label, NormalisedPricing, Price, Unlimited, Value


def value_json(value: Value) -> Any:
    """A value as JSON: ``Unlimited`` is ``{"unlimited": true}``, everything else as it is."""
    if isinstance(value, Unlimited):
        return {"unlimited": True}
    return value


def price_json(price: Price) -> dict[str, Any]:
    if isinstance(price, Fixed):
        return {"kind": "fixed", "amount": price.amount}
    if isinstance(price, Expression):
        out: dict[str, Any] = {"kind": "expression", "source": price.source, "value": price.value}
        if price.error:
            out["error"] = price.error
        return out
    assert isinstance(price, Label)
    return {"kind": "label", "text": price.text}


def summary(pricing: NormalisedPricing) -> dict[str, Any]:
    """Names, kinds, values and units for choosing plans and add-ons; metered add-ons are listed apart."""
    return {
        "syntaxVersion": pricing.syntax_version,
        "title": pricing.title,
        "version": pricing.version,
        "createdAt": pricing.created_at,
        "currency": pricing.currency,
        "billing": [{"id": b.id, "multiplier": b.multiplier, "synthesized": b.synthesized} for b in pricing.billing],
        "features": [
            {"id": f.name, "name": f.display_name, "type": f.type, "valueType": f.value_type,
             "default": value_json(f.default), **({"docUrl": f.doc_url} if f.doc_url else {})}
            for f in pricing.features.values()
        ],
        "usageLimits": [
            {"id": u.name, "name": u.display_name, "valueType": u.value_type, "unit": u.unit,
             "default": value_json(u.default), "linkedFeatures": list(u.linked_features)}
            for u in pricing.usage_limits.values()
        ],
        "plans": [
            {
                "id": p.name, "name": p.display_name, "private": p.private, "price": price_json(p.price),
                "unit": p.unit, "period": units.period_of(p.unit), "perSeat": units.per_seat(p.unit),
                "features": {k: value_json(v) for k, v in p.features.items()},
                "usageLimits": {k: value_json(v) for k, v in p.limits.items()},
            }
            for p in pricing.plans.values()
        ],
        "addOns": [
            {
                "id": a.name, "name": a.display_name, "private": a.private, "price": price_json(a.price),
                "unit": a.unit, "period": units.period_of(a.unit), "availableFor": list(a.available_for),
                "dependsOn": list(a.depends_on), "excludes": list(a.excludes),
                "features": {k: value_json(v) for k, v in a.features.items()},
                "usageLimits": {k: value_json(v) for k, v in a.limits.items()},
                "usageLimitsExtensions": dict(a.extensions),
            }
            for a in pricing.add_ons.values()
            if not a.metered
        ],
        "meteredAddOns": [
            {
                "id": a.name, "name": a.display_name, "private": a.private, "price": price_json(a.price),
                "unit": a.unit, "quantity": a.metered_quantity, "availableFor": list(a.available_for),
                "usageLimitsExtensions": dict(a.extensions),
            }
            for a in pricing.add_ons.values()
            if a.metered
        ],
        "diagnostics": [d.as_dict() for d in pricing.diagnostics],
    }


def effective_json(result: Effective) -> dict[str, Any]:
    return {
        "plan": result.plan,
        "billing": {"id": result.billing.id, "multiplier": result.billing.multiplier},
        "addOns": dict(result.add_ons),
        "removed": list(result.removed),
        "parts": [
            {"kind": p.kind, "id": p.id, "quantity": p.quantity, "price": price_json(p.price),
             "unitAmount": p.unit_amount, "amount": p.amount}
            for p in result.parts
        ],
        "subtotal": result.subtotal,
        "requiresQuote": result.requires_quote,
        "features": {k: value_json(v) for k, v in result.features.items()},
        "usageLimits": {k: value_json(v) for k, v in result.limits.items()},
    }


def as_json(pricing: NormalisedPricing) -> dict[str, Any]:
    """The whole normalised reading (the goldens of ``tools/dump_normalised_pricings.py``)."""
    out = summary(pricing)
    by_id = {item["id"]: item for item in out["addOns"] + out.pop("meteredAddOns")}
    out["addOns"] = [by_id[name] | {"metered": add_on.metered} for name, add_on in pricing.add_ons.items()]
    out["variables"] = {k: _plain(v) for k, v in pricing.variables.items()}
    return out


def _plain(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value

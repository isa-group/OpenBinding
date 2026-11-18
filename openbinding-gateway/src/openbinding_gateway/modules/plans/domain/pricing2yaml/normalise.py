"""Normalise a Pricing2Yaml 3.x document (``normalise``).

Semantics followed from pricing4ts 0.12.1 (``pricing-parser.js:148-178``, ``pricing-validators.js``,
``version-manager.js``; semantics followed, no code copied) and pricing-renderer v0.2.0
(``src/core/normalize.ts``, ``compare-values.ts``), choosing pricing-renderer where they differ:

- syntax ``3.0`` and ``3.1`` (3.0 is read as 3.1: pricing4ts's 3.0 -> 3.1 updater only bumps the number);
  ``1.x`` and ``2.x`` are ``PricingInvalid("sphere_syntax_unsupported")``, as pricing-renderer refuses them;
- a plan's ``features``/``usageLimits`` (also ``null``) override only the ``value`` of the global defaults;
  add-ons carry only their overrides and ``usageLimitsExtensions``;
- a price is ``Fixed`` (a number or a numeric string), an ``Expression`` (a string with ``#``, evaluated over
  the variables' defaults by the safe evaluator) or a ``Label`` (``Contact Sales``);
- ``.inf``, ``Infinity``, ``unlimited``, ``null`` for a limit and any NUMERIC value of at least ``1e8``
  (pricing4ts's sentinel) are ``Unlimited``;
- billing absent is ``monthly: 1`` (marked synthesized); multipliers must be in (0, 1];
- an add-on whose unit has no period is metered (``units.is_metered``);
- kept checks: an ISO 4217 currency code, ``availableFor`` (all plans when absent), ``dependsOn`` and
  ``excludes`` naming add-ons, the eight feature types and ``docUrl`` only for GUARANTEE. Unknown keys
  (TomatoMeter's misspelt ``subscriptionContraints``) are ignored, as both parsers do.
"""

from __future__ import annotations

import datetime as _dt
import math
import re
from collections.abc import Mapping
from typing import Any

from ..content_hash import js_number
from ..errors import PricingDiagnostic, PricingInvalid
from . import expression, units
from .model import (
    FEATURE_TYPES,
    UNLIMITED_SENTINEL,
    UNLIMITED_TEXT,
    AddOn,
    Billing,
    Expression,
    FeatureDef,
    Fixed,
    Label,
    LimitDef,
    NormalisedPricing,
    Plan,
    Price,
    Unlimited,
    Value,
)

_SYNTAX = re.compile(r"^(\d+)\.(\d+)(?:\.\d+)?$")
_CURRENCY = re.compile(r"^[A-Z]{3}$")
_MISSING = object()


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, _dt.datetime):
        return value.isoformat()
    if isinstance(value, _dt.date):
        return value.isoformat()
    return str(value)


def _mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return {str(k): v for k, v in value.items()}
    return {}


def _strings(value: Any) -> tuple[str, ...]:
    if isinstance(value, (list, tuple)):
        return tuple(str(item) for item in value if isinstance(item, (str, int)) and not isinstance(item, bool))
    return ()


def _unwrap(value: Any) -> Any:
    if isinstance(value, Mapping) and "value" in value:
        return value["value"]
    return value


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def to_value(raw: Any, *, limit: bool, numeric: bool) -> Value:
    """A feature or usage-limit value: ``Unlimited``, a number, a boolean, a text or ``None``."""
    if raw is _MISSING:
        return None
    if raw is None:
        return Unlimited(None) if limit else None
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        if isinstance(raw, float) and math.isnan(raw):
            return None
        if math.isinf(raw) and raw > 0:
            return Unlimited(".inf")
        if (numeric or limit) and raw >= UNLIMITED_SENTINEL:
            return Unlimited(raw)
        return raw
    if isinstance(raw, str):
        return Unlimited(raw) if raw in UNLIMITED_TEXT else raw
    if isinstance(raw, (_dt.date, _dt.datetime)):
        return raw.isoformat()
    if isinstance(raw, (list, tuple, Mapping)):
        return _plain(raw)
    return _text(raw)


def _plain(value: Any) -> Any:
    """A list or mapping value (a PAYMENT feature's methods) as plain JSON data."""
    if isinstance(value, Mapping):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (_dt.date, _dt.datetime)):
        return value.isoformat()
    return value


def _syntax(document: Mapping[str, Any], diagnostics: list[PricingDiagnostic]) -> str:
    raw = document.get("syntaxVersion")
    text = js_number(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else (raw or "")
    text = str(text).strip()
    match = _SYNTAX.match(text)
    if not match:
        raise PricingInvalid("sphere_pricing_invalid", "syntaxVersion must be a version such as 3.1")
    if match.group(1) != "3":
        raise PricingInvalid(
            "sphere_syntax_unsupported",
            f"syntax {text} is not supported (Pricing2Yaml 3.0 and 3.1 are)",
            (PricingDiagnostic("sphere_syntax_unsupported", f"syntax {text} is not supported", "/syntaxVersion",
                               extra={"syntaxVersion": text}),),
        )
    if match.group(2) == "0":
        diagnostics.append(
            PricingDiagnostic("p2y_syntax_read_as_3_1", "Pricing2Yaml 3.0 is read as 3.1.", "/syntaxVersion", "info")
        )
    return text


def _price(raw: Any, at: str, variables: Mapping[str, Any], diagnostics: list[PricingDiagnostic]) -> Price:
    if isinstance(raw, bool):
        diagnostics.append(PricingDiagnostic("p2y_price_invalid", "A price must be a number or a text.", at))
        return Label("Unavailable")
    if isinstance(raw, (int, float)):
        if math.isfinite(raw) and raw >= 0:
            return Fixed(float(raw))
        diagnostics.append(PricingDiagnostic("p2y_price_invalid", "A price must be finite and non-negative.", at))
        return Label("Unavailable")
    if isinstance(raw, str):
        source = raw.strip()
        if "#" in source:
            result = expression.evaluate(source, variables)
            error = result.error.message if result.error else None
            if error:
                diagnostics.append(
                    PricingDiagnostic("p2y_price_expression", f"The price expression has no value: {error}.", at, "warning")
                )
            return Expression(source, result.value, error, expression.dependencies(source))
        number = _number(source)
        if number is not None and math.isfinite(number) and number >= 0 and source:
            return Fixed(number)
        return Label(source or "Unavailable")
    diagnostics.append(PricingDiagnostic("p2y_price_missing", "The price is missing: a quote is needed.", at, "warning"))
    return Label("Contact sales")


def _billing(raw: Any) -> tuple[Billing, ...]:
    entries = _mapping(raw)
    if not entries:
        return (Billing("monthly", 1.0, synthesized=True),)
    out = []
    for name, value in entries.items():
        number = _number(value) if not isinstance(value, str) else None
        if number is None or not (0 < number <= 1):
            raise PricingInvalid(
                "sphere_pricing_invalid",
                f'the billing multiplier "{name}" must be a number in (0, 1]',
                (PricingDiagnostic("p2y_billing_invalid", f'The billing multiplier "{name}" must be in (0, 1].',
                                   f"/billing/{name}"),),
            )
        out.append(Billing(name, number))
    return tuple(out)


def _display(raw: Mapping[str, Any], name: str) -> str:
    text = raw.get("name")
    return text if isinstance(text, str) and text and text != name else name


def _features(raw: Any, diagnostics: list[PricingDiagnostic]) -> dict[str, FeatureDef]:
    out: dict[str, FeatureDef] = {}
    for name, value in _mapping(raw).items():
        item = _mapping(value)
        kind = _text(item.get("type"))
        kind = kind.upper() if kind else None
        if kind is not None and kind not in FEATURE_TYPES:
            diagnostics.append(
                PricingDiagnostic("p2y_feature_type_unknown", f'Feature "{name}" has an unknown type "{kind}".',
                                  f"/features/{name}/type")
            )
        value_type = _text(item.get("valueType"))
        value_type = value_type.upper() if value_type else None
        default = item.get("defaultValue", _MISSING)
        doc_url = item.get("docUrl") if kind == "GUARANTEE" and isinstance(item.get("docUrl"), str) else None
        out[name] = FeatureDef(
            name=name,
            display_name=_display(item, name),
            type=kind,
            value_type=value_type,
            default=to_value(default, limit=False, numeric=value_type == "NUMERIC"),
            doc_url=doc_url,
            description=_text(item.get("description")),
        )
    return out


def _limits(raw: Any) -> dict[str, LimitDef]:
    out: dict[str, LimitDef] = {}
    for name, value in _mapping(raw).items():
        item = _mapping(value)
        value_type = _text(item.get("valueType"))
        value_type = value_type.upper() if value_type else None
        out[name] = LimitDef(
            name=name,
            display_name=_display(item, name),
            value_type=value_type,
            default=to_value(item.get("defaultValue", _MISSING), limit=True, numeric=value_type == "NUMERIC"),
            unit=_text(item.get("unit")),
            type=_text(item.get("type")),
            period=item.get("period"),
            linked_features=_strings(item.get("linkedFeatures")),
            description=_text(item.get("description")),
        )
    return out


def _check_numeric(value: Any, kind: str, name: str, at: str, diagnostics: list[PricingDiagnostic]) -> None:
    if isinstance(value, str) and value not in UNLIMITED_TEXT:
        diagnostics.append(
            PricingDiagnostic(
                "p2y_value_type_mismatch", f'The value "{value}" of the NUMERIC {kind} "{name}" is text, not a number.',
                at, "warning",
            )
        )


def _values(
    raw: Any, definitions: Mapping[str, FeatureDef] | Mapping[str, LimitDef], *, limit: bool, at: str,
    diagnostics: list[PricingDiagnostic],
) -> dict[str, Value]:
    """Overrides of known names (unknown names are ignored, as the renderer reads only known ids)."""
    out: dict[str, Value] = {}
    for name, value in _mapping(raw).items():
        definition = definitions.get(name)
        if definition is None:
            continue
        unwrapped = _unwrap(value)
        numeric = definition.value_type == "NUMERIC"
        if numeric:
            _check_numeric(unwrapped, "usage limit" if limit else "feature", name, f"{at}/{name}", diagnostics)
        out[name] = to_value(unwrapped, limit=limit, numeric=numeric)
    return out


def normalise(document: Mapping[str, Any]) -> NormalisedPricing:
    """Read a loaded Pricing2Yaml mapping; raises ``PricingInvalid`` for 1.x/2.x and broken structure."""
    if not isinstance(document, Mapping):
        raise PricingInvalid("sphere_pricing_invalid", "a pricing is a YAML mapping")
    diagnostics: list[PricingDiagnostic] = []
    syntax = _syntax(document, diagnostics)
    currency = _text(document.get("currency"))
    if not currency or not _CURRENCY.match(currency):
        raise PricingInvalid(
            "sphere_pricing_invalid",
            f'the currency "{currency or ""}" is not an ISO 4217 code',
            (PricingDiagnostic("p2y_currency_invalid", "The currency must be an ISO 4217 code such as EUR.", "/currency"),),
        )
    if not isinstance(document.get("plans"), Mapping) and not isinstance(document.get("addOns"), Mapping):
        raise PricingInvalid("sphere_pricing_invalid", "the pricing has no plans and no add-ons")
    variables = _mapping(document.get("variables"))
    features = _features(document.get("features"), diagnostics)
    limits = _limits(document.get("usageLimits"))

    plans: dict[str, Plan] = {}
    for name, value in _mapping(document.get("plans")).items():
        item = _mapping(value)
        own_features = _values(item.get("features"), features, limit=False, at=f"/plans/{name}/features",
                               diagnostics=diagnostics)
        own_limits = _values(item.get("usageLimits"), limits, limit=True, at=f"/plans/{name}/usageLimits",
                             diagnostics=diagnostics)
        plans[name] = Plan(
            name=name,
            display_name=_display(item, name),
            price=_price(item.get("price"), f"/plans/{name}/price", variables, diagnostics),
            unit=_text(item.get("unit")),
            private=item.get("private") is True,
            features={f: own_features[f] if f in own_features else d.default for f, d in features.items()},
            limits={u: own_limits[u] if u in own_limits else d.default for u, d in limits.items()},
            description=_text(item.get("description")),
        )

    add_ons: dict[str, AddOn] = {}
    raw_add_ons = _mapping(document.get("addOns"))
    for name, value in raw_add_ons.items():
        item = _mapping(value)
        unit = _text(item.get("unit"))
        extensions: dict[str, float] = {}
        for limit_name, extension in _mapping(item.get("usageLimitsExtensions")).items():
            amount = _unwrap(extension)
            if limit_name in limits and isinstance(amount, (int, float)) and not isinstance(amount, bool) \
                    and math.isfinite(amount):
                extensions[limit_name] = float(amount)
            elif limit_name in limits:
                diagnostics.append(
                    PricingDiagnostic("p2y_value_type_mismatch",
                                      f'The extension of "{limit_name}" in add-on "{name}" is not a finite number.',
                                      f"/addOns/{name}/usageLimitsExtensions/{limit_name}", "warning")
                )
        constraints = _mapping(item.get("subscriptionConstraints"))
        minimum = _number(constraints.get("minQuantity"))
        maximum = _number(constraints.get("maxQuantity"))
        step = _number(constraints.get("quantityStep"))
        metered = units.is_metered(unit)
        available = _strings(item.get("availableFor")) if item.get("availableFor") is not None else tuple(plans)
        add_ons[name] = AddOn(
            name=name,
            display_name=_display(item, name),
            price=_price(item.get("price"), f"/addOns/{name}/price", variables, diagnostics),
            unit=unit,
            available_for=available,
            depends_on=_strings(item.get("dependsOn")),
            excludes=_strings(item.get("excludes")),
            private=item.get("private") is True,
            features=_values(item.get("features"), features, limit=False, at=f"/addOns/{name}/features",
                             diagnostics=diagnostics),
            limits=_values(item.get("usageLimits"), limits, limit=True, at=f"/addOns/{name}/usageLimits",
                           diagnostics=diagnostics),
            extensions=extensions,
            metered=metered,
            metered_quantity=units.metered_quantity(unit) if metered else None,
            min_quantity=minimum if minimum is not None and minimum >= 0 else 1.0,
            max_quantity=maximum if maximum is not None and math.isfinite(maximum) else None,
            quantity_step=step if step is not None and step > 0 else 1.0,
            description=_text(item.get("description")),
        )

    for name, add_on in add_ons.items():
        for dependency in add_on.depends_on:
            if dependency not in add_ons:
                diagnostics.append(PricingDiagnostic(
                    "p2y_addon_dependency_missing", f'Add-on "{name}" depends on the unknown add-on "{dependency}".',
                    f"/addOns/{name}/dependsOn"))
        for excluded in add_on.excludes:
            if excluded not in add_ons:
                diagnostics.append(PricingDiagnostic(
                    "p2y_addon_exclusion_missing", f'Add-on "{name}" excludes the unknown add-on "{excluded}".',
                    f"/addOns/{name}/excludes", "warning"))
        for plan in add_on.available_for:
            if plan not in plans:
                diagnostics.append(PricingDiagnostic(
                    "p2y_addon_plan_missing", f'Add-on "{name}" is available for the unknown plan "{plan}".',
                    f"/addOns/{name}/availableFor", "warning"))

    return NormalisedPricing(
        syntax_version=syntax,
        title=_text(document.get("saasName")) or "Pricing",
        version=_text(document.get("version")),
        created_at=_text(document.get("createdAt")),
        currency=currency,
        billing=_billing(document.get("billing")),
        variables=variables,
        features=features,
        usage_limits=limits,
        plans=plans,
        add_ons=add_ons,
        diagnostics=tuple(diagnostics),
    )


def normalise_text(text: str | bytes) -> NormalisedPricing:
    """Load (``yaml12``, with its limits) and normalise a Pricing2Yaml text."""
    from .. import yaml12

    document = yaml12.load(text)
    if not isinstance(document, Mapping):
        raise PricingInvalid("sphere_pricing_invalid", "a pricing is a YAML mapping")
    return normalise(document)

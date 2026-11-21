"""One SPHERE candidate judged against one pricing, with the generator's own functions.

The per-candidate half of the package generator, moved here from ``generate`` so the F6 upstream classifier asks
exactly the generator's question: "would regenerating this candidate from that version with the pinned recipe keep
it, and with which values?". ``generate`` calls ``admit_plan``, ``admit_add_on`` and ``judge`` for every candidate it
builds; ``candidate_values`` runs the same three for one plan (and add-ons) and returns the outcome as data:
eligibility with the first refusal's code, each target's ``(value, source kind, detail)`` (``_value_of``), and the
recipe's requirements explained (``_explain``).

Pure: no I/O, no session, no clock.
"""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from ....plans.application import month_factor
from ....plans.application import pricing2yaml as p2y
from ...domain.sphere import ids
from ...domain.sphere.diagnostics import SphereDiagnostic, diagnostic
from ...domain.sphere.recipe import (
    UNLIMITED_VALUE,
    PropertySpec,
    Recipe,
    Source,
    Task,
)


@dataclass(frozen=True)
class SnapshotMeta:
    """What the generator may know of a source's snapshot (written into origins, never into the package)."""

    pricing_id: str
    version_id: str
    registry: str | None = None
    snapshot_id: str | None = None
    owner: str | None = None
    slug: str | None = None
    title: str = ""
    version_label: str = ""
    permanent_url: str | None = None
    latest_version_id: str | None = None
    content_hash_verified: bool = True

    @property
    def sphere_ref(self) -> str | None:
        return f"{self.owner}/{self.slug}" if self.owner and self.slug else None


def _number(value: float) -> int | float:
    """A computed number as the package writes it: integral values as integers, others rounded to 1e-9."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    rounded = round(float(value), 9)
    if rounded.is_integer() and abs(rounded) < 1e15:
        return int(rounded)
    return rounded


def _plain(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, float):
        return _number(value)
    return value


def _literal(value: float) -> str:
    number = _number(value)
    return str(number) if isinstance(number, int) else repr(number)


def _explain(task: Task, recipe: Recipe, properties: Mapping[str, Any]) -> list[dict[str, Any]]:
    out = []
    for req in task.require_limits:
        bound = req.value(recipe.demand)
        value = properties.get(req.limit)
        ok = isinstance(value, (int, float)) and not isinstance(value, bool) and value >= bound
        numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
        shown = _literal(value) if numeric else repr(value)
        out.append({
            "property": req.limit, "operator": ">=", "bound": _number(bound),
            "value": _plain(value), "satisfied": bool(ok),
            "text": f"{req.limit}: {shown} {'>=' if ok else '<'} {_literal(bound)}",
        })
    for name in task.require_features:
        value = properties.get(name)
        ok = value is True
        out.append({
            "property": name, "operator": "==", "bound": True, "value": value, "satisfied": ok,
            "text": f"{name}: {'yes' if value is True else 'no' if value is False else value!r}"
                    f"{'' if ok else ' (required)'}",
        })
    return out


def task_specs(task: Task) -> dict[str, PropertySpec]:
    """Every target the task writes: its properties, plus the properties its requirements read."""
    specs = dict(task.properties)
    for req in task.require_limits:
        specs.setdefault(req.limit, PropertySpec("limit", name=req.limit))
    for name in task.require_features:
        specs.setdefault(name, PropertySpec("feature", name=name))
    return specs


@dataclass
class _Candidate:
    resource: str
    id: str
    task: str
    capability: str
    provider: str
    plan: str | None
    add_on: str | None
    source: Source
    meta: SnapshotMeta | None
    name: str | None
    features: dict[str, float] = field(default_factory=dict)
    properties: dict[str, Any] = field(default_factory=dict)
    origins: list[dict[str, Any]] = field(default_factory=list)
    price: float | None = None
    capabilities: list[str] = field(default_factory=list)
    #: Further add-ons of the selection (``candidate_values``; the generator's variants hold one add-on at most).
    extra_add_ons: tuple[str, ...] = ()

    @property
    def key(self) -> str:
        return ids.candidate_key(self.resource, self.id)


class _Context:
    def __init__(self, recipe: Recipe, feature_targets: set[str]) -> None:
        self.recipe = recipe
        self.feature_targets = feature_targets
        self.diagnostics: list[SphereDiagnostic] = []
        self._once: set[tuple[str, str, str]] = set()

    def add(self, item: SphereDiagnostic) -> None:
        self.diagnostics.append(item)

    def once(self, code: str, message: str, at: str, **extra: Any) -> None:
        key = (code, at, message)
        if key not in self._once:
            self._once.add(key)
            self.add(diagnostic(code, message, at, **extra))


def _price(
    ctx: _Context, pricing: p2y.NormalisedPricing, source: Source, plan: str, add_ons: Sequence[str], billing: str
) -> tuple[float, dict[str, Any]]:
    result = p2y.effective(pricing, plan, {name: 1 for name in add_ons} or None, billing)
    parts = []
    total = 0.0
    formula = []
    for part in result.parts:
        unit = pricing.plans[plan].unit if part.kind == "plan" else pricing.add_ons[part.id].unit
        period = p2y.units.period_of(unit)
        exact_factor = month_factor(period)
        factor = None if exact_factor is None else float(exact_factor)
        if factor is None:
            ctx.once("sphere_unit_unknown",
                     f"The unit {unit or '(none)'!r} names no period; prices in it are taken as monthly.",
                     source.at, unit=unit)
            factor = 1.0
        seats = 1
        if p2y.units.per_seat(unit):
            seats = source.seats or 1
            if source.seats is None:
                ctx.once("sphere_unit_per_user",
                         f"Prices per user ({unit}) are taken for one seat; the recipe names no seats.",
                         source.at, unit=unit)
        assert part.unit_amount is not None
        amount = part.unit_amount * factor * seats * result.billing.multiplier * part.quantity
        total += amount
        detail: dict[str, Any] = {
            "kind": part.kind, "id": part.id, "unit": unit, "period": period, "unitAmount": _number(part.unit_amount),
            "monthlyFactor": _number(factor), "seats": seats, "amount": _number(amount),
        }
        if isinstance(part.price, p2y.Expression):
            detail["expression"] = part.price.source
            detail["variables"] = {
                name: _plainish(pricing.variables.get(name)) for name in part.price.dependencies
            }
        parts.append(detail)
        text = f"{part.id} {_literal(part.unit_amount)}"
        if factor != 1.0:
            text += f" x {_literal(factor)}"
        if seats != 1:
            text += f" x {seats} seats"
        formula.append(text)
    expression = "(" + " + ".join(formula) + ")" if len(formula) > 1 else formula[0]
    expression += f" x {_literal(result.billing.multiplier)} ({result.billing.id})"
    return float(_number(total)), {
        "parts": parts, "billing": result.billing.id, "multiplier": _number(result.billing.multiplier),
        "seats": source.seats or 1, "currency": pricing.currency, "formula": expression,
    }


def _plainish(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


def _manual(spec_values: Mapping[str, float], provider: str, plan: str | None) -> tuple[str, float] | None:
    keys = ([f"{provider}.{plan}"] if plan is not None else []) + [provider, "*"]
    for key in keys:
        if key in spec_values:
            return key, spec_values[key]
    return None


def _value_of(
    ctx: _Context,
    candidate: _Candidate,
    pricing: p2y.NormalisedPricing,
    result: p2y.Effective,
    target: str,
    spec: PropertySpec,
    price: tuple[float, dict[str, Any]] | None,
) -> tuple[Any, str, dict[str, Any]] | None:
    """``(value, source kind, detail)`` of ``target`` for a SPHERE candidate, or ``None`` with a finding."""
    source = candidate.source
    is_feature = target in ctx.feature_targets
    key = candidate.key
    provider = source.provider or ""
    if provider in spec.overrides:
        found = _manual(spec.overrides[provider], provider, candidate.plan)
        if found is None:
            ctx.add(diagnostic("sphere_property_unmapped", f"No value is set by hand for {target} here.", key,
                               target=target))
            return None
        return found[1], "manual", {"key": found[0], "override": True}
    if spec.kind == "price":
        assert price is not None
        return price[0], "priced", price[1]
    if spec.kind == "constant":
        return spec.value, "manual", {"constant": True}
    if spec.kind == "manual":
        assert spec.manual is not None
        found = _manual(spec.manual, provider, candidate.plan)
        if found is None:
            ctx.add(diagnostic("sphere_property_unmapped", f"No value is set by hand for {target} here.", key,
                               target=target))
            return None
        return found[1], "manual", {"key": found[0]}
    assert spec.name is not None
    name = source.name_of(spec.name)
    if spec.kind == "limit":
        definition = pricing.usage_limits.get(name)
        if definition is None:
            if spec.name in source.assume:
                assumed = source.assume[spec.name]
                value = UNLIMITED_VALUE if assumed == "unlimited" else float(assumed)
                ctx.once("sphere_limit_assumed",
                         f"This pricing does not declare {name}; the recipe assumes {assumed}.", source.at,
                         limit=spec.name)
                return value, "manual", {"assumed": True, "reason": "not declared by the pricing", "limit": spec.name,
                                         "value": assumed}
            ctx.once("sphere_limit_unknown",
                     f"This pricing declares no usage limit {name}; name its own limit or assume a value.",
                     source.at, limit=name)
            return None
        raw = result.limits.get(name)
        unlimited = raw is None or isinstance(raw, p2y.Unlimited)
        if unlimited:
            if is_feature and spec.unlimited_as is None:
                ctx.once("sphere_unlimited_unmapped",
                         f"{name} is unlimited here; say which number the feature {target} takes (unlimitedAs).",
                         key, target=target)
                return None
            value = spec.unlimited_as if spec.unlimited_as is not None else UNLIMITED_VALUE
        elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
            value = float(raw)
        else:
            ctx.add(diagnostic("sphere_property_unmapped", f"The limit {name} is not a number here.", key,
                               target=target))
            return None
        return value, "limit", {
            "name": name, "raw": p2y.value_json(raw), "unit": definition.unit, "period": _plainish(definition.period),
            "unlimited": unlimited,
        }
    definition = pricing.features.get(name)
    if definition is None:
        ctx.once("sphere_feature_unknown", f"This pricing declares no feature {name}.", source.at, feature=name)
        return None
    raw = result.features.get(name)
    if spec.kind == "feature":
        if isinstance(raw, p2y.Unlimited):
            raw_value: Any = UNLIMITED_VALUE
        else:
            raw_value = raw
        if is_feature and not (isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool)):
            ctx.add(diagnostic("sphere_property_unmapped",
                               f"The feature {name} is not a number, so it cannot be the problem feature {target}.",
                               key, target=target))
            return None
        if not isinstance(raw_value, (bool, int, float, str)):
            ctx.add(diagnostic("sphere_property_unmapped", f"The feature {name} is not a scalar here.", key,
                               target=target))
            return None
        return raw_value, "feature", {"name": name, "raw": p2y.value_json(raw)}
    # guarantee
    detail: dict[str, Any] = {"feature": name, "raw": p2y.value_json(raw)}
    if definition.doc_url:
        detail["docUrl"] = definition.doc_url
    if isinstance(raw, bool):
        word = "true" if raw else "false"
        if spec.map is None or word not in spec.map:
            ctx.once("sphere_guarantee_unmapped",
                     f"The guarantee {name} is {word} here; give its value in a table (map).", key, target=target)
            return None
        detail["map"] = dict(spec.map)
        return spec.map[word], "guarantee", detail
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        scale = spec.scale if spec.scale is not None else 1.0
        detail["scale"] = _number(scale)
        return float(raw) * scale, "guarantee", detail
    ctx.once("sphere_guarantee_unmapped", f"The guarantee {name} has no boolean or numeric value here.", key,
             target=target)
    return None


def _origin(candidate: _Candidate, target: str, kind: str, value: Any, source_kind: str,
            detail: dict[str, Any]) -> dict[str, Any]:
    meta = candidate.meta
    return {
        "candidateKey": candidate.key,
        "targetKind": kind,
        "target": target,
        "sourceKind": source_kind,
        "value": _plain(value),
        "snapshot": meta.snapshot_id if meta else None,
        "registry": meta.registry if meta else None,
        "pricingId": meta.pricing_id if meta else None,
        "versionId": meta.version_id if meta else None,
        "plan": candidate.plan,
        "addOns": [candidate.add_on] if candidate.add_on else [],
        "sphereRef": meta.sphere_ref if meta else None,
        "detail": _plain(detail),
    }


def _priced(ctx: _Context, price: p2y.Price, name: str, key: str, named: bool) -> bool:
    if isinstance(price, p2y.Label):
        ctx.add(diagnostic(
            "sphere_price_not_numeric", f"{name} has no published price ({price.text!r}); it is left out.", key,
            severity="error" if named else None, plan=name,
        ))
        return False
    if isinstance(price, p2y.Expression) and price.value is None:
        ctx.add(diagnostic(
            "sphere_price_expression", f"The price of {name} cannot be computed: {price.error}.", key,
            severity="error" if named else None, plan=name,
        ))
        return False
    return True


# -- One candidate, as the generator judges it --------------------------------------------------------------------


def admit_plan(
    ctx: _Context, pricing: p2y.NormalisedPricing, plan_name: str, plan_key: str, named: bool, uses_price: bool
) -> bool:
    """Whether the generator takes candidates of ``plan_name`` at all (public, and priced when a price is read)."""
    plan = pricing.plans[plan_name]
    if plan.private:
        ctx.add(diagnostic("sphere_plan_private", f"The plan {plan_name} is private in this pricing; it is left out.",
                           plan_key, plan=plan_name))
        return False
    if uses_price and not _priced(ctx, plan.price, plan_name, plan_key, named):
        return False
    return True


def admit_add_on(
    ctx: _Context, pricing: p2y.NormalisedPricing, plan_name: str, add_name: str, key: str, uses_price: bool
) -> bool:
    """Whether the generator prices the variant ``plan_name + add_name`` (when a price is read)."""
    if uses_price and not _priced(ctx, pricing.add_ons[add_name].price, f"{plan_name} + {add_name}", key, False):
        return False
    return True


def judge(
    ctx: _Context,
    candidate: _Candidate,
    pricing: p2y.NormalisedPricing,
    billing: str,
    specs: Mapping[str, PropertySpec],
    uses_price: bool,
) -> bool:
    """Fill ``candidate``'s values, properties and origins from ``pricing``; ``False`` when a target has no value."""
    names = ([candidate.add_on] if candidate.add_on else []) + list(candidate.extra_add_ons)
    result = p2y.effective(pricing, candidate.plan or "", {name: 1 for name in names} or None, billing)
    price = _price(ctx, pricing, candidate.source, candidate.plan or "", names, billing) if uses_price else None
    if price is not None:
        candidate.price = price[0]
    complete = True
    for target in sorted(specs):
        found = _value_of(ctx, candidate, pricing, result, target, specs[target], price)
        if found is None:
            complete = False
            continue
        value, source_kind, detail = found
        kind = "feature" if target in ctx.feature_targets else "property"
        if kind == "feature":
            candidate.features[target] = float(value)
        else:
            candidate.properties[target] = value
        candidate.origins.append(_origin(candidate, target, kind, value, source_kind, detail))
    return complete


@dataclass(frozen=True)
class CandidateValues:
    """The generator's judgement of one candidate: ``eligible`` (with the first refusal's ``reason`` code and its
    findings), each target's ``(value, source kind, detail)``, and the requirements explained."""

    eligible: bool
    reason: str | None
    values: Mapping[str, tuple[Any, str, dict[str, Any]]]
    requirements: tuple[dict[str, Any], ...]
    diagnostics: tuple[SphereDiagnostic, ...] = ()


def candidate_values(
    source: Source,
    meta: SnapshotMeta | None,
    task: Task,
    recipe: Recipe,
    pricing: p2y.NormalisedPricing,
    plan: str,
    add_ons: Sequence[str] = (),
    *,
    billing: str | None = None,
    seats: int | None = None,
    feature_targets: set[str] | None = None,
) -> CandidateValues:
    """What the generator makes of ``plan`` (with ``add_ons``) of ``pricing`` for ``task`` of ``recipe``.

    ``billing`` and ``seats`` replace the source's when given. ``feature_targets`` are the problem's features (the
    recipe's by default). The refusal codes are the generator's (``sphere_plan_private``,
    ``sphere_price_not_numeric``, ``sphere_price_expression``, ``sphere_property_unmapped``, ``sphere_limit_unknown``
    ...), plus ``sphere_plan_unknown``, ``sphere_addon_unknown`` (not declared), ``sphere_addon_unavailable`` (not
    available for the plan) and ``sphere_addon_not_subscription`` (metered, private or dependent: never a variant).
    """
    if billing is not None or seats is not None:
        source = dataclasses.replace(
            source, billing=billing if billing is not None else source.billing,
            seats=seats if seats is not None else source.seats,
        )
    ctx = _Context(recipe, set(recipe.features) if feature_targets is None else set(feature_targets))
    specs = task_specs(task)
    uses_price = any(spec.kind == "price" for spec in specs.values())
    period = source.billing or recipe.billing

    def refused(code: str) -> CandidateValues:
        return CandidateValues(False, code, {}, (), tuple(ctx.diagnostics))

    if pricing.currency != recipe.currency:
        return refused("sphere_currency_mismatch")
    if period not in {b.id for b in pricing.billing}:
        return refused("sphere_billing_unknown")
    if plan not in pricing.plans:
        return refused("sphere_plan_unknown")
    service = task.service
    resource = ids.catalog_resource(service)
    plan_key = ids.candidate_key(resource, ids.candidate_id(service, source.provider or "", plan))
    if not admit_plan(ctx, pricing, plan, plan_key, True, uses_price):
        return refused(ctx.diagnostics[-1].code)
    names = list(add_ons)
    for name in names:
        add_on = pricing.add_ons.get(name)
        if add_on is None:
            return refused("sphere_addon_unknown")
        if plan not in add_on.available_for:
            return refused("sphere_addon_unavailable")
        if add_on.metered or add_on.private or add_on.depends_on:
            return refused("sphere_addon_not_subscription")
    first = names[0] if names else None
    identifier = ids.candidate_id(service, source.provider or "", plan, first)
    key = ids.candidate_key(resource, identifier)
    for name in names:
        if not admit_add_on(ctx, pricing, plan, name, key, uses_price):
            return refused(ctx.diagnostics[-1].code)
    candidate = _Candidate(
        resource=resource, id=identifier, task=task.task, capability=task.capability,
        provider=source.provider or "", plan=plan, add_on=first, source=source, meta=meta, name=None,
        capabilities=[task.capability], extra_add_ons=tuple(names[1:]),
    )
    found = len(ctx.diagnostics)
    complete = judge(ctx, candidate, pricing, period, specs, uses_price)
    values = {o["target"]: (o["value"], o["sourceKind"], o["detail"]) for o in candidate.origins}
    requirements = tuple(_explain(task, recipe, candidate.properties))
    if not complete:
        refusal = next((d.code for d in ctx.diagnostics[found:]), "sphere_property_unmapped")
        return CandidateValues(False, refusal, values, requirements, tuple(ctx.diagnostics))
    return CandidateValues(True, None, values, requirements, tuple(ctx.diagnostics))

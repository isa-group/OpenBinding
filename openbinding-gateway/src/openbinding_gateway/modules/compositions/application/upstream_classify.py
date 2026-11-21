"""Classifying an upstream change without a solver (F6, decision 11): two snapshots in, one category out.

Pure: no session, no network, no clock, nothing compiled, no ``BimPort``. The watcher gathers the inputs in a read
phase (the two normalised snapshots, the bound selection, the stored value origins, the pinned recipe, the problem's
feature rules and the version's current values) and writes the result in a short transaction. It lives in
``application`` only because modules reach each other through ``application`` packages; it imports nothing that
reads a database or the network and never reads the clock (``tests/compositions/test_upstream_classify.py``).

**Building blocks, one implementation each:** ``plans.compare_selections`` (pricing-renderer's ``compareSelections``,
ported; what changed for the selection), ``problems.candidate_values`` (the generator's own judgement of one
candidate: eligibility, values, requirements) and ``margins.compute`` (offering margins before and after).

**Precedence** (``domain.upstream.PRECEDENCE``): ``source_unavailable`` > ``pricing_unreadable`` > per-entry
"rebinding recommended" reasons (``binding_invalid``) > ``values_changed`` (some entry compares non-empty) >
``no_impact``. An entry without stored origins (a hand-written ``from``, declared values) gets the plan, add-on and
price checks only, ``mapped: null`` and no delta (note ``no_value_origins``).

**The direct delta.** For an origin of kind ``priced`` feeding a problem feature whose aggregation is ``sum`` and whose
scope is ``selectedCandidate`` (TomatoMeter's ``subscription``), with ``verified`` values, ``delta = after - before``
per attribute and, per feature, ``after = evaluation value + sum(deltas)``, in ``Decimal`` under ``money_context``.
Everything else gets before and after only (``no_direct_mapping``).

**Feature rules** are read from the linked compilation's stored IR at ``spec.application.features.<name>`` (``scope``,
and ``aggregation``, which the toolchain expands to ``{"sequence": ..., "parallel": ...}``; ``sum`` is both ``sum``),
falling back to the revision's package ``application.json`` ``spec.features.<name>`` (``aggregation: "sum"``), the key
``generate`` writes (``feature_rules``).

**Offering** (``classify_offering``): an equal functional hash is no event (a rename); otherwise ``offering_changed``,
never invalidating, with the catalog diff, each margin row's effective values before and after, and the margins of
every adopted environment and of the latest version computed with ``margins.compute`` on both pricings.
``notify`` is false when nothing a row reads moved.

The diff is ``openbinding/upstream-event-diff@1``: canonical (the pricing's declared order, numbers as ``Decimal``
strings, no floats), at most ``MAX_DIFF_BYTES`` (``truncated: true`` beyond).
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from ...plans.application import (
    AmountOutOfRange,
    Selection,
    catalog_diff,
    compare_selections,
    exact,
    identical_plan,
    money_context,
    money_str,
    pricing2yaml,
    quantize6,
)
from ...problems.application import CandidateValues, SnapshotMeta, candidate_values
from ..domain.upstream import Category, Note, Reason
from . import margins as margin_rules

CLASSIFIER_VERSION = "1"
DIFF_SCHEMA = "openbinding/upstream-event-diff@1"
MAX_DIFF_BYTES = 64 * 1024
#: Generator refusals that mean "a value the recipe reads is no longer declared".
_UNMAPPED = {
    "sphere_property_unmapped", "sphere_limit_unknown", "sphere_feature_unknown", "sphere_guarantee_unmapped",
    "sphere_unlimited_unmapped",
}


# -- Inputs ----------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Side:
    """One version of a pricing as the event shows it: ids, label and the normalised reading (``None`` when it
    does not normalise: ``refusal`` is the normaliser's code)."""

    version_id: str | None
    label: str | None
    created_at: str | None = None
    snapshot_id: str | None = None
    url: str | None = None
    pricing: pricing2yaml.NormalisedPricing | None = None
    refusal: str | None = None
    content_hash: str | None = None

    def ref(self) -> dict[str, Any]:
        return {"versionId": self.version_id, "label": self.label, "createdAt": self.created_at,
                "snapshotId": self.snapshot_id, "url": self.url}


@dataclass(frozen=True)
class Origin:
    """One stored ``problem_value_origins`` row of the bound candidate."""

    target: str
    target_kind: str
    source_kind: str
    value: Any
    detail: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class FeatureRule:
    """How the problem aggregates a feature (from the compiled IR) and its unit."""

    aggregation: str | None
    scope: str | None
    unit: str | None = None

    @property
    def direct(self) -> bool:
        return self.aggregation == "sum" and self.scope == "selectedCandidate"


@dataclass(frozen=True)
class RecipeEntry:
    """The pinned recipe's view of the entry: the recipe, its task and the source naming this pricing."""

    recipe: Any
    task: Any
    source: Any
    meta: SnapshotMeta | None = None


@dataclass(frozen=True)
class EntryInput:
    task: str
    candidate: str
    selection: Selection
    origins: tuple[Origin, ...] = ()
    recipe: RecipeEntry | None = None


@dataclass(frozen=True)
class Facts:
    """What the watch knows of the source beyond the two copies."""

    pricing: Mapping[str, Any]
    gone: bool = False
    withdrawn: bool = False


@dataclass(frozen=True)
class BindingContext:
    values_status: str
    #: The version's current global values: ``{name: {"value": ..., "unit": ...}}``.
    values: Mapping[str, Any] = field(default_factory=dict)
    features: Mapping[str, FeatureRule] = field(default_factory=dict)


@dataclass(frozen=True)
class Classification:
    category: Category
    reasons: tuple[dict[str, Any], ...]
    notify: bool
    diff: dict[str, Any]


# -- Feature rules from the stored IR --------------------------------------------------------------------------------


def _aggregation(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        sequence, parallel = value.get("sequence"), value.get("parallel")
        if sequence == parallel and isinstance(sequence, str):
            return sequence
        return "mixed"
    return None


def feature_rules(ir: Mapping[str, Any] | None, document: Mapping[str, Any] | None = None) -> dict[str, FeatureRule]:
    """``{feature: FeatureRule}`` from a compilation's IR (``spec.application.features``), else from a package's
    ``application.json`` (``spec.features``)."""
    found: Mapping[str, Any] = {}
    if isinstance(ir, Mapping):
        found = ((ir.get("spec") or {}).get("application") or {}).get("features") or {}
    if not found and isinstance(document, Mapping):
        found = (document.get("spec") or {}).get("features") or {}
    out = {}
    for name, item in found.items():
        if isinstance(item, Mapping):
            unit = item.get("unit")
            out[str(name)] = FeatureRule(_aggregation(item.get("aggregation")), item.get("scope"),
                                         unit if isinstance(unit, str) else None)
    return out


# -- Numbers ---------------------------------------------------------------------------------------------------------


def _num(value: Any) -> str | None:
    """A stored or computed value as a diff writes it: a Decimal string, or the value's JSON for anything else."""
    if isinstance(value, bool) or value is None:
        return value  # type: ignore[return-value]
    if isinstance(value, (int, float, Decimal)):
        try:
            with money_context():
                return money_str(exact(value))
        except AmountOutOfRange:
            return str(value)
    return value


def _decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal, str)):
        return None
    try:
        return exact(value)
    except (AmountOutOfRange, TypeError):
        return None


# -- Binding ---------------------------------------------------------------------------------------------------------


def _reason(code: Reason | str, **detail: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"code": code.value if isinstance(code, Reason) else code}
    out.update({k: v for k, v in detail.items() if v is not None})
    return out


def _price_not_numeric(price: pricing2yaml.Price) -> bool:
    return isinstance(price, pricing2yaml.Label) or (isinstance(price, pricing2yaml.Expression) and price.value is None)


def _not_subscription(add_on: Any) -> bool:
    return bool(add_on.metered or add_on.private or add_on.depends_on)


def _renamed_to(old: pricing2yaml.NormalisedPricing, new: pricing2yaml.NormalisedPricing, plan: str) -> str | None:
    twins = [name for name in new.plans if name not in old.plans and identical_plan(plan, name, old, new)]
    return twins[0] if len(twins) == 1 else None


def _judge(entry: EntryInput, pricing: pricing2yaml.NormalisedPricing, features: set[str]) -> CandidateValues | None:
    if entry.recipe is None:
        return None
    return candidate_values(
        entry.recipe.source, entry.recipe.meta, entry.recipe.task, entry.recipe.recipe, pricing,
        entry.selection.plan, list(entry.selection.add_ons), billing=entry.selection.billing,
        seats=entry.selection.seats, feature_targets=features,
    )


def _structural(entry: EntryInput, old: pricing2yaml.NormalisedPricing | None,
                new: pricing2yaml.NormalisedPricing) -> list[dict[str, Any]]:
    """The plan, add-on, price, currency and billing checks every entry gets. A state the pinned side already had (a
    hand-written ``from`` on a private plan or a dependent add-on) is no new reason: only what became so counts."""
    selection = entry.selection
    reasons: list[dict[str, Any]] = []
    plan = new.plans.get(selection.plan)
    if plan is None:
        reasons.append(_reason(Reason.PLAN_REMOVED, plan=selection.plan,
                               renamedTo=_renamed_to(old, new, selection.plan) if old is not None else None))
        return reasons
    pinned_plan = old.plans.get(selection.plan) if old is not None else None
    if plan.private and not (pinned_plan is not None and pinned_plan.private):
        reasons.append(_reason(Reason.PLAN_PRIVATE, plan=selection.plan))
    if entry.origins:
        reads_price = any(o.source_kind == "priced" for o in entry.origins)
    else:
        # Without origins nothing says the price is read: only a price that stopped being a number counts.
        was = old.plans.get(selection.plan) if old is not None else None
        reads_price = was is not None and not _price_not_numeric(was.price)
    if reads_price and _price_not_numeric(plan.price):
        reasons.append(_reason(Reason.PRICE_NOT_NUMERIC, plan=selection.plan))
    for name in selection.add_ons:
        add_on = new.add_ons.get(name)
        pinned = old.add_ons.get(name) if old is not None else None
        if add_on is None:
            reasons.append(_reason(Reason.ADDON_REMOVED, addOn=name))
        elif selection.plan not in add_on.available_for:
            if pinned is None or selection.plan in pinned.available_for:
                reasons.append(_reason(Reason.ADDON_UNAVAILABLE, addOn=name))
        elif _not_subscription(add_on):
            if pinned is None or not _not_subscription(pinned):
                reasons.append(_reason(Reason.ADDON_NOT_SUBSCRIPTION, addOn=name))
        elif reads_price and _price_not_numeric(add_on.price):
            if pinned is None or not _price_not_numeric(pinned.price):
                reasons.append(_reason(Reason.PRICE_NOT_NUMERIC, addOn=name))
    if old is not None and reads_price and old.currency != new.currency:
        reasons.append(_reason(Reason.CURRENCY_CHANGED, before=old.currency, after=new.currency))
    if selection.billing is not None and selection.billing not in {b.id for b in new.billing}:
        reasons.append(_reason(Reason.BILLING_MISSING, billing=selection.billing))
    return reasons


def _requirement_rows(before: CandidateValues | None, after: CandidateValues | None) -> list[dict[str, Any]]:
    if after is None:
        return []
    was = {row["property"]: row for row in (before.requirements if before is not None else ())}
    rows = []
    for row in after.requirements:
        kind = "feature" if row["operator"] == "==" else "limit"
        rows.append({
            "name": row["property"], "kind": kind, "demand": _num(row["bound"]) if kind == "limit" else True,
            "before": was[row["property"]]["satisfied"] if row["property"] in was else None,
            "after": bool(row["satisfied"]),
            "valueBefore": _num(was[row["property"]]["value"]) if row["property"] in was else None,
            "valueAfter": _num(row["value"]),
        })
    return rows


def _entry(entry: EntryInput, old: Side, new: Side, context: BindingContext, notes: set[str]) -> dict[str, Any]:
    assert new.pricing is not None
    features = set(context.features) | {o.target for o in entry.origins if o.target_kind == "feature"}
    selection = entry.selection
    comparison = compare_selections(old.pricing, new.pricing, selection) if old.pricing is not None else None
    reasons = _structural(entry, old.pricing, new.pricing)
    if comparison is not None and comparison.sentinel:
        notes.add(Note.UNLIMITED_SENTINEL.value)
    if not entry.origins:
        notes.add(Note.NO_VALUE_ORIGINS.value)
    judged_after = judged_before = None
    if entry.origins and not reasons:
        judged_after = _judge(entry, new.pricing, features)
        if old.pricing is not None:
            judged_before = _judge(entry, old.pricing, features)
        refused_before = judged_before.reason if judged_before is not None and not judged_before.eligible else None
        if judged_after is not None and not judged_after.eligible and judged_after.reason != refused_before:
            code = judged_after.reason or ""
            if code in _UNMAPPED:
                target = next((d.extra.get("target") or d.extra.get("limit") or d.extra.get("feature")
                               for d in judged_after.diagnostics if d.code == code), None)
                reasons.append(_reason(Reason.VALUE_UNMAPPED, target=target, refusal=code))
            elif code == "sphere_price_not_numeric" or code == "sphere_price_expression":
                reasons.append(_reason(Reason.PRICE_NOT_NUMERIC, plan=selection.plan))
            elif code == "sphere_plan_private":
                reasons.append(_reason(Reason.PLAN_PRIVATE, plan=selection.plan))
            elif code == "sphere_currency_mismatch":
                reasons.append(_reason(Reason.CURRENCY_CHANGED, after=new.pricing.currency))
            elif code == "sphere_billing_unknown":
                reasons.append(_reason(Reason.BILLING_MISSING, billing=selection.billing))
            else:
                reasons.append(_reason(Reason.VALUE_UNMAPPED, refusal=code))
    requirements = _requirement_rows(judged_before, judged_after)
    for row in requirements:
        if not row["after"]:
            reasons.append(_reason(Reason.REQUIREMENT_UNMET, name=row["name"], kind=row["kind"], demand=row["demand"],
                                   before=row["valueBefore"], after=row["valueAfter"]))
    attributes, mismatches = [], []
    for origin in entry.origins:
        if origin.source_kind == "manual":
            continue
        after_value = judged_after.values.get(origin.target) if judged_after is not None else None
        attribute: dict[str, Any] = {
            "target": origin.target, "targetKind": origin.target_kind, "sourceKind": origin.source_kind,
            "before": _num(origin.value), "after": _num(after_value[0]) if after_value is not None else None,
            "delta": None,
        }
        recomputed = judged_before.values.get(origin.target) if judged_before is not None else None
        if recomputed is not None and _num(recomputed[0]) != _num(origin.value):
            mismatches.append({"target": origin.target, "stored": _num(origin.value), "recomputed": _num(recomputed[0])})
        rule = context.features.get(origin.target)
        b, a = _decimal(origin.value), _decimal(after_value[0]) if after_value is not None else None
        if (origin.source_kind == "priced" and rule is not None and rule.direct
                and context.values_status == "verified" and b is not None and a is not None):
            with money_context():
                attribute["delta"] = money_str(quantize6(a - b))
            if a > b:
                notes.add(Note.DOMAIN_MAY_CHANGE.value)
        elif attribute["before"] != attribute["after"]:
            notes.add(Note.NO_DIRECT_MAPPING.value)
        attributes.append(attribute)
    return {
        "task": entry.task,
        "candidate": entry.candidate,
        "selection": {"plan": selection.plan, "addOns": list(selection.add_ons), "billing": selection.billing,
                      "seats": selection.seats},
        "comparison": _comparison(comparison, reasons),
        "attributes": attributes,
        "requirements": requirements,
        "reasons": reasons,
        "originMismatch": mismatches,
        "_changed": comparison is None or not comparison.empty,
    }


def _comparison(comparison: Any, reasons: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    if comparison is None:
        return None
    out = comparison.as_json()
    out.pop("catalog", None)
    renamed = next((r.get("renamedTo") for r in reasons if r["code"] == Reason.PLAN_REMOVED.value), None)
    out["plan"] = dict(out["plan"]) | {"renamedTo": renamed}
    return out


def _global(entries: Sequence[dict[str, Any]], context: BindingContext) -> list[dict[str, Any]]:
    deltas: dict[str, Decimal] = {}
    with money_context():
        for entry in entries:
            for attribute in entry["attributes"]:
                if attribute["delta"] is not None:
                    deltas[attribute["target"]] = deltas.get(attribute["target"], Decimal(0)) + Decimal(attribute["delta"])
        rows = []
        for feature, delta in deltas.items():
            if delta == 0:
                continue
            item = context.values.get(feature)
            current = _decimal(item.get("value")) if isinstance(item, Mapping) else _decimal(item)
            rule = context.features.get(feature)
            unit = (item.get("unit") if isinstance(item, Mapping) else None) or (rule.unit if rule else None)
            rows.append({
                "feature": feature, "unit": unit,
                "before": money_str(quantize6(current)) if current is not None else None,
                "after": money_str(quantize6(current + delta)) if current is not None else None,
                "delta": money_str(quantize6(delta)), "rule": "sum/selectedCandidate",
            })
    return rows


def _first(reasons: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    order = {code.value: index for index, code in enumerate(
        (Reason.SOURCE_UNAVAILABLE, Reason.PRICING_UNREADABLE, Reason.PLAN_REMOVED, Reason.PLAN_PRIVATE,
         Reason.PRICE_NOT_NUMERIC, Reason.ADDON_REMOVED, Reason.ADDON_UNAVAILABLE, Reason.ADDON_NOT_SUBSCRIPTION,
         Reason.CURRENCY_CHANGED, Reason.BILLING_MISSING, Reason.VALUE_UNMAPPED, Reason.REQUIREMENT_UNMET))}
    return sorted(reasons, key=lambda r: order.get(r["code"], len(order)))


def classify_binding(
    old: Side, new: Side | None, facts: Facts, entries: Sequence[EntryInput], context: BindingContext,
) -> Classification:
    """The category of ``new`` (``None``: gone) for the entries of one version that pin ``old``."""
    notes: set[str] = {Note.VALUES_NOT_REEVALUATED.value}
    diff: dict[str, Any] = {
        "schema": DIFF_SCHEMA, "pricing": dict(facts.pricing), "old": old.ref(),
        "new": new.ref() if new is not None and not facts.gone else None,
        "catalog": None, "entries": [], "global": [], "notes": [],
    }
    if facts.gone or facts.withdrawn or new is None:
        detail = "family_not_found" if facts.gone or new is None else "version_withdrawn"
        reasons = [_reason(Reason.SOURCE_UNAVAILABLE, detail=detail)]
        if facts.withdrawn and not facts.gone:
            diff["new"] = new.ref() if new is not None else None
        diff["entries"] = [{"task": e.task, "candidate": e.candidate,
                            "selection": {"plan": e.selection.plan, "addOns": list(e.selection.add_ons),
                                          "billing": e.selection.billing, "seats": e.selection.seats},
                            "reasons": reasons} for e in entries]
        diff["notes"] = sorted(notes)
        return Classification(Category.BINDING_INVALID, tuple(reasons), True, _bounded(diff))
    if new.pricing is None:
        reasons = [_reason(Reason.PRICING_UNREADABLE, detail=new.refusal or "pricing_invalid")]
        diff["notes"] = sorted(notes)
        return Classification(Category.BINDING_INVALID, tuple(reasons), True, _bounded(diff))
    if old.pricing is None:
        notes.add(Note.BASELINE_UNAVAILABLE.value)
    else:
        diff["catalog"] = _catalog(old.pricing, new.pricing)
    rows = [_entry(entry, old, new, context, notes) for entry in entries]
    reasons = _first([reason for row in rows for reason in row["reasons"]])
    changed = any(row.pop("_changed") for row in rows)
    diff["entries"] = rows
    if reasons:
        category = Category.BINDING_INVALID
    elif changed or old.pricing is None:
        category = Category.VALUES_CHANGED
        diff["global"] = _global(rows, context)
    else:
        category = Category.NO_IMPACT
    if category != Category.VALUES_CHANGED:
        notes.discard(Note.DOMAIN_MAY_CHANGE.value)
    if category != Category.VALUES_CHANGED:
        notes.discard(Note.NO_DIRECT_MAPPING.value)
    diff["notes"] = sorted(notes)
    return Classification(category, tuple(reasons), category != Category.NO_IMPACT, _bounded(diff))


def _catalog(old: pricing2yaml.NormalisedPricing, new: pricing2yaml.NormalisedPricing) -> dict[str, Any]:
    found = catalog_diff(old, new)
    return {
        "plans": {"added": found["onlyInAfter"]["plans"], "removed": found["onlyInBefore"]["plans"]},
        "addOns": {"added": found["onlyInAfter"]["addOns"], "removed": found["onlyInBefore"]["addOns"]},
        "features": {"added": found["onlyInAfter"]["features"], "removed": found["onlyInBefore"]["features"]},
        "usageLimits": {"added": found["onlyInAfter"]["usageLimits"], "removed": found["onlyInBefore"]["usageLimits"]},
    }


# -- Offering --------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class MarginInput:
    """One evaluation whose margins an offering event shows (an environment's adoption, or the latest version)."""

    values: Mapping[str, Any]
    values_status: str
    outcome: str
    users: int | None
    environment: str | None = None
    adoption: int | None = None
    evaluation: str | None = None
    version: str | None = None


def _row_values(pricing: pricing2yaml.NormalisedPricing | None, plan: str, add_on: str | None) -> dict[str, Any] | None:
    if pricing is None or plan not in pricing.plans or (add_on is not None and add_on not in pricing.add_ons):
        return None
    chosen = pricing.plans[plan]
    result = pricing2yaml.effective(pricing, plan, {add_on: 1} if add_on else None)
    with money_context():
        price = None if result.requires_quote else money_str(quantize6(exact(result.subtotal)))
    return {
        "price": price, "unit": chosen.unit,
        "features": {k: _value(v) for k, v in result.features.items()},
        "usageLimits": {k: _value(v) for k, v in result.limits.items()},
    }


def _value(value: Any) -> Any:
    if isinstance(value, pricing2yaml.Unlimited):
        return {"unlimited": True}
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _num(value)
    return value


def _margins(item: MarginInput, pricing: pricing2yaml.NormalisedPricing | None) -> dict[str, Any]:
    found = margin_rules.compute(item.values, item.values_status, item.outcome, pricing,
                                 "read" if pricing is not None else "unreadable", item.users)
    return {"status": found["status"], "costPerUser": found["costPerUser"], "currency": found["currency"],
            "rows": [{k: row[k] for k in ("plan", "addOns", "revenue", "cost", "margin")} for row in found["rows"]]}


def _moved(before: dict[str, Any], after: dict[str, Any]) -> bool:
    return [(r["plan"], r["addOns"], r["revenue"], r["margin"]) for r in before["rows"]] != [
        (r["plan"], r["addOns"], r["revenue"], r["margin"]) for r in after["rows"]
    ]


def classify_offering(
    old: Side, new: Side | None, facts: Facts, environments: Sequence[MarginInput], latest: MarginInput | None,
) -> Classification | None:
    """The offering event of ``new`` against the baseline ``old``; ``None`` when nothing happened (equal functional
    hash: a rename)."""
    diff: dict[str, Any] = {
        "schema": DIFF_SCHEMA, "pricing": dict(facts.pricing), "old": old.ref(),
        "new": None, "catalog": None, "plans": [], "margins": {"environments": [], "latest": None}, "notes": [],
    }
    unavailable = facts.gone or new is None or new.pricing is None
    if not unavailable and old.content_hash is not None and new.content_hash == old.content_hash:
        return None
    if unavailable:
        diff["new"] = new.ref() if new is not None and not facts.gone else None
        reasons = (_reason(Reason.OFFERING_UNAVAILABLE, detail="gone" if facts.gone or new is None
                           else (new.refusal or "pricing_invalid")),)
        diff["margins"]["environments"] = [
            {"environment": e.environment, "adoption": e.adoption, "evaluation": e.evaluation, "users": e.users,
             "before": _margins(e, old.pricing), "after": None} for e in environments
        ]
        return Classification(Category.OFFERING_CHANGED, reasons, True, _bounded(diff))
    assert new is not None and new.pricing is not None
    diff["new"] = new.ref()
    moved = False
    if old.pricing is not None:
        diff["catalog"] = _catalog(old.pricing, new.pricing)
        variants: list[tuple[str, str | None]] = []
        for pricing in (old.pricing, new.pricing):
            for variant in pricing2yaml.single_variants(pricing, limit=margin_rules.MAX_MARGIN_ROWS):
                if variant not in variants:
                    variants.append(variant)
        for plan, add_on in variants[: margin_rules.MAX_MARGIN_ROWS]:
            before, after = _row_values(old.pricing, plan, add_on), _row_values(new.pricing, plan, add_on)
            changed = before != after
            moved = moved or changed
            diff["plans"].append({"plan": plan, "addOns": [add_on] if add_on else [], "before": before,
                                  "after": after, "changed": changed})
    else:
        diff["notes"].append(Note.BASELINE_UNAVAILABLE.value)
        moved = True
    for item in environments:
        before, after = _margins(item, old.pricing), _margins(item, new.pricing)
        moved = moved or _moved(before, after)
        diff["margins"]["environments"].append({
            "environment": item.environment, "adoption": item.adoption, "evaluation": item.evaluation,
            "users": item.users, "before": before, "after": after,
        })
    if latest is not None:
        before, after = _margins(latest, old.pricing), _margins(latest, new.pricing)
        moved = moved or _moved(before, after)
        diff["margins"]["latest"] = {"version": latest.version, "before": before, "after": after}
    return Classification(Category.OFFERING_CHANGED, (), moved, _bounded(diff))


# -- Bounds ----------------------------------------------------------------------------------------------------------


def canonical(diff: Mapping[str, Any]) -> bytes:
    return json.dumps(diff, sort_keys=False, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _bounded(diff: dict[str, Any]) -> dict[str, Any]:
    if len(canonical(diff)) <= MAX_DIFF_BYTES:
        return diff
    trimmed = dict(diff) | {"truncated": True}
    for key in ("plans", "entries"):
        items = list(trimmed.get(key) or [])
        while items and len(canonical(trimmed | {key: items})) > MAX_DIFF_BYTES:
            items.pop()
        trimmed[key] = items
    if len(canonical(trimmed)) > MAX_DIFF_BYTES:
        trimmed["margins"] = {"environments": [], "latest": None}
    return trimmed

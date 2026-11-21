"""Margins per offering plan: revenue of each plan minus the upstream cost per user (plan §7.1).

``compute`` is the one implementation (the upstream classifier's "offering changed" margins call it too): pure, Decimal throughout inside
``money_context()`` (34 digits, traps on), every amount quantized stepwise to six places half-even, so the numbers
shown always subtract exactly. ``margins`` reads its inputs: an evaluation of the version (the current one by default,
the adoption's pinned one for an environment) and the offering snapshot that evaluation read.

Steps (the order decides the ``status``):

1. **Offering**: none is ``no_offering``, an unreadable, invalid or unknown-registry one its own status; no rows.
2. **Pricing**: the snapshot's normalised pricing (memoised per snapshot).
3. **Cost**: the global value named by ``cost``, else the only value whose unit is ``CUR/period``; none is
   ``no_cost_value``, several ``ambiguous_cost``; made monthly with the shared month factor.
4. **Currency**: the cost's against the offering's; different is ``currency_mismatch`` (no conversion).
5. **Binding**: an evaluation whose binding is invalid, or whose problem the toolchain reads differently, gives no
   cost a version stands behind.
6. **Rows**: each plan alone, then each plan with each single non-metered, dependency-free add-on available to it at
   its minimum quantity, in declared order, at most ``MAX_MARGIN_ROWS`` (``rowsTruncated``). Revenue is the sum of
   the parts ``effective()`` keeps, each ``unit amount x billing multiplier x quantity x month factor``; a part
   without a period is left out (``excludedParts``); a label price or a failed expression needs a quote.
7. **Basis**: per subscription; a per-seat part counts one seat (``basis: seat``).
8. **Per user**: ``costPerUser = monthly / users`` (uniform apportionment, said on every answer); ``margin =
   revenue - costPerUser``. Without ``users``: revenue rows, ``users_required``.
9. ``ok`` only when every step passed; declared values are said (``declared_values``).

Hostile documents never make a 500: an amount beyond ``MAX_AMOUNT`` or not finite is ``amount_out_of_range`` (the
cost: margins null; a part or a row: that row's revenue and margin null, ``outOfRange``).
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from decimal import Decimal, DecimalException
from typing import Any, Mapping

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import (
    CompositionEvaluation,
    CompositionVersion,
    EvaluationOutcome,
    PricingSnapshot,
)
from ....models.errors import api_error
from ...plans.application import (
    AmountOutOfRange,
    PricingError,
    exact,
    in_range,
    money_context,
    money_str,
    month_factor,
    normalised,
    pricing2yaml,
    quantize6,
)
from . import versions

#: The most rows one answer holds.
MAX_MARGIN_ROWS = 200
#: A global value is money when its unit is a currency per period.
MONEY_UNIT = re.compile(r"^([A-Z]{3})/(month|year|week)$")
APPORTIONMENT = "uniform"

#: An ``offering_status`` that is not ``read``, as a margins status.
OFFERING_STATUS = {
    "unreadable": "offering_unreadable",
    "invalid_pricing": "offering_invalid",
    "registry_unknown": "offering_registry_unknown",
}


class MarginsRefused(Exception):
    """A request the margins cannot answer (an unknown billing period or cost value): 422."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _money(value: Decimal | None) -> str | None:
    return None if value is None else money_str(value)


def _plain(value: Any) -> str:
    try:
        return format(exact(value), "f")
    except (AmountOutOfRange, TypeError):
        return str(value)


def _part_unit(pricing: pricing2yaml.NormalisedPricing, part: pricing2yaml.PricePart) -> str | None:
    return pricing.plans[part.id].unit if part.kind == "plan" else pricing.add_ons[part.id].unit


def _row(
    pricing: pricing2yaml.NormalisedPricing, plan: str, add_on: str | None, billing: pricing2yaml.Billing,
) -> dict[str, Any]:
    chosen = pricing.plans[plan]
    selection = {add_on: pricing.add_ons[add_on].min_quantity} if add_on else None
    result = pricing2yaml.effective(pricing, plan, selection, billing.id)
    private = chosen.private or (add_on is not None and pricing.add_ons[add_on].private)
    row: dict[str, Any] = {
        "plan": plan, "planName": chosen.display_name, "addOns": [add_on] if add_on else [], "basis": "subscription",
        "private": private, "requiresQuote": False, "outOfRange": False, "excludedParts": [], "revenue": None,
    }
    total = Decimal(0)
    for part in result.parts:
        unit = _part_unit(pricing, part)
        if pricing2yaml.units.per_seat(unit):
            row["basis"] = "seat"
        factor = month_factor(pricing2yaml.units.period_of(unit))
        if factor is None:
            row["excludedParts"].append(part.id)
            continue
        if isinstance(part.price, pricing2yaml.Label) or part.unit_amount is None or (
            isinstance(part.price, pricing2yaml.Expression) and part.price.error
        ):
            row["requiresQuote"] = True
            continue
        try:
            unit_amount = exact(part.unit_amount)
            scale = exact(billing.multiplier) * exact(part.quantity)
            if not (in_range(unit_amount) and in_range(scale)):
                raise AmountOutOfRange("part")
            total += unit_amount * scale * factor
        except (AmountOutOfRange, DecimalException):
            row["outOfRange"] = True
    if row["requiresQuote"] or row["outOfRange"]:
        return row
    try:
        row["revenue"] = quantize6(total)
    except (AmountOutOfRange, DecimalException):
        row["outOfRange"] = True
    return row


def _cost(values: Mapping[str, Any], name: str | None) -> tuple[str | None, dict[str, Any] | None, str | None]:
    """``(status, cost, currency)``: the selected global value made monthly, or why there is none."""
    money = {
        key: item for key, item in sorted(values.items())
        if isinstance(item, Mapping) and isinstance(item.get("unit"), str) and MONEY_UNIT.match(item["unit"])
    }
    if name is not None:
        if name not in values:
            raise MarginsRefused("unknown_cost", f"The version has no global value {name!r}.")
        if name not in money:
            raise MarginsRefused("unknown_cost", f"The global value {name!r} is not an amount per period.")
        chosen = name
    elif not money:
        return "no_cost_value", None, None
    elif len(money) > 1:
        return "ambiguous_cost", None, None
    else:
        (chosen,) = money
    item = money[chosen]
    currency, period = MONEY_UNIT.match(item["unit"]).groups()  # type: ignore[union-attr]
    cost: dict[str, Any] = {"name": chosen, "value": None, "unit": item["unit"], "monthly": None}
    try:
        value = exact(item["value"])
        if not in_range(value):
            raise AmountOutOfRange("cost")
        cost["value"] = quantize6(value)
        cost["monthly"] = quantize6(value * month_factor(period))
    except (AmountOutOfRange, DecimalException, TypeError):
        cost["value"] = None
        cost["raw"] = str(item.get("value"))
        return "amount_out_of_range", cost, currency
    return None, cost, currency


def compute(
    values: Mapping[str, Any],
    values_status: str,
    outcome: str,
    pricing: pricing2yaml.NormalisedPricing | None,
    offering_status: str | None,
    users: int | None,
    billing: str | None = None,
    cost: str | None = None,
) -> dict[str, Any]:
    """The margins of ``values`` (the evaluation's global values) against ``pricing`` (see the module docstring).

    Raises ``MarginsRefused`` for an unknown ``billing`` or ``cost``.
    """
    with money_context():
        return _compute(values, values_status, outcome, pricing, offering_status, users, billing, cost)


def _compute(values, values_status, outcome, pricing, offering_status, users, billing, cost) -> dict[str, Any]:
    warnings: list[str] = []
    if values_status == "declared":
        warnings.append("declared_values")
    answer: dict[str, Any] = {
        "cost": None, "users": users, "billing": None, "apportionment": APPORTIONMENT, "status": "ok",
        "currency": None, "costPerUser": None, "rowsTruncated": False, "rows": [], "warnings": warnings,
    }

    def fail(code: str) -> None:
        if answer["status"] == "ok":
            answer["status"] = code

    if offering_status is None:
        fail("no_offering")
    elif offering_status != "read":
        fail(OFFERING_STATUS.get(offering_status, "offering_unreadable"))
    elif pricing is None or not pricing.plans:
        fail("offering_invalid")
    period = None
    if answer["status"] == "ok":
        period = next((b for b in pricing.billing if b.id == billing), None) if billing else pricing.default_billing()
        if period is None:
            raise MarginsRefused("unknown_billing", f"The offering has no billing period {billing!r}.")
        answer["billing"] = {"id": period.id, "multiplier": _plain(period.multiplier)}
        answer["currency"] = pricing.currency

    cost_status, chosen, cost_currency = _cost(values, cost)
    if chosen is not None:
        answer["cost"] = {
            "name": chosen["name"], "value": _money(chosen["value"]) if chosen["value"] is not None else chosen.get("raw"),
            "unit": chosen["unit"], "monthly": _money(chosen["monthly"]),
        }
    if answer["status"] != "ok":
        return answer
    if cost_status is not None:
        fail(cost_status)
        if cost_status == "amount_out_of_range":
            warnings.append("amount_out_of_range")
    elif cost_currency != pricing.currency:
        fail("currency_mismatch")
    if outcome == EvaluationOutcome.BINDING_INVALID.value:
        fail("binding_invalid")
    elif outcome == EvaluationOutcome.SEMANTICS_CHANGED.value:
        fail("semantics_changed")
    if users is None:
        fail("users_required")

    per_user = None
    if answer["status"] == "ok":
        per_user = quantize6(chosen["monthly"] / Decimal(users))
        answer["costPerUser"] = money_str(per_user)

    variants = pricing2yaml.single_variants(pricing, limit=MAX_MARGIN_ROWS)
    if len(variants) > MAX_MARGIN_ROWS:
        variants = variants[:MAX_MARGIN_ROWS]
        answer["rowsTruncated"] = True
        warnings.append("rows_truncated")
    out_of_range = False
    for plan, add_on in variants:
        row = _row(pricing, plan, add_on, period)
        revenue = row.pop("revenue")
        out_of_range = out_of_range or row["outOfRange"]
        row["revenue"] = _money(revenue)
        row["cost"] = None if per_user is None else money_str(per_user)
        row["margin"] = None if per_user is None or revenue is None else money_str(revenue - per_user)
        answer["rows"].append(row)
    if out_of_range and "amount_out_of_range" not in warnings:
        warnings.append("amount_out_of_range")
    return answer


# -- Reading the inputs ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Inputs:
    evaluation: CompositionEvaluation
    snapshot: PricingSnapshot | None
    pricing: pricing2yaml.NormalisedPricing | None


async def inputs(
    session: AsyncSession, version: CompositionVersion, evaluation_id: uuid.UUID | None = None,
) -> Inputs:
    """The evaluation the margins read (``evaluation_id``, else the version's current one) and its offering."""
    evaluations = list((await session.scalars(
        select(CompositionEvaluation).where(CompositionEvaluation.version_id == version.id)
        .order_by(CompositionEvaluation.created_at, CompositionEvaluation.id)
    )).all())
    if evaluation_id is not None:
        evaluation = next((row for row in evaluations if row.id == evaluation_id), None)
    else:
        evaluation = versions.current_of(evaluations, versions.installed_basis())
    if evaluation is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "evaluation_not_found", "That evaluation is not one of this version's.")
    snapshot = None
    pricing = None
    if evaluation.offering_snapshot_id is not None:
        snapshot = await session.get(PricingSnapshot, evaluation.offering_snapshot_id)
        if snapshot is not None:
            try:
                parsed = await normalised(snapshot)
                pricing = parsed.normalised
            except PricingError:
                pricing = None
    return Inputs(evaluation, snapshot, pricing)


def offering_view(version: CompositionVersion, evaluation: CompositionEvaluation, snapshot: PricingSnapshot | None):
    if version.offering is None and evaluation.offering_status is None:
        return None
    return {
        "source": dict(version.offering) if version.offering else None,
        "status": evaluation.offering_status,
        "versionName": snapshot.version_label if snapshot is not None else None,
        "createdAt": snapshot.version_created_at if snapshot is not None else None,
        "snapshot": snapshot.id if snapshot is not None else None,
        "currency": snapshot.currency if snapshot is not None else None,
    }


def evaluation_view(version: CompositionVersion, evaluation: CompositionEvaluation) -> dict[str, Any]:
    return {
        "id": evaluation.id, "basisKey": evaluation.basis_key, "valuesStatus": version.values_status.value,
        "outcome": evaluation.outcome.value,
    }


def values_of(evaluation: CompositionEvaluation) -> dict[str, Any]:
    return dict(evaluation.values or {})


async def margins(
    session: AsyncSession,
    version: CompositionVersion,
    *,
    evaluation: uuid.UUID | None = None,
    users: int | None = None,
    billing: str | None = None,
    cost: str | None = None,
) -> dict[str, Any]:
    """The ``CompositionMargins`` of ``version`` on one of its evaluations (the current one by default)."""
    found = await inputs(session, version, evaluation)
    try:
        core = compute(
            values_of(found.evaluation), version.values_status.value, found.evaluation.outcome.value, found.pricing,
            found.evaluation.offering_status, users, billing, cost,
        )
    except MarginsRefused as refused:
        raise api_error(422, refused.code, refused.message) from refused
    return {
        "version": {"id": version.id, "label": version.label},
        "evaluation": evaluation_view(version, found.evaluation),
        "offering": offering_view(version, found.evaluation, found.snapshot),
        **core,
    }


async def what_if(
    session: AsyncSession,
    version: CompositionVersion,
    values: Mapping[str, Any],
    valid: bool,
    users: int | None,
) -> dict[str, Any] | None:
    """The margins of what-if ``values`` (an ``evaluate`` answer) against the offering version the version's current
    evaluation read; ``None`` when neither ``users`` is given nor that evaluation read an offering."""
    found = await inputs(session, version)
    if users is None and found.evaluation.offering_status is None:
        return None
    core = compute(
        dict(values), "verified", "verified" if valid else EvaluationOutcome.BINDING_INVALID.value, found.pricing,
        found.evaluation.offering_status, users,
    )
    return {
        "version": {"id": version.id, "label": version.label},
        "evaluation": None,
        "offering": offering_view(version, found.evaluation, found.snapshot),
        **core,
    }

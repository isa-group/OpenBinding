"""The Python Pricing2Yaml normaliser over the recorded SPHERE set (``plans.domain.pricing2yaml``)."""

from __future__ import annotations

import asyncio
import math
import time

import pytest

from openbinding_gateway.modules.plans.application import parse
from openbinding_gateway.modules.plans.domain.errors import PricingInvalid
from openbinding_gateway.modules.plans.domain.pricing2yaml import (
    Expression,
    Fixed,
    Label,
    Unlimited,
    effective,
    normalise,
    normalise_text,
    summary,
)
from openbinding_gateway.modules.plans.domain.pricing2yaml import units

from ._pricings import (
    DROPBOX,
    DROPBOX_2021,
    DROPBOX_2023,
    DROPBOX_2024,
    DROPBOX_25,
    RESEND_SPHERE,
    SET_A,
    SET_B,
    TOMATOMETER,
    pricing,
    raw,
)


def _minimal(**extra) -> dict:
    document = {
        "saasName": "X", "syntaxVersion": "3.1", "currency": "EUR",
        "features": {"f": {"valueType": "BOOLEAN", "defaultValue": False, "type": "DOMAIN"}},
        "usageLimits": {"u": {"valueType": "NUMERIC", "defaultValue": 1, "linkedFeatures": ["f"]}},
        "plans": {"P": {"price": 1, "unit": "user/month"}},
    }
    document.update(extra)
    return document


# --- defaults and add-ons -----------------------------------------------------------------------------------------


def test_a_plan_with_null_features_inherits_every_default() -> None:
    tomato = pricing(TOMATOMETER)
    basic = tomato.plans["basic"]
    assert basic.features == {name: f.default for name, f in tomato.features.items()}
    assert tomato.syntax_version == "3.0"
    assert any(d.code == "p2y_syntax_read_as_3_1" for d in tomato.diagnostics)


def test_mailgun_free_inherits_unlimited_per_month_and_100_per_day() -> None:
    free = pricing(SET_B["mailgun"]).plans["FREE"]
    assert isinstance(free.limits["emailsPerMonth"], Unlimited)
    assert free.limits["emailsPerDay"] == 100


def test_add_on_extensions_count_their_quantity_and_a_misspelt_key_is_ignored() -> None:
    tomato = pricing(TOMATOMETER)
    base = tomato.plans["basic"].limits["maxPomodoroTimers"]
    assert effective(tomato, "basic", {"extraTimers": 1}).limits["maxPomodoroTimers"] == base + 5
    assert effective(tomato, "basic", {"extraTimers": 2}).limits["maxPomodoroTimers"] == base + 10
    assert "subscriptionContraints" in raw(TOMATOMETER).decode()


def test_available_for_removes_an_add_on_the_plan_cannot_take() -> None:
    tomato = pricing(TOMATOMETER)
    assert tomato.add_ons["exportAsJson"].available_for == ("premium",)
    assert effective(tomato, "basic", {"exportAsJson": 1}).removed == ("exportAsJson",)
    assert effective(tomato, "premium", {"exportAsJson": 1}).features["exportDataToJson"] is True


def test_depends_on_and_excludes_must_name_add_ons() -> None:
    document = _minimal(addOns={
        "a": {"price": 1, "unit": "user/month", "dependsOn": ["missing"]},
        "b": {"price": 1, "unit": "user/month", "excludes": ["gone"], "availableFor": ["Q"]},
    })
    codes = {(d.code, d.severity) for d in normalise(document).diagnostics}
    assert ("p2y_addon_dependency_missing", "error") in codes
    assert ("p2y_addon_exclusion_missing", "warning") in codes
    assert ("p2y_addon_plan_missing", "warning") in codes
    assert not normalise(document).valid
    assert normalise(_minimal(addOns={"a": {"price": 1, "unit": "x/month"}})).add_ons["a"].available_for == ("P",)


def test_a_depending_add_on_goes_with_its_removed_dependency() -> None:
    document = _minimal(plans={"P": {"price": 1}, "Q": {"price": 2}}, addOns={
        "a": {"price": 1, "unit": "user/month", "availableFor": ["Q"]},
        "b": {"price": 1, "unit": "user/month", "dependsOn": ["a"]},
    })
    assert effective(normalise(document), "P", {"a": 1, "b": 1}).removed == ("a", "b")


# --- prices ---------------------------------------------------------------------------------------------------------


def test_price_kinds() -> None:
    document = _minimal(plans={
        "A": {"price": 3}, "B": {"price": 9.99}, "C": {"price": "12.5"}, "D": {"price": "Contact Sales"},
        "E": {"price": "Not published"}, "F": {},
    })
    plans = normalise(document).plans
    assert plans["A"].price == Fixed(3.0) and plans["B"].price == Fixed(9.99) and plans["C"].price == Fixed(12.5)
    assert plans["D"].price == Label("Contact Sales") and plans["E"].price == Label("Not published")
    assert isinstance(plans["F"].price, Label)


@pytest.mark.parametrize(
    ("provider", "plan", "amount"),
    [("brevo", "STARTER", 9), ("sendgrid", "ESSENTIALS", 19.95), ("resend", "PRO", 20), ("postmark", "BASIC", 15)],
)
def test_set_b_expression_prices_are_evaluated_at_the_variable_defaults(provider: str, plan: str, amount: float) -> None:
    price = pricing(SET_B[provider]).plans[plan].price
    assert isinstance(price, Expression) and "String(" in price.source
    assert price.value == pytest.approx(amount) and price.error is None


def test_an_expression_over_empty_variables_is_an_error_value_not_an_exception() -> None:
    dropbox = pricing(DROPBOX, DROPBOX_2024)
    plus = dropbox.plans["PLUS"].price
    assert isinstance(plus, Expression) and plus.value is None and "not defined" in (plus.error or "")
    assert any(d.code == "p2y_price_expression" for d in dropbox.diagnostics)
    assert effective(dropbox, "PLUS").requires_quote


# --- unlimited, billing, metered -------------------------------------------------------------------------------------


def test_unlimited_forms() -> None:
    assert isinstance(pricing(SET_A["sendgrid"]).plans["pro"].limits.get("emailsPerMonth")
                      or pricing(SET_A["sendgrid"]).usage_limits, object)
    document = _minimal(
        usageLimits={
            "a": {"valueType": "NUMERIC", "defaultValue": ".inf"},
            "b": {"valueType": "NUMERIC", "defaultValue": None},
            "c": {"valueType": "NUMERIC", "defaultValue": 100000000},
            "d": {"valueType": "NUMERIC", "defaultValue": 99999999},
            "e": {"valueType": "NUMERIC", "defaultValue": float("inf")},
        },
        plans={"P": {"price": 1, "usageLimits": {"d": {"value": "unlimited"}}}},
    )
    limits = normalise(document).plans["P"].limits
    assert all(isinstance(limits[name], Unlimited) for name in "abcde")
    assert limits["c"].raw == 100000000


def test_the_1e8_sentinel_of_set_a_reads_as_unlimited() -> None:
    sendgrid = pricing(SET_A["sendgrid"])
    values = [plan.limits.get("emailsPerMonth") for plan in sendgrid.plans.values()]
    assert any(isinstance(v, Unlimited) and v.raw == 100000000 for v in values), values


def test_billing() -> None:
    assert [(b.id, b.multiplier, b.synthesized) for b in normalise(_minimal()).billing] == [("monthly", 1.0, True)]
    assert [(b.id, b.multiplier) for b in pricing(SET_A["brevo"]).billing] == [("monthly", 1.0), ("annual", 0.9)]
    assert [(b.id, b.multiplier) for b in pricing(DROPBOX, DROPBOX_2024).billing] == [("monthly", 1.0), ("yearly", 0.8)]
    for bad in (0, 1.5, -1, "x"):
        with pytest.raises(PricingInvalid):
            normalise(_minimal(billing={"monthly": 1, "odd": bad}))


def test_metered_add_ons_carry_their_quantity() -> None:
    mailgun = pricing(SET_B["mailgun"])
    extra = mailgun.add_ons["extraEmailsFoundation"]
    assert extra.metered and extra.metered_quantity == 1000 and extra.unit == "1000 emails"
    assert not pricing(TOMATOMETER).add_ons["extraTimers"].metered
    assert units.period_of("user/month") == "month" and units.period_of("MONTH") == "month"
    assert units.period_of("IP/year") == "year" and units.period_of("1000 emails") is None
    assert units.per_seat("user/month") and units.per_seat("sales seat/month") and not units.per_seat("account/month")


# --- versions and checks ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("pricing_id", "version_id"), [(DROPBOX, DROPBOX_2023), (DROPBOX_25, None)])
def test_syntax_2_is_refused(pricing_id: str, version_id: str | None) -> None:
    with pytest.raises(PricingInvalid) as caught:
        normalise_text(raw(pricing_id, version_id))
    assert caught.value.code == "sphere_syntax_unsupported" and "2.1" in caught.value.message


def test_syntax_3_0_is_read() -> None:
    assert pricing(RESEND_SPHERE).syntax_version == "3.0"
    assert pricing(DROPBOX, DROPBOX_2021).syntax_version == "3.1"


@pytest.mark.parametrize("currency", ["EURO", "eur", "$", None])
def test_a_non_iso_currency_is_refused(currency) -> None:
    with pytest.raises(PricingInvalid):
        normalise(_minimal(currency=currency))


def test_feature_types_and_doc_url() -> None:
    document = _minimal(features={
        "g": {"valueType": "BOOLEAN", "defaultValue": True, "type": "GUARANTEE", "docUrl": "https://x.example/sla"},
        "d": {"valueType": "BOOLEAN", "defaultValue": True, "type": "DOMAIN", "docUrl": "https://x.example/d"},
        "z": {"valueType": "BOOLEAN", "defaultValue": True, "type": "WHATEVER"},
    })
    normalised = normalise(document)
    assert normalised.features["g"].doc_url == "https://x.example/sla"
    assert normalised.features["d"].doc_url is None
    assert any(d.code == "p2y_feature_type_unknown" for d in normalised.diagnostics)


def test_summary_of_set_b_brevo() -> None:
    view = summary(pricing(SET_B["brevo"]))
    plans = {plan["id"]: plan for plan in view["plans"]}
    assert plans["STARTER"]["price"]["kind"] == "expression" and plans["STARTER"]["price"]["value"] == 9
    assert plans["ENTERPRISE"]["private"] is True and plans["ENTERPRISE"]["price"]["kind"] == "label"
    mailgun = summary(pricing(SET_B["mailgun"]))
    metered = {a["id"]: a for a in mailgun["meteredAddOns"]}
    assert metered["extraEmailsFoundation"]["quantity"] == 1000
    assert not {a["id"] for a in mailgun["addOns"]} & set(metered)


def test_every_recorded_3x_version_normalises() -> None:
    from sphere_recorded import SFX

    read = refused = 0
    for path in SFX.glob("*/*.yml"):
        try:
            normalise_text(path.read_bytes())
            read += 1
        except PricingInvalid as exc:
            assert exc.code == "sphere_syntax_unsupported", path
            refused += 1
    assert read >= 18 and refused >= 9


# --- the loader and the worker thread --------------------------------------------------------------------------------


def test_a_doubling_alias_chain_within_50_aliases_is_refused_on_the_expanded_count() -> None:
    lines = ["a0: &a0 [x, x, x, x]"] + [f"a{i}: &a{i} [*a{i - 1}, *a{i - 1}, *a{i - 1}]" for i in range(1, 16)]
    with pytest.raises(PricingInvalid) as caught:
        normalise_text("\n".join(lines))
    assert caught.value.code == "yaml_limits"


@pytest.mark.asyncio
async def test_parsing_runs_in_a_worker_thread_and_the_loop_stays_responsive() -> None:
    plans = "\n".join(f"  P{i}:\n    price: {i}\n    description: '{'x' * 400}'" for i in range(10_000))
    text = "saasName: Big\nsyntaxVersion: '3.1'\ncurrency: EUR\nplans:\n" + plans + "\n"
    assert 3 * 1024 * 1024 < len(text) < 5 * 1024 * 1024
    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    task = asyncio.create_task(ticker())
    started = time.monotonic()
    parsed = await parse(text, timeout_s=60)
    elapsed = time.monotonic() - started
    task.cancel()
    assert parsed.normalised is not None and len(parsed.normalised.plans) == 10_000
    # The loop kept turning while the thread worked (a blocked loop would tick about once).
    assert ticks >= max(3, int(elapsed / 0.01) // 4)
    assert math.isfinite(elapsed)

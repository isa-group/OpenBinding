"""The margin goldens (``tests/golden/margins``): checked-in, reproduced offline, and the hand-computed numbers.

The TomatoMeter offering (``sphere/tomatometer`` 1.0.0) prices basic 0.00, advanced 3.99 and premium 9.99 per user
and month; extraTimers 1.00 a month (quantity 1..10) and exportAsJson 2.00 a month (premium only); no billing block.
"""

from __future__ import annotations

import json

import pytest

from _paths import GATEWAY_ROOT, gateway_tool

GOLDEN = GATEWAY_ROOT / "tests" / "golden" / "margins"
tool = gateway_tool("dump_margin_goldens")


def load(name: str) -> dict:
    return json.loads((GOLDEN / f"{name}.json").read_text())


def margins(name: str) -> dict[str, str | None]:
    return {"+".join([row["plan"], *row["addOns"]]): row["margin"] for row in load(name)["rows"]}


def test_the_checked_in_goldens_are_reproduced(capsys):
    assert tool.main(["--check"]) == 0


def test_check_detects_drift(tmp_path, monkeypatch):
    for path in GOLDEN.glob("*.json"):
        (tmp_path / path.name).write_text(path.read_text())
    (tmp_path / "brevo-dropbox.json").write_text("{}\n")
    monkeypatch.setattr(tool, "GOLDEN", tmp_path)
    monkeypatch.setattr(tool, "CASES", tmp_path / "cases.json")
    assert tool.main(["--check"]) == 1


@pytest.mark.parametrize(("case", "per_user", "expected"), [
    ("brevo-dropbox", "0.508990", {
        "basic": "-0.508990", "basic+extraTimers": "0.491010", "advanced": "3.481010",
        "advanced+extraTimers": "4.481010", "premium": "9.481010", "premium+extraTimers": "10.481010",
        "premium+exportAsJson": "11.481010",
    }),
    ("resend-dropbox", "0.029990", {
        "basic": "-0.029990", "basic+extraTimers": "0.970010", "advanced": "3.960010",
        "advanced+extraTimers": "4.960010", "premium": "9.960010", "premium+extraTimers": "10.960010",
        "premium+exportAsJson": "11.960010",
    }),
    ("mailgun-foundation", "0.035000", {
        "basic": "-0.035000", "basic+extraTimers": "0.965000", "advanced": "3.955000",
        "advanced+extraTimers": "4.955000", "premium": "9.955000", "premium+extraTimers": "10.955000",
        "premium+exportAsJson": "11.955000",
    }),
    ("users-three", "11.666667", {"basic": "-11.666667", "advanced": "-7.676667", "premium": "-1.676667"}),
])
def test_the_hand_computed_margins(case, per_user, expected):
    answer = load(case)
    assert answer["status"] == "ok" and answer["apportionment"] == "uniform" and answer["currency"] == "USD"
    assert answer["costPerUser"] == per_user
    found = margins(case)
    for key, value in expected.items():
        assert found[key] == value, key
    # The numbers shown always subtract exactly.
    from decimal import Decimal

    for row in answer["rows"]:
        assert Decimal(row["revenue"]) - Decimal(row["cost"]) == Decimal(row["margin"])


def test_the_month_factor_and_float_noise():
    assert load("float-noise")["cost"]["monthly"] == "29.990000"
    assert load("yearly")["cost"]["monthly"] == "20.000000"
    assert load("weekly")["cost"]["monthly"] == "30.333333"


@pytest.mark.parametrize(("case", "status", "rows"), [
    ("users-required", "users_required", 7),
    ("order-desk-unreadable", "offering_unreadable", 0),
    ("currency-mismatch", "currency_mismatch", 7),
    ("no-cost-value", "no_cost_value", 7),
    ("ambiguous-cost", "ambiguous_cost", 7),
    ("binding-invalid", "binding_invalid", 7),
    ("no-offering", "no_offering", 0),
    ("semantics-changed", "semantics_changed", 7),
    ("cost-infinite", "amount_out_of_range", 7),
])
def test_the_statuses_that_give_no_margin(case, status, rows):
    answer = load(case)
    assert answer["status"] == status
    assert len(answer["rows"]) == rows
    assert all(row["margin"] is None and row["revenue"] is not None for row in answer["rows"])
    assert answer["costPerUser"] is None


def test_declared_values_are_said():
    answer = load("declared")
    assert answer["status"] == "ok" and answer["warnings"] == ["declared_values"]
    assert load("order-desk-unreadable")["warnings"] == ["declared_values"]


def test_hostile_offerings_never_raise():
    priced = load("price-1e30")
    assert priced["status"] == "ok" and priced["warnings"] == ["amount_out_of_range"]
    premium = [row for row in priced["rows"] if row["plan"] == "premium"]
    assert premium and all(row["outOfRange"] and row["revenue"] is None and row["margin"] is None for row in premium)
    assert margins("price-1e30")["advanced"] == "3.955000"
    huge = load("huge-addon-quantity")
    timers = [row for row in huge["rows"] if row["addOns"] == ["extraTimers"]]
    assert len(timers) == 3 and all(row["outOfRange"] for row in timers)
    wide = load("many-variants")
    assert len(wide["rows"]) == 200 and wide["rowsTruncated"] and "rows_truncated" in wide["warnings"]
    assert [row["plan"] for row in wide["rows"][:2]] == ["p000", "p000"]


def test_an_annual_billing_and_seats():
    answer = load("brevo-offering-annual")
    assert answer["billing"] == {"id": "annual", "multiplier": "0.9"}
    rows = {"+".join([row["plan"], *row["addOns"]]): row for row in answer["rows"]}
    assert rows["STARTER"]["revenue"] == "8.100000" and rows["STARTER"]["basis"] == "subscription"
    assert rows["PROFESSIONAL"]["revenue"] == "449.100000"
    assert rows["ENTERPRISE"]["private"] and rows["ENTERPRISE"]["requiresQuote"] and rows["ENTERPRISE"]["revenue"] is None
    assert rows["STARTER+salesEssentials"]["basis"] == "seat"


def test_a_part_without_a_period_is_left_out_and_named():
    from openbinding_gateway.modules.compositions.application.margins import compute
    from openbinding_gateway.modules.plans.domain.pricing2yaml import normalise

    pricing = normalise({
        "syntaxVersion": "3.0", "saasName": "Setup", "version": "1", "createdAt": "2026-01-01", "currency": "USD",
        "features": {"f": {"valueType": "BOOLEAN", "defaultValue": True, "type": "DOMAIN"}},
        "plans": {"once": {"price": 100, "unit": "installation", "features": None},
                  "monthly": {"price": 10, "unit": "/month", "features": None}},
    })
    answer = compute({"subscription": {"value": 4, "unit": "USD/month"}}, "verified", "verified", pricing, "read", 2)
    rows = {row["plan"]: row for row in answer["rows"]}
    assert rows["once"]["excludedParts"] == ["once"] and rows["once"]["revenue"] == "0.000000"
    assert rows["monthly"]["excludedParts"] == [] and rows["monthly"]["margin"] == "8.000000"

"""``compare_selections``: one selection compared across two versions, as pricing-renderer's ``compareSelections``."""

from __future__ import annotations

from openbinding_gateway.modules.plans.application import Selection, compare_selections, identical_plan
from openbinding_gateway.modules.plans.domain.pricing2yaml import NormalisedPricing, normalise_text
from sphere_recorded import SFX

from ._pricings import DROPBOX, DROPBOX_2021, DROPBOX_2024, SET_B, pricing, raw

BREVO = SET_B["brevo"]
BREVO_2026_10 = "6ade2d444b2b5b01c587d80d"


def brevo(*edits: tuple[str, str]) -> NormalisedPricing:
    text = raw(BREVO, BREVO_2026_10).decode()
    for old, new in edits:
        assert old in text, old
        text = text.replace(old, new, 1)
    return normalise_text(text.encode())


def _scenario(name: str) -> NormalisedPricing:
    path = SFX / "derived" / f"{name}.yml"
    return normalise_text(path.read_bytes())


PROFESSIONAL = Selection.of("PROFESSIONAL")


def test_the_synthetic_mailgun_pair() -> None:
    old = pricing(SET_B["mailgun"], "6ade36454b2b5b01c587db3d")
    new = _scenario("mailgun-scale")
    scale = compare_selections(old, new, Selection.of("SCALE"))
    assert [change["id"] for change in scale.usage_limits] == ["emailsPerMonth"]
    assert not scale.empty
    foundation = compare_selections(old, new, Selection.of("FOUNDATION"))
    assert foundation.empty


def test_dropbox_plus_2021_to_2024() -> None:
    comparison = compare_selections(pricing(DROPBOX, DROPBOX_2021), pricing(DROPBOX, DROPBOX_2024), Selection.of("PLUS"))
    assert comparison.plan["before"]["known"] and comparison.plan["after"]["known"]
    assert not comparison.empty


def test_a_professional_price_raise() -> None:
    old = pricing(BREVO, BREVO_2026_10)
    new = brevo(("'150000': 499", "'150000': 549"))
    comparison = compare_selections(old, new, PROFESSIONAL)
    price = comparison.price
    assert (price["before"]["subtotal"], price["after"]["subtotal"], price["difference"]) == (
        "499.000000", "549.000000", "50.000000",
    )
    assert price["before"]["unit"] == "USD/month"
    assert not comparison.empty
    assert compare_selections(old, new, Selection.of("STARTER")).empty


def test_annual_billing_applies_the_multiplier() -> None:
    old = pricing(BREVO, BREVO_2026_10)
    new = brevo(("'150000': 499", "'150000': 549"))
    comparison = compare_selections(old, new, Selection.of("PROFESSIONAL", billing="annual"))
    assert comparison.price["before"]["subtotal"] == "449.100000"
    assert comparison.price["difference"] == "45.000000"


def test_seats_multiply_a_per_seat_add_on() -> None:
    old = pricing(BREVO, BREVO_2026_10)
    new = brevo(("    price: 31\n    unit: sales seat/month", "    price: 33\n    unit: sales seat/month"))
    one = compare_selections(old, new, Selection.of("PROFESSIONAL", ["salesEssentials"]))
    three = compare_selections(old, new, Selection.of("PROFESSIONAL", ["salesEssentials"], seats=3))
    assert one.price["difference"] == "2.000000" and three.price["difference"] == "6.000000"


def test_a_retired_plan_is_not_known() -> None:
    old = pricing(BREVO, BREVO_2026_10)
    new = brevo(("  PROFESSIONAL:\n    description:", "  PROFESSIONAL_GONE:\n    description:"))
    comparison = compare_selections(old, new, PROFESSIONAL)
    assert comparison.plan["after"]["known"] is False and comparison.price["differenceOmitted"] == "plan"
    assert comparison.catalog["onlyInBefore"]["plans"] == ["PROFESSIONAL"]
    assert comparison.catalog["onlyInAfter"]["plans"] == ["PROFESSIONAL_GONE"]
    assert identical_plan("PROFESSIONAL", "PROFESSIONAL_GONE", old, new) is False  # no add-on follows the rename


def test_add_on_reconciliation_reasons() -> None:
    old = pricing(BREVO, BREVO_2026_10)
    new = brevo(
        ("  dedicatedIpAddOn:\n", "  dedicatedIpAddOnGone:\n"),
        ("    price: 324\n    unit: account/month\n    availableFor:\n      - PROFESSIONAL",
         "    price: 324\n    unit: account/month\n    availableFor:\n      - STARTER"),
    )
    comparison = compare_selections(old, new, Selection.of("PROFESSIONAL", ["dedicatedIpAddOn", "samlSso"]))
    reasons = {item["id"]: item["reason"] for item in comparison.add_ons["removedByReconciliation"]}
    assert reasons == {"dedicatedIpAddOn": "not-in-version", "samlSso": "unavailable-for-plan"}
    assert {f["id"] for f in comparison.features["lost"]} >= {"dedicatedIp", "ssoSaml"}


def test_a_quote_or_another_currency_omits_the_difference() -> None:
    old = pricing(BREVO, BREVO_2026_10)
    quote = brevo(("    price: '#professionalPrices[String(#professionalVolume)]'", "    price: Contact sales"))
    assert compare_selections(old, quote, PROFESSIONAL).price["differenceOmitted"] == "quote"
    euros = brevo(("currency: USD", "currency: EUR"))
    assert compare_selections(old, euros, PROFESSIONAL).price["differenceOmitted"] == "currency"


def test_unlimited_on_both_sides_is_unchanged_and_the_sentinel_is_listed() -> None:
    old = brevo(("  PROFESSIONAL:", "  PROFESSIONAL:"))
    same = compare_selections(old, old, PROFESSIONAL)
    assert same.empty and same.sentinel == ()
    big = brevo(("  emailsPerDay:\n    description: Daily email sending cap.\n    valueType: NUMERIC\n    defaultValue: 300",
                 "  emailsPerDay:\n    description: Daily email sending cap.\n    valueType: NUMERIC\n"
                 "    defaultValue: 100000000"))
    bigger = brevo(("  emailsPerDay:\n    description: Daily email sending cap.\n    valueType: NUMERIC\n    defaultValue: 300",
                    "  emailsPerDay:\n    description: Daily email sending cap.\n    valueType: NUMERIC\n"
                    "    defaultValue: 200000000"))
    comparison = compare_selections(big, bigger, Selection.of("FREE"))
    assert comparison.empty and comparison.sentinel == ("emailsPerDay",)


def test_a_limit_change_has_a_direction_and_a_delta() -> None:
    old = pricing(BREVO, BREVO_2026_10)
    new = brevo(("    usageLimits:\n      emailsPerDay:\n        value: .inf\n      emailsPerMonth:\n        value: 5000",
                 "    usageLimits:\n      emailsPerDay:\n        value: .inf\n      emailsPerMonth:\n        value: 6000"))
    comparison = compare_selections(old, new, Selection.of("STARTER"))
    (change,) = comparison.usage_limits
    assert (change["id"], change["direction"], change["delta"]) == ("emailsPerMonth", "increased", "1000")

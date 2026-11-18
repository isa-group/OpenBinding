"""The facts carry value sources, candidate properties and provenance next to the package locations, from plain
mappings (the composition library reads no table); a draft has none."""

from __future__ import annotations

from functools import cache
from typing import Any

from _paths import gateway_tool
from openbinding_gateway.composition.facts import facts_view
from openbinding_gateway.integrations import bim

tool = gateway_tool("dump_sphere_goldens")


@cache
def _compiled() -> dict[str, Any]:
    result = tool.Runner().generated("tomatometer-email")
    return bim.build_bim().compile(result.archive())


def _facts(**extra: Any) -> dict[str, Any]:
    compiled = _compiled()
    return facts_view(compiled["ir"], compiled.get("sourceMap"), {"bindingSpace": "1"}, ir_digest=compiled["irDigest"],
                      **extra)


def _candidate(facts: dict[str, Any], key: str) -> dict[str, Any]:
    return next(c for c in facts["candidates"] if c["key"] == key)


def test_a_draft_has_properties_with_package_origins_and_no_sources():
    facts = _facts()
    mailgun = _candidate(facts, "sphere-email/email.mailgun.free")
    assert mailgun["properties"] == {"emailsPerDay": 100, "emailsPerMonth": 100000000}
    assert mailgun["propertyOrigins"]["emailsPerDay"] == {
        "kind": "package", "resource": "sphere-email", "path": "sphere-email.json",
        "pointer": "/spec/candidates/email.mailgun.free/properties/emailsPerDay", "source": None,
    }
    assert mailgun["origins"]["subscription"]["source"] is None
    assert mailgun["provenance"] is None
    assert _candidate(facts, "catalog/auth.builtin.local")["properties"] == {}


def test_sources_merge_next_to_the_package_location():
    key = "sphere-email/email.mailgun.free"
    priced = {"kind": "priced", "pricing": {"plan": "FREE"}, "detail": {"formula": "FREE 0 x 1 (monthly)"},
              "carried": False}
    limit = {"kind": "limit", "pricing": {"plan": "FREE"}, "detail": {"raw": 100}, "carried": True}
    provenance = {"sphere": "danruilop1/mailgun", "version": "6ade36454b2b5b01c587db3d", "plan": "FREE"}
    facts = _facts(
        sources={(key, "feature", "subscription"): priced, (key, "property", "emailsPerDay"): limit},
        provenance={key: provenance},
    )
    candidate = _candidate(facts, key)
    assert candidate["origins"]["subscription"]["source"] == priced
    assert candidate["origins"]["subscription"]["pointer"].endswith("/features/subscription")
    assert candidate["propertyOrigins"]["emailsPerDay"]["source"] == limit
    assert candidate["propertyOrigins"]["emailsPerMonth"]["source"] is None
    assert candidate["provenance"] == provenance
    assert candidate["values"]["subscription"] == 0
    other = _candidate(facts, "sphere-email/email.mailgun.basic")
    assert other["provenance"] is None and other["origins"]["subscription"]["source"] is None

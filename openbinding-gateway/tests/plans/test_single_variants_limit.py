"""``single_variants(limit=)`` stops early in declared order (margins cap their rows on it)."""

from __future__ import annotations

from openbinding_gateway.modules.plans.domain.pricing2yaml import normalise, single_variants


def _wide(plans: int, add_ons: int):
    doc = {
        "syntaxVersion": "3.0",
        "saasName": "Wide",
        "version": "1",
        "createdAt": "2026-01-01",
        "currency": "USD",
        "features": {"f": {"valueType": "BOOLEAN", "defaultValue": True, "type": "DOMAIN"}},
        "plans": {f"p{i:03d}": {"price": i, "unit": "user/month", "features": None} for i in range(plans)},
        "addOns": {
            f"a{j:03d}": {"price": 1, "unit": "/month", "availableFor": [f"p{i:03d}" for i in range(plans)]}
            for j in range(add_ons)
        },
    }
    return normalise(doc)


def test_limit_stops_at_limit_plus_one_in_declared_order():
    pricing = _wide(300, 300)
    variants = single_variants(pricing, limit=200)
    assert len(variants) == 201
    assert variants[0] == ("p000", None)
    assert variants[1] == ("p000", "a000")
    assert variants[200] == ("p000", "a199")


def test_no_limit_is_unchanged():
    pricing = _wide(3, 2)
    assert single_variants(pricing) == [
        ("p000", None), ("p000", "a000"), ("p000", "a001"),
        ("p001", None), ("p001", "a000"), ("p001", "a001"),
        ("p002", None), ("p002", "a000"), ("p002", "a001"),
    ]
    assert single_variants(pricing, limit=100) == single_variants(pricing)
    assert single_variants(pricing, limit=0) == [("p000", None)]

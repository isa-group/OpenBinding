"""Pricing2Yaml editor snippets adapted from SPHERE PR #143."""

from openbinding_gateway.routes.pricing import pricing_templates


async def test_pricing_templates_cover_each_editable_catalog_section() -> None:
    templates = (await pricing_templates())["templates"]

    assert {template["section"] for template in templates} == {
        "features",
        "usageLimits",
        "plans",
        "addOns",
    }
    assert len({template["id"] for template in templates}) == len(templates)
    assert all(template["body"].strip() for template in templates)

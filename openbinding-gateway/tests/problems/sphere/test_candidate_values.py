"""``candidate_values``: one candidate judged with the generator's own functions (the F6 classifier's question).

For every candidate of every golden case the values equal the stored origins, and each refusal the generator can
make of one candidate has its code.
"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest

from _paths import gateway_tool
from openbinding_gateway.modules.plans.application import pricing2yaml as p2y
from openbinding_gateway.modules.problems.application import candidate_values
from openbinding_gateway.modules.problems.domain.sphere.recipe import parse_recipe

tool = gateway_tool("dump_sphere_goldens")
RUNNER = tool.Runner()
CASES = [
    case["name"] for case in RUNNER.document["cases"]
    if (tool.DEFAULT_OUT / f"{case['name']}.origins.json").is_file()
]
BREVO = ("6ade2d4440e55445692b07f1", "6ade2d444b2b5b01c587d80d")


def _sources(case):
    """``candidateKey`` prefix -> (task, source, meta, pricing) for every SPHERE source of the case."""
    out = []
    for task in case.recipe.tasks:
        for source in task.sources:
            if source.sphere is None:
                continue
            read = case.sources.get(source.sphere.key)
            if read is None or read.pricing is None:
                continue
            out.append((task, source, read.meta, read.pricing))
    return out


@pytest.mark.parametrize("name", CASES)
def test_every_golden_candidate_has_its_stored_values(name):
    case = RUNNER.load(name)
    origins = json.loads((tool.DEFAULT_OUT / f"{name}.origins.json").read_text())
    features = {o["target"] for o in origins if o["targetKind"] == "feature"}
    by_candidate: dict[str, list[dict]] = {}
    for origin in origins:
        if origin["pricingId"] is not None:
            by_candidate.setdefault(origin["candidateKey"], []).append(origin)
    assert by_candidate
    for key, stored in by_candidate.items():
        first = stored[0]
        matches = [
            (task, source, meta, pricing) for task, source, meta, pricing in _sources(case)
            if source.sphere.pricing == first["pricingId"] and source.sphere.version == first["versionId"]
            and key.startswith(f"sphere-{task.service}/")
        ]
        assert matches, key
        task, source, meta, pricing = matches[0]
        judged = candidate_values(source, meta, task, case.recipe, pricing, first["plan"], first["addOns"],
                                  feature_targets=features)
        assert judged.eligible, (key, judged.reason)
        got = {target: (json.loads(json.dumps(tool_plain(value))), kind, json.loads(json.dumps(tool_plain(detail))))
               for target, (value, kind, detail) in judged.values.items()}
        want = {o["target"]: (o["value"], o["sourceKind"], o["detail"]) for o in stored}
        assert got == want, key


def tool_plain(value):
    from openbinding_gateway.modules.problems.application.sphere.candidate import _plain

    return _plain(value)


def _flagship():
    case = RUNNER.load("tomatometer-email")
    for task, source, meta, pricing in _sources(case):
        if (source.sphere.pricing, source.sphere.version) == BREVO:
            return case, task, source, meta, pricing
    raise AssertionError("no Brevo source")


def test_brevo_professional_matches_the_flagship_origins_and_requirements():
    case, task, source, meta, pricing = _flagship()
    judged = candidate_values(source, meta, task, case.recipe, pricing, "PROFESSIONAL")
    assert judged.eligible and judged.values["subscription"][0] == 499.0
    assert judged.values["subscription"][1] == "priced"
    requirements = RUNNER.generated("tomatometer-email").requirements
    stored = next(v for k, v in requirements.items() if k.endswith("email.brevo.professional"))
    assert list(judged.requirements) == stored


def _edited(pricing_text: str, old: str, new: str) -> p2y.NormalisedPricing:
    assert old in pricing_text
    return p2y.normalise_text(pricing_text.replace(old, new, 1).encode())


def _brevo_text() -> str:
    return (tool.SFX / BREVO[0] / f"{BREVO[1]}.yml").read_text()


def test_a_label_price_is_not_numeric():
    case, task, source, meta, _ = _flagship()
    pricing = _edited(_brevo_text(), "    price: '#professionalPrices[String(#professionalVolume)]'",
                      "    price: Contact sales")
    judged = candidate_values(source, meta, task, case.recipe, pricing, "PROFESSIONAL")
    assert (judged.eligible, judged.reason) == (False, "sphere_price_not_numeric")


def test_an_unevaluable_expression_is_refused():
    case, task, source, meta, _ = _flagship()
    pricing = _edited(_brevo_text(), "    price: '#professionalPrices[String(#professionalVolume)]'",
                      "    price: '#professionalPrices[String(#nowhere)]'")
    judged = candidate_values(source, meta, task, case.recipe, pricing, "PROFESSIONAL")
    assert (judged.eligible, judged.reason) == (False, "sphere_price_expression")


def test_a_private_plan_is_refused():
    case, task, source, meta, _ = _flagship()
    pricing = _edited(_brevo_text(), "  PROFESSIONAL:\n    description: Teams using data and AI across channels.",
                      "  PROFESSIONAL:\n    private: true\n    description: Teams using data and AI across channels.")
    judged = candidate_values(source, meta, task, case.recipe, pricing, "PROFESSIONAL")
    assert (judged.eligible, judged.reason) == (False, "sphere_plan_private")


def test_a_metered_add_on_is_never_a_variant():
    case, task, source, meta, _ = _flagship()
    pricing = _edited(_brevo_text(), "    price: 324\n    unit: account/month", "    price: 324\n    unit: 1000 emails")
    assert pricing.add_ons["samlSso"].metered
    judged = candidate_values(source, meta, task, case.recipe, pricing, "PROFESSIONAL", ["samlSso"])
    assert (judged.eligible, judged.reason) == (False, "sphere_addon_not_subscription")


def test_an_unmapped_property_is_refused():
    case, task, source, meta, pricing = _flagship()
    recipe_doc = RUNNER.recipe_document(RUNNER.by_name["tomatometer-email"])
    recipe, _ = parse_recipe(recipe_doc)
    renamed = replace(source, names={**source.names, "emailsPerDay": "noSuchLimit"}, assume={})
    judged = candidate_values(renamed, meta, task, recipe, pricing, "PROFESSIONAL")
    assert not judged.eligible and judged.reason in {"sphere_limit_unknown", "sphere_property_unmapped"}

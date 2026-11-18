"""The SPHERE package generator (``problems.application.sphere.generate``), pure: no toolchain, no database.

Every golden case of ``tests/golden/sphere/cases.json`` is regenerated and compared with its files (the package
as a JSON file map, the origins, the findings, the requirement explanations); the toolchain's view of them
(digest, facts) is ``test_generated_compile.py``'s.
"""

from __future__ import annotations

import json
import random
import re
from dataclasses import replace

import pytest

from _paths import gateway_tool
from openbinding_gateway.modules.plans.application import pricing2yaml as p2y
from openbinding_gateway.modules.problems.application.sphere import RECIPE_ANNOTATION, dump, generate
from openbinding_gateway.modules.problems.application.sphere.generate import nice
from openbinding_gateway.modules.problems.domain.sphere import ids
from openbinding_gateway.modules.problems.domain.sphere.recipe import parse_recipe, recipe_digest

tool = gateway_tool("dump_sphere_goldens")
RUNNER = tool.Runner()
CASES = [case["name"] for case in RUNNER.document["cases"]]
MAILGUN = ("6ade364540e55445692b0eda", "6ade36454b2b5b01c587db3d")
BREVO_B = ("6ade2d4440e55445692b07f1", "6ade2d444b2b5b01c587d80d")


def golden(name: str) -> dict[str, bytes]:
    return {
        path.name: path.read_bytes() for path in tool.DEFAULT_OUT.glob(f"{name}.*")
        if path.name.endswith((".files.json", ".origins.json", ".diagnostics.json", ".requirements.json"))
    }


@pytest.mark.parametrize("name", CASES)
def test_every_case_matches_its_golden(name):
    assert RUNNER.outputs(name, toolchain=False) == golden(name)


def test_the_flagship_case_is_what_the_design_expects():
    result = RUNNER.generated("tomatometer-email")
    eligible = sorted(c["id"] for c in result.candidates if c["eligible"])
    assert eligible == [
        "email.brevo.professional", "email.mailgun.foundation", "email.mailgun.scale", "email.resend.pro",
        "email.resend.scale", "email.sendgrid.essentials", "email.sendgrid.pro",
    ]
    written_but_not = {c["id"] for c in result.candidates if not c["eligible"]}
    assert {"email.mailgun.free", "email.brevo.starter", "email.brevo.standard", "email.postmark.basic"} <= written_but_not
    assert all(c["id"] not in {"email.mailgun.enterprise", "email.sendgrid.premier"} for c in result.candidates)
    # Metered overage add-ons never become variants.
    assert not any("extraemails" in c["id"] for c in result.candidates)
    codes = {(d.code, d.severity) for d in result.diagnostics}
    assert ("sphere_limit_assumed", "warning") in codes and ("sphere_plan_private", "info") in codes
    free = result.requirements["sphere-email/email.mailgun.free"]
    assert [t["text"] for t in free] == ["emailsPerDay: 100 < 1000", "emailsPerMonth: 100000000 >= 30000"]


def test_generation_is_deterministic_and_independent_of_order():
    case = RUNNER.load("tomatometer-email")
    first = generate(case.recipe, case.sources, case.base, name="tomatometer-email")
    again = generate(case.recipe, case.sources, case.base, name="tomatometer-email")
    assert first.files == again.files and first.origins == again.origins
    shuffled_sources = dict(random.Random(7).sample(list(case.sources.items()), len(case.sources)))
    document = json.loads(json.dumps(case.recipe.document))
    task = document["tasks"][0]
    task["properties"] = dict(reversed(list(task["properties"].items())))
    reordered, problems = parse_recipe({key: document[key] for key in reversed(list(document))})
    assert problems == []
    other = generate(reordered, shuffled_sources, dict(reversed(list(case.base.items()))), name="tomatometer-email")
    assert other.files == first.files
    assert other.origins == first.origins
    assert [d.as_dict() for d in other.diagnostics] == [d.as_dict() for d in first.diagnostics]


def test_candidate_keys_survive_a_new_version():
    real = RUNNER.generated("mailgun-real")
    changed = RUNNER.generated("mailgun-changed")
    assert {c["key"] for c in real.candidates} == {c["key"] for c in changed.candidates}
    catalog = json.loads(changed.files["instance.json"])["spec"]["resources"]["candidateCatalog"]
    assert catalog == {"sphere-email": "sphere-email.json"}
    scale = [o for o in changed.origins if o["candidateKey"].endswith("mailgun.scale") and o["target"] == "emailsPerMonth"]
    assert scale[0]["value"] == 101000 and scale[0]["versionId"] == "000000000000000000000001"
    assert not any(d.code == "sphere_candidate_removed" for d in changed.diagnostics)


def test_a_real_new_version_removes_candidates_and_keeps_shared_keys_identical():
    old = RUNNER.generated("dropbox-2021")
    new = RUNNER.generated("dropbox-2024")
    old_keys = {c["key"] for c in old.candidates}
    new_keys = {c["key"] for c in new.candidates}
    removed = {d.at for d in new.diagnostics if d.code == "sphere_candidate_removed"}
    assert removed == old_keys - new_keys and removed
    assert new_keys == {"sphere-storage/storage.dropbox.basic"}
    expressions = {d.at.rsplit(".", 1)[-1] for d in new.diagnostics if d.code == "sphere_price_expression"}
    assert expressions == {"plus", "essentials", "business", "business-plus"}
    assert any(d.code == "sphere_plan_private" and d.at.endswith("enterprise") for d in new.diagnostics)


def test_a_rename_gives_a_byte_identical_package():
    case = RUNNER.load("mailgun-real")
    key = (None, *MAILGUN)
    renamed = tool.read_source(tool.SFX / "derived" / "mailgun-renamed.yml", case.sources[key].meta)
    assert renamed.pricing.title != case.sources[key].pricing.title
    sources = dict(case.sources)
    sources[key] = renamed
    assert generate(case.recipe, sources, name="mailgun").files == RUNNER.generated("mailgun-real").files


@pytest.mark.parametrize("name", [n for n in CASES if not n.startswith("refused-")])
def test_no_digest_or_content_hash_in_a_package_and_the_recipe_is_annotated(name):
    result = RUNNER.generated(name)
    blob = b"".join(result.files.values()).decode()
    for meta in result.sources:
        assert meta.version_id not in blob and meta.pricing_id not in blob
    case = RUNNER.load(name)
    assert not re.search(r"[0-9a-f]{64}", blob.replace(result.recipe_digest, ""))
    instance = json.loads(result.files["instance.json"])
    assert instance["metadata"]["annotations"][RECIPE_ANNOTATION] == recipe_digest(case.recipe)


def test_priced_values_follow_the_formula():
    set_a = RUNNER.generated("email-set-a")
    brevo = [o for o in set_a.origins if o["candidateKey"].startswith("sphere-email/email.brevo.") and o["target"] == "subscription"]
    assert brevo and all(o["detail"]["billing"] == "annual" and o["detail"]["multiplier"] == 0.9 for o in brevo)
    starter = next(o for o in brevo if o["plan"] == "starter")
    assert starter["value"] == pytest.approx(9 * 0.9)
    seats = RUNNER.generated("tomatometer-plan-only")
    premium_json = next(o for o in seats.origins if o["candidateKey"].endswith("premium.exportasjson") and o["target"] == "subscription")
    assert premium_json["value"] == pytest.approx(9.99 * 3 + 2)
    assert premium_json["detail"]["parts"][0]["seats"] == 3 and premium_json["detail"]["parts"][1]["seats"] == 1


def test_a_yearly_add_on_is_divided_by_twelve():
    document = {
        "recipeVersion": "1", "currency": "USD",
        "features": {"subscription": {"unit": "USD/month", "direction": "minimize"}},
        "tasks": [{"task": "send", "capability": "service/email",
                   "from": [{"sphere": {"pricing": BREVO_B[0], "version": BREVO_B[1]}, "provider": "brevo",
                             "plans": ["PROFESSIONAL"], "addons": ["dedicatedIpAddOn"]}],
                   "properties": {"subscription": "price"}}],
    }
    recipe, problems = parse_recipe(document)
    assert problems == []
    result = generate(recipe, tool.recorded_sources(recipe), name="brevo")
    assert result.valid, [d.as_dict() for d in result.diagnostics]
    variant = next(o for o in result.origins if o["candidateKey"].endswith("professional.dedicatedipaddon"))
    assert variant["value"] == pytest.approx(499 + 251 / 12)
    assert variant["detail"]["parts"][1]["monthlyFactor"] == pytest.approx(1 / 12)


def test_unlimited_limits_are_the_sentinel_and_predicates_stay_small():
    result = RUNNER.generated("tomatometer-email")
    foundation = next(o for o in result.origins
                      if o["candidateKey"].endswith("mailgun.foundation") and o["target"] == "emailsPerDay")
    assert foundation["value"] == 100000000 and foundation["detail"]["unlimited"] is True
    assert result.predicates["dailySummary"] == (
        "candidate.properties.emailsPerDay >= 1000 && candidate.properties.emailsPerMonth >= 30000"
    )
    application = json.loads(result.files["application.json"])
    assert application["spec"]["tasks"]["dailySummary"]["requires"]["predicate"] == result.predicates["dailySummary"]
    assert all(len(p or "") <= 4096 for p in result.predicates.values())


def test_the_generator_keeps_what_it_does_not_own():
    result = RUNNER.generated("existing-package")
    base = RUNNER.load("existing-package").base
    for path in ("candidates.json", "constraints.json"):
        assert result.files[path] == base[path]
    application = json.loads(result.files["application.json"])
    assert application["spec"]["features"]["cost"]["domain"]["maximum"] == 500
    assert application["spec"]["tasks"]["t2"] == "service/t2"
    optimization = json.loads(result.files["optimization.json"])
    assert next(c for c in optimization["spec"]["criteria"] if c["id"] == "cost")["normalize"]["max"] == 500
    assert {d.code for d in result.diagnostics} >= {"sphere_rescaled"}


def test_ids_are_slugged_and_bounded():
    assert ids.slug("Business Plus (Yearly)") == "business-plus-yearly"
    assert ids.slug("Ünïcode Plan") == "unicode-plan"
    assert ids.candidate_id("email", "mailgun", "FOUNDATION") == "email.mailgun.foundation"
    assert ids.candidate_id("email", "mailgun", "SCALE", "Dedicated IP") == "email.mailgun.scale.dedicated-ip"
    assert ids.id_problem("email.mailgun." + "x" * 130) == "too_long"
    assert ids.id_problem("email.mailgun.") == "empty"
    assert ids.id_problem("email.mailgun.pro") is None


def test_an_id_over_128_characters_is_refused():
    case = RUNNER.load("mailgun-real")
    key = (None, *MAILGUN)
    pricing = case.sources[key].pricing
    long_name = "P" * 130
    plans = dict(pricing.plans)
    plans[long_name] = replace(plans["SCALE"], name=long_name)
    sources = {key: replace(case.sources[key], pricing=replace(pricing, plans=plans))}
    result = generate(case.recipe, sources, name="mailgun")
    assert [d.code for d in result.diagnostics if d.severity == "error"] == ["sphere_id_too_long"]
    assert result.files == {}


def test_nice_bounds():
    assert [nice(x) for x in (0, 0.3, 1, 1.2, 3, 7, 35, 90, 101, 499, 1000)] == [1, 0.5, 1, 2, 5, 10, 50, 100, 200, 500, 1000]


def test_the_file_map_is_canonical_json():
    result = RUNNER.generated("born-storage")
    for content in result.files.values():
        assert content == dump(json.loads(content))
        assert content.endswith(b"\n")
    assert p2y.Unlimited  # the normaliser's own view is what the generator reads

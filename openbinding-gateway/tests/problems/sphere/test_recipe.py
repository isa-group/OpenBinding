"""The SPHERE import recipe (``problems.domain.sphere.recipe``): validation, canonical form and pinning."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import jsonschema
import pytest

from openbinding_gateway.modules.problems.domain.sphere import recipe as r
from openbinding_gateway.modules.problems.domain.sphere.diagnostics import SEVERITIES, diagnostic

SCHEMA = json.loads(
    (Path(r.__file__).resolve().parents[2] / "resources" / "sphere-recipe" / "1" / "recipe.schema.json").read_text()
)
MAILGUN = {"pricing": "6ade364540e55445692b0eda", "version": "6ade36454b2b5b01c587db3d"}
RESEND = {"pricing": "6ade2d2540e55445692b07c6", "version": "6ade2d254b2b5b01c587d7ee"}


def example() -> dict:
    """The architecture G example (the TomatoMeter email task, abridged)."""
    return {
        "recipeVersion": "1",
        "currency": "USD",
        "billing": "monthly",
        "demand": {
            "monthlyEmails": {"value": 30000, "unit": "email/month"},
            "dailyEmails": {"value": 1000, "unit": "email/day"},
        },
        "features": {
            "subscription": {"unit": "USD/month", "direction": "minimize"},
            "availability": {"unit": "", "direction": "maximize", "domain": "ratio"},
            "latency": {"unit": "ms", "direction": "minimize"},
        },
        "tasks": [{
            "task": "dailySummary",
            "capability": "service/email",
            "service": "email",
            "expand": "plans",
            "from": [
                {"sphere": dict(MAILGUN), "provider": "mailgun", "plans": ["FREE", "BASIC", "FOUNDATION", "SCALE"],
                 "addons": [], "seats": 1},
                {"sphere": dict(RESEND), "provider": "resend",
                 "names": {"emailsPerMonth": "transactionalEmailsPerMonth", "emailsPerDay": "transactionalEmailsPerDay"}},
                {"candidate": {"id": "email.selfhosted.postfix", "provider": "selfhosted", "name": "Postfix on a VPS",
                               "properties": {"emailsPerMonth": 100000000, "emailsPerDay": 100000000},
                               "values": {"subscription": 12, "availability": 0.99, "latency": 300}}},
            ],
            "require": {"features": [],
                        "limits": {"emailsPerMonth": {"atLeast": "monthlyEmails"},
                                   "emailsPerDay": {"atLeast": "dailyEmails"}}},
            "properties": {
                "subscription": "price",
                "availability": {"guarantee": "guaranteedUptimeSla", "map": {"true": 0.9995, "false": 0.99},
                                 "resend": {"manual": {"*": 0.995}}},
                "latency": {"manual": {"mailgun": 250, "mailgun.FOUNDATION": 200, "*": 400}},
            },
            "prune": "none",
        }],
    }


def codes(problems) -> list[tuple[str, str]]:
    return [(p.code, p.at) for p in problems]


def schema_accepts(document) -> bool:
    try:
        jsonschema.validate(document, SCHEMA, cls=jsonschema.Draft202012Validator)
    except jsonschema.ValidationError:
        return False
    return True


def test_the_architecture_example_is_valid():
    recipe, problems = r.parse_recipe(example())
    assert problems == []
    assert recipe is not None
    assert recipe.currency == "USD" and recipe.billing == "monthly"
    assert recipe.demand["monthlyEmails"].value == 30000
    assert recipe.features["availability"].domain == "ratio"
    task = recipe.tasks[0]
    assert (task.task, task.capability, task.service, task.expand, task.prune) == (
        "dailySummary", "service/email", "email", "plans", "none",
    )
    mailgun, resend, postfix = task.sources
    assert mailgun.sphere == r.SphereRef(MAILGUN["pricing"], MAILGUN["version"])
    assert mailgun.plans == ("FREE", "BASIC", "FOUNDATION", "SCALE") and mailgun.addons == ()
    assert resend.plans is None and resend.addons is None
    assert resend.name_of("emailsPerMonth") == "transactionalEmailsPerMonth"
    assert postfix.candidate is not None and postfix.candidate.values["latency"] == 300
    # Objects are read in key order (the canonical form); lists keep theirs.
    assert [req.limit for req in task.require_limits] == ["emailsPerDay", "emailsPerMonth"]
    assert task.require_limits[1].value(recipe.demand) == 30000
    availability = task.properties["availability"]
    assert availability.kind == "guarantee" and availability.map == {"true": 0.9995, "false": 0.99}
    assert availability.overrides == {"resend": {"*": 0.995}}
    assert task.properties["latency"].manual == {"mailgun": 250, "mailgun.FOUNDATION": 200, "*": 400}
    assert task.properties["subscription"].kind == "price"
    assert schema_accepts(example())


def test_the_service_defaults_from_the_capability():
    document = example()
    del document["tasks"][0]["service"]
    document["tasks"][0]["capability"] = "service/Transactional Mail".replace(" ", "_")
    recipe, problems = r.parse_recipe(document)
    assert problems == [] and recipe.tasks[0].service == "transactional-mail"


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda d: d.pop("currency"), [("sphere_recipe_shape", "/currency")]),
        (lambda d: d.update(currency="usd"), [("sphere_recipe_shape", "/currency")]),
        (lambda d: d.update(recipeVersion="2"), [("sphere_recipe_shape", "/recipeVersion")]),
        (lambda d: d.update(extra=1), [("sphere_recipe_shape", "/extra")]),
        (lambda d: d.update(tasks=[]), [("sphere_recipe_shape", "/tasks")]),
        (lambda d: d["features"]["latency"].update(direction="down"), [("sphere_recipe_shape", "/features/latency/direction")]),
        (lambda d: d["features"]["latency"].update(domain="int"), [("sphere_recipe_shape", "/features/latency/domain")]),
        (lambda d: d["demand"]["dailyEmails"].update(value=-1), [("sphere_recipe_shape", "/demand/dailyEmails/value")]),
        (lambda d: d["tasks"][0].update(task="1bad"), [("sphere_recipe_shape", "/tasks/0/task")]),
        (lambda d: d["tasks"][0].update(capability="service email"), [("sphere_recipe_shape", "/tasks/0/capability")]),
        (lambda d: d["tasks"][0].update(prune="all"), [("sphere_recipe_shape", "/tasks/0/prune")]),
        (lambda d: d["tasks"][0].update(expand="configurations"), [("sphere_expand_unsupported", "/tasks/0/expand")]),
        (lambda d: d["tasks"][0]["from"][0].pop("provider"), [("sphere_recipe_shape", "/tasks/0/from/0/provider")]),
        (lambda d: d["tasks"][0]["from"][0].update(provider="Mail Gun"), [("sphere_recipe_shape", "/tasks/0/from/0/provider")]),
        (lambda d: d["tasks"][0]["from"][0].update(seats=0), [("sphere_recipe_shape", "/tasks/0/from/0/seats")]),
        (lambda d: d["tasks"][0]["from"][0].update(plans="FREE"), [("sphere_recipe_shape", "/tasks/0/from/0/plans")]),
        (lambda d: d["tasks"][0]["from"][2]["candidate"].update(id="email/postfix"),
         [("sphere_recipe_shape", "/tasks/0/from/2/candidate/id")]),
        (lambda d: d["tasks"][0]["from"][2]["candidate"]["values"].update(latency="fast"),
         [("sphere_recipe_shape", "/tasks/0/from/2/candidate/values/latency")]),
        (lambda d: d["tasks"][0]["require"]["limits"]["emailsPerDay"].update(atLeast="hourlyEmails"),
         [("sphere_recipe_shape", "/tasks/0/require/limits/emailsPerDay/atLeast")]),
        (lambda d: d["tasks"][0]["require"]["limits"].update({"emails-per-hour": {"atLeast": 1}}),
         [("sphere_recipe_shape", "/tasks/0/require/limits/emails-per-hour")]),
        (lambda d: d["tasks"][0]["require"].update(features=["two.factor"]),
         [("sphere_recipe_shape", "/tasks/0/require/features/0")]),
        (lambda d: d["tasks"][0]["properties"].update(latency="speed"), [("sphere_recipe_shape", "/tasks/0/properties/latency")]),
        (lambda d: d["tasks"][0]["properties"].update(latency={"manual": {}}),
         [("sphere_recipe_shape", "/tasks/0/properties/latency/manual")]),
        (lambda d: d["tasks"][0]["properties"].update(latency={"guarantee": "x", "limit": "y"}),
         [("sphere_recipe_shape", "/tasks/0/properties/latency")]),
        (lambda d: d["tasks"][0]["properties"].update(availability={"guarantee": "x", "map": {"yes": 1}}),
         [("sphere_recipe_shape", "/tasks/0/properties/availability/map/yes")]),
        (lambda d: d["tasks"][0]["properties"].update(availability={"guarantee": "x", "scale": 0}),
         [("sphere_recipe_shape", "/tasks/0/properties/availability/scale")]),
        (lambda d: d["tasks"][0]["properties"].update(latency={"manual": {"Mailgun": 3}}),
         [("sphere_recipe_shape", "/tasks/0/properties/latency/manual/Mailgun")]),
    ],
)
def test_each_shape_error_is_located(mutate, expected):
    document = example()
    mutate(document)
    recipe, problems = r.parse_recipe(document)
    assert recipe is None
    assert codes(problems) == expected
    assert all(p.severity == SEVERITIES[p.code] for p in problems)
    # A demand a requirement names but the recipe lacks is a cross-reference no JSON Schema can state.
    if expected[0][1] != "/tasks/0/require/limits/emailsPerDay/atLeast":
        assert not schema_accepts(document)


def test_latest_is_parsed_and_refused_by_require_pinned():
    document = example()
    document["tasks"][0]["from"][1]["sphere"]["version"] = "latest"
    recipe, problems = r.parse_recipe(document)
    assert problems == []
    assert codes(r.require_pinned(recipe)) == [("sphere_version_unpinned", "/tasks/0/from/1/sphere/version")]
    assert schema_accepts(document)
    resolved = r.pinned(recipe, {(None, RESEND["pricing"]): RESEND["version"]})
    assert r.require_pinned(resolved) == []
    assert resolved.tasks[0].sources[1].sphere.version == RESEND["version"]
    assert r.recipe_digest(resolved) == r.recipe_digest(r.parse_recipe(example())[0])


def test_a_demand_above_the_unlimited_value_is_too_large():
    document = example()
    document["demand"]["monthlyEmails"]["value"] = 100000001
    recipe, problems = r.parse_recipe(document)
    assert recipe is None
    assert codes(problems) == [("sphere_demand_too_large", "/demand/monthlyEmails/value")]
    document = example()
    document["tasks"][0]["require"]["limits"]["emailsPerDay"]["atLeast"] = 2e8
    assert codes(r.parse_recipe(document)[1]) == [
        ("sphere_demand_too_large", "/tasks/0/require/limits/emailsPerDay/atLeast")
    ]


@pytest.mark.parametrize("value", ["../../users/me", "6ade364540e55445692b0edA", "6ade364540e5544569", "x" * 24, 7])
@pytest.mark.parametrize("member", ["pricing", "version"])
def test_sphere_ids_are_24_hex_characters(member, value):
    document = example()
    document["tasks"][0]["from"][0]["sphere"][member] = value
    recipe, problems = r.parse_recipe(document)
    assert recipe is None
    assert codes(problems) == [("sphere_recipe_shape", f"/tasks/0/from/0/sphere/{member}")]
    assert not schema_accepts(document)


def test_a_registry_is_an_alias():
    document = example()
    document["tasks"][0]["from"][0]["sphere"]["registry"] = "onprem"
    recipe, problems = r.parse_recipe(document)
    assert problems == [] and recipe.tasks[0].sources[0].sphere.registry == "onprem"
    document["tasks"][0]["from"][0]["sphere"]["registry"] = "https://evil.example"
    assert codes(r.parse_recipe(document)[1]) == [("sphere_recipe_shape", "/tasks/0/from/0/sphere/registry")]


def _many_sources(count: int) -> dict:
    document = example()
    tasks = []
    for t in range((count + 7) // 8):
        sources = []
        for s in range(min(8, count - t * 8)):
            n = t * 8 + s
            sources.append({"sphere": {"pricing": f"{n:024x}", "version": f"{n + 1000:024x}"}, "provider": f"p{n}"})
        tasks.append({"task": f"t{t}", "capability": f"service/s{t}", "from": sources})
    document["tasks"] = tasks
    return document


def test_at_most_24_distinct_sources():
    recipe, problems = r.parse_recipe(_many_sources(24))
    assert problems == [] and len(recipe.distinct_sources()) == 24
    recipe, problems = r.parse_recipe(_many_sources(25))
    assert recipe is None
    assert codes(problems) == [("sphere_recipe_shape", "/tasks")]


def test_bounds_on_tasks_and_sources_per_task():
    document = example()
    document["tasks"][0]["from"] = [dict(document["tasks"][0]["from"][0], provider=f"p{i}") for i in range(9)]
    assert codes(r.parse_recipe(document)[1]) == [("sphere_recipe_shape", "/tasks/0/from")]
    document = example()
    document["tasks"] = [dict(example()["tasks"][0], task=f"t{i}") for i in range(17)]
    assert codes(r.parse_recipe(document)[1]) == [("sphere_recipe_shape", "/tasks")]
    document = example()
    document["tasks"].append(copy.deepcopy(document["tasks"][0]))
    assert codes(r.parse_recipe(document)[1]) == [("sphere_recipe_shape", "/tasks/1/task")]


@pytest.mark.parametrize(
    ("assume", "at"),
    [
        ({"teammatesLimit": "unlimited"}, "/tasks/0/from/0/assume/teammatesLimit"),
        ({"emailsPerDay": "lots"}, "/tasks/0/from/0/assume/emailsPerDay"),
        ({"emailsPerDay": -5}, "/tasks/0/from/0/assume/emailsPerDay"),
    ],
)
def test_assume_names_a_required_limit_with_unlimited_or_a_number(assume, at):
    document = example()
    document["tasks"][0]["from"][0]["assume"] = assume
    recipe, problems = r.parse_recipe(document)
    assert recipe is None and codes(problems) == [("sphere_recipe_shape", at)]


def test_assume_and_per_source_billing_are_kept():
    document = example()
    document["tasks"][0]["from"][0]["assume"] = {"emailsPerDay": "unlimited"}
    document["tasks"][0]["from"][1]["assume"] = {"emailsPerDay": 5000}
    document["tasks"][0]["from"][1]["billing"] = "annual"
    recipe, problems = r.parse_recipe(document)
    assert problems == []
    assert recipe.tasks[0].sources[0].assume == {"emailsPerDay": "unlimited"}
    assert recipe.tasks[0].sources[1].assume == {"emailsPerDay": 5000.0}
    assert recipe.tasks[0].sources[1].billing == "annual"
    assert schema_accepts(document)


def test_canonical_bytes_do_not_depend_on_key_order_or_whitespace():
    first = r.parse_recipe(example())[0]
    shuffled = json.loads(json.dumps(example(), indent=7, sort_keys=True)[::-1][::-1])
    shuffled = {key: shuffled[key] for key in reversed(list(shuffled))}
    second = r.parse_recipe(shuffled)[0]
    assert r.canonical(first) == r.canonical(second)
    assert r.recipe_digest(first) == r.recipe_digest(second)
    assert r.recipe_digest(first).startswith("sha256-") and len(r.recipe_digest(first)) == 71
    assert b" " not in r.canonical(first).replace(b"Postfix on a VPS", b"")
    other = example()
    other["demand"]["dailyEmails"]["value"] = 1001
    assert r.recipe_digest(r.parse_recipe(other)[0]) != r.recipe_digest(first)


def test_a_recipe_over_64_kib_is_refused():
    document = example()
    document["tasks"][0]["from"][2]["candidate"]["properties"] = {f"p{i}": "x" * 250 for i in range(300)}
    recipe, problems = r.parse_recipe(document)
    assert recipe is None and codes(problems) == [("sphere_recipe_shape", "")]


@pytest.mark.parametrize("document", [None, [], "recipe", {"recipeVersion": "1"}])
def test_what_is_not_a_recipe(document):
    recipe, problems = r.parse_recipe(document)
    assert recipe is None and problems and all(p.code == "sphere_recipe_shape" for p in problems)


def test_the_catalogue_knows_every_code_and_refuses_others():
    assert diagnostic("sphere_pruned", "x").severity == "info"
    assert diagnostic("sphere_rescaled", "x").severity == "warning"
    assert diagnostic("sphere_no_candidates", "x").severity == "error"
    assert diagnostic("sphere_price_not_numeric", "x", severity="error").severity == "error"
    with pytest.raises(KeyError):
        diagnostic("sphere_nothing", "x")
    assert len(SEVERITIES) == 38

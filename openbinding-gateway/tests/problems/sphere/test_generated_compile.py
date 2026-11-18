"""Generated packages are ordinary BIM packages: the pinned toolchain compiles every golden, its facts and digest
match, the generator's explanations say exactly which candidates the compiler finds ineligible, and a candidate
that serves two tasks is charged its subscription once."""

from __future__ import annotations

import asyncio
import json

import pytest
from bim_core.compiler import compile_instance
from bim_core.package import load_package

from _paths import gateway_tool
from openbinding_gateway.composition.problem import ProblemFacts
from openbinding_gateway.modules.problems.application.sphere import generate
from openbinding_gateway.modules.problems.domain.sphere.recipe import parse_recipe

tool = gateway_tool("dump_sphere_goldens")
RUNNER = tool.Runner()
GENERATED = [case["name"] for case in RUNNER.document["cases"] if not case["name"].startswith("refused-")]


@pytest.mark.parametrize("name", GENERATED)
def test_every_golden_compiles_with_its_digest_and_facts(name):
    result = RUNNER.generated(name)
    digest, facts = asyncio.run(tool.compiled(result))
    assert (tool.DEFAULT_OUT / f"{name}.package.digest").read_text() == digest + "\n"
    assert json.loads((tool.DEFAULT_OUT / f"{name}.facts.json").read_text()) == json.loads(tool.text(facts))


@pytest.mark.parametrize("name", GENERATED)
def test_the_explanations_equal_the_compilers_eligibility(name):
    result = RUNNER.generated(name)
    compiled = compile_instance(load_package(result.archive()))
    facts = ProblemFacts.from_ir(compiled.document, compiled.source_map)
    for task in {c["task"] for c in result.candidates}:
        generated = {c["key"] for c in result.candidates if c["task"] == task}
        eligible = {str(ref) for ref in facts.eligibility.get(task, ())}
        explained = {c["key"] for c in result.candidates if c["task"] == task and c["eligible"]}
        assert explained == eligible & generated, task


def test_a_candidate_serving_two_tasks_is_charged_once():
    document = {
        "recipeVersion": "1", "currency": "USD",
        "features": {"subscription": {"unit": "USD/month", "direction": "minimize"},
                     "latency": {"unit": "ms", "direction": "minimize"}},
        "tasks": [
            {"task": "notify", "capability": "service/notify", "service": "email",
             "from": [{"sphere": {"pricing": "6ade364540e55445692b0eda", "version": "6ade36454b2b5b01c587db3d"},
                       "provider": "mailgun", "plans": ["FOUNDATION"], "addons": []}],
             "properties": {"subscription": "price", "latency": 200}},
            {"task": "digest", "capability": "service/digest", "service": "email",
             "from": [{"sphere": {"pricing": "6ade364540e55445692b0eda", "version": "6ade36454b2b5b01c587db3d"},
                       "provider": "mailgun", "plans": ["FOUNDATION"], "addons": []}],
             "properties": {"subscription": "price", "latency": 200}},
        ],
    }
    recipe, problems = parse_recipe(document)
    assert problems == []
    result = generate(recipe, tool.recorded_sources(recipe), name="two-tasks")
    assert result.valid, [d.as_dict() for d in result.diagnostics]
    catalog = json.loads(result.files["sphere-email.json"])
    assert catalog["spec"]["candidates"]["email.mailgun.foundation"]["provides"] == ["service/digest", "service/notify"]
    problem = compile_instance(load_package(result.archive()))
    shared = {"resource": "sphere-email", "id": "email.mailgun.foundation"}
    values = problem.evaluate_binding({"notify": shared, "digest": shared})
    assert values["subscription"] == pytest.approx(35.0)
    assert values["latency"] == pytest.approx(400.0)

"""The worked example in the specification must satisfy the shipped schema.

``docs/COMPOSITION2YAML.md`` is the normative document and the JSON Schema beside the
package is its machine-readable half. Nothing keeps the two in step on its own: the
example in the spec is prose to a reader and data to a validator, and the easiest way to
leave them disagreeing is to edit one of them. This test extracts the example from the
document and validates it, so a drift is a failing test rather than a surprise in phase
F1 when the parser is written against the schema.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import jsonschema
import pytest
import yaml

from _repo import REPO_ROOT
from openbinding_gateway import composition

SPEC = REPO_ROOT / "docs" / "COMPOSITION2YAML.md"
SCHEMA_PATH = (
    Path(composition.__file__).resolve().parent
    / "resources"
    / "composition2yaml"
    / "v1"
    / "composition.schema.json"
)
#: A fenced YAML block in the specification.
BLOCK = re.compile(r"^```yaml\n(.*?)^```", re.MULTILINE | re.DOTALL)


@pytest.fixture(scope="module")
def schema() -> dict:
    document = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(document)
    return document


#: What the schema requires of a whole composition.
MANDATORY = frozenset({"composition", "version", "properties", "tasks", "workflow"})
#: The spec's structure overview writes ``{...}`` where a section goes. It is an outline,
#: not an example, so it is not validated: YAML reads the marker as a real key and the
#: schema would rightly refuse it.
PLACEHOLDER = "..."


def _has_placeholder(value: object) -> bool:
    if isinstance(value, str):
        return value == PLACEHOLDER
    if isinstance(value, dict):
        return any(
            key == PLACEHOLDER or _has_placeholder(item) for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_has_placeholder(item) for item in value)
    return False


def _complete_examples() -> list[tuple[int, dict]]:
    """Every fenced YAML block of the spec that is a whole composition.

    A block is a document when it carries every mandatory key and no outline marker; the
    rest are excerpts of one section and are not validated against the whole-document
    schema.
    """
    if not SPEC.is_file():
        return []
    found = []
    for index, match in enumerate(BLOCK.finditer(SPEC.read_text(encoding="utf-8"))):
        try:
            loaded = yaml.safe_load(match.group(1))
        except yaml.YAMLError:
            continue
        if not isinstance(loaded, dict) or not MANDATORY.issubset(loaded):
            continue
        if _has_placeholder(loaded):
            continue
        found.append((index, loaded))
    return found


EXAMPLES = _complete_examples()


def test_the_specification_carries_a_complete_example() -> None:
    assert SPEC.is_file(), f"{SPEC} is missing"
    assert EXAMPLES, "the specification has no fenced YAML block that is a whole composition"


@pytest.mark.parametrize("index,document", EXAMPLES, ids=[f"block{i}" for i, _ in EXAMPLES])
def test_example_satisfies_the_schema(index: int, document: dict, schema: dict) -> None:
    errors = sorted(
        jsonschema.Draft202012Validator(schema).iter_errors(document),
        key=lambda error: list(error.absolute_path),
    )
    assert not errors, "\n".join(
        f"/{'/'.join(str(p) for p in e.absolute_path)}: {e.message}" for e in errors
    )


def test_every_template_named_by_the_schema_exists_in_the_model(schema: dict) -> None:
    """The spec's template table, the schema's enum and the model must agree."""
    enumerated = set(schema["$defs"]["property"]["properties"]["template"]["enum"])
    assert enumerated == set(composition.TEMPLATES), (
        f"schema templates {sorted(enumerated)} != model templates {sorted(composition.TEMPLATES)}"
    )


#: The smallest document the schema accepts, used as the base for the rule tests below.
def _minimal(exclusive: dict) -> dict:
    return {
        "composition": "c",
        "version": "1.0.0",
        "properties": {"cost": {"template": "cost", "domain": {"min": 0, "max": 1}}},
        "tasks": {"A": {"open": True, "requires": "service/A"}, "B": {"local": True}},
        "workflow": {"exclusive": exclusive},
    }


def _errors(document: dict, schema: dict) -> list[str]:
    return [e.message for e in jsonschema.Draft202012Validator(schema).iter_errors(document)]


@pytest.mark.parametrize(
    "exclusive,valid",
    [
        # Inline probabilities, the default distribution of a composition.
        ({"id": "x", "branches": [
            {"probability": 0.8, "flow": {"task": "A"}},
            {"probability": 0.2, "flow": {"task": "B"}},
        ]}, True),
        # The explicit opt-in, which is the only way to say "equally likely".
        ({"id": "x", "distribution": "uniform", "branches": [
            {"flow": {"task": "A"}}, {"flow": {"task": "B"}},
        ]}, True),
        # Nothing stated, which is not the same as uniform and emits no overlay.
        ({"id": "x", "branches": [{"flow": {"task": "A"}}, {"flow": {"task": "B"}}]}, True),
        # A condition is prose and coexists with a probability.
        ({"id": "x", "branches": [
            {"probability": 0.8, "condition": "when the problem is small", "flow": {"task": "A"}},
            {"probability": 0.2, "condition": "when the problem is large", "flow": {"task": "B"}},
        ]}, True),
        # An author-named branch id, the escape hatch for reproducing a package exactly.
        ({"id": "x", "branches": [
            {"id": "node_routing_choice_branch_1", "probability": 0.8, "flow": {"task": "A"}},
            {"id": "node_routing_choice_branch_2", "probability": 0.2, "flow": {"task": "B"}},
        ]}, True),
        # Saying it twice: a distribution and inline probabilities together.
        ({"id": "x", "distribution": "uniform", "branches": [
            {"probability": 0.5, "flow": {"task": "A"}},
            {"probability": 0.5, "flow": {"task": "B"}},
        ]}, False),
        # Only `uniform` is a distribution; computed shares are never a source value.
        ({"id": "x", "distribution": "weighted", "branches": [
            {"flow": {"task": "A"}}, {"flow": {"task": "B"}},
        ]}, False),
    ],
    ids=["inline", "uniform", "unstated", "condition", "named-branches", "both", "unknown"],
)
def test_the_schema_rules_for_an_exclusive_choice(exclusive: dict, valid: bool, schema: dict) -> None:
    errors = _errors(_minimal(exclusive), schema)
    assert bool(errors) != valid, f"expected valid={valid}, got {errors}"


def test_a_branch_may_not_carry_a_container_condition() -> None:
    """``when`` is the container's conditional choice and this version never emits it.

    The exact engine declares its workflow node kinds without conditional choice, so a
    composition that exposed ``when`` would compile, validate and digest, and then fail at
    dispatch. The schema refuses the key outright so the trap is never armed.
    """
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    document = _minimal({"id": "x", "branches": [
        {"when": "features.cost > 1", "flow": {"task": "A"}},
        {"flow": {"task": "B"}},
    ]})
    assert _errors(document, schema), "the schema accepted a container condition on a branch"


@pytest.mark.parametrize(
    "pricing,valid",
    [
        # The shorthand: a bare permanent link to one immutable version.
        ("https://sphere.score.us.es/faked/fleet-management/2026-01.yaml", True),
        # The long form, with the digest that makes the reference tamper-evident.
        ({"href": "https://sphere.score.us.es/faked/fleet-management/2026-01.yaml",
          "digest": "sha256-" + "0" * 64}, True),
        # A separate version field is gone on purpose: the link already names it, and a
        # second source of truth for the same fact can only disagree with the first.
        ({"href": "https://sphere.score.us.es/faked/fleet-management/2026-01.yaml",
          "version": "2026-01"}, False),
        # Not a link at all, which is what the old three-field form reduced to.
        ({"organization": "faked", "slug": "fleet-management", "version": "2026-01"}, False),
        # A relative reference has no origin to trust.
        ("/faked/fleet-management/2026-01.yaml", False),
        # Plain http is not a permanent reference anyone should follow.
        ("http://sphere.score.us.es/faked/fleet-management/2026-01.yaml", False),
        # A malformed digest is worse than none: it looks checked and is not.
        ({"href": "https://sphere.score.us.es/faked/fleet-management/2026-01.yaml",
          "digest": "sha256-nothex"}, False),
    ],
    ids=["shorthand", "with-digest", "with-version", "three-fields", "relative", "http", "bad-digest"],
)
def test_the_schema_rules_for_a_pricing_reference(pricing, valid: bool, schema: dict) -> None:
    document = _minimal({"id": "x", "branches": [{"flow": {"task": "A"}}, {"flow": {"task": "B"}}]})
    document["pricing"] = pricing
    errors = _errors(document, schema)
    assert bool(errors) != valid, f"expected valid={valid}, got {errors}"


@pytest.mark.parametrize(
    "declared,valid",
    [
        # A bare template, the common case.
        ({"template": "availability"}, True),
        # One operator overridden beside a template: what version 1 of the guiding case
        # needs, since it aggregates availability's exclusive with weightedSum.
        ({"template": "availability", "aggregate": {"exclusive": "weightedSum"}}, True),
        # A declared neutral, the only way to say what a local step contributes when the
        # inferred value would make a claim the author does not want to make.
        ({"template": "availability", "neutral": 0.95}, True),
        # No template at all, so the direction and the whole policy are stated.
        ({"direction": "maximize", "aggregate": {
            "sequence": "min", "parallel": "min", "exclusive": "weightedSum",
            "repeat": "identity", "selection": "min"}}, True),
        # An override that overrides nothing is a typo, not a document.
        ({"template": "availability", "aggregate": {}}, False),
        # An operator the container does not have.
        ({"template": "availability", "aggregate": {"exclusive": "average"}}, False),
        # A block the container does not have.
        ({"template": "availability", "aggregate": {"retry": "sum"}}, False),
        # Neither a template nor the pair that replaces one.
        ({"aggregate": {"sequence": "sum"}}, False),
        ({"direction": "maximize"}, False),
    ],
    ids=[
        "template", "one-operator-override", "declared-neutral", "no-template",
        "empty-override", "unknown-operator", "unknown-block", "aggregate-alone",
        "direction-alone",
    ],
)
def test_the_schema_rules_for_a_property(declared, valid: bool, schema: dict) -> None:
    document = _minimal({"id": "x", "branches": [{"flow": {"task": "A"}}, {"flow": {"task": "B"}}]})
    document["properties"]["availability"] = declared
    errors = _errors(document, schema)
    assert bool(errors) != valid, f"expected valid={valid}, got {errors}"


@pytest.mark.parametrize(
    "goal,valid",
    [
        # The common case: the criterion normalizes over the property's domain.
        ({"property": "cost"}, True),
        # The override the corpus forces. 14 packages scale a property onto a range that
        # is not its domain, and seven of those are inside the phase F1 gate, so a goal
        # that could only ever use the domain would put the gate at 68 of 82, not 75.
        ({"property": "cost", "normalize": {"min": 1, "max": 4}}, True),
        # Half a range is not a range.
        ({"property": "cost", "normalize": {"min": 1}}, False),
        # clamp IS exposed, and it has to be: the container defaults it to false, and five
        # of the gate's 243 criteria omit the key and so do not clamp. A goal that could
        # not say false would miss three of the 75 packages.
        ({"property": "cost", "normalize": {"min": 1, "max": 4, "clamp": True}}, True),
        ({"property": "cost", "normalize": {"min": 1, "max": 4, "clamp": False}}, True),
        # It is a boolean, not a mode.
        ({"property": "cost", "normalize": {"min": 1, "max": 4, "clamp": "always"}}, False),
        # No weight, no scalarization: those belong to an analysis run, not to the
        # composition. The criterion id is not a field either -- it is the property name.
        ({"property": "cost", "weight": 0.5}, False),
        ({"property": "cost", "id": "cost_criterion"}, False),
    ],
    ids=[
        "plain", "range-override", "partial-range", "clamp-true", "clamp-false",
        "clamp-not-a-boolean", "weight", "explicit-id",
    ],
)
def test_the_schema_rules_for_a_goal(goal, valid: bool, schema: dict) -> None:
    document = _minimal({"id": "x", "branches": [{"flow": {"task": "A"}}, {"flow": {"task": "B"}}]})
    document["goals"] = [goal]
    errors = _errors(document, schema)
    assert bool(errors) != valid, f"expected valid={valid}, got {errors}"

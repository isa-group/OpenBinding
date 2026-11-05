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

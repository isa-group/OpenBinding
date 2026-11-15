"""The JSON Schema of Composition2Yaml 1.0 agrees with the readers.

The schema ships for editors (it is what the F2 editor autocompletes from) and runs as the
readers' backstop. Every valid golden passes it, every invalid golden that loads fails it,
and no golden expects ``c2y_schema``: the readers cover the language, and the schema only
catches what a reader would have missed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from _paths import TESTS_DIR
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition import ids, syntax, text
from openbinding_gateway.composition.diagnostics import CompositionError

GOLDEN = TESTS_DIR / "composition" / "golden"
VALID = sorted(path for path in (GOLDEN / "valid").glob("*.yaml") if not path.name.endswith(".canonical.yaml"))
INVALID = sorted((GOLDEN / "invalid").glob("*.yaml"))


def _loaded(path: Path) -> object:
    return syntax.load(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("source", VALID, ids=lambda path: path.stem)
def test_every_valid_golden_passes_the_schema(source: Path) -> None:
    assert list(text._validator().iter_errors(_loaded(source))) == []


@pytest.mark.parametrize("source", VALID, ids=lambda path: path.stem)
def test_every_canonical_golden_passes_the_schema(source: Path) -> None:
    canonical = source.with_name(source.name.removesuffix(".yaml") + ".canonical.yaml")
    assert list(text._validator().iter_errors(_loaded(canonical))) == []


def _structural(path: Path) -> bool:
    """Whether the YAML reader accepts the golden, so that it is refused for its structure."""
    try:
        _loaded(path)
    except CompositionError:
        return False
    return True


STRUCTURAL = [path for path in INVALID if _structural(path)]


def test_the_syntax_goldens_are_the_only_ones_left_out() -> None:
    left_out = {path.stem for path in INVALID} - {path.stem for path in STRUCTURAL}
    assert left_out == {"alias", "duplicate_key", "integer_past_2_53", "on_as_task_key"}


@pytest.mark.parametrize("source", STRUCTURAL, ids=lambda path: path.stem)
def test_every_structural_invalid_golden_fails_the_schema(source: Path) -> None:
    assert list(text._validator().iter_errors(_loaded(source))) != []


def test_no_golden_expects_the_backstop() -> None:
    for expected in (GOLDEN / "invalid").glob("*.expected.json"):
        found = json.loads(expected.read_text(encoding="utf-8"))
        assert codes.SCHEMA not in {item["code"] for item in found}, expected.name


def test_the_schema_is_identified_and_returned_as_a_copy() -> None:
    first = text.schema()
    assert first["$id"] == "https://openbinding.dev/schemas/composition2yaml/1.0/composition.schema.json"
    assert first["title"] == "Composition2Yaml 1.0"
    assert first["properties"]["syntaxVersion"] == {
        "description": first["properties"]["syntaxVersion"]["description"], "const": "1.0",
    }
    first["title"] = "changed"
    assert text.schema()["title"] == "Composition2Yaml 1.0"
    assert text.schema("1.0") == text.schema()
    with pytest.raises(ValueError):
        text.schema("2.0")


def test_the_schema_requires_exactly_the_documents_required_keys() -> None:
    from openbinding_gateway.composition.document import REQUIRED_KEYS, ROOT_KEYS

    found = text.schema()
    assert tuple(found["required"]) == REQUIRED_KEYS
    assert tuple(found["properties"]) == ROOT_KEYS


def test_the_schema_patterns_are_the_readers_patterns() -> None:
    """One grammar: the schema's patterns are the library's, less Python's named groups."""
    found = text.schema()

    def plain(pattern: re.Pattern[str]) -> str:
        return re.sub(r"\(\?P<[a-z]+>", "(?:", pattern.pattern)

    defs = found["$defs"]
    assert found["properties"]["composition"]["pattern"] == plain(ids.SLUG)
    assert found["properties"]["version"]["pattern"] == plain(ids.SEMVER)
    assert found["properties"]["problem"]["properties"]["ref"]["pattern"] == plain(ids.REF)
    assert found["properties"]["problem"]["properties"]["compilation"]["pattern"] == plain(ids.DIGEST)
    assert defs["task"]["pattern"] == plain(ids.SYMBOL)
    assert found["properties"]["values"]["propertyNames"]["pattern"] == plain(ids.SYMBOL)
    assert defs["entry"]["oneOf"][0]["properties"]["candidate"]["pattern"] == plain(ids.CANDIDATE)
    provenance = defs["provenance"]["properties"]
    assert provenance["sphere"]["pattern"] == plain(ids.PRICING)
    assert provenance["registry"]["pattern"] == plain(ids.ALIAS)
    assert provenance["version"]["pattern"] == plain(ids.VERSION_ID)
    assert provenance["plan"]["pattern"] == plain(ids.PLAN)
    assert defs["evidence"]["properties"]["run"]["pattern"] == plain(ids.UUID)

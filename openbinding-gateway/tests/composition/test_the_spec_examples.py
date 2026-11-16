"""The examples of the Composition2Yaml specification read as their fences say.

``docs/COMPOSITION2YAML.md`` marks every example it makes a claim about with its fence's info string:

* ```` ```yaml c2y valid ```` -- the document reads with no error;
* ```` ```yaml c2y invalid <code> ```` -- the document is refused.

After the outcome, the fence lists every code the reading reports (an invalid example names at least the
code that refuses it), so the set of codes found is exactly the set written, warnings and infos included.
Two options may follow: ``registries=<alias>,...`` reads with those SPHERE registry aliases defined, and
``canonical`` says the example is written in canonical form, so writing what it reads gives its bytes back.

The Language page of the web application (``/language``) shows its own examples, from
``frontend/src/content/composition2yaml-examples.json``: a ``starter`` document, which the composition editor also
opens with, and ``sections``, each ``{name, description, yaml, expect}``. ``expect`` is ``valid`` (the document reads
with no diagnostic at all) or the one code that refuses it. They are read as the stateless ``validate`` route reads
them on a deployment that defines no SPHERE registry alias, so the page never shows an invalid example as valid.

Both files are read by name from the repository root; nothing here walks a directory.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition import text

SPEC = REPO_ROOT / "docs" / "COMPOSITION2YAML.md"
PAGE_EXAMPLES = REPO_ROOT / "frontend" / "src" / "content" / "composition2yaml-examples.json"
FENCE = re.compile(r"^```yaml c2y (?P<info>[^\n]*)\n(?P<body>.*?)^```$", re.MULTILINE | re.DOTALL)
#: Codes the language reserves for later phases: named in the specification, defined by no module yet.
RESERVED = ("c2y_offering_unreadable", "c2y_offering_invalid_pricing", "c2y_provenance_mismatch")


@dataclass(frozen=True)
class Example:
    line: int
    valid: bool
    codes: frozenset[str]
    registries: frozenset[str]
    canonical: bool
    body: str

    def __str__(self) -> str:
        return f"COMPOSITION2YAML.md:{self.line}"


def _examples() -> list[Example]:
    spec = SPEC.read_text(encoding="utf-8")
    found = []
    for match in FENCE.finditer(spec):
        outcome, *tokens = match["info"].split()
        assert outcome in {"valid", "invalid"}, f"line {spec.count(chr(10), 0, match.start()) + 1}: {match['info']!r}"
        registries = frozenset(
            alias for token in tokens if token.startswith("registries=") for alias in token.split("=", 1)[1].split(",")
        )
        found.append(Example(
            line=spec.count("\n", 0, match.start()) + 1,
            valid=outcome == "valid",
            codes=frozenset(token for token in tokens if token.startswith("c2y_")),
            registries=registries,
            canonical="canonical" in tokens,
            body=match["body"],
        ))
    return found


EXAMPLES = _examples()


def test_the_specification_has_marked_examples_of_both_outcomes():
    assert sum(example.valid for example in EXAMPLES) >= 10
    assert sum(not example.valid for example in EXAMPLES) >= 20
    assert any(example.canonical for example in EXAMPLES)


@pytest.mark.parametrize("example", EXAMPLES, ids=str)
def test_each_example_reads_as_its_fence_says(example: Example):
    reading = text.read(example.body, context=text.Context(registries=example.registries))

    found = {item.code for item in reading.diagnostics}
    if example.valid:
        assert reading.document is not None and not reading.errors, reading.diagnostics
    else:
        assert reading.document is None, reading.diagnostics
        assert example.codes, "an invalid example names the code that refuses it"
    assert found == example.codes, reading.diagnostics
    for item in reading.diagnostics:
        assert item.pointer is not None and (item.span is not None or item.code == codes.MORE), item
    if example.canonical:
        assert text.serialise(reading.document) == example.body


def test_the_code_table_names_every_code_and_the_reserved_ones():
    spec = SPEC.read_text(encoding="utf-8")
    defined = sorted(value for value in vars(codes).values() if isinstance(value, str) and value.startswith("c2y_"))
    assert len(defined) > 50
    missing = [code for code in (*defined, *RESERVED) if f"| `{code}`" not in spec]
    assert not missing, f"not in the code table of docs/COMPOSITION2YAML.md: {missing}"
    assert not set(RESERVED) & set(defined), "a reserved code is defined: move it out of the reserved list"


def _page_examples() -> dict:
    return json.loads(PAGE_EXAMPLES.read_text(encoding="utf-8"))


PAGE = _page_examples()


def test_the_language_page_has_a_starter_and_examples_of_both_outcomes():
    assert isinstance(PAGE["starter"], str) and PAGE["starter"].strip()
    sections = PAGE["sections"]
    assert all(set(section) == {"name", "description", "yaml", "expect"} for section in sections), sections
    names = [section["name"] for section in sections]
    assert len(set(names)) == len(names), "two examples of the Language page share a name"
    assert sum(section["expect"] == "valid" for section in sections) >= 5
    assert any(section["expect"] != "valid" for section in sections)


def test_the_starter_of_the_language_page_and_the_editor_reads_with_no_diagnostic():
    reading = text.read(PAGE["starter"])
    assert reading.document is not None and not reading.diagnostics, reading.diagnostics


@pytest.mark.parametrize("section", PAGE["sections"], ids=lambda section: section["name"])
def test_each_example_of_the_language_page_reads_as_it_says(section: dict):
    reading = text.read(section["yaml"])

    found = {item.code for item in reading.diagnostics}
    if section["expect"] == "valid":
        assert reading.document is not None and not reading.diagnostics, reading.diagnostics
    else:
        assert section["expect"].startswith("c2y_"), section["expect"]
        assert reading.document is None, reading.diagnostics
        assert found == {section["expect"]}, reading.diagnostics

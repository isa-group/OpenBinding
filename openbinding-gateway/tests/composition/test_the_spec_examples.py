"""The examples of the Composition2Yaml specification read as their fences say.

``docs/COMPOSITION2YAML.md`` marks every example it makes a claim about with its fence's info string:

* ```` ```yaml c2y valid ```` -- the document reads with no error;
* ```` ```yaml c2y invalid <code> ```` -- the document is refused.

After the outcome, the fence lists every code the reading reports (an invalid example names at least the
code that refuses it), so the set of codes found is exactly the set written, warnings and infos included.
Two options may follow: ``registries=<alias>,...`` reads with those SPHERE registry aliases defined, and
``canonical`` says the example is written in canonical form, so writing what it reads gives its bytes back.

The specification is read by name from the repository root; nothing here walks a directory.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition import text

SPEC = REPO_ROOT / "docs" / "COMPOSITION2YAML.md"
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

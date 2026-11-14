"""Where each element of a document sits in its source text, so a refusal can be underlined.

``spans.locate`` composes a document a second time -- ``yaml.compose`` keeps the marks that
reading throws away -- and maps the path a reader would write (``properties.cost.unit``,
``candidates.rows[0]``) to the region of source that produced it. ``spans.placed`` fills the
spans of a refusal's diagnostics from that map; ``syntax.load`` locates its own refusals.
"""

from __future__ import annotations

import pytest

from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition.diagnostics import CompositionError, Diagnostic
from openbinding_gateway.composition.spans import locate, placed
from openbinding_gateway.composition.syntax import load

SOURCE = """\
composition: fleet
version: "1.0.0"
properties:
  cost:
    unit: USD/month
    direction: minimize
    domain: {min: 0, max: 100}
    aggregate:
      sequence: sum
      parallel: sum
      exclusive: weightedSum
      repeat: scale
      selection: sum
tasks:
  pick: {open: true, requires: service/pick}
workflow:
  sequence: [{task: pick}]
candidates:
  rows:
    - {id: c_pick, provides: service/pick, properties: {cost: 10}}
goals:
  - property: cost
"""


def test_the_document_reads() -> None:
    """The guard on everything else here: the source is one the loader accepts."""
    assert load(SOURCE)["composition"] == "fleet"


# ------------------------------------------------------------------- the locator itself


def test_a_path_is_located_from_its_key_to_the_end_of_its_value() -> None:
    """Which is what an editor should underline: the name is the part the author knows."""
    found = locate(SOURCE)
    assert found["properties.cost.unit"].line == 5
    assert found["properties.cost.unit"].column == 5
    assert found["tasks.pick"].line == 15
    assert found["candidates.rows[0]"].line == 20
    assert found["candidates.rows[0].id"].line == 20
    assert found["goals[0].property"].line == 22


def test_the_root_has_a_span_and_an_absent_path_has_none() -> None:
    """A refusal about the document as a whole reports no path; line 1 beats nowhere."""
    found = locate(SOURCE)
    assert found[""].line == 1
    assert "nothing.here" not in found


def test_only_the_paths_asked_for_are_located() -> None:
    found = locate(SOURCE, ["tasks.pick"])
    assert set(found) <= {"", "tasks.pick"}
    assert found["tasks.pick"].line == 15


def test_a_document_that_does_not_compose_locates_nothing() -> None:
    """Rather than raising a second reading error over the first one."""
    assert locate("{not: [valid") == {}


# -------------------------------------------------------------- a refusal, located


def _refusal(path: str) -> CompositionError:
    return CompositionError((Diagnostic(code=codes.PROPERTY_TEMPLATE, message="unknown template", path=path),))


def test_a_refusal_is_placed_at_the_line_of_its_path() -> None:
    (found,) = placed(_refusal("properties.cost.unit"), SOURCE).diagnostics
    assert found.span is not None
    assert (found.span.line, found.span.column) == (5, 5)


def test_a_refusal_whose_path_is_absent_keeps_no_span() -> None:
    (found,) = placed(_refusal("nothing.here"), SOURCE).diagnostics
    assert found.span is None


def test_a_refusal_prints_where_before_what() -> None:
    """``Diagnostic.__str__`` is what a terminal and a 422 body both show."""
    (found,) = placed(_refusal("properties.cost.unit"), SOURCE).diagnostics
    assert str(found).startswith("5:5: c2y_property_template:")


def test_an_unreadable_document_is_a_located_syntax_refusal() -> None:
    """There is no element to name, so the path is the document's; the span is where the
    reading stopped."""
    with pytest.raises(CompositionError) as raised:
        load("{not: [valid")
    (found,) = raised.value.diagnostics
    assert found.code == codes.SYNTAX
    assert found.path == ""
    assert found.span is not None

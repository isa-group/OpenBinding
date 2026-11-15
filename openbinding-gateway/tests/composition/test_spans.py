"""Where each element of a document sits in its source text, so a finding can be underlined.

``spans.locate`` composes a document a second time -- ``yaml.compose`` keeps the marks that
reading throws away -- and maps the path a reader would write (``binding.ship.from``,
``workflow.seq[1]``) to the region of source that produced it. ``spans.placed`` fills the
spans of a refusal's diagnostics from that map; ``syntax.load`` locates its own refusals.
A ``Path`` names the same element by its segments, so a key holding a dot is found exactly.
"""

from __future__ import annotations

import pytest

from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition.diagnostics import CompositionError, Diagnostic, Path, at
from openbinding_gateway.composition.spans import locate, placed
from openbinding_gateway.composition.syntax import load

SOURCE = """\
syntaxVersion: "1.0"
composition: fleet
version: "1.0.0"
kind: application
workflow:
  seq: [pick, {and: [ship, bill.eu]}]
binding:
  pick: {candidate: c_pick}
  ship:
    candidate: c_ship
    from: {sphere: acme/ship, version: "2024-01", plan: basic}
  bill.eu: {local: true}
values:
  cost: {value: 10, unit: USD/month}
  cost.unit: 3
"""


def test_the_document_reads() -> None:
    """The guard on everything else here: the source is one the loader accepts."""
    assert load(SOURCE)["composition"] == "fleet"


# ------------------------------------------------------------------- the locator itself


def test_a_path_is_located_from_its_key_to_the_end_of_its_value() -> None:
    """Which is what an editor should underline: the name is the part the author knows."""
    found = locate(SOURCE)
    assert (found["binding.ship.from"].line, found["binding.ship.from"].column) == (11, 5)
    assert found["binding.ship.from.version"].line == 11
    assert found["binding.pick"].line == 8
    assert found["workflow.seq[1]"].line == 6
    assert found["workflow.seq[1].and[0]"].line == 6
    assert found["values.cost"].line == 14


def test_the_root_has_a_span_and_an_absent_path_has_none() -> None:
    """A refusal about the document as a whole reports no path; line 1 beats nowhere."""
    found = locate(SOURCE)
    assert found[""].line == 1
    assert "nothing.here" not in found


def test_only_the_paths_asked_for_are_located() -> None:
    found = locate(SOURCE, ["binding.pick"])
    assert set(found) <= {"", "binding.pick"}
    assert found["binding.pick"].line == 8


def test_a_document_that_does_not_compose_locates_nothing() -> None:
    """Rather than raising a second reading error over the first one."""
    assert locate("{not: [valid") == {}


def test_a_path_whose_key_holds_a_dot_is_located_by_its_segments() -> None:
    """The dotted ``values.cost.unit`` reads as the unit of ``cost``; the segments say which."""
    dotted = locate(SOURCE, ["values.cost.unit"])["values.cost.unit"]
    exact = Path(("values", "cost.unit"))
    found = locate(SOURCE, [exact])
    assert dotted.line == 14
    assert found[exact].line == 15
    assert locate(SOURCE, [Path(("binding", "bill.eu", "local"))])[Path(("binding", "bill.eu", "local"))].line == 12


def test_a_path_read_back_from_a_pointer_follows_indexes_by_the_node_it_reaches() -> None:
    """Every segment of a pointer is a string; at a sequence it is an index."""
    path = Path.from_pointer("/workflow/seq/1/and/1")
    assert path == ("workflow", "seq", "1", "and", "1")
    span = locate(SOURCE, [path])[path]
    assert (span.line, span.column) == (6, 28)
    assert Path(("workflow", "seq", "9")) not in locate(SOURCE, [Path(("workflow", "seq", "9"))])


# ----------------------------------------------------------------- paths and diagnostics


def test_a_path_has_a_dotted_form_and_a_pointer_from_the_same_segments() -> None:
    path = Path(("workflow", "seq", 1, "and", 0))
    assert path.dotted == "workflow.seq[1].and[0]"
    assert path.pointer == "/workflow/seq/1/and/0"
    odd = Path(("binding", "a/b~c", "from"))
    assert odd.pointer == "/binding/a~1b~0c/from"
    assert Path.from_pointer(odd.pointer) == odd
    assert Path().dotted == "" and Path().pointer == ""


def test_at_builds_the_dotted_path_and_the_pointer_together() -> None:
    found = at(("binding", "bill.eu", "local"), "c2y_example", "a message", severity="warning")
    assert found.path == "binding.bill.eu.local"
    assert found.pointer == "/binding/bill.eu/local"
    assert found.severity == "warning"
    assert found.span is None


def test_an_error_lists_its_errors_first_and_keeps_every_severity() -> None:
    info = at(("values",), "c2y_note", "for your information", severity="info")
    warning = at(("binding",), "c2y_careful", "careful", severity="warning")
    error = at(("workflow",), codes.SYNTAX, "wrong")
    raised = CompositionError((info, warning, error))
    assert [item.severity for item in raised.diagnostics] == ["error", "warning", "info"]
    assert raised.errors == (error,)


# -------------------------------------------------------------- a refusal, located


def _refusal(path: str) -> CompositionError:
    return CompositionError((Diagnostic(code=codes.SYNTAX, message="not this", path=path),))


def test_a_refusal_is_placed_at_the_line_of_its_path() -> None:
    (found,) = placed(_refusal("binding.ship.from"), SOURCE).diagnostics
    assert found.span is not None
    assert (found.span.line, found.span.column) == (11, 5)


def test_a_refusal_with_a_pointer_is_placed_by_it() -> None:
    """``values.cost.unit`` as a dotted path would land on line 14; its pointer says line 15."""
    (found,) = placed(CompositionError((at(("values", "cost.unit"), codes.SYNTAX, "not this"),)), SOURCE).diagnostics
    assert found.span is not None and found.span.line == 15


def test_a_refusal_whose_path_is_absent_keeps_no_span() -> None:
    (found,) = placed(_refusal("nothing.here"), SOURCE).diagnostics
    assert found.span is None


def test_a_refusal_prints_where_and_how_severe_before_what() -> None:
    """``Diagnostic.__str__`` is what a terminal and a 422 body both show."""
    (found,) = placed(_refusal("binding.ship.from"), SOURCE).diagnostics
    assert str(found).startswith("11:5: error c2y_syntax:")


def test_an_unreadable_document_is_a_located_syntax_refusal() -> None:
    """There is no element to name, so the path is the document's; the span is where the
    reading stopped."""
    with pytest.raises(CompositionError) as raised:
        load("{not: [valid")
    (found,) = raised.value.diagnostics
    assert found.code == codes.SYNTAX
    assert found.path == ""
    assert found.span is not None

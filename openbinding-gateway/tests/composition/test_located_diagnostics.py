"""A refusal now says what is wrong, where, and under which code.

Phase F3 begins here, and not with a screen. ``composition/diagnostics.py`` has carried
``Diagnostic``, ``Span``, ``CompositionError`` and sixteen ``c2y_*`` codes since F0, and
**nothing in the repository constructed one**: ``text.parse`` raised ``TextError`` with a
sentence and no position. An editor cannot put a marker on a line it was never told about,
so the authoring API could not be built on top of it.

Three things are pinned here.

**Every refusal carries a code and a path**, and the path is the one a reader would write:
``properties.cost.template``, ``candidates.rows[0]``. ``spans.locate`` turns that into a
region of the source by composing the document a second time -- ``yaml.compose`` keeps the
marks ``yaml.safe_load`` throws away -- and ``parse`` is the one place that attaches them,
because it is the one place that holds the text.

**The schema is consulted at last.** It was already the authority on a composition's shape,
exercised rule by rule by ``test_spec_example_validates.py``, and ``parse`` ignored it. A
document the schema refused could still be read, and the case that found it is a task
declared both ``open`` and ``local``: the reader takes the first kind it recognises while
the schema's ``oneOf`` refuses the pair.

**Nothing downstream had to change.** ``CompositionError`` is a subclass of ``TextError``,
so the two callers outside this package -- the library's content validator and the diff
route -- keep catching every refusal without knowing about diagnostics they do not read.
"""

from __future__ import annotations

import pytest

from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition.diagnostics import CompositionError, TextError
from openbinding_gateway.composition.spans import locate
from openbinding_gateway.composition.text import parse

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


def _refusal(text: str) -> CompositionError:
    with pytest.raises(CompositionError) as raised:
        parse(text)
    return raised.value


def test_the_valid_document_still_parses() -> None:
    """The guard on everything else here: none of this refuses what used to pass."""
    assert parse(SOURCE).composition == "fleet"


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
    """A schema error about the document as a whole reports no path; line 1 beats nowhere."""
    found = locate(SOURCE)
    assert found[""].line == 1
    assert "nothing.here" not in found


def test_a_document_that_does_not_compose_locates_nothing() -> None:
    """Rather than raising a second parse error over the first one."""
    assert locate("{not: [valid") == {}


# -------------------------------------------------------------- the refusals, located


def test_an_unknown_template_names_the_template_and_its_line() -> None:
    refusal = _refusal(SOURCE.replace("    unit: USD/month", "    template: nonsense"))
    first = refusal.diagnostics[0]
    assert first.code == codes.PROPERTY_TEMPLATE
    assert first.path == "properties.cost.template"
    assert first.span is not None and first.span.line == 5


def test_a_task_that_is_two_kinds_at_once_is_refused_by_the_schema() -> None:
    """The gap that consulting the schema closed.

    The reader takes the first kind it recognises, so ``open`` won and ``local`` was
    ignored: the document was read as something the author did not write. The schema's
    ``oneOf`` refuses the pair, and it is now asked.
    """
    refusal = _refusal(
        SOURCE.replace("{open: true, requires: service/pick}",
                       "{open: true, local: true, requires: service/pick}"),
    )
    assert refusal.diagnostics[0].code == codes.SCHEMA
    assert refusal.diagnostics[0].path == "tasks.pick"
    assert refusal.diagnostics[0].span is not None


def test_a_misspelled_key_is_refused_and_points_at_the_document() -> None:
    refusal = _refusal(SOURCE + "studioo: {}\n")
    first = refusal.diagnostics[0]
    assert first.code == codes.SCHEMA
    assert "studioo" in first.message
    assert first.span is not None and first.span.line == 1


def test_every_schema_failure_is_reported_at_once() -> None:
    """A schema says everything that is wrong; an editor wants every marker, not the first."""
    broken = (SOURCE + "studioo: {}\n").replace("{id: c_pick, provides", "{provides")
    refusal = _refusal(broken)
    assert len(refusal.diagnostics) >= 2
    assert {item.code for item in refusal.diagnostics} == {codes.SCHEMA}
    assert any(item.path == "candidates.rows[0]" for item in refusal.diagnostics)


def test_a_refusal_prints_where_before_what() -> None:
    """``Diagnostic.__str__`` is what a terminal and a 422 body both show."""
    refusal = _refusal(SOURCE.replace("    unit: USD/month", "    template: nonsense"))
    assert str(refusal.diagnostics[0]).startswith("5:5: c2y_property_template:")


# ------------------------------------------------------- nothing downstream had to change


def test_a_composition_error_is_a_text_error() -> None:
    """So the library's content validator and the diff route keep working untouched.

    Both catch ``TextError``. Neither reads a diagnostic, and neither had to learn to.
    """
    assert issubclass(CompositionError, TextError)
    with pytest.raises(TextError):
        parse(SOURCE + "studioo: {}\n")


def test_an_unreadable_document_is_still_a_plain_refusal() -> None:
    """Malformed YAML is not a composition with a bad element: there is no document yet."""
    with pytest.raises(Exception) as raised:
        parse("{not: [valid")
    assert not isinstance(raised.value, CompositionError), (
        "a YAML syntax error has no path to name, so it is not a located diagnostic"
    )

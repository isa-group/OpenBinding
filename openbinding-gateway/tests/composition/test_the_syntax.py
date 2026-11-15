"""The YAML a composition may be written in: JSON's data model, in YAML's syntax.

``composition/syntax.py`` narrows ``yaml.SafeLoader`` to what a JSON document can hold, and
every refusal it makes is a ``c2y_syntax`` diagnostic located where PyYAML stopped. These
tests pin each refusal, and above all that **the alias expansion is closed**: a few hundred
bytes of nested aliases took the old reader seconds; refused at the first alias, it costs
nothing.
"""

from __future__ import annotations

import time

import pytest

from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition.diagnostics import CompositionError
from openbinding_gateway.composition.syntax import MAX_DEPTH, TooLong, dump, load

HEAD = """\
syntaxVersion: "1.0"
composition: fleet
version: "1.0.0"
values:
  cost: {value: 10, unit: USD}
binding: {pick: {local: true}}
workflow: pick
"""


def _refusal(text: str) -> codes.Diagnostic:
    with pytest.raises(CompositionError) as raised:
        load(text)
    (only,) = raised.value.diagnostics
    return only


# --------------------------------------------------------------------- what is refused


def test_an_alias_is_refused_where_it_is_used_and_costs_nothing() -> None:
    """The billion laughs, refused at its first alias with nothing expanded.

    The reader this replaced accepted it, and paid for the expansion in its span locator --
    seconds of it -- the moment anything else in the document was refused.
    """
    bomb = HEAD + (
        "presentation:\n"
        "  a: &a [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]\n"
        "  b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\n"
        "  c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\n"
        "  d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]\n"
        "  e: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]\n"
        "  f: &f [*e, *e, *e, *e, *e, *e, *e, *e, *e, *e]\n"
    )
    started = time.perf_counter()
    found = _refusal(bomb)
    assert time.perf_counter() - started < 1.0
    assert found.code == codes.SYNTAX
    assert "alias" in found.message
    assert (found.span.line, found.span.column) == (10, 10)


def test_a_merge_key_is_refused() -> None:
    found = _refusal(HEAD + "presentation: {<<: {shared: 1}}\n")
    assert found.code == codes.SYNTAX
    assert "merge" in found.message


def test_a_duplicate_key_is_refused_rather_than_silently_kept_last() -> None:
    found = _refusal(HEAD.replace('version: "1.0.0"\n', 'version: "1.0.0"\nversion: "2.0.0"\n'))
    assert found.code == codes.SYNTAX
    assert "twice" in found.message
    assert found.span.line == 4


@pytest.mark.parametrize("key", ["on", "yes", "1", "null", "1.5"])
def test_a_key_yaml_does_not_read_as_a_string_is_refused(key: str) -> None:
    """``on:`` is ``True`` to YAML 1.1, and JSON has no key that is not a string."""
    found = _refusal(HEAD.replace("  cost: {value: 10, unit: USD}", f"  {key}: {{value: 10, unit: USD}}"))
    assert found.code == codes.SYNTAX
    assert "quote it" in found.message


def test_the_same_key_quoted_is_a_string() -> None:
    document = load(HEAD.replace("  cost: {value: 10, unit: USD}", '  "on": {value: 10, unit: USD}'))
    assert list(document["values"]) == ["on"]


@pytest.mark.parametrize("value", [".inf", "-.inf", ".nan", ".NaN"])
def test_a_number_that_is_not_finite_is_refused(value: str) -> None:
    """``.inf`` passed the schema, which types a number and not its finiteness."""
    found = _refusal(HEAD.replace("{value: 10, unit: USD}", f"{{value: {value}, unit: USD}}"))
    assert found.code == codes.SYNTAX
    assert "not a finite number" in found.message


@pytest.mark.parametrize("tag", ["!!binary aGVsbG8=", "!!set {a, b}", "!!timestamp 2024-01-01"])
def test_a_value_json_cannot_hold_is_refused(tag: str) -> None:
    found = _refusal(HEAD + f"presentation: {{value: {tag}}}\n")
    assert found.code == codes.SYNTAX
    assert "JSON cannot hold" in found.message


def test_a_plain_date_stays_the_string_it_was_written_as() -> None:
    """A ``datetime`` in a free-form block was a value no JSON response could carry."""
    assert load(HEAD + "presentation: {created: 2024-01-01}\n")["presentation"] == {"created": "2024-01-01"}


def test_nesting_past_the_bound_is_refused_before_anything_recurses() -> None:
    """Measured: parse broke at 163 nested steps; the corpus nests 17 levels counted this way."""
    deep = HEAD.replace(
        "workflow: pick",
        "workflow: " + "{seq: [" * MAX_DEPTH + "pick" + "]}" * MAX_DEPTH,
    )
    found = _refusal(deep)
    assert found.code == codes.SYNTAX
    assert f"deeper than {MAX_DEPTH}" in found.message


def test_text_that_is_not_yaml_is_located_by_the_library_itself() -> None:
    """``c2y_syntax`` is raised by the loader, located where the library stopped."""
    found = _refusal("composition: [unclosed\nversion: 1\n")
    assert found.code == codes.SYNTAX
    assert found.span is not None


def test_more_than_one_document_is_refused() -> None:
    found = _refusal(HEAD + "---\n" + HEAD)
    assert found.code == codes.SYNTAX


def test_an_integer_json_cannot_carry_exactly_is_refused_where_it_is_written() -> None:
    """Past +-(2^53 - 1) a JavaScript reader loses digits and the container refuses it."""
    found = _refusal(HEAD.replace("{value: 10, unit: USD}", "{value: 9007199254740993, unit: USD}"))
    assert found.code == codes.SYNTAX
    assert "2^53" in found.message
    assert found.span.line == 5


def test_a_number_written_past_the_length_bound_is_refused_before_it_is_converted() -> None:
    """YAML 1.1 base-60 integers convert in quadratic time; the bound comes first."""
    sexagesimal = ":".join(["1"] * 40_000)
    started = time.perf_counter()
    found = _refusal(HEAD + f"presentation:\n  n: {sexagesimal}\n")
    assert time.perf_counter() - started < 1.0
    assert found.code == codes.SYNTAX
    assert "quote it" in found.message


def test_a_short_base_60_number_still_reads_as_yaml_1_1_says() -> None:
    """The scalar rules are YAML 1.1's, unchanged: switching would re-read sealed sources."""
    assert load(HEAD + "presentation:\n  n: 1:30\n  flag: yes\n")["presentation"] == {"n": 90, "flag": True}


def test_a_character_yaml_does_not_allow_is_located() -> None:
    found = _refusal(HEAD + 'presentation: {note: "a\x01b"}\n')
    assert found.code == codes.SYNTAX
    assert found.span is not None and found.span.line == 8


# ----------------------------------------------------------------- what is unchanged


def test_the_writer_never_writes_an_alias() -> None:
    """PyYAML writes an anchor for any object that appears twice; the reader refuses it."""
    shared = {"candidate": "c_pick", "from": {"sphere": "acme/pick", "version": "1", "plan": "basic"}}
    text = dump({"binding": {"pick": shared, "ship": shared}})
    assert "&" not in text and "*" not in text
    assert load(text) == {"binding": {"pick": shared, "ship": shared}}


# ------------------------------------------------- what the review of the change found


@pytest.mark.parametrize(
    "value", ["!!int", "!!int ''", "!!float ''", "!!bool maybe", "!!bool ''"],
)
def test_a_scalar_its_own_converter_cannot_read_is_a_located_refusal(value: str) -> None:
    """PyYAML's converters raise plain Python errors for these; they used to escape parse."""
    found = _refusal(HEAD + f"presentation: {{x: {value}}}\n")
    assert found.code == codes.SYNTAX
    assert found.span is not None


def test_a_plain_equals_sign_is_a_string() -> None:
    """YAML 1.1's ``=`` value key is dropped with the merge it served."""
    assert load(HEAD + "presentation:\n  =: equals\n")["presentation"] == {"=": "equals"}


@pytest.mark.parametrize("character", ["\x85", " ", " ", "\t", "\r", "\x00"])
def test_every_string_reads_back_as_written(character: str) -> None:
    """U+0085 was written raw and read back as a space; it is now written escaped."""
    document_ = {"value": f"a{character}b", f"key{character}": 1, "list": [f"{character}"]}
    try:
        assert load(dump(document_)) == document_
    except CompositionError as error:
        # A character YAML does not allow in a document is refused, never changed.
        assert error.diagnostics[0].code == codes.SYNTAX


# ------------------------------------------- what the verification of the fixes found


def test_placing_a_refusal_under_a_long_dotted_key_is_not_quadratic() -> None:
    """The span finder tried every separator in the path at every level; now only the
    lengths of the mapping's own keys."""
    from openbinding_gateway.composition.spans import locate  # noqa: PLC0415

    key = "a." * 60_000 + "a"
    text = (
        HEAD + "presentation:\n  providers:\n    p:\n      properties:\n"
        f"        ? {key}\n        : [1]\n"
    )
    path = f"presentation.providers.p.properties.{key}"
    started = time.perf_counter()
    found = locate(text, [path])
    assert time.perf_counter() - started < 5.0
    assert found[path].line == 12


def test_a_path_is_found_the_way_the_walk_wrote_it() -> None:
    """A key that starts with a bracket, and a dotted key beside a shorter one."""
    from openbinding_gateway.composition.spans import locate  # noqa: PLC0415

    text = (
        "values:\n"
        "  '[x': {value: 1, unit: nope}\n"
        "  cost.unit: {value: 2, unit: USD}\n"
        "  cost: {value: 5, unit: USD}\n"
    )
    wanted = ["values.[x.unit", "values.cost.unit"]
    assert locate(text, wanted) == {path: span for path, span in locate(text).items() if path in wanted or path == ""}


def test_a_position_at_the_end_of_a_buffer_with_no_newline_stays_inside_it() -> None:
    """libyaml puts the end of such a text on a line the buffer does not have."""
    text = HEAD.rstrip("\n").replace("workflow: pick", "workflow: {seq: [pi")
    found = _refusal(text)
    assert found.span.line == len(text.split("\n"))


def test_a_lone_surrogate_in_the_text_is_a_located_refusal() -> None:
    found = _refusal(HEAD + 'presentation: {note: "a\ud800b"}\n')
    assert found.code == codes.SYNTAX
    assert found.span is not None and found.span.line == 8


@pytest.mark.parametrize(
    "text", ["presentation: {draft:}\n", "presentation: {layers: [a:, b:]}\n"],
)
def test_libyamls_reading_of_a_flow_key_with_no_value_is_the_reading_of_record(text: str) -> None:
    """One of the three corners libyaml reads differently from PyYAML's own scanner."""
    assert _refusal(HEAD + text).code == codes.SYNTAX


def test_the_writing_stops_once_it_passes_its_bound() -> None:
    """A long string folds into lines indented by depth: the estimate could not see that."""

    node: object = " ".join(["a"] * 50_000)
    for _ in range(40):
        node = {"a": node}
    started = time.perf_counter()
    with pytest.raises(TooLong):
        dump(node, limit=100_000)
    assert time.perf_counter() - started < 5.0


# ------------------------------------------------- what the canonical writer relies on


def test_a_long_string_is_written_on_one_line() -> None:
    """The writer folds at 4096 columns, past any line a document holds, so nothing folds."""
    note = " ".join(["word"] * 40)
    assert len(note) > 80
    text = dump({"note": note})
    assert text == f"note: {note}\n"
    assert load(text) == {"note": note}


def test_the_bound_counts_utf_8_bytes_not_characters() -> None:
    """The store caps a document in bytes, so the writer does too."""
    document_ = {"note": "é" * 1_000}
    text = dump(document_)
    size = len(text.encode("utf-8"))
    assert len(text) < 1_500 < size
    with pytest.raises(TooLong, match="bytes"):
        dump(document_, limit=1_500)
    assert dump(document_, limit=size) == text

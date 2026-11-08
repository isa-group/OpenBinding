"""The YAML a composition may be written in: JSON's data model, in YAML's syntax.

``composition/syntax.py`` narrows ``yaml.SafeLoader`` to what a JSON document can hold, and
every refusal it makes is a ``c2y_syntax`` diagnostic located where PyYAML stopped. These
tests pin each refusal, and two things that matter more than any one of them:

* **the alias expansion is closed.** A few hundred bytes of nested aliases took ``parse``
  seconds, on routes anyone may call; refused at the first alias, it costs nothing.
* **a document that arrives as JSON is judged by the same rules.** ``compose`` is ``parse``
  after the text, and a body parsed by the web framework -- whose JSON reader accepts ``NaN``
  -- reaches it without the YAML loader's guard.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition.diagnostics import CompositionError
from openbinding_gateway.composition.syntax import MAX_DEPTH, dump, load
from openbinding_gateway.composition.text import compose, document, parse, serialise

FIXTURES = Path(__file__).resolve().parent / "fixtures"

HEAD = """\
composition: fleet
version: "1.0.0"
properties:
  cost: {template: cost}
tasks:
  pick: {local: true}
workflow: {task: pick}
"""


def _refusal(text: str) -> codes.Diagnostic:
    with pytest.raises(CompositionError) as raised:
        parse(text)
    (only,) = raised.value.diagnostics
    return only


# --------------------------------------------------------------------- what is refused


def test_an_alias_is_refused_where_it_is_used_and_costs_nothing() -> None:
    """The billion laughs, refused at its first alias with nothing expanded.

    The reader this replaced accepted it, and paid for the expansion in its span locator --
    seconds of it -- the moment anything else in the document was refused.
    """
    bomb = HEAD + (
        "studio:\n"
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
    found = _refusal(HEAD + "studio: {<<: {shared: 1}}\n")
    assert found.code == codes.SYNTAX
    assert "merge" in found.message


def test_a_duplicate_key_is_refused_rather_than_silently_kept_last() -> None:
    found = _refusal(HEAD.replace('version: "1.0.0"\n', 'version: "1.0.0"\nversion: "2.0.0"\n'))
    assert found.code == codes.SYNTAX
    assert "twice" in found.message
    assert found.span.line == 3


@pytest.mark.parametrize("key", ["on", "yes", "1", "null", "1.5"])
def test_a_key_yaml_does_not_read_as_a_string_is_refused(key: str) -> None:
    """``on:`` is ``True`` to YAML 1.1, and JSON has no key that is not a string."""
    found = _refusal(HEAD.replace("  cost: {template: cost}", f"  {key}: {{template: cost}}"))
    assert found.code == codes.SYNTAX
    assert "quote it" in found.message


def test_the_same_key_quoted_is_a_string() -> None:
    composition = parse(HEAD.replace("  cost: {template: cost}", '  "on": {template: cost}'))
    assert list(composition.properties) == ["on"]


@pytest.mark.parametrize("value", [".inf", "-.inf", ".nan", ".NaN"])
def test_a_number_that_is_not_finite_is_refused(value: str) -> None:
    """``.inf`` passed the schema, which types a number and not its finiteness."""
    found = _refusal(HEAD.replace("{template: cost}", f"{{template: cost, neutral: {value}}}"))
    assert found.code == codes.SYNTAX
    assert "not a finite number" in found.message


@pytest.mark.parametrize("tag", ["!!binary aGVsbG8=", "!!set {a, b}", "!!timestamp 2024-01-01"])
def test_a_value_json_cannot_hold_is_refused(tag: str) -> None:
    found = _refusal(HEAD + f"studio: {{value: {tag}}}\n")
    assert found.code == codes.SYNTAX
    assert "JSON cannot hold" in found.message


def test_a_plain_date_stays_the_string_it_was_written_as() -> None:
    """A ``datetime`` in ``studio`` was a value no JSON response could carry."""
    composition = parse(HEAD + "studio: {created: 2024-01-01}\n")
    assert composition.studio == {"created": "2024-01-01"}
    json.dumps(document(composition))


def test_nesting_past_the_bound_is_refused_before_anything_recurses() -> None:
    """Measured: parse broke at 163 nested steps; the corpus nests 17 levels counted this way."""
    deep = HEAD.replace(
        "workflow: {task: pick}",
        "workflow: " + "{sequence: [" * MAX_DEPTH + "{task: pick}" + "]}" * MAX_DEPTH,
    )
    found = _refusal(deep)
    assert found.code == codes.SYNTAX
    assert f"deeper than {MAX_DEPTH}" in found.message


def test_text_that_is_not_yaml_is_located_by_the_library_itself() -> None:
    """``c2y_syntax`` used to be built by the validate route; now ``parse`` raises it."""
    found = _refusal("composition: [unclosed\nversion: 1\n")
    assert found.code == codes.SYNTAX
    assert found.span is not None


def test_more_than_one_document_is_refused() -> None:
    found = _refusal(HEAD + "---\n" + HEAD)
    assert found.code == codes.SYNTAX


def test_an_integer_json_cannot_carry_exactly_is_refused_where_it_is_written() -> None:
    """Past +-(2^53 - 1) a JavaScript reader loses digits and the container refuses it."""
    found = _refusal(HEAD.replace("{template: cost}", "{template: cost, neutral: 9007199254740993}"))
    assert found.code == codes.SYNTAX
    assert "2^53" in found.message
    assert found.span.line == 4


def test_a_number_written_past_the_length_bound_is_refused_before_it_is_converted() -> None:
    """YAML 1.1 base-60 integers convert in quadratic time; the bound comes first."""
    sexagesimal = ":".join(["1"] * 40_000)
    started = time.perf_counter()
    found = _refusal(HEAD + f"studio:\n  n: {sexagesimal}\n")
    assert time.perf_counter() - started < 1.0
    assert found.code == codes.SYNTAX
    assert "quote it" in found.message


def test_a_short_base_60_number_still_reads_as_yaml_1_1_says() -> None:
    """The scalar rules are YAML 1.1's, unchanged: switching would re-read sealed sources."""
    assert parse(HEAD + "studio:\n  n: 1:30\n  flag: yes\n").studio == {"n": 90, "flag": True}


def test_a_character_yaml_does_not_allow_is_located() -> None:
    found = _refusal(HEAD + 'studio: {note: "a\x01b"}\n')
    assert found.code == codes.SYNTAX
    assert found.span is not None and found.span.line == 8


# ----------------------------------------------------------------- what is unchanged


@pytest.mark.parametrize("name", ["fleet-management-v1.c2y.yaml", "fleet-management-v2.c2y.yaml"])
def test_the_guiding_case_reads_exactly_as_before(name: str) -> None:
    """The loader narrows what YAML may say; it does not change what a composition says."""
    import yaml  # noqa: PLC0415

    text = (FIXTURES / name).read_text(encoding="utf-8")
    assert load(text) == yaml.safe_load(text)
    assert parse(serialise(parse(text))) == parse(text)


def test_the_writer_never_writes_an_alias() -> None:
    """PyYAML writes an anchor for any object that appears twice; the reader refuses it."""
    shared = {"cost": 10.0}
    text = dump({"rows": [{"properties": shared}, {"properties": shared}]})
    assert "&" not in text and "*" not in text
    assert load(text) == {"rows": [{"properties": {"cost": 10.0}}, {"properties": {"cost": 10.0}}]}


# ------------------------------------------------- a document that arrives as JSON


def _composed(body: object) -> list[codes.Diagnostic]:
    with pytest.raises(CompositionError) as raised:
        compose(body)
    return list(raised.value.diagnostics)


def test_a_json_document_reads_as_the_same_composition_its_text_does() -> None:
    text = (FIXTURES / "fleet-management-v1.c2y.yaml").read_text(encoding="utf-8")
    composition = parse(text)
    assert compose(json.loads(json.dumps(document(composition)))) == composition


def test_the_document_is_a_copy_the_caller_may_edit() -> None:
    composition = parse(HEAD + "studio: {notes: [a]}\n")
    copied = document(composition)
    copied["studio"]["notes"].append("b")
    assert composition.studio == {"notes": ["a"]}


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_a_json_number_that_is_not_finite_is_refused_by_path(value: float) -> None:
    """``json.loads`` accepts ``NaN``; the YAML loader's guard never saw this document."""
    body = json.loads(json.dumps(document(parse(HEAD))))
    body["properties"]["cost"]["neutral"] = value
    (found,) = _composed(body)
    assert found.code == codes.SCHEMA
    assert found.path == "properties.cost.neutral"
    assert found.span is None


def test_a_json_integer_past_the_safe_range_is_refused_by_path() -> None:
    body = json.loads(json.dumps(document(parse(HEAD))))
    body["properties"]["cost"]["neutral"] = 2**53
    (found,) = _composed(body)
    assert (found.code, found.path) == (codes.SCHEMA, "properties.cost.neutral")


def test_a_json_string_that_is_not_text_is_refused_by_path() -> None:
    body = json.loads(json.dumps(document(parse(HEAD))))
    body["properties"]["cost"]["title"] = "\ud800"
    (found,) = _composed(body)
    assert found.path == "properties.cost.title"


def test_a_value_json_has_no_type_for_is_refused_by_path() -> None:
    body = json.loads(json.dumps(document(parse(HEAD))))
    body["studio"] = {"when": {1, 2}}
    (found,) = _composed(body)
    assert found.path == "studio.when"


def test_a_json_document_nested_past_the_bound_is_refused_without_recursing() -> None:
    """The walk uses a stack: the document it refuses would exhaust a recursive one."""
    body = json.loads(json.dumps(document(parse(HEAD))))
    node: dict = {"task": "pick"}
    for _ in range(5_000):
        node = {"sequence": [node]}
    body["workflow"] = node
    found = _composed(body)
    assert [item.code for item in found] == [codes.SCHEMA]
    assert f"deeper than {MAX_DEPTH}" in found[0].message


# ------------------------------------------------- what the review of the change found


@pytest.mark.parametrize(
    "value", ["!!int", "!!int ''", "!!float ''", "!!bool maybe", "!!bool ''"],
)
def test_a_scalar_its_own_converter_cannot_read_is_a_located_refusal(value: str) -> None:
    """PyYAML's converters raise plain Python errors for these; they used to escape parse."""
    found = _refusal(HEAD + f"studio: {{x: {value}}}\n")
    assert found.code == codes.SYNTAX
    assert found.span is not None


def test_a_plain_equals_sign_is_a_string() -> None:
    """YAML 1.1's ``=`` value key is dropped with the merge it served."""
    assert parse(HEAD + "studio:\n  =: equals\n").studio == {"=": "equals"}


@pytest.mark.parametrize("character", ["\x85", " ", " ", "\t", "\r", "\x00"])
def test_every_string_reads_back_as_written(character: str) -> None:
    """U+0085 was written raw and read back as a space; it is now written escaped."""
    document_ = {"value": f"a{character}b", f"key{character}": 1, "list": [f"{character}"]}
    try:
        assert load(dump(document_)) == document_
    except CompositionError as error:
        # A character YAML does not allow in a document is refused, never changed.
        assert error.diagnostics[0].code == codes.SYNTAX


def test_a_long_key_over_a_long_list_costs_its_size_not_their_product() -> None:
    """Each node used to carry its full path: 40,000 characters times 10,000 items."""
    import tracemalloc  # noqa: PLC0415

    from openbinding_gateway.composition.text import unrepresentable  # noqa: PLC0415

    body = {"studio": {"k" * 40_000: [0] * 10_000}}
    tracemalloc.start()
    try:
        unrepresentable(body)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 20_000_000


def test_a_refusal_lists_the_first_hundred_problems() -> None:
    rules = "\n".join(f"  - {position}" for position in range(300))
    with pytest.raises(CompositionError) as raised:
        parse(HEAD + f"rules:\n{rules}\n")
    found = raised.value.diagnostics
    assert len(found) == 101
    assert found[-1].code == codes.MORE


# ------------------------------------------- what the verification of the fixes found


def test_placing_a_refusal_under_a_long_dotted_key_is_not_quadratic() -> None:
    """The span finder tried every separator in the path at every level; now only the
    lengths of the mapping's own keys."""
    key = "a." * 60_000 + "a"
    text = (
        HEAD + "candidates:\n  providers:\n    p:\n      properties:\n"
        f"        ? {key}\n        : [1]\n"
    )
    started = time.perf_counter()
    with pytest.raises(CompositionError):
        parse(text)
    assert time.perf_counter() - started < 5.0


def test_a_path_is_found_the_way_the_walk_wrote_it() -> None:
    """A key that starts with a bracket, and a dotted key beside a shorter one."""
    from openbinding_gateway.composition.spans import locate  # noqa: PLC0415

    text = (
        "properties:\n"
        "  '[x': {template: nope}\n"
        "  cost.neutral: {template: cost}\n"
        "  cost: {template: cost, neutral: 5}\n"
    )
    wanted = ["properties.[x.template", "properties.cost.neutral"]
    assert locate(text, wanted) == {path: span for path, span in locate(text).items() if path in wanted or path == ""}


def test_a_kind_that_is_not_even_a_string_is_the_schemas_to_name() -> None:
    """Hashing it in the coherence check raised a TypeError past the schema."""
    with pytest.raises(CompositionError) as raised:
        parse(HEAD.replace("{template: cost}", "{template: cost, domain: {kind: [ratio]}}"))
    assert [item.code for item in raised.value.diagnostics] == [codes.SCHEMA]


def test_a_position_at_the_end_of_a_buffer_with_no_newline_stays_inside_it() -> None:
    """libyaml puts the end of such a text on a line the buffer does not have."""
    text = HEAD.rstrip("\n").replace("workflow: {task: pick}", "workflow: {task: pi")
    found = _refusal(text)
    assert found.span.line == len(text.split("\n"))


def test_a_lone_surrogate_in_the_text_is_a_located_refusal() -> None:
    found = _refusal(HEAD + 'studio: {note: "a\ud800b"}\n')
    assert found.code == codes.SYNTAX
    assert found.span is not None and found.span.line == 8


@pytest.mark.parametrize(
    "text", ["studio: {draft:}\n", "studio: {layers: [a:, b:]}\n"],
)
def test_libyamls_reading_of_a_flow_key_with_no_value_is_the_reading_of_record(text: str) -> None:
    """One of the three corners libyaml reads differently from PyYAML's own scanner."""
    assert _refusal(HEAD + text).code == codes.SYNTAX


def test_the_schemas_note_does_not_invent_a_count() -> None:
    """The schema's search stops one past the list, so how many more is not known."""
    rules = "\n".join(f"  - {position}" for position in range(300))
    with pytest.raises(CompositionError) as raised:
        parse(HEAD + f"rules:\n{rules}\n")
    note = raised.value.diagnostics[-1]
    assert note.code == codes.MORE
    assert not any(character.isdigit() for character in note.message)


def test_the_writing_stops_once_it_passes_its_bound() -> None:
    """A long string folds into lines indented by depth: the estimate could not see that."""
    from openbinding_gateway.composition.syntax import TooLong  # noqa: PLC0415

    node: object = " ".join(["a"] * 50_000)
    for _ in range(40):
        node = {"a": node}
    started = time.perf_counter()
    with pytest.raises(TooLong):
        dump(node, limit=100_000)
    assert time.perf_counter() - started < 5.0

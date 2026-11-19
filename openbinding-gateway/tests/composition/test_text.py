"""Reading and writing Composition2Yaml text: canonical bytes, bounds, and what a reading reports.

The canonical bytes are a fixed point: a document read from its own canonical text is the
same document, and writes the same bytes again. A JSON body judged by ``compose`` is the same
document as its YAML text. The size bound counts UTF-8 bytes on the way in and on the way
out, because the canonical text is what a version stores.
"""

from __future__ import annotations

import json
import time
from pathlib import Path as FilePath

import pytest

from _paths import TESTS_DIR
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition import checks, spans, syntax, text
from openbinding_gateway.composition.diagnostics import CompositionError, Path
from openbinding_gateway.composition.document import Entry, Evidence, Offering, Provenance, Value
from openbinding_gateway.composition.workflow import Branch, EmptyNode, Exclusive, Sequence, TaskNode

GOLDEN = TESTS_DIR / "composition" / "golden"
VALID = sorted(
    path for path in (GOLDEN / "valid").glob("*.yaml") if not path.name.endswith(".canonical.yaml")
)

HEAD = 'syntaxVersion: "1.0"\ncomposition: shop\nversion: 1.0.0\nkind: application\n'
MINIMAL = HEAD + "workflow: pick\nbinding: {pick: {candidate: c_pick}}\nvalues: {}\n"
LAB = text.Context(registries=frozenset({"lab"}))


def _context(source: FilePath) -> text.Context:
    """The deployment and entity a golden is read in: its ``.context.json``, if it has one."""
    path = source.with_name(source.name.removesuffix(".yaml") + ".context.json")
    if not path.is_file():
        return text.Context()
    given = json.loads(path.read_text(encoding="utf-8"))
    return text.Context(registries=frozenset(given.get("registries", ())), entity_slug=given.get("entity_slug"))


def _codes(reading: text.Reading) -> list[tuple[str, str]]:
    return [(item.code, item.path) for item in reading.diagnostics]


def _big(count: int, plan: str = "basic", *, flow: bool = True, registry: bool = False) -> str:
    """A document of ``count`` tasks in one parallel block, each bound with a provenance."""
    where = ", registry: lab" if registry else ""
    names = [f"t{position}" for position in range(count)]
    entries = ", ".join(
        f"{name}: {{candidate: c{name}, from: {{sphere: acme/pricing{where}, version: v1, plan: {plan}}}}}"
        for name in names
    )
    source = HEAD + f"workflow: {{and: [{', '.join(names)}]}}\nbinding: {{{entries}}}\nvalues: {{}}\n"
    if registry:
        source += "offering: {sphere: acme/offer, registry: lab}\n"
    return source if flow else text.serialise(text.parse(source, context=LAB))


# --------------------------------------------------------------------------- canonical bytes


@pytest.mark.parametrize("source", VALID, ids=lambda path: path.stem)
def test_the_canonical_bytes_are_a_fixed_point(source: FilePath) -> None:
    context = _context(source)
    document = text.parse(source.read_text(encoding="utf-8"), context=context)
    canonical = text.serialise(document)
    again = text.parse(canonical, context=context)
    assert again == document
    assert text.serialise(again) == canonical


@pytest.mark.parametrize("source", VALID, ids=lambda path: path.stem)
def test_a_json_body_is_the_same_document_as_its_text(source: FilePath) -> None:
    context = _context(source)
    read = text.read(source.read_text(encoding="utf-8"), context=context)
    body = json.loads(json.dumps(text.document(read.document)))
    reading = text.compose(body, context=context)
    assert [(item.code, item.severity, item.path) for item in reading.diagnostics] == [
        (item.code, item.severity, item.path) for item in read.diagnostics
    ]
    assert reading.document == read.document


def test_the_binding_follows_the_workflow_and_the_values_are_sorted() -> None:
    source = HEAD + (
        "workflow: {seq: [pick, {loop: pack, count: 3}, ship]}\n"
        "binding: {ship: {candidate: c_ship}, pick: {candidate: c_pick}, pack: {candidate: c_pack}}\n"
        "values: {latency: {value: 12, unit: ms}, cost: 4.5, availability: 0.99}\n"
    )
    document = text.parse(source)
    assert [task for task, _ in document.binding] == ["pick", "pack", "ship"]
    assert [name for name, _ in document.values] == ["availability", "cost", "latency"]
    canonical = text.serialise(document)
    assert canonical.index("  pick:") < canonical.index("  pack:") < canonical.index("  ship:")
    assert document.entry("pack") == Entry(candidate="c_pack")
    assert document.value("latency") == Value(12, "ms")
    assert document.value("cost") == Value(4.5)
    assert document.entry("nothing") is None and document.value("nothing") is None


def test_the_canonical_text_is_block_style_and_folds_nothing() -> None:
    toolchain = "bim-core " + "x" * 200
    source = MINIMAL + f"evidence: {{manual: true, evaluatedBy: declared, toolchain: {toolchain}}}\n"
    canonical = text.serialise(text.parse(source))
    assert "{" not in canonical.replace("values: {}", "")
    assert f"  toolchain: {toolchain}\n" in canonical


def test_a_zero_probability_and_a_long_unit_with_spaces_are_kept() -> None:
    """Both are legal in BIM (``routingEntry.probability`` ``minimum: 0``, a unit is any non-empty string)."""
    unit = "requests per second at peak " * 7 + "ok"
    assert len(unit) == 198 and " " in unit
    source = HEAD + (
        "workflow: {xor: [{probability: 0, flow: a}, {probability: 1, flow: b}]}\n"
        "binding: {a: {candidate: ca}, b: {candidate: cb}}\n"
        f"values: {{throughput: {{value: 3, unit: '{unit}'}}}}\n"
    )
    document = text.parse(source)
    assert document.workflow == Exclusive(branches=(Branch(TaskNode("a"), 0), Branch(TaskNode("b"), 1)))
    assert document.value("throughput") == Value(3, unit)
    canonical = text.serialise(document)
    assert "probability: 0\n" in canonical
    assert text.parse(canonical) == document
    assert text.serialise(text.parse(canonical)) == canonical


def test_nested_sequences_are_flattened_and_keep_their_paths() -> None:
    document = text.parse((GOLDEN / "valid" / "05_nested_seq.yaml").read_text(encoding="utf-8"))
    assert document.workflow == Sequence((TaskNode("a"), TaskNode("b"), TaskNode("c"), TaskNode("d")))
    assert document.paths.nodes[()] == Path(("workflow",))
    assert document.paths.nodes[(1,)] == Path(("workflow", "seq", 1, "seq", 0))
    assert document.paths.nodes[(2,)] == Path(("workflow", "seq", 1, "seq", 1, "seq", 0))
    assert document.paths.nodes[(3,)] == Path(("workflow", "seq", 2))
    assert document.paths.leaves["c"] == Path(("workflow", "seq", 1, "seq", 1, "seq", 0))


def test_the_empty_step_and_the_paths_of_weighted_branches() -> None:
    document = text.parse((GOLDEN / "valid" / "06_empty_step.yaml").read_text(encoding="utf-8"))
    choice = document.workflow.children[1]
    assert isinstance(choice, Exclusive) and choice.branches[1].flow == EmptyNode()
    assert document.paths.nodes[(1, 0)] == Path(("workflow", "seq", 1, "xor", 0, "flow"))


def test_a_document_built_in_code_writes_like_a_read_one() -> None:
    read = text.parse((GOLDEN / "valid" / "02_tomatometer.yaml").read_text(encoding="utf-8"))
    built = type(read)(
        syntax_version=read.syntax_version, composition=read.composition, version=read.version,
        kind=read.kind, problem=read.problem, workflow=read.workflow,
        binding=tuple(reversed(read.binding)), values=tuple(reversed(read.values)),
        offering=Offering(sphere="sphere/tomatometer"),
        evidence=Evidence(run=read.evidence.run, evaluated_by="gateway", toolchain="bim-core 0.2.0"),
    )
    assert text.serialise(built) == text.serialise(read)


# --------------------------------------------------------------------------- what JSON cannot hold


@pytest.mark.parametrize(
    ("value", "path"),
    [
        (float("nan"), "values.ratio"),
        (2**53, "values.ratio"),
        ("\ud800", "values.ratio.unit"),
    ],
    ids=["nan", "past-2-53", "lone-surrogate"],
)
def test_a_json_body_with_a_value_json_cannot_hold_is_refused(value: object, path: str) -> None:
    body = json.loads(json.dumps(text.document(text.parse(MINIMAL))))
    body["values"]["ratio"] = {"value": 1, "unit": value} if isinstance(value, str) else value
    reading = text.compose(body)
    assert _codes(reading) == [(codes.SYNTAX, path)]
    assert reading.document is None


def test_a_json_body_nested_past_the_bound_is_refused() -> None:
    nested: object = "a"
    for _ in range(syntax.MAX_DEPTH):
        nested = [nested]
    body = json.loads(json.dumps(text.document(text.parse(MINIMAL))))
    body["values"]["deep"] = nested
    reading = text.compose(body)
    assert [item.code for item in reading.diagnostics] == [codes.SYNTAX]
    assert "nests deeper than 64" in reading.diagnostics[0].message


# --------------------------------------------------------------------------- the size bound


def test_exactly_the_limit_reads_and_one_byte_more_does_not() -> None:
    room = text.MAX_SOURCE_BYTES - len(MINIMAL.encode("utf-8")) - 2
    exact = MINIMAL + "#" + "é" * (room // 2) + "x" * (room % 2) + "\n"
    assert len(exact.encode("utf-8")) == text.MAX_SOURCE_BYTES
    assert text.read(exact).valid
    over = text.read(exact + " ")
    assert _codes(over) == [(codes.TOO_LONG, "")]


def test_a_canonical_text_past_the_limit_is_refused() -> None:
    """Flow style grows in block form: the source fits and its canonical text does not."""
    plan = "é" * 128
    count = 1
    while len(_big(count * 2, plan).encode("utf-8")) <= text.MAX_SOURCE_BYTES:
        count *= 2
    low, high = count, count * 2
    while high - low > 1:
        middle = (low + high) // 2
        low, high = (middle, high) if len(_big(middle, plan).encode("utf-8")) <= text.MAX_SOURCE_BYTES else (low, middle)
    source = _big(low, plan)
    reading = text.read(source)
    assert reading.valid
    assert len(syntax.dump(text.document(reading.document)).encode("utf-8")) > text.MAX_SOURCE_BYTES
    with pytest.raises(CompositionError) as refused:
        text.serialise(reading.document)
    assert [(item.code, item.path) for item in refused.value.diagnostics] == [(codes.TOO_LONG, "")]


def test_the_canonical_limit_counts_bytes_not_characters() -> None:
    plan = "é" * 128
    body = json.loads(json.dumps(text.document(text.parse(_big(2, plan)))))
    for position in range(2, 1000):
        body["workflow"]["and"].append(f"t{position}")
        body["binding"][f"t{position}"] = body["binding"]["t0"]
    reading = text.compose(body)
    assert reading.valid
    written = syntax.dump(text.document(reading.document))
    assert len(written) <= text.MAX_SOURCE_BYTES < len(written.encode("utf-8"))
    with pytest.raises(CompositionError):
        text.serialise(reading.document)


def test_a_256_kib_document_reads_in_under_two_seconds() -> None:
    source = _big(1700, flow=False)
    source += "#" * (text.MAX_SOURCE_BYTES - len(source.encode("utf-8")) - 1) + "\n"
    assert len(source.encode("utf-8")) == text.MAX_SOURCE_BYTES
    started = time.perf_counter()
    reading = text.read(source)
    elapsed = time.perf_counter() - started
    assert reading.valid
    assert elapsed < 2.0, f"reading took {elapsed:.2f} s"


# --------------------------------------------------------------------------- stored versions


def test_a_stored_version_reads_without_the_deployment_checks() -> None:
    canonical = _big(3, registry=True, flow=False)
    assert "registry: lab" in canonical
    document = text.read_stored(canonical)
    assert document.offering == Offering(sphere="acme/offer", registry="lab")
    assert document.entry("t0").source == Provenance(sphere="acme/pricing", registry="lab", version="v1", plan="basic")
    reading = text.read(canonical, context=text.Context(stored=True, entity_slug="other"))
    assert reading.diagnostics == ()
    plain = text.read(canonical, context=text.Context(entity_slug="other"))
    assert sorted({(item.code, item.severity) for item in plain.diagnostics}) == [
        (codes.FROM_REGISTRY_UNKNOWN, "error"),
        (codes.OFFERING_REGISTRY_UNKNOWN, "warning"),
        (codes.SLUG_MISMATCH, "info"),
    ]
    assert [item.path for item in plain.errors] == [f"binding.t{position}.from.registry" for position in range(3)]


def test_a_stored_version_that_does_not_read_is_a_bug() -> None:
    with pytest.raises(text.StoredContentError) as refused:
        text.read_stored(MINIMAL.replace("kind: application", "kind: service"))
    assert [item.code for item in refused.value.diagnostics] == [codes.KIND_UNKNOWN]


# --------------------------------------------------------------------------- what a reading reports


def test_a_clean_document_is_never_located(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_: object, **__: object) -> None:
        raise AssertionError("a clean document was located")

    monkeypatch.setattr(spans, "locate", refuse)
    reading = text.read((GOLDEN / "valid" / "02_tomatometer.yaml").read_text(encoding="utf-8"))
    assert reading.valid and reading.diagnostics == ()


def test_parse_raises_with_every_located_diagnostic() -> None:
    source = MINIMAL.replace("kind: application", "kind: service").replace("composition: shop", "composition: My Shop")
    with pytest.raises(CompositionError) as refused:
        text.parse(source)
    found = [(item.code, item.span.line) for item in refused.value.diagnostics]
    assert found == [(codes.SLUG_INVALID, 2), (codes.KIND_UNKNOWN, 4)]


def test_a_root_that_is_not_a_mapping_is_refused() -> None:
    assert _codes(text.read("- a\n- b\n")) == [(codes.TYPE, "")]
    assert _codes(text.read("")) == [(codes.TYPE, "")]


def test_a_syntax_refusal_has_the_root_pointer() -> None:
    reading = text.read("syntaxVersion: [1.0\n")
    assert [(item.code, item.pointer) for item in reading.diagnostics] == [(codes.SYNTAX, "")]


def test_more_findings_than_are_listed_end_with_a_note() -> None:
    entries = ", ".join(f"{position}x: {{candidate: c}}" for position in range(150))
    source = HEAD + f"workflow: null\nbinding: {{{entries}}}\nvalues: {{}}\n"
    reading = text.read(source)
    assert len(reading.diagnostics) == codes.MAX_LISTED + 1
    assert reading.diagnostics[-1].code == codes.MORE and reading.diagnostics[-1].severity == "info"
    assert {item.code for item in reading.errors} == {codes.TASK_ID_INVALID}


def test_the_schema_backstops_what_the_checks_miss(monkeypatch: pytest.MonkeyPatch) -> None:
    source = MINIMAL + "evidence: {evaluatedBy: robot}\n"
    assert _codes(text.read(source)) == [(codes.EVIDENCE_SHAPE, "evidence.evaluatedBy")]
    monkeypatch.setattr(checks, "coherence", lambda *_, **__: ())
    reading = text.read(source)
    assert _codes(reading) == [(codes.SCHEMA, "evidence.evaluatedBy")]
    assert reading.diagnostics[0].span.line == 8


WORKFLOWS = [
    ("{seq: []}", codes.WORKFLOW_MALFORMED, "workflow.seq"),
    ("{seq: pick}", codes.WORKFLOW_MALFORMED, "workflow.seq"),
    ("[pick]", codes.WORKFLOW_MALFORMED, "workflow"),
    ("yes", codes.WORKFLOW_MALFORMED, "workflow"),
    ("3", codes.WORKFLOW_MALFORMED, "workflow"),
    ("{seq: [pick], and: [pick]}", codes.WORKFLOW_MALFORMED, "workflow"),
    ("{steps: [pick]}", codes.WORKFLOW_MALFORMED, "workflow"),
    ("{seq: [pick], uniform: true}", codes.WORKFLOW_MALFORMED, "workflow.uniform"),
    ("{seq: [pick], label: x}", codes.UNKNOWN_KEY, "workflow.label"),
    ("{loop: pick, count: 2, expected: 2.5}", codes.WORKFLOW_MALFORMED, "workflow"),
    ("{loop: pick, count: -1}", codes.WORKFLOW_MALFORMED, "workflow.count"),
    ("{loop: pick, expected: -0.5}", codes.WORKFLOW_MALFORMED, "workflow.expected"),
    ("{loop: pick, count: 2.0}", codes.TYPE, "workflow.count"),
    ("{xor: [{probability: 0.5}]}", codes.WORKFLOW_MALFORMED, "workflow.xor[0]"),
    ("{xor: [{flow: pick}]}", codes.WORKFLOW_MALFORMED, "workflow.xor[0]"),
    ("{xor: [{probability: 1.5, flow: pick}]}", codes.WORKFLOW_MALFORMED, "workflow.xor[0].probability"),
    ("{xor: [{probability: half, flow: pick}]}", codes.TYPE, "workflow.xor[0].probability"),
    ("{xor: [{probability: 1, flow: pick, weight: 2}]}", codes.UNKNOWN_KEY, "workflow.xor[0].weight"),
    ("{xor: [pick], uniform: maybe}", codes.TYPE, "workflow.uniform"),
    ("{probability: 1, flow: pick}", codes.WORKFLOW_MALFORMED, "workflow"),
    ("{seq: [pick, 'not a task']}", codes.TASK_ID_INVALID, "workflow.seq[1]"),
]


@pytest.mark.parametrize(("workflow", "code", "path"), WORKFLOWS, ids=[case[0] for case in WORKFLOWS])
def test_a_malformed_workflow_is_refused_at_the_node(workflow: str, code: str, path: str) -> None:
    reading = text.read(HEAD + f"workflow: {workflow}\nbinding: {{pick: {{candidate: c}}}}\nvalues: {{}}\n")
    assert _codes(reading) == [(code, path)]
    assert reading.diagnostics[0].span is not None


SECTIONS = [
    ("problem: {ref: isa/problems/p@3}", [(codes.MISSING_KEY, "problem.compilation")]),
    ("problem: {ref: isa/problems/p@3, compilation: sha256-" + "0" * 64 + ", tasks: []}", [(codes.UNKNOWN_KEY, "problem.tasks")]),
    ("problem: isa/problems/p@3", [(codes.TYPE, "problem")]),
    ("evidence: {run: 7}", [(codes.TYPE, "evidence.run")]),
    ("evidence: {point: '1', manual: 1}", [(codes.TYPE, "evidence.point"), (codes.TYPE, "evidence.manual")]),
    ("evidence: {by: me}", [(codes.UNKNOWN_KEY, "evidence.by")]),
]


@pytest.mark.parametrize(("section", "found"), SECTIONS, ids=[case[0] for case in SECTIONS])
def test_an_optional_section_is_read_by_its_own_reader(section: str, found: list) -> None:
    assert _codes(text.read(MINIMAL + section + "\n")) == found


BINDINGS = [
    ("{pick: c_pick}", [(codes.TYPE, "binding.pick")]),
    ("{pick: {candidate: 7}}", [(codes.TYPE, "binding.pick.candidate")]),
    ("{pick: {candidate: c, local: yes please}}", [(codes.TYPE, "binding.pick.local")]),
    ("{pick: {candidate: c, alternatives: [d]}}", [(codes.PROBLEM_CONTENT, "binding.pick.alternatives")]),
    ("{pick: {candidate: c, from: {sphere: a/b, version: v, plan: p, contentHash: x}}}", [(codes.UNKNOWN_KEY, "binding.pick.from.contentHash")]),
    ("{pick: {candidate: c, from: {sphere: a/b, version: 3, plan: p}}}", [(codes.TYPE, "binding.pick.from.version")]),
    ("{pick: {candidate: c, from: {sphere: a/b, version: v, plan: p, addons: x}}}", [(codes.TYPE, "binding.pick.from.addons")]),
    ("{pick: {candidate: c, from: {sphere: a/b, version: v, plan: p, addons: [1]}}}", [(codes.TYPE, "binding.pick.from.addons[0]")]),
    ("{pick: {candidate: c, from: a/b}}", [(codes.TYPE, "binding.pick.from")]),
]


@pytest.mark.parametrize(("binding", "found"), BINDINGS, ids=[case[0] for case in BINDINGS])
def test_a_binding_entry_is_read_field_by_field(binding: str, found: list) -> None:
    source = HEAD + f"workflow: pick\nbinding: {binding}\nvalues: {{}}\n"
    assert _codes(text.read(source)) == found


VALUES = [
    ("{cost: cheap}", [(codes.TYPE, "values.cost")]),
    ("{cost: {value: 1}}", [(codes.MISSING_KEY, "values.cost.unit")]),
    ("{cost: {value: 1, unit: 2}}", [(codes.TYPE, "values.cost.unit")]),
    ("{cost: {value: '1', unit: EUR}}", [(codes.TYPE, "values.cost.value")]),
    ("{cost: {value: 1, unit: EUR, scope: run}}", [(codes.UNKNOWN_KEY, "values.cost.scope")]),
    ("{1cost: 3}", [(codes.PROPERTY_ID_INVALID, "values.1cost")]),
    ("[cost]", [(codes.TYPE, "values")]),
]


@pytest.mark.parametrize(("values", "found"), VALUES, ids=[case[0] for case in VALUES])
def test_values_are_read_property_by_property(values: str, found: list) -> None:
    source = HEAD + f"workflow: pick\nbinding: {{pick: {{candidate: c}}}}\nvalues: {values}\n"
    assert _codes(text.read(source)) == found


def test_a_missing_key_is_underlined_at_its_parent() -> None:
    reading = text.read(HEAD + "workflow: pick\nbinding: {pick: {candidate: c}}\nvalues: {cost: {value: 1}}\n")
    (found,) = reading.diagnostics
    assert (found.path, found.pointer) == ("values.cost.unit", "/values/cost/unit")
    assert (found.span.line, found.span.column) == (7, 10)

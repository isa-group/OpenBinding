"""What changed between two Composition2Yaml documents, in SPHERE's PricingDiff shape.

The mutation table changes one field of every dataclass of ``document.py`` at a time and
names exactly the changes the diff must report (none for ``version`` and ``evidence``, which
differ between versions by definition). It is checked complete against ``dataclasses.fields``,
so a field added to the model without a row here fails.
"""

from __future__ import annotations

import dataclasses
import json
from dataclasses import replace
from typing import Callable

import pytest

from openbinding_gateway.composition import document as model
from openbinding_gateway.composition import text
from openbinding_gateway.composition.diff import KINDS, SECTIONS, comparison, diff, value_status
from openbinding_gateway.composition.document import Document, Evidence, Offering, ProblemRef, Provenance, Value
from openbinding_gateway.composition.workflow import Branch, Exclusive, Sequence, TaskNode

RUN = "3f2b8c1e-7d4a-4e9b-9c1f-2a6d8e5b7c90"
DIGEST = "sha256-" + "0" * 64
SOURCE = f"""\
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
problem: {{ref: isa/problems/shop@3, compilation: {DIGEST}}}
workflow: {{seq: [pick, {{xor: [{{probability: 0.25, flow: pack}}, {{probability: 0.75, flow: wrap}}]}}, ship]}}
binding:
  pick: {{candidate: c_pick, from: {{sphere: acme/pick, registry: lab, version: v1, plan: basic, addons: [fast, safe]}}}}
  pack: {{candidate: c_pack}}
  wrap: {{local: true}}
  ship: {{candidate: c_ship}}
values: {{cost: {{value: 4.5, unit: EUR/month}}, availability: 0.99}}
offering: {{sphere: isa/shop}}
evidence: {{run: {RUN}, point: 2, evaluatedBy: gateway, toolchain: bim-core 0.2.0}}
"""
#: The deployment the documents are read in: it defines the registry ``pick``'s provenance names.
LAB = text.Context(registries=frozenset({"lab"}))
BASE = text.parse(SOURCE, context=LAB)


def _entry(document: Document, task: str, **changes: object) -> Document:
    return replace(document, binding=tuple(
        (name, replace(entry, **changes) if name == task else entry) for name, entry in document.binding
    ))


def _source(document: Document, **changes: object) -> Document:
    return _entry(document, "pick", source=replace(document.entry("pick").source, **changes))


def _value(document: Document, name: str, **changes: object) -> Document:
    return replace(document, values=tuple(
        (key, replace(value, **changes) if key == name else value) for key, value in document.values
    ))


def _ref(document: Document, **changes: object) -> Document:
    return replace(document, problem=replace(document.problem, ref=replace(document.problem.ref, **changes)))


def _offering(document: Document, **changes: object) -> Document:
    return replace(document, offering=replace(document.offering, **changes))


def _evidence(document: Document, **changes: object) -> Document:
    return replace(document, evidence=replace(document.evidence, **changes))


def _swapped(document: Document) -> Document:
    first, choice, last = document.workflow.children
    return replace(document, workflow=Sequence((last, choice, first)))


REF = "isa/problems/shop@3"
PICK_FROM = {"sphere": "acme/pick", "registry": "lab", "version": "v1", "plan": "basic", "addons": ["fast", "safe"]}
WORKFLOW = {"seq": ["pick", {"xor": [{"probability": 0.25, "flow": "pack"}, {"probability": 0.75, "flow": "wrap"}]}, "ship"]}

#: One reported field change: ``(section, entry, kind, path, before, after)``; general changes have
#: section ``general`` and no entry.
Row = tuple[str, "str | None", str, str, object, object]


def rows(found: dict) -> tuple[Row, ...]:
    """Every field change of a diff, in the order it lists them."""
    listed: list[Row] = [("general", None, "changed", c["path"], c["before"], c["after"]) for c in found["general"]]
    for section in found["sections"]:
        for entry in section["entries"]:
            listed += [
                (section["key"], entry["name"], entry["kind"], c["path"], c["before"], c["after"])
                for c in entry["changes"]
            ]
    return tuple(listed)


MUTATIONS: dict[tuple[str, str], tuple[Callable[[Document], Document], tuple[Row, ...]]] = {
    ("Document", "syntax_version"): (
        lambda d: replace(d, syntax_version="1.1"),
        (("general", None, "changed", "syntaxVersion", "1.0", "1.1"),),
    ),
    ("Document", "composition"): (
        lambda d: replace(d, composition="store"),
        (("general", None, "changed", "composition", "shop", "store"),),
    ),
    # A version's label differs from any other version's by definition.
    ("Document", "version"): (lambda d: replace(d, version="1.1.0"), ()),
    ("Document", "kind"): (
        lambda d: replace(d, kind="system"),
        (("general", None, "changed", "kind", "application", "system"),),
    ),
    ("Document", "problem"): (
        lambda d: replace(d, problem=None),
        (
            ("general", None, "changed", "problem.ref", REF, None),
            ("general", None, "changed", "problem.compilation", DIGEST, None),
        ),
    ),
    ("Document", "workflow"): (
        _swapped,
        (("general", None, "changed", "workflow", WORKFLOW, {"seq": ["ship", WORKFLOW["seq"][1], "pick"]}),),
    ),
    ("Document", "binding"): (
        lambda d: replace(d, binding=tuple(item for item in d.binding if item[0] != "ship")),
        (("binding", "ship", "removed", "candidate", "c_ship", None),),
    ),
    ("Document", "values"): (
        lambda d: replace(d, values=(*d.values, ("latency", Value(12, "ms")))),
        (
            ("values", "latency", "added", "value", None, 12),
            ("values", "latency", "added", "unit", None, "ms"),
        ),
    ),
    ("Document", "offering"): (
        lambda d: replace(d, offering=None),
        (("offering", "source", "removed", "sphere", "isa/shop", None),),
    ),
    ("Document", "evidence"): (lambda d: replace(d, evidence=None), ()),
    ("ProblemLink", "ref"): (
        lambda d: replace(d, problem=replace(d.problem, ref=ProblemRef("acme", "store", "1"))),
        (("general", None, "changed", "problem.ref", REF, "acme/problems/store@1"),),
    ),
    ("ProblemLink", "compilation"): (
        lambda d: replace(d, problem=replace(d.problem, compilation="sha256-" + "1" * 64)),
        (("general", None, "changed", "problem.compilation", DIGEST, "sha256-" + "1" * 64),),
    ),
    ("ProblemRef", "organization"): (
        lambda d: _ref(d, organization="acme"),
        (("general", None, "changed", "problem.ref", REF, "acme/problems/shop@3"),),
    ),
    ("ProblemRef", "problem"): (
        lambda d: _ref(d, problem="store"),
        (("general", None, "changed", "problem.ref", REF, "isa/problems/store@3"),),
    ),
    ("ProblemRef", "revision"): (
        lambda d: _ref(d, revision="4"),
        (("general", None, "changed", "problem.ref", REF, "isa/problems/shop@4"),),
    ),
    ("Entry", "candidate"): (
        lambda d: _entry(d, "pack", candidate="c_pack_fast"),
        (("binding", "pack", "changed", "candidate", "c_pack", "c_pack_fast"),),
    ),
    ("Entry", "local"): (
        lambda d: _entry(d, "wrap", local=False),
        (("binding", "wrap", "changed", "local", True, None),),
    ),
    ("Entry", "source"): (
        lambda d: _entry(d, "pack", source=Provenance(sphere="acme/pack", version="v2", plan="pro")),
        (
            ("binding", "pack", "changed", "from.sphere", None, "acme/pack"),
            ("binding", "pack", "changed", "from.version", None, "v2"),
            ("binding", "pack", "changed", "from.plan", None, "pro"),
        ),
    ),
    ("Provenance", "sphere"): (
        lambda d: _source(d, sphere="acme/pick-eu"),
        (("binding", "pick", "changed", "from.sphere", "acme/pick", "acme/pick-eu"),),
    ),
    ("Provenance", "version"): (
        lambda d: _source(d, version="v2"),
        (("binding", "pick", "changed", "from.version", "v1", "v2"),),
    ),
    ("Provenance", "plan"): (
        lambda d: _source(d, plan="pro"),
        (("binding", "pick", "changed", "from.plan", "basic", "pro"),),
    ),
    ("Provenance", "registry"): (
        lambda d: _source(d, registry=None),
        (("binding", "pick", "changed", "from.registry", "lab", None),),
    ),
    ("Provenance", "addons"): (
        lambda d: _source(d, addons=("fast",)),
        (("binding", "pick", "changed", "from.addons", ["fast", "safe"], ["fast"]),),
    ),
    ("Value", "value"): (
        lambda d: _value(d, "cost", value=5),
        (("values", "cost", "changed", "value", 4.5, 5),),
    ),
    ("Value", "unit"): (
        lambda d: _value(d, "cost", unit="USD/month"),
        (("values", "cost", "changed", "unit", "EUR/month", "USD/month"),),
    ),
    ("Offering", "sphere"): (
        lambda d: _offering(d, sphere="isa/store"),
        (("offering", "source", "changed", "sphere", "isa/shop", "isa/store"),),
    ),
    ("Offering", "registry"): (
        lambda d: _offering(d, registry="lab"),
        (("offering", "source", "changed", "registry", None, "lab"),),
    ),
    ("Offering", "url"): (
        lambda d: replace(d, offering=Offering(url="https://example.org/pricing.yaml")),
        (
            ("offering", "source", "changed", "sphere", "isa/shop", None),
            ("offering", "source", "changed", "url", None, "https://example.org/pricing.yaml"),
        ),
    ),
    ("Evidence", "run"): (lambda d: _evidence(d, run="00000000-0000-4000-8000-000000000000"), ()),
    ("Evidence", "point"): (lambda d: _evidence(d, point=0), ()),
    ("Evidence", "manual"): (
        lambda d: replace(d, evidence=Evidence(manual=True, evaluated_by="gateway", toolchain="bim-core 0.2.0")), (),
    ),
    ("Evidence", "evaluated_by"): (lambda d: _evidence(d, evaluated_by="declared"), ()),
    ("Evidence", "toolchain"): (lambda d: _evidence(d, toolchain="bim-core 0.3.0"), ()),
}


def test_the_mutation_table_covers_every_field_of_the_model() -> None:
    classes = [
        item for item in vars(model).values()
        if isinstance(item, type) and dataclasses.is_dataclass(item) and item.__module__ == model.__name__
        and item.__dataclass_params__.eq
    ]
    fields = {(cls.__name__, field.name) for cls in classes for field in dataclasses.fields(cls) if field.compare}
    assert fields == set(MUTATIONS)


@pytest.mark.parametrize("key", list(MUTATIONS), ids=lambda key: ".".join(key))
def test_one_mutation_gives_exactly_its_changes(key: tuple[str, str]) -> None:
    mutate, expected = MUTATIONS[key]
    after = mutate(BASE)
    assert after != BASE
    found = diff(BASE, after)
    assert rows(found) == expected
    assert found["isEmpty"] is (expected == ())
    entries = [entry for section in found["sections"] for entry in section["entries"]]
    assert found["totals"] == {
        "added": sum(entry["kind"] == "added" for entry in entries),
        "removed": sum(entry["kind"] == "removed" for entry in entries),
        "changed": sum(entry["kind"] == "changed" for entry in entries) + len(found["general"]),
    }


def test_the_shape_is_spheres_pricing_diff_with_a_comparison() -> None:
    found = diff(BASE, BASE)

    assert found == {
        "general": [],
        "sections": [
            {"key": "binding", "label": "Binding", "entries": []},
            {"key": "values", "label": "Values", "entries": []},
            {"key": "offering", "label": "Offering", "entries": []},
        ],
        "totals": {"added": 0, "removed": 0, "changed": 0},
        "isEmpty": True,
        "comparison": {
            "comparable": True, "problemRefChanged": False, "compilationChanged": False,
            "valueStatus": {"before": "verified", "after": "verified"},
        },
    }
    assert [key for key, _ in SECTIONS] == ["binding", "values", "offering"]
    assert KINDS == ("added", "removed", "changed")


def test_a_document_does_not_differ_from_itself() -> None:
    assert diff(BASE, text.parse(text.serialise(BASE), context=LAB))["isEmpty"]


def test_entries_are_listed_per_task_and_counted() -> None:
    after = _entry(_entry(BASE, "pack", candidate="c_pack_fast"), "ship", candidate="c_ship_eu")
    after = replace(after, binding=tuple(item for item in after.binding if item[0] != "pick"))

    found = diff(BASE, after)

    (binding, _, _) = found["sections"]
    assert [(entry["name"], entry["kind"]) for entry in binding["entries"]] == [
        ("pick", "removed"), ("pack", "changed"), ("ship", "changed"),
    ]
    assert binding["entries"][0]["changes"] == [
        {"path": "candidate", "before": "c_pick", "after": None},
        *({"path": f"from.{key}", "before": value, "after": None} for key, value in PICK_FROM.items()),
    ]
    assert found["totals"] == {"added": 0, "removed": 1, "changed": 2}
    assert found["isEmpty"] is False


def test_a_choice_whose_probabilities_changed_changes_the_workflow_whole() -> None:
    first, _, last = BASE.workflow.children
    changed = Exclusive(branches=(Branch(TaskNode("pack"), 0.5), Branch(TaskNode("wrap"), 0.5)))
    after = replace(BASE, workflow=Sequence((first, changed, last)))

    ((path, before, now),) = [(c["path"], c["before"], c["after"]) for c in diff(BASE, after)["general"]]

    assert path == "workflow" and before == WORKFLOW
    assert now["seq"][1] == {"xor": [{"probability": 0.5, "flow": "pack"}, {"probability": 0.5, "flow": "wrap"}]}


def test_a_number_is_compared_by_its_json() -> None:
    integral = _value(BASE, "cost", value=30)
    floating = _value(BASE, "cost", value=30.0)

    assert rows(diff(integral, floating)) == (("values", "cost", "changed", "value", 30, 30.0),)


def test_a_bare_value_is_compared_as_a_dimensionless_one() -> None:
    after = _value(BASE, "availability", value=0.995)

    assert rows(diff(BASE, after)) == (("values", "availability", "changed", "value", 0.99, 0.995),)


def test_values_are_not_compared_between_a_verified_and_a_declared_side() -> None:
    declared = _value(_evidence(BASE, evaluated_by="declared"), "cost", value=7)

    found = diff(BASE, declared)

    assert found["comparison"] == {
        "comparable": False, "problemRefChanged": False, "compilationChanged": False,
        "valueStatus": {"before": "verified", "after": "declared"},
    }
    assert found["sections"][1] == {"key": "values", "label": "Values", "entries": []}
    assert found["isEmpty"] is True


def test_values_are_not_compared_across_problems_or_compilations() -> None:
    other_problem = _value(_ref(BASE, problem="store"), "cost", value=7)
    other_compilation = _value(
        replace(BASE, problem=replace(BASE.problem, compilation="sha256-" + "1" * 64)), "cost", value=7,
    )

    by_problem, by_compilation = diff(BASE, other_problem), diff(BASE, other_compilation)

    assert by_problem["comparison"]["problemRefChanged"] and not by_problem["comparison"]["comparable"]
    assert by_compilation["comparison"]["compilationChanged"] and not by_compilation["comparison"]["comparable"]
    assert by_problem["sections"][1]["entries"] == by_compilation["sections"][1]["entries"] == []
    assert by_problem["totals"]["changed"] == by_compilation["totals"]["changed"] == 1


def test_two_declared_documents_compare_their_values() -> None:
    declared = replace(BASE, problem=None, evidence=None)

    found = diff(declared, _value(declared, "cost", value=7))

    assert found["comparison"]["comparable"] is True
    assert found["comparison"]["valueStatus"] == {"before": "declared", "after": "declared"}
    assert rows(found) == (("values", "cost", "changed", "value", 4.5, 7),)


def test_the_value_status_is_verified_only_for_a_linked_document_the_gateway_evaluated() -> None:
    assert value_status(BASE) == "verified"
    assert value_status(replace(BASE, evidence=None)) == "declared"
    assert value_status(_evidence(BASE, evaluated_by="declared")) == "declared"
    assert value_status(replace(BASE, problem=None)) == "declared"
    assert comparison(BASE, BASE)["comparable"] is True


def test_a_new_block_changes_the_workflow_and_nothing_else() -> None:
    after = text.parse(SOURCE.replace(
        "workflow: {seq: [pick, ", "workflow: {seq: [{loop: pick, count: 2}, ",
    ), context=LAB)

    assert [c["path"] for c in diff(BASE, after)["general"]] == ["workflow"]
    assert rows(diff(BASE, after))[0][5]["seq"][0] == {"loop": "pick", "count": 2}


def test_a_task_added_to_the_workflow_and_the_binding() -> None:
    after = text.parse(SOURCE.replace("ship]}", "ship, bill]}").replace(
        "  ship: {candidate: c_ship}\n", "  ship: {candidate: c_ship}\n  bill: {candidate: c_bill}\n",
    ), context=LAB)
    found = rows(diff(BASE, after))
    assert found[0][3] == "workflow"
    assert ("binding", "bill", "added", "candidate", None, "c_bill") in found


def test_the_diff_is_json() -> None:
    for mutate, _ in MUTATIONS.values():
        found = diff(BASE, mutate(BASE))
        assert json.loads(json.dumps(found)) == found

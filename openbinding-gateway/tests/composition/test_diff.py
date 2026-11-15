"""What changed between two Composition2Yaml documents.

The mutation table changes one field of every dataclass of ``document.py`` at a time and
names exactly the changes the diff must report. It is checked complete against
``dataclasses.fields``, so a field added to the model without a row here fails.
"""

from __future__ import annotations

import dataclasses
import json
from dataclasses import replace
from typing import Callable

import pytest

from openbinding_gateway.composition import document as model
from openbinding_gateway.composition import text
from openbinding_gateway.composition.diff import KINDS, SECTIONS, Change, as_documents, diff
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

MUTATIONS: dict[tuple[str, str], tuple[Callable[[Document], Document], tuple[Change, ...]]] = {
    ("Document", "syntax_version"): (
        lambda d: replace(d, syntax_version="1.1"),
        (Change("identity", "syntaxVersion", "changed", "1.0", "1.1"),),
    ),
    ("Document", "composition"): (
        lambda d: replace(d, composition="store"),
        (Change("identity", "composition", "changed", "shop", "store"),),
    ),
    ("Document", "version"): (
        lambda d: replace(d, version="1.1.0"),
        (Change("identity", "version", "changed", "1.0.0", "1.1.0"),),
    ),
    ("Document", "kind"): (
        lambda d: replace(d, kind="system"),
        (Change("identity", "kind", "changed", "application", "system"),),
    ),
    ("Document", "problem"): (
        lambda d: replace(d, problem=None),
        (
            Change("problem", "compilation", "removed", was=DIGEST),
            Change("problem", "ref", "removed", was=REF),
        ),
    ),
    ("Document", "workflow"): (
        _swapped,
        (
            Change("workflow", "pick", "moved", was=["workflow.seq[0]"], now=["workflow.seq[2]"]),
            Change("workflow", "ship", "moved", was=["workflow.seq[2]"], now=["workflow.seq[0]"]),
        ),
    ),
    ("Document", "binding"): (
        lambda d: replace(d, binding=tuple(item for item in d.binding if item[0] != "ship")),
        (Change("binding", "ship", "removed", was={"candidate": "c_ship"}),),
    ),
    ("Document", "values"): (
        lambda d: replace(d, values=(*d.values, ("latency", Value(12, "ms")))),
        (Change("values", "latency", "added", now={"value": "12", "unit": "ms"}),),
    ),
    ("Document", "offering"): (
        lambda d: replace(d, offering=None),
        (Change("offering", "source", "removed", was={"sphere": "isa/shop"}),),
    ),
    ("Document", "evidence"): (
        lambda d: replace(d, evidence=None),
        (
            Change("evidence", "evaluatedBy", "removed", was="gateway"),
            Change("evidence", "point", "removed", was=2),
            Change("evidence", "run", "removed", was=RUN),
            Change("evidence", "toolchain", "removed", was="bim-core 0.2.0"),
        ),
    ),
    ("ProblemLink", "ref"): (
        lambda d: replace(d, problem=replace(d.problem, ref=ProblemRef("acme", "store", "1"))),
        (Change("problem", "ref", "changed", REF, "acme/problems/store@1"),),
    ),
    ("ProblemLink", "compilation"): (
        lambda d: replace(d, problem=replace(d.problem, compilation="sha256-" + "1" * 64)),
        (Change("problem", "compilation", "changed", DIGEST, "sha256-" + "1" * 64),),
    ),
    ("ProblemRef", "organization"): (
        lambda d: _ref(d, organization="acme"),
        (Change("problem", "ref", "changed", REF, "acme/problems/shop@3"),),
    ),
    ("ProblemRef", "problem"): (
        lambda d: _ref(d, problem="store"),
        (Change("problem", "ref", "changed", REF, "isa/problems/store@3"),),
    ),
    ("ProblemRef", "revision"): (
        lambda d: _ref(d, revision="4"),
        (Change("problem", "ref", "changed", REF, "isa/problems/shop@4"),),
    ),
    ("Entry", "candidate"): (
        lambda d: _entry(d, "pack", candidate="c_pack_fast"),
        (Change("binding", "pack.candidate", "changed", "c_pack", "c_pack_fast"),),
    ),
    ("Entry", "local"): (
        lambda d: _entry(d, "wrap", local=False),
        (Change("binding", "wrap.local", "changed", True, False),),
    ),
    ("Entry", "source"): (
        lambda d: _entry(d, "pack", source=Provenance(sphere="acme/pack", version="v2", plan="pro")),
        (Change("binding", "pack.from", "added", now={"sphere": "acme/pack", "version": "v2", "plan": "pro"}),),
    ),
    ("Provenance", "sphere"): (
        lambda d: _source(d, sphere="acme/pick-eu"),
        (Change("binding", "pick.from.sphere", "changed", "acme/pick", "acme/pick-eu"),),
    ),
    ("Provenance", "version"): (
        lambda d: _source(d, version="v2"),
        (Change("binding", "pick.from.version", "changed", "v1", "v2"),),
    ),
    ("Provenance", "plan"): (
        lambda d: _source(d, plan="pro"),
        (Change("binding", "pick.from.plan", "changed", "basic", "pro"),),
    ),
    ("Provenance", "registry"): (
        lambda d: _source(d, registry=None),
        (Change("binding", "pick.from.registry", "removed", was="lab"),),
    ),
    ("Provenance", "addons"): (
        lambda d: _source(d, addons=("fast",)),
        (Change("binding", "pick.from.addons", "changed", ["fast", "safe"], ["fast"]),),
    ),
    ("Value", "value"): (
        lambda d: _value(d, "cost", value=5),
        (Change("values", "cost.value", "changed", "4.5", "5"),),
    ),
    ("Value", "unit"): (
        lambda d: _value(d, "cost", unit="USD/month"),
        (Change("values", "cost.unit", "changed", "EUR/month", "USD/month"),),
    ),
    ("Offering", "sphere"): (
        lambda d: _offering(d, sphere="isa/store"),
        (Change("offering", "source", "changed", {"sphere": "isa/shop"}, {"sphere": "isa/store"}),),
    ),
    ("Offering", "registry"): (
        lambda d: _offering(d, registry="lab"),
        (Change("offering", "source", "changed", {"sphere": "isa/shop"}, {"sphere": "isa/shop", "registry": "lab"}),),
    ),
    ("Offering", "url"): (
        lambda d: replace(d, offering=Offering(url="https://example.org/pricing.yaml")),
        (Change("offering", "source", "changed", {"sphere": "isa/shop"}, {"url": "https://example.org/pricing.yaml"}),),
    ),
    ("Evidence", "run"): (
        lambda d: _evidence(d, run="00000000-0000-4000-8000-000000000000"),
        (Change("evidence", "run", "changed", RUN, "00000000-0000-4000-8000-000000000000"),),
    ),
    ("Evidence", "point"): (
        lambda d: _evidence(d, point=0),
        (Change("evidence", "point", "changed", 2, 0),),
    ),
    ("Evidence", "manual"): (
        lambda d: replace(d, evidence=Evidence(manual=True, evaluated_by="gateway", toolchain="bim-core 0.2.0")),
        (
            Change("evidence", "manual", "added", now=True),
            Change("evidence", "point", "removed", was=2),
            Change("evidence", "run", "removed", was=RUN),
        ),
    ),
    ("Evidence", "evaluated_by"): (
        lambda d: _evidence(d, evaluated_by="declared"),
        (Change("evidence", "evaluatedBy", "changed", "gateway", "declared"),),
    ),
    ("Evidence", "toolchain"): (
        lambda d: _evidence(d, toolchain="bim-core 0.3.0"),
        (Change("evidence", "toolchain", "changed", "bim-core 0.2.0", "bim-core 0.3.0"),),
    ),
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
    assert diff(BASE, after) == expected
    for change in expected:
        assert change.section in SECTIONS and change.kind in KINDS


def test_a_document_does_not_differ_from_itself() -> None:
    assert diff(BASE, BASE) == ()
    assert diff(BASE, text.parse(text.serialise(BASE), context=LAB)) == ()


def test_a_choice_whose_probabilities_changed_is_reported_at_the_choice() -> None:
    first, choice, last = BASE.workflow.children
    changed = Exclusive(branches=(Branch(TaskNode("pack"), 0.5), Branch(TaskNode("wrap"), 0.5)))
    after = replace(BASE, workflow=Sequence((first, changed, last)))
    assert diff(BASE, after) == (Change(
        "workflow", "workflow.seq[1]", "changed",
        was={"uniform": False, "probabilities": [0.25, 0.75]},
        now={"uniform": False, "probabilities": [0.5, 0.5]},
    ),)


def test_a_new_block_changes_the_shape_and_the_invocations() -> None:
    after = text.parse(SOURCE.replace(
        "workflow: {seq: [pick, ", "workflow: {seq: [{loop: pick, count: 2}, ",
    ), context=LAB)
    found = diff(BASE, after)
    assert found == (
        Change("workflow", "pick", "moved", was=["workflow.seq[0]"], now=["workflow.seq[0].loop"]),
        Change(
            "workflow", "shape", "changed",
            was="seq(task,xor(task,task),task)", now="seq(loop[count=2](task),xor(task,task),task)",
        ),
    )


def test_a_task_added_to_the_workflow_and_the_binding() -> None:
    after = text.parse(SOURCE.replace("ship]}", "ship, bill]}").replace(
        "  ship: {candidate: c_ship}\n", "  ship: {candidate: c_ship}\n  bill: {candidate: c_bill}\n",
    ), context=LAB)
    found = diff(BASE, after)
    assert Change("workflow", "bill", "added", now=["workflow.seq[3]"]) in found
    assert Change("binding", "bill", "added", now={"candidate": "c_bill"}) in found


def test_the_changes_are_json_documents() -> None:
    changes: list[Change] = []
    for mutate, _ in MUTATIONS.values():
        changes += diff(BASE, mutate(BASE))
    documents = as_documents(changes)
    assert json.loads(json.dumps(documents)) == documents
    assert documents[0].keys() == {"section", "subject", "kind", "was", "now"}

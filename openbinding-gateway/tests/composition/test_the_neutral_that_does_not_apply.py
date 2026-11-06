"""The second explicit neutral: a property that does not apply to a candidate.

Phase F1 step 5. The first write landed with the emitter -- every feature carries its
neutral, and ``test_neutral_matches_compiler.py`` keeps that rule pinned to the
container's over the whole corpus. This is the other one: when a property does not apply
to a candidate, a quantum property on a classical solver, the Studio writes **that
property's own neutral** into the candidate's features and records the substitution in
provenance.

Two things these tests are really defending.

The substituted value is the semantically right one, not a placeholder. Under ``sum`` the
candidate contributes nothing; under ``min`` over a bounded domain it is the *upper* bound,
because that is the value that does not constrain a minimum. Getting that one backwards is
the sharpest trap in the guiding case and it would not show up as an error -- only as every
binding evaluation being slightly wrong.

Provenance is not part of the package. A package holds its manifest and the documents the
manifest declares and nothing else, so a ``provenance.json`` inside it is
``undeclared_resource`` on every compile. It cannot go in the IR either, which is why it is
written beside the package.
"""

from __future__ import annotations

import json

import pytest

from openbinding_gateway.composition import emit as emitter
from openbinding_gateway.composition.model import (
    Aggregation,
    Candidate,
    Composition,
    Domain,
    FixedTask,
    Goal,
    Normalize,
    OpenTask,
    Property,
    Sequence,
    TaskNode,
)

#: A quantum-only property whose sequence operator is ``sum``: its neutral is 0.
QUBITS = Property(
    unit="qubits",
    direction="minimize",
    aggregation=Aggregation("sum", "sum", "weightedSum", "scale", "sum"),
    domain=Domain("integer", 0, 4096),
    applies_to="quantum",
)
#: A quantum-only property aggregating with ``min`` over a bounded domain: its neutral is
#: the domain's MAXIMUM, which is the trap worth a test of its own.
FIDELITY = Property(
    unit="score",
    direction="maximize",
    aggregation=Aggregation("min", "min", "min", "identity", "min"),
    domain=Domain("real", 1.0, 5.0),
    applies_to="quantum",
)
COST = Property(
    unit="USD/month",
    direction="minimize",
    aggregation=Aggregation("sum", "sum", "weightedSum", "scale", "sum"),
    domain=Domain("real", 0.0, 10000.0),
)


def _composition(**overrides) -> Composition:
    base = {
        "composition": "hybrid",
        "version": "1.0.0",
        "properties": {"cost": COST, "qubit_count": QUBITS, "fidelity": FIDELITY},
        "tasks": {"solve": OpenTask(requires="service/solve")},
        "workflow": Sequence((TaskNode("solve"),)),
        "candidates": (
            Candidate(
                id="quantum_one",
                provides="service/solve",
                properties={"cost": 1500.0, "qubit_count": 128, "fidelity": 4.2},
                domain="quantum",
            ),
            Candidate(
                id="classical_one",
                provides="service/solve",
                properties={"cost": 300.0},
                domain="classical",
            ),
        ),
        "goals": (Goal("cost", normalize=Normalize(0.0, 10000.0)),),
    }
    base.update(overrides)
    return Composition(**base)


def _catalog(composition: Composition) -> dict:
    return json.loads(emitter.emit(composition)["candidates.json"])["spec"]["candidates"]


def test_a_property_that_does_not_apply_gets_its_neutral() -> None:
    candidates = _catalog(_composition())
    classical = candidates["classical_one"]["features"]
    # Every declared property is present, because the profile imputes nothing.
    assert sorted(classical) == ["cost", "fidelity", "qubit_count"]
    assert classical["cost"] == 300.0
    assert classical["qubit_count"] == 0.0, "a sum property contributes nothing"
    assert classical["fidelity"] == 5.0, (
        "the neutral of a min property is the domain's MAXIMUM: the value that does not "
        "constrain a minimum"
    )


def test_a_candidate_the_property_applies_to_keeps_its_own_values() -> None:
    quantum = _catalog(_composition())["quantum_one"]["features"]
    assert quantum == {"cost": 1500.0, "fidelity": 4.2, "qubit_count": 128}


def test_an_applicable_property_is_never_invented() -> None:
    """A value the author omitted for a property that does mean something stays omitted.

    Filling it would make a number up and hide the omission. The container refuses it by
    name instead, which is a diagnostic a reader can act on.
    """
    composition = _composition(
        candidates=(
            Candidate(id="bare", provides="service/solve", properties={}, domain="classical"),
        ),
    )
    features = _catalog(composition)["bare"]["features"]
    assert "cost" not in features, "cost applies to every candidate and was not declared"
    assert sorted(features) == ["fidelity", "qubit_count"]


def test_provenance_records_each_substitution_and_its_reason() -> None:
    records = emitter.provenance(_composition())
    assert [(r["candidate"], r["property"]) for r in records] == [
        ("classical_one", "fidelity"),
        ("classical_one", "qubit_count"),
    ]
    fidelity = records[0]
    assert fidelity["value"] == 5.0
    assert fidelity["reason"] == "domain_mismatch"
    assert fidelity["candidateDomain"] == "classical"
    assert fidelity["propertyDomain"] == "quantum"
    assert fidelity["neutralSource"] == "inferred"
    assert fidelity["inferredFrom"] == {
        "sequence": "min",
        "domain": {"kind": "real", "minimum": 1.0, "maximum": 5.0},
    }


def test_a_declared_neutral_is_recorded_as_declared() -> None:
    """An author-declared neutral is the only way to say what a step contributes."""
    declared = Property(
        unit="qubits",
        direction="minimize",
        aggregation=Aggregation("min", "min", "min", "identity", "min"),
        domain=Domain("real", 1.0, 5.0),
        applies_to="quantum",
        neutral=3.0,
    )
    records = emitter.provenance(_composition(properties={"cost": COST, "q": declared}))
    assert len(records) == 1
    assert records[0]["value"] == 3.0
    assert records[0]["neutralSource"] == "declared"
    assert "inferredFrom" not in records[0], "nothing was inferred"


def test_a_fixed_task_reaches_the_substitution_too() -> None:
    """The candidate a fixed task mints carries the task's own solver domain."""
    composition = _composition(
        tasks={"solve": OpenTask(requires="service/solve"), "inhouse": FixedTask(
            properties={"cost": 0.0}, domain="classical",
        )},
        workflow=Sequence((TaskNode("solve"), TaskNode("inhouse"))),
    )
    minted = _catalog(composition)["cand_inhouse"]["features"]
    assert minted == {"cost": 0.0, "fidelity": 5.0, "qubit_count": 0.0}
    record = next(r for r in emitter.provenance(composition) if r["candidate"] == "cand_inhouse")
    assert record["task"] == "inhouse"


def test_provenance_is_not_a_package_entry() -> None:
    """A package holds its manifest and what the manifest declares. Nothing else compiles."""
    composition = _composition()
    files = emitter.emit(composition)
    assert "provenance.json" not in files
    assert sorted(files) == [
        "application.json",
        "candidates.json",
        "instance.json",
        "optimization.json",
    ]
    document = json.loads(emitter.provenance_bytes(composition))
    assert list(document) == ["substitutions"]
    assert len(document["substitutions"]) == 2


def test_the_substitution_leaves_a_compilable_package() -> None:
    """The point of the substitution: the package the profile would otherwise refuse."""
    try:
        from bim_core import compile_instance  # noqa: PLC0415
        from bim_core.package import InstancePackage  # noqa: PLC0415
    except ImportError:
        pytest.skip("bim_core is not importable in this environment")
    try:
        compiled = compile_instance(InstancePackage(emitter.emit(_composition())))
    except FileNotFoundError as exc:  # the vendored OMG BPMN XSDs
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    features = compiled.document["spec"]["candidates"]["catalog"]["candidates"]
    assert features["classical_one"]["features"]["fidelity"] == 5.0


def test_the_solver_domain_survives_the_text_layer() -> None:
    """The gate cannot catch this: every candidate in the corpus is ``all``.

    So a composition with a quantum candidate is the only thing that would notice the
    field being dropped on the way through the YAML, and it is not in the 75.
    """
    from openbinding_gateway.composition.text import parse, serialise

    composition = _composition(
        tasks={
            "solve": OpenTask(requires="service/solve"),
            "inhouse": FixedTask(properties={"cost": 0.0}, domain="classical"),
        },
        workflow=Sequence((TaskNode("solve"), TaskNode("inhouse"))),
    )
    back = parse(serialise(composition))
    assert back == composition
    assert {c.id: c.domain for c in back.candidates} == {
        "quantum_one": "quantum",
        "classical_one": "classical",
    }
    assert back.tasks["inhouse"].domain == "classical"

"""The emitter's gate: a composition compiles to the IR digest of an existing package.

Phase F1 step 1 is the emitter, and its only honest test is the one the specification set
as the phase gate (section 11.2): emit a composition, compile the result with the
container, and require the IR digest to equal that of a package already in the corpus.
Anything weaker -- that the package validates, that it has the right keys -- passes while
the emitter is wrong in exactly the ways that cost a digest.

``examples/demo/01_simple_seq`` is the first target because it is the smallest package in
the gate and because it is deceptively bare: its one feature declares nothing but a unit,
so the container fills in the direction, the scope, the domain, the five aggregation
operators and the neutral. The composition below states all of them explicitly, and the
digest is what proves the Studio's values are the container's. It also omits ``clamp`` on
its criterion, which the container reads as **false** -- the single rule that, written the
obvious way, loses this very package.

Step 2 generalizes this to the whole 75-package gate through an importer. This file stays
at one package on purpose: when the gate run fails, this test says whether the emitter or
the importer is at fault.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.composition import emit as emitter
from openbinding_gateway.composition.model import (
    Aggregation,
    Candidate,
    Composition,
    Domain,
    Goal,
    Normalize,
    OpenTask,
    Property,
    Sequence,
    TaskNode,
)

TARGET = REPO_ROOT / "examples" / "demo" / "01_simple_seq"

#: The five aggregation operators the container infers for a feature that declares none.
#: Measured from the compiled IR, not assumed: a bare ``{"unit": "ms"}`` feature becomes
#: sum / sum / weightedSum / scale / sum with direction ``minimize``, scope ``invocation``,
#: an unbounded real domain and neutral 0.0.
INFERRED = Aggregation("sum", "sum", "weightedSum", "scale", "sum")


def _composition() -> Composition:
    """``examples/demo/01_simple_seq`` as a composition, written by hand.

    Nothing here is read from the package: that is the point. A value copied out of the
    target would make the test prove only that copying works.
    """
    latency = {
        "latency": Property(
            unit="ms",
            direction="minimize",
            aggregation=INFERRED,
            domain=Domain("real"),
        ),
    }
    return Composition(
        composition="demo_01_simple_seq",
        version="1.0.0",
        properties=latency,
        tasks={
            "t1": OpenTask(requires="service/t1"),
            "t2": OpenTask(requires="service/t2"),
            "t3": OpenTask(requires="service/t3"),
        },
        workflow=Sequence((TaskNode("t1"), TaskNode("t2"), TaskNode("t3"))),
        candidates=(
            Candidate(id="c1a", provides="service/t1", properties={"latency": 10}),
            Candidate(id="c1b", provides="service/t1", properties={"latency": 20}),
            Candidate(id="c2a", provides="service/t2", properties={"latency": 15}),
            Candidate(id="c3a", provides="service/t3", properties={"latency": 5}),
        ),
        goals=(Goal("latency", normalize=Normalize(0, 1000, clamp=False)),),
    )


def _compile(files: dict[str, bytes]):
    try:
        from bim_core import compile_instance, ir_digest  # noqa: PLC0415
        from bim_core.package import InstancePackage  # noqa: PLC0415
    except ImportError:
        pytest.skip("bim_core is not importable in this environment")
    try:
        compiled = compile_instance(InstancePackage(files))
    except FileNotFoundError as exc:  # the vendored OMG BPMN XSDs
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    return ir_digest(getattr(compiled, "document", compiled))


@pytest.fixture(scope="module")
def target_digest() -> str:
    if not (TARGET / "instance.json").is_file():
        pytest.skip(f"{TARGET} is not mounted in this environment")
    return _compile({f.name: f.read_bytes() for f in Path(TARGET).iterdir() if f.is_file()})


def test_the_emitted_package_has_the_target_s_ir_digest(target_digest: str) -> None:
    assert _compile(emitter.emit(_composition())) == target_digest


def test_the_file_set_is_the_manifest_and_nothing_else() -> None:
    """A package entry the manifest does not declare is refused as ``undeclared_resource``.

    This package states no rule and carries no probabilistic choice, so neither
    ``constraints.json`` nor ``routing.json`` is emitted -- an empty constraint set is not
    the same document as no constraint set, and an unstated distribution is not uniform.
    """
    files = emitter.emit(_composition())
    assert sorted(files) == [
        "application.json",
        "candidates.json",
        "instance.json",
        "optimization.json",
    ]
    manifest = json.loads(files["instance.json"])
    declared = {
        name
        for members in manifest["spec"]["resources"].values()
        for name in members.values()
    }
    assert declared | {"instance.json"} == set(files)


def test_emitting_twice_gives_the_same_bytes() -> None:
    """The emitter is a pure function of the model, byte for byte."""
    assert emitter.emit(_composition()) == emitter.emit(_composition())


def test_nothing_studio_side_reaches_the_package() -> None:
    """The Studio block, a title and a pricing reference have no destination.

    Section 9 settles that the block is emitted nowhere, and a candidate's or a provider's
    name has no home in the catalog -- writing one moves the digest. So a composition that
    differs only in Studio data compiles to the identical bytes.
    """
    plain = _composition()
    decorated = Composition(
        composition=plain.composition,
        version=plain.version,
        properties=plain.properties,
        tasks=plain.tasks,
        workflow=plain.workflow,
        candidates=tuple(
            Candidate(
                id=candidate.id,
                provides=candidate.provides,
                properties=candidate.properties,
                title=f"a name for {candidate.id}",
            )
            for candidate in plain.candidates
        ),
        goals=plain.goals,
        studio={"tags": ["jisbd-2026"], "layers": {"data": ["t1"]}},
    )
    assert emitter.emit(decorated) == emitter.emit(plain)

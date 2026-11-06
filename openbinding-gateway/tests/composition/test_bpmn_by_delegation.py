"""The BPMN lift, against the oracle the corpus already contains.

Phase F1 step 4. ``examples/demo/15_bpmn_complete`` and ``examples/demo/16_json_complete``
are the same problem written two ways -- one as a BPMN diagram, one as a JSON workflow --
and they compile to the identical IR digest. So a faithful lift of the first's diagram is
the second's hand-written workflow, node for node, and that is what these tests assert.

Both packages declare a Placement resource and so sit outside section 11.2's gate, which
is why this step needs its own oracle rather than the gate: the two packages that exercise
BPMN are exactly the two the gate excludes.

Nothing here parses BPMN. The container reduces it and this reads the result, and the one
test that would notice a second reducer appearing is the one that checks the lifted
workflow re-emits to the same compiled problem.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from _repo import REPO_ROOT

BPMN_PACKAGE = REPO_ROOT / "examples" / "demo" / "15_bpmn_complete"
JSON_PACKAGE = REPO_ROOT / "examples" / "demo" / "16_json_complete"
#: The process the diagram declares, which the application references by id.
PROCESS = "Process_Fulfillment"


def _files(directory: Path) -> dict[str, bytes]:
    if not (directory / "instance.json").is_file():
        pytest.skip(f"{directory} is not mounted in this environment")
    return {entry.name: entry.read_bytes() for entry in directory.iterdir() if entry.is_file()}


@pytest.fixture(scope="module")
def compile_package():
    """The container's compiler, handed to the lift rather than imported by it.

    ``composition/`` may not reach into the toolchain -- the gateway has one door to BIM and
    ``test_bim_boundary.py`` enforces it -- so the reduction takes a callable. A test is a
    legitimate place to supply the in-process one; a route would ask the port, which is
    also what makes the lift work under ``BIM_MODE=http``, where the compiler is elsewhere.
    """
    try:
        from bim_core import compile_instance  # noqa: PLC0415
        from bim_core.package import InstancePackage  # noqa: PLC0415
    except ImportError:
        pytest.skip("bim_core is not importable in this environment")

    def compile(files):
        compiled = compile_instance(InstancePackage(dict(files)))
        return getattr(compiled, "document", compiled)

    return compile


def test_the_two_packages_really_are_one_problem(compile_package) -> None:
    """The oracle itself, asserted before anything leans on it."""
    from bim_core import compile_instance, ir_digest
    from bim_core.package import InstancePackage

    try:
        bpmn = ir_digest(compile_instance(InstancePackage(_files(BPMN_PACKAGE))).document)
        plain = ir_digest(compile_instance(InstancePackage(_files(JSON_PACKAGE))).document)
    except FileNotFoundError as exc:  # the vendored OMG BPMN XSDs
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    assert bpmn == plain, (
        "the BPMN and JSON packages no longer compile to one problem; this step's oracle is "
        "gone and the comparison below means nothing"
    )


def test_the_diagram_and_the_hand_written_workflow_reduce_to_one_tree(compile_package) -> None:
    """The diagram's reduction equals the twin package's, node for node.

    Both sides are lifted from the IR, which is the only level at which they can be
    compared: the container flattens a nested sequence while canonicalizing, so the IR tree
    is not the source tree. The next assertion shows that difference rather than leaving it
    implied -- it is why the Studio never pre-flattens a sequence of its own, since
    flattening twice, differently, is how an import and an emit stop agreeing.
    """
    from openbinding_gateway.composition import bpmn as lift
    from openbinding_gateway.composition.read import _node

    try:
        from_diagram = lift.reduce_package(_files(BPMN_PACKAGE), compile_package)
        from_json = lift.reduce_package(_files(JSON_PACKAGE), compile_package)
    except FileNotFoundError as exc:
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    assert from_diagram == from_json

    declared = json.loads((JSON_PACKAGE / "application.json").read_text(encoding="utf-8"))
    as_written = _node(declared["spec"]["workflow"], [0])
    assert as_written != from_json, (
        "the twin package's source workflow now matches its own IR, so the container has "
        "stopped flattening nested sequences and this test's reasoning needs re-reading"
    )


def test_a_lifted_workflow_re_emits_to_the_same_problem(compile_package) -> None:
    """The check that would notice a second reducer: lift, write it as JSON, compile.

    The BPMN package's own workflow reference is replaced with the emitted JSON of the
    lifted node and nothing else changes, so an IR digest that still matches says the lift
    kept everything the compiled problem depends on.
    """
    from bim_core import compile_instance, ir_digest
    from bim_core.package import InstancePackage

    from openbinding_gateway.composition import bpmn as lift
    from openbinding_gateway.composition.emit import _node as emit_node

    files = _files(BPMN_PACKAGE)
    try:
        before = ir_digest(compile_instance(InstancePackage(files)).document)
        lifted = lift.reduce_package(files, compile_package)
    except FileNotFoundError as exc:
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")

    rewritten = dict(files)
    application = json.loads(rewritten["application.json"])
    application["spec"]["workflow"] = emit_node(lifted)
    rewritten["application.json"] = json.dumps(application, indent=2).encode("utf-8")
    # A BPMN package's routing overlay targets the DIAGRAM, because that is where its
    # branch ids are declared, while a JSON workflow's targets the application. The IR does
    # not distinguish them -- which is why the two twin packages share a digest -- but the
    # resource has to exist, so dropping the diagram means retargeting the overlay. This is
    # exactly the difference between the two packages in the corpus.
    routing = json.loads(rewritten["routing.json"])
    for entry in routing["spec"]["entries"]:
        entry["target"]["resource"] = "application"
    rewritten["routing.json"] = json.dumps(routing, indent=2).encode("utf-8")

    manifest = json.loads(rewritten["instance.json"])
    # The diagram is no longer referenced, and a package entry its manifest does not
    # declare is refused, so the resource and the file go together.
    manifest["spec"]["resources"]["application"].pop(lift.WORKFLOW, None)
    rewritten["instance.json"] = json.dumps(manifest, indent=2).encode("utf-8")
    rewritten.pop("workflow.bpmn", None)

    after = ir_digest(compile_instance(InstancePackage(rewritten)).document)
    assert after == before


def test_a_process_is_reduced_without_a_package_of_its_own(compile_package) -> None:
    """The Studio's import path: a diagram plus a task-to-capability map, nothing else."""
    from openbinding_gateway.composition import bpmn as lift

    files = _files(BPMN_PACKAGE)
    application = json.loads(files["application.json"])
    tasks = {
        task_id: body if isinstance(body, str) else body["requires"]
        for task_id, body in application["spec"]["tasks"].items()
    }
    try:
        lifted = lift.reduce_process(files["workflow.bpmn"], process=PROCESS, tasks=tasks, compile=compile_package)
        from_package = lift.reduce_package(files, compile_package)
    except FileNotFoundError as exc:
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    assert lifted == from_package


def test_an_unknown_node_kind_is_refused_rather_than_dropped() -> None:
    """A workflow that quietly lost a block would compile to a different problem."""
    from openbinding_gateway.composition import bpmn as lift

    with pytest.raises(lift.BpmnError, match="cannot read"):
        lift.node_from_ir({"kind": "compensation", "steps": []})


def test_a_process_needs_its_capabilities_named(compile_package) -> None:
    from openbinding_gateway.composition import bpmn as lift

    with pytest.raises(lift.BpmnError, match="capability"):
        lift.reduce_process(b"<definitions/>", process=PROCESS, tasks={}, compile=compile_package)

"""Read a BPMN workflow by delegation: the container reduces it, this lifts the result.

Phase F1 step 4. BPMN 2.0.2 is a large notation and its reduction to the four blocks is
already implemented, validated against the five vendored OMG XSDs and exercised by the
corpus. Re-implementing that in the Studio would mean two reducers that must agree forever
and will not, so this module implements none of it. It builds a package whose workflow is a
``bpmn`` reference, hands it to the compiler, and lifts the **already reduced** workflow out
of the IR.

The IR's workflow is not shaped like a source document's -- it is ``{"kind": "sequence",
"steps": [...]}`` where a source writes ``{"sequence": [...]}`` -- so the lift is a real
conversion rather than a copy, and it is the only place in this package that reads the IR's
node shapes.

The corpus provides the oracle this deserves: ``examples/demo/15_bpmn_complete`` and
``examples/demo/16_json_complete`` are the same problem written two ways and compile to the
same IR digest, so a faithful lift of the first's BPMN is the second's hand-written
workflow, node for node.

What the lift cannot recover, because the reduction does not keep it: anything BPMN says
that the four blocks do not. A branch's id survives -- the reduced exclusive carries the
BPMN sequence-flow id, which is why an imported composition keeps branch ids verbatim
rather than deriving them -- and the rest of the diagram, its layout included, does not.
"""

from __future__ import annotations

import json
from typing import Any, Mapping

from . import ids
from .model import EmptyNode, Exclusive, Branch, Node, Parallel, Repeat, Sequence, TaskNode

#: The resource id a synthesized package gives the BPMN document. It is declared in the
#: application role beside ``application.json``, which is where the Profile admits it.
WORKFLOW = "workflow"
#: The file name the BPMN document takes inside a synthesized package. The instance
#: schema's path pattern admits ``.bpmn``, which is why the source can travel here at all
#: while a composition's own YAML cannot.
WORKFLOW_FILE = "workflow.bpmn"
#: The feature a synthesized package needs in order to compile at all: the deterministic
#: profile wants at least one criterion, and a criterion wants a feature.
PROBE_FEATURE = "probe"


class BpmnError(Exception):
    """The BPMN workflow could not be reduced, or the reduction holds something new."""


def node_from_ir(source: Mapping[str, Any], counter: list[int] | None = None) -> Node:
    """One node of the IR's reduced workflow as a model node.

    A node kind this does not know is an error rather than a silent omission: the container
    may gain one, and a workflow that quietly lost a block would compile to a different
    problem with no diagnostic.
    """
    if counter is None:
        counter = [0]
    kind = source.get("kind")
    if kind == "task":
        reference = source["task"]
        return TaskNode(reference["id"] if isinstance(reference, dict) else reference)
    if kind == "empty":
        return EmptyNode()
    if kind == "sequence":
        return Sequence(tuple(node_from_ir(step, counter) for step in source["steps"]))
    if kind == "parallel":
        return Parallel(tuple(node_from_ir(branch, counter) for branch in source["branches"]))
    if kind == "exclusive":
        counter[0] += 1
        position = counter[0]
        branches = tuple(
            Branch(flow=node_from_ir(entry["flow"], counter), id=entry.get("id"))
            for entry in source["branches"]
        )
        return Exclusive(
            id=ids.exclusive_stem(branches[0].id if branches else None, position),
            branches=branches,
        )
    if kind == "repeat":
        return Repeat(
            body=node_from_ir(source["body"], counter),
            count=source.get("count"),
            expected=source.get("expectedCount"),
        )
    raise BpmnError(f"the reduced workflow holds a node kind this version cannot read: {kind!r}")


def reduce_package(files: Mapping[str, bytes]) -> Node:
    """The reduced workflow of a package that already declares one, BPMN or not.

    The package is compiled as it stands, so it has to be complete and valid: the compiler
    is all-or-nothing and there is no half-reduction to read.
    """
    from bim_core import compile_instance
    from bim_core.package import InstancePackage

    compiled = compile_instance(InstancePackage(dict(files)))
    document = getattr(compiled, "document", compiled)
    return node_from_ir(document["spec"]["application"]["workflow"])


def reduce_process(
    bpmn: bytes,
    *,
    process: str,
    tasks: Mapping[str, str],
    name: str = "bpmn_probe",
) -> Node:
    """A BPMN process as a model workflow, through a package built only to be compiled.

    ``tasks`` maps each task id the diagram references to the capability it requires. The
    caller supplies it rather than this module guessing: which capability a drawn task buys
    is an authoring decision, and deriving it from the diagram would be the first step of
    re-implementing the reducer.

    The package this builds exists for one compile and is never written anywhere.
    """
    if not tasks:
        raise BpmnError("a BPMN workflow needs the capability each of its tasks requires")
    capabilities = sorted(set(tasks.values()))
    application = {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": f"{name}_application"},
        "spec": {
            "tasks": dict(sorted(tasks.items())),
            # The probe feature exists only so the package compiles, and every part of it
            # is there to avoid a refusal rather than to mean anything: ``min`` because a
            # feature aggregating its exclusive with weightedSum makes the container demand
            # a probability per branch, and an explicit domain and neutral because ``min``
            # over an unbounded domain has none to infer.
            "features": {
                PROBE_FEATURE: {
                    "unit": "1",
                    "aggregation": "min",
                    "domain": {"kind": "real", "minimum": 0, "maximum": 1},
                    "neutral": 1,
                },
            },
            "workflow": {"bpmn": {"resource": WORKFLOW, "id": process}},
        },
    }
    # A diagram carries no distribution, and the container refuses an exclusive choice that
    # states none: "each XOR must be fully probabilistic, explicitly uniform, or fully
    # conditional". The probe declares the uniform flag, which says nothing about the
    # composition being imported -- the lifted branches carry no probability, and stating
    # the real distribution is the author's next decision.
    routing = {
        "apiVersion": "qos-binding/v1",
        "kind": "RoutingOverlay",
        "metadata": {"name": f"{name}_routing"},
        "spec": {"uniform": True},
    }
    catalog = {
        "apiVersion": "qos-binding/v1",
        "kind": "CandidateCatalog",
        "metadata": {"name": f"{name}_catalog"},
        "spec": {
            "featureBindings": {
                PROBE_FEATURE: {"resource": ids.APPLICATION, "id": PROBE_FEATURE},
            },
            "candidates": {
                f"probe_{position}": {
                    "provides": capability,
                    "features": {PROBE_FEATURE: 0},
                }
                for position, capability in enumerate(capabilities, start=1)
            },
        },
    }
    optimization = {
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "metadata": {"name": f"{name}_optimization"},
        "spec": {
            "criteria": [
                {
                    "id": PROBE_FEATURE,
                    "feature": {"resource": ids.APPLICATION, "id": PROBE_FEATURE},
                    "normalize": {"min": 0, "max": 1, "clamp": True},
                },
            ],
        },
    }
    instance = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": name, "version": "1.0.0"},
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {
                    ids.APPLICATION: "application.json",
                    WORKFLOW: WORKFLOW_FILE,
                },
                "candidateCatalog": {
                    ids.CATALOG: "candidates.json",
                    ids.ROUTING: "routing.json",
                },
                "optimization": {ids.OPTIMIZATION: "optimization.json"},
            },
        },
    }
    files = {
        "instance.json": _bytes(instance),
        "application.json": _bytes(application),
        "candidates.json": _bytes(catalog),
        "routing.json": _bytes(routing),
        "optimization.json": _bytes(optimization),
        WORKFLOW_FILE: bpmn,
    }
    try:
        return reduce_package(files)
    except Exception as error:  # noqa: BLE001 - the compiler's diagnostics are the message
        raise BpmnError(f"the container refused the BPMN workflow: {error}") from error


def _bytes(document: dict[str, Any]) -> bytes:
    return (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

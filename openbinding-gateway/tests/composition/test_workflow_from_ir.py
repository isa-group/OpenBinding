"""The workflow tree, lifted from compiled problems, and the first place two trees differ.

A problem's workflow is read from its compiled IR, which already holds the reduced workflow:
BPMN lowered, routing materialised, nested sequences flattened. The packages are compiled
here through the gateway's in-process port, so the test needs the pinned toolchain and no
kit, and it never skips.

``examples/demo/15_bpmn_complete`` and ``examples/demo/16_json_complete`` are the same
problem written two ways -- a BPMN diagram and a JSON workflow -- so their lifted trees must
describe each other: that is the BPMN oracle, now read on the IR.
"""

from __future__ import annotations

from functools import cache
from typing import Any

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.composition.diagnostics import Path
from openbinding_gateway.composition.workflow import (
    Branch,
    EmptyNode,
    Exclusive,
    Location,
    Node,
    Parallel,
    Repeat,
    Sequence,
    TaskNode,
    WorkflowError,
    first_mismatch,
    from_ir,
    invocations,
    normalise,
    shape,
    tasks,
)
from openbinding_gateway.integrations import bim, packages

SIMPLE = REPO_ROOT / "examples" / "demo" / "01_simple_seq"
BPMN = REPO_ROOT / "examples" / "demo" / "15_bpmn_complete"
JSON = REPO_ROOT / "examples" / "demo" / "16_json_complete"
PLACEMENT = REPO_ROOT / "examples" / "placement" / "01_small_placement"


@cache
def _spec(directory) -> dict[str, Any]:
    return bim.build_bim().compile(packages.zip_directory(directory))["ir"]["spec"]


def _lifted(directory) -> Node:
    spec = _spec(directory)
    return from_ir(spec["application"]["workflow"], spec.get("routing", ()))


WORKFLOW = Path(("workflow",))


def _paths(node: Node, path: Path = WORKFLOW, location: Location = ()) -> dict[Location, Path]:
    """The source path of each node as Composition2Yaml writes it: ``seq``/``and``/``xor``/``loop``,
    a branch that states a probability as ``{probability, flow}``."""
    found = {location: path}
    if isinstance(node, (Sequence, Parallel)):
        word = "seq" if isinstance(node, Sequence) else "and"
        for position, child in enumerate(node.children):
            found |= _paths(child, path.child(word, position), (*location, position))
    elif isinstance(node, Exclusive):
        for position, branch in enumerate(node.branches):
            at = path.child("xor", position)
            found |= _paths(
                branch.flow, at.child("flow") if branch.probability is not None else at, (*location, position)
            )
    elif isinstance(node, Repeat):
        found |= _paths(node.body, path.child("loop"), (*location, 0))
    return found


def _mismatch(written: Node, problem: Node):
    return first_mismatch(written, _paths(written), problem)


# --------------------------------------------------------------------------- the lift


def test_a_plain_sequence_lifts_to_its_tasks() -> None:
    assert _lifted(SIMPLE) == Sequence((TaskNode("t1"), TaskNode("t2"), TaskNode("t3")))


def test_routing_and_loops_are_lifted_as_the_ir_states_them() -> None:
    assert _lifted(JSON) == Sequence(
        (
            TaskNode("authenticate"),
            Parallel(
                (
                    Sequence(
                        (
                            TaskNode("enrich"),
                            Exclusive((Branch(TaskNode("cache"), 0.65), Branch(TaskNode("fetch"), 0.35))),
                            Repeat(TaskNode("score"), count=2),
                        )
                    ),
                    TaskNode("audit"),
                )
            ),
            TaskNode("publish"),
        )
    )


def test_the_diagram_and_the_hand_written_workflow_describe_each_other() -> None:
    from_diagram, from_json = _lifted(BPMN), _lifted(JSON)
    assert from_diagram == from_json
    assert _mismatch(from_diagram, from_json) is None
    assert _mismatch(from_json, from_diagram) is None


def test_an_exclusive_with_equal_probabilities_is_uniform_and_keeps_them() -> None:
    lifted = _lifted(PLACEMENT)
    (choice,) = [node for node in _nodes(lifted) if isinstance(node, Exclusive)]
    assert choice.uniform is True
    assert [branch.probability for branch in choice.branches] == [0.5, 0.5]


@pytest.mark.parametrize(
    ("probabilities", "uniform", "matches"),
    [((None, None), True, True), ((0.5, 0.5), False, True), ((0.4, 0.6), False, False)],
)
def test_a_uniform_choice_matches_uniform_or_its_probabilities_written_out(
    probabilities, uniform, matches
) -> None:
    problem = _lifted(PLACEMENT)
    written = _with_choice(problem, probabilities, uniform)
    found = _mismatch(written, problem)
    if matches:
        assert found is None
    else:
        assert found is not None
        assert found.path == Path(("workflow", "seq", 1, "and", 0, "seq", 1, "xor", 0, "probability"))
        assert "0.5" in found.reason


def test_an_empty_step_lifts_and_an_unknown_kind_is_refused() -> None:
    assert from_ir(
        {"kind": "sequence", "steps": [{"kind": "empty"}, {"kind": "task", "task": "a"}]}
    ) == Sequence(
        (EmptyNode(), TaskNode("a")),
    )
    with pytest.raises(WorkflowError, match="cannot read"):
        from_ir({"kind": "compensation", "steps": []})


def test_a_choice_without_routing_states_no_probabilities() -> None:
    lifted = from_ir(
        {
            "kind": "exclusive",
            "branches": [
                {"id": "x", "flow": {"kind": "task", "task": "a"}},
                {"flow": {"kind": "task", "task": "b"}},
            ],
        }
    )
    assert lifted == Exclusive((Branch(TaskNode("a")), Branch(TaskNode("b"))))
    written = Exclusive((Branch(TaskNode("a"), 0.5), Branch(TaskNode("b"), 0.5)))
    found = _mismatch(written, lifted)
    assert found is not None and found.path == Path(("workflow", "xor", 0, "probability"))


# --------------------------------------------------------------------------- the first mismatch


def test_a_swapped_task_is_named_where_it_is_written() -> None:
    problem = _lifted(JSON)
    written = _replace(problem, TaskNode("cache"), TaskNode("fetch"), first_only=True)
    found = _mismatch(written, problem)
    assert found is not None
    assert found.path == Path(("workflow", "seq", 1, "and", 0, "seq", 1, "xor", 0, "flow"))
    assert "'cache'" in found.reason


def test_a_missing_branch_is_named_at_its_choice() -> None:
    problem = _lifted(JSON)
    written = Sequence(
        (
            TaskNode("authenticate"),
            Parallel(
                (
                    Sequence(
                        (
                            TaskNode("enrich"),
                            Exclusive((Branch(TaskNode("cache"), 0.65),)),
                            Repeat(TaskNode("score"), count=2),
                        )
                    ),
                    TaskNode("audit"),
                )
            ),
            TaskNode("publish"),
        )
    )
    found = _mismatch(written, problem)
    assert found is not None
    assert found.path == Path(("workflow", "seq", 1, "and", 0, "seq", 1))
    assert "2 branches" in found.reason


def test_a_changed_loop_count_is_named_at_its_count() -> None:
    problem = _lifted(JSON)
    written = _replace(problem, Repeat(TaskNode("score"), count=2), Repeat(TaskNode("score"), count=3))
    found = _mismatch(written, problem)
    assert found is not None
    assert found.path == Path(("workflow", "seq", 1, "and", 0, "seq", 2, "count"))
    expected = _replace(problem, Repeat(TaskNode("score"), count=2), Repeat(TaskNode("score"), expected=2.0))
    assert _mismatch(expected, problem).path == Path(("workflow", "seq", 1, "and", 0, "seq", 2, "expected"))


def test_a_differing_written_probability_is_named_at_its_branch() -> None:
    problem = _lifted(JSON)
    written = _replace(
        problem,
        Exclusive((Branch(TaskNode("cache"), 0.65), Branch(TaskNode("fetch"), 0.35))),
        Exclusive((Branch(TaskNode("cache"), 0.65), Branch(TaskNode("fetch"), 0.36))),
    )
    found = _mismatch(written, problem)
    assert found is not None
    assert found.path == Path(("workflow", "seq", 1, "and", 0, "seq", 1, "xor", 1, "probability"))
    unstated = _replace(
        problem,
        Exclusive((Branch(TaskNode("cache"), 0.65), Branch(TaskNode("fetch"), 0.35))),
        Exclusive((Branch(TaskNode("cache")), Branch(TaskNode("fetch")))),
    )
    assert _mismatch(unstated, problem) is None


def test_uniform_is_refused_on_a_choice_that_is_not() -> None:
    problem = _lifted(JSON)
    written = _replace(
        problem,
        Exclusive((Branch(TaskNode("cache"), 0.65), Branch(TaskNode("fetch"), 0.35))),
        Exclusive((Branch(TaskNode("cache")), Branch(TaskNode("fetch"))), uniform=True),
    )
    found = _mismatch(written, problem)
    assert found is not None
    assert found.path == Path(("workflow", "seq", 1, "and", 0, "seq", 1, "uniform"))


def test_a_nested_sequence_is_no_mismatch() -> None:
    problem = _lifted(SIMPLE)
    written = Sequence((TaskNode("t1"), Sequence((TaskNode("t2"), Sequence((TaskNode("t3"),))))))
    assert written != problem
    assert normalise(written) == problem
    assert _mismatch(written, problem) is None
    assert _mismatch(Sequence((Sequence((written,)),)), problem) is None


def test_a_mismatch_inside_a_spliced_sequence_keeps_its_written_path() -> None:
    problem = _lifted(SIMPLE)
    written = Sequence((TaskNode("t1"), Sequence((TaskNode("t2"), TaskNode("t9")))))
    found = _mismatch(written, problem)
    assert found is not None
    assert found.path == Path(("workflow", "seq", 1, "seq", 1))


def test_order_is_significant() -> None:
    problem = _lifted(SIMPLE)
    found = _mismatch(Sequence((TaskNode("t2"), TaskNode("t1"), TaskNode("t3"))), problem)
    assert found is not None and found.path == Path(("workflow", "seq", 0))


def test_a_location_without_a_path_is_reported_at_its_nearest_ancestor() -> None:
    problem = _lifted(SIMPLE)
    found = first_mismatch(
        Sequence((TaskNode("t1"), TaskNode("t2"), TaskNode("t4"))), {(): Path(("workflow",))}, problem
    )
    assert found is not None and found.path == Path(("workflow",))


# --------------------------------------------------------------------------- tree helpers


def test_tasks_invocations_and_shape() -> None:
    lifted = _lifted(JSON)
    assert tasks(lifted) == ("authenticate", "enrich", "cache", "fetch", "score", "audit", "publish")
    assert invocations(lifted)["score"] == [(1, 0, 2, 0)]
    assert shape(lifted) == "seq(task,and(seq(task,xor(task,task),loop[count=2](task)),task),task)"


# --------------------------------------------------------------------------- helpers


def _nodes(node: Node):
    yield node
    if isinstance(node, (Sequence, Parallel)):
        for child in node.children:
            yield from _nodes(child)
    elif isinstance(node, Exclusive):
        for branch in node.branches:
            yield from _nodes(branch.flow)
    elif isinstance(node, Repeat):
        yield from _nodes(node.body)


def _replace(node: Node, old: Node, new: Node, *, first_only: bool = False) -> Node:
    done = [False]

    def go(item: Node) -> Node:
        if item == old and not (first_only and done[0]):
            done[0] = True
            return new
        if isinstance(item, Sequence):
            return Sequence(tuple(go(child) for child in item.children))
        if isinstance(item, Parallel):
            return Parallel(tuple(go(child) for child in item.children))
        if isinstance(item, Exclusive):
            return Exclusive(tuple(Branch(go(b.flow), b.probability) for b in item.branches), item.uniform)
        if isinstance(item, Repeat):
            return Repeat(go(item.body), item.count, item.expected)
        return item

    return go(node)


def _with_choice(node: Node, probabilities: tuple[float | None, ...], uniform: bool) -> Node:
    def go(item: Node) -> Node:
        if isinstance(item, Sequence):
            return Sequence(tuple(go(child) for child in item.children))
        if isinstance(item, Parallel):
            return Parallel(tuple(go(child) for child in item.children))
        if isinstance(item, Exclusive):
            return Exclusive(
                tuple(Branch(go(b.flow), p) for b, p in zip(item.branches, probabilities, strict=True)),
                uniform,
            )
        if isinstance(item, Repeat):
            return Repeat(go(item.body), item.count, item.expected)
        return item

    return go(node)

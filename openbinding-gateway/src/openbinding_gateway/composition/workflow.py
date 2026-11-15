"""The workflow of a composition, as a tree, and how two such trees are compared.

A Composition2Yaml document writes its workflow with four blocks -- a sequence (``seq``),
a parallel split (``and``), an exclusive choice (``xor``) and a loop (``loop``) -- over task
ids and the empty step (``null``). A problem's workflow is read from its **compiled IR**,
never from the package files: the IR already holds the reduced workflow (BPMN lowered,
routing materialised, nested sequences flattened), and it is exactly what the problem's
semantic digest covers. :func:`from_ir` lifts it; it is the only place in this package that
reads the IR's node shapes, and it implements none of the compiler: it reads a published
interchange format.

**Equivalence is positional.** Branch and exclusive ids are problem detail and never appear
here; branch order and parallel order are significant, because the IR keeps the source
order. Both sides are put in the same form by :func:`normalise` (what the compiler's
``_flatten_workflow_sequences`` does, and sequence aggregation is associative), and
:func:`first_mismatch` walks them in parallel. Probabilities and loop counts are compared
only where the document writes them, exactly.

A node of a written tree is addressed by its :data:`Location`: the child positions from the
root (a step of a sequence or a parallel split, a branch of an exclusive choice, ``0`` for a
loop's body). The reader records the source :class:`~.diagnostics.Path` of each location, so
a mismatch underlines the node that differs.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Iterator, Mapping, Union
from typing import Sequence as Seq

from .diagnostics import Path

#: The child positions that lead from the root of a tree to one of its nodes.
Location = tuple[int, ...]


class WorkflowError(Exception):
    """The IR holds a workflow this version cannot read."""


@dataclass(frozen=True, slots=True)
class TaskNode:
    """A step that invokes a task."""

    task: str


@dataclass(frozen=True, slots=True)
class EmptyNode:
    """A step that does nothing (the IR's ``empty``)."""


@dataclass(frozen=True, slots=True)
class Sequence:
    """Steps one after another."""

    children: tuple["Node", ...]


@dataclass(frozen=True, slots=True)
class Parallel:
    """Branches that all run."""

    children: tuple["Node", ...]


@dataclass(frozen=True, slots=True)
class Branch:
    """One arm of an exclusive choice, with the probability it is taken, when one is stated."""

    flow: "Node"
    probability: float | None = None


@dataclass(frozen=True, slots=True)
class Exclusive:
    """A choice of exactly one branch.

    ``uniform`` says every branch is equally likely. A problem's exclusive gets it when all its
    routed probabilities are equal, and keeps those probabilities on its branches too: a
    three-way choice is ``0.3333333333333333`` three times, whose exact sum is not one, so a
    document may match it with ``uniform: true`` or with the same probabilities written out.
    """

    branches: tuple[Branch, ...]
    uniform: bool = False


@dataclass(frozen=True, slots=True)
class Repeat:
    """A body run ``count`` times (an integer) or ``expected`` times on average, never both."""

    body: "Node"
    count: int | None = None
    expected: float | None = None


Node = Union[TaskNode, EmptyNode, Sequence, Parallel, Exclusive, Repeat]


# --------------------------------------------------------------------------- lifting from the IR


def from_ir(workflow: Mapping[str, Any], routing: Seq[Mapping[str, Any]] = ()) -> Node:
    """The workflow of a compiled IR (``spec.application.workflow``) as a tree.

    ``routing`` is the IR's ``spec.routing``: each entry gives the probability of the branch
    whose id is its ``target``. An exclusive choice whose branches have no routing entry -- a
    static choice made by ``when`` -- has no probabilities. A node kind this does not know is
    an error rather than a silent omission: a workflow that quietly lost a block would
    describe a different problem.
    """
    probabilities: dict[str, Any] = {}
    for entry in routing:
        target = entry.get("target")
        branch = target.get("id") if isinstance(target, Mapping) else target
        if isinstance(branch, str):
            probabilities[branch] = entry.get("probability")
    return _lift(workflow, probabilities)


def _lift(source: Mapping[str, Any], probabilities: Mapping[str, Any]) -> Node:
    kind = source.get("kind") if isinstance(source, Mapping) else None
    if kind == "task":
        reference = source["task"]
        return TaskNode(reference["id"] if isinstance(reference, Mapping) else reference)
    if kind == "empty":
        return EmptyNode()
    if kind == "sequence":
        return Sequence(tuple(_lift(step, probabilities) for step in source["steps"]))
    if kind == "parallel":
        return Parallel(tuple(_lift(branch, probabilities) for branch in source["branches"]))
    if kind == "exclusive":
        branches = tuple(
            Branch(flow=_lift(entry["flow"], probabilities), probability=probabilities.get(entry.get("id")))
            for entry in source["branches"]
        )
        stated = [branch.probability for branch in branches]
        uniform = bool(stated) and None not in stated and len({_exact(p) for p in stated}) == 1
        return Exclusive(branches=branches, uniform=uniform)
    if kind == "repeat":
        return Repeat(
            body=_lift(source["body"], probabilities),
            count=source.get("count"),
            expected=source.get("expectedCount"),
        )
    raise WorkflowError(f"the compiled workflow holds a node kind this version cannot read: {kind!r}")


# --------------------------------------------------------------------------- normal form


def normalise(node: Node) -> Node:
    """``node`` with every sequence inside a sequence spliced into it, and every one-step
    sequence replaced by its step. Parallel and exclusive nodes keep their shape."""
    return _normal(node, ()).node


@dataclass(frozen=True, slots=True)
class _Located:
    """A normalised node, the location of the written node it stands for, and its children's."""

    node: Node
    location: Location
    children: tuple["_Located", ...] = ()


def _normal(node: Node, location: Location) -> _Located:
    """The normal form of ``node``, each node keeping the location it was written at.

    A sequence that absorbs nested ones keeps its own location, and its steps keep theirs; a
    one-step sequence stands for its step, so a mismatch there underlines the step.
    """
    if isinstance(node, Sequence):
        steps: list[_Located] = []
        for position, child in enumerate(node.children):
            normal = _normal(child, (*location, position))
            if isinstance(normal.node, Sequence):
                steps.extend(normal.children)
            else:
                steps.append(normal)
        if len(steps) == 1:
            return steps[0]
        return _Located(Sequence(tuple(step.node for step in steps)), location, tuple(steps))
    if isinstance(node, Parallel):
        children = tuple(
            _normal(child, (*location, position)) for position, child in enumerate(node.children)
        )
        return _Located(Parallel(tuple(child.node for child in children)), location, children)
    if isinstance(node, Exclusive):
        flows = tuple(
            _normal(branch.flow, (*location, position)) for position, branch in enumerate(node.branches)
        )
        branches = tuple(
            Branch(flow=flow.node, probability=branch.probability)
            for flow, branch in zip(flows, node.branches, strict=True)
        )
        return _Located(Exclusive(branches=branches, uniform=node.uniform), location, flows)
    if isinstance(node, Repeat):
        body = _normal(node.body, (*location, 0))
        return _Located(Repeat(body=body.node, count=node.count, expected=node.expected), location, (body,))
    return _Located(node, location)


# --------------------------------------------------------------------------- tree helpers


def walk(node: Node, location: Location = ()) -> Iterator[tuple[Location, Node]]:
    """Every node of the tree with its location, depth first, parents before children."""
    yield location, node
    if isinstance(node, (Sequence, Parallel)):
        for position, child in enumerate(node.children):
            yield from walk(child, (*location, position))
    elif isinstance(node, Exclusive):
        for position, branch in enumerate(node.branches):
            yield from walk(branch.flow, (*location, position))
    elif isinstance(node, Repeat):
        yield from walk(node.body, (*location, 0))


def invocations(node: Node) -> dict[str, list[Location]]:
    """Where each task is invoked, in order. A task may appear more than once."""
    found: dict[str, list[Location]] = {}
    for location, item in walk(node):
        if isinstance(item, TaskNode):
            found.setdefault(item.task, []).append(location)
    return found


def tasks(node: Node) -> tuple[str, ...]:
    """The task ids of the tree, each once, in the order a depth-first walk first meets them."""
    return tuple(invocations(node))


def shape(node: Node) -> str:
    """The block structure of the tree with the task ids left out.

    Two versions whose tasks were all renamed still share a shape, and saying so is the
    difference between "everything changed" and "the same plan, with new names". A loop's
    count is part of its shape: it changes the plan rather than naming a part of it.
    """
    if isinstance(node, TaskNode):
        return "task"
    if isinstance(node, EmptyNode):
        return "empty"
    if isinstance(node, Sequence):
        return "seq(" + ",".join(shape(child) for child in node.children) + ")"
    if isinstance(node, Parallel):
        return "and(" + ",".join(shape(child) for child in node.children) + ")"
    if isinstance(node, Exclusive):
        return "xor(" + ",".join(shape(branch.flow) for branch in node.branches) + ")"
    if isinstance(node, Repeat):
        times = f"count={node.count}" if node.count is not None else f"expected={node.expected}"
        return f"loop[{times}](" + shape(node.body) + ")"
    raise TypeError(f"not a workflow node: {node!r}")


# --------------------------------------------------------------------------- equivalence


@dataclass(frozen=True, slots=True)
class Mismatch:
    """Where a written workflow first differs from a problem's, and how."""

    path: Path
    reason: str


def first_mismatch(written: Node, written_paths: Mapping[Location, Path], problem: Node) -> Mismatch | None:
    """The first place, depth first, where ``written`` does not describe ``problem``; ``None`` if it does.

    Both trees are normalised first. Node kinds, task ids and the number of children must
    agree everywhere. Where the written tree states a detail, it must match exactly:

    * an exclusive choice may state nothing, ``uniform`` (matches iff the problem's choice is
      uniform) or probabilities (each equal to the problem's float, compared as
      ``Decimal(repr(p))``, so equal iff the floats are equal) -- whether or not the problem's
      choice is uniform, so ``0.5``/``0.5`` matches a uniform two-way choice;
    * a loop's ``count`` or ``expected``, kind and value.

    ``written_paths`` gives the source path of each location of the written tree (before
    normalisation); a location with none is reported at its nearest ancestor that has one.
    """
    return _compare(_normal(written, ()), normalise(problem), written_paths)


def _compare(written: _Located, problem: Node, paths: Mapping[Location, Path]) -> Mismatch | None:
    node = written.node

    def here(reason: str, *key: str) -> Mismatch:
        return Mismatch(_path_of(written.location, paths).child(*key), reason)

    if type(node) is not type(problem):
        return here(f"the problem has {_describe(problem)} here, not {_describe(node)}")
    if isinstance(node, TaskNode):
        assert isinstance(problem, TaskNode)
        if node.task != problem.task:
            return here(f"the problem invokes task {problem.task!r} here, not {node.task!r}")
        return None
    if isinstance(node, EmptyNode):
        return None
    if isinstance(node, (Sequence, Parallel)):
        assert isinstance(problem, (Sequence, Parallel))
        if len(node.children) != len(problem.children):
            return here(
                f"the problem's {_describe(problem)} has {len(problem.children)} "
                f"{_plural(problem, len(problem.children))}, not {len(node.children)}"
            )
        return _first(written.children, problem.children, paths)
    if isinstance(node, Exclusive):
        assert isinstance(problem, Exclusive)
        if len(node.branches) != len(problem.branches):
            return here(
                f"the problem's choice has {len(problem.branches)} branches, not {len(node.branches)}"
            )
        if node.uniform and not problem.uniform:
            return here("the problem's choice is not uniform", "uniform")
        for flow, branch, expected in zip(written.children, node.branches, problem.branches, strict=True):
            if branch.probability is None:
                continue
            if expected.probability is None:
                return Mismatch(
                    _path_of(flow.location, paths, branch=True),
                    "the problem's choice states no probabilities",
                )
            if _exact(branch.probability) != _exact(expected.probability):
                return Mismatch(
                    _path_of(flow.location, paths, branch=True),
                    f"the problem takes this branch with probability {expected.probability!r}, "
                    f"not {branch.probability!r}",
                )
        return _first(written.children, tuple(branch.flow for branch in problem.branches), paths)
    if isinstance(node, Repeat):
        assert isinstance(problem, Repeat)
        if node.count is not None and (problem.count is None or _exact(node.count) != _exact(problem.count)):
            return here(f"the problem repeats this {_times(problem)}, not count {node.count!r}", "count")
        if node.expected is not None and (
            problem.expected is None or _exact(node.expected) != _exact(problem.expected)
        ):
            return here(
                f"the problem repeats this {_times(problem)}, not expected {node.expected!r}", "expected"
            )
        return _compare(written.children[0], problem.body, paths)
    raise TypeError(f"not a workflow node: {node!r}")


def _first(
    written: tuple[_Located, ...], problem: tuple[Node, ...], paths: Mapping[Location, Path]
) -> Mismatch | None:
    for child, expected in zip(written, problem, strict=True):
        found = _compare(child, expected, paths)
        if found is not None:
            return found
    return None


def _exact(number: Any) -> Decimal:
    """A number as the decimal its ``repr`` writes: two floats are equal iff these are."""
    return Decimal(repr(number))


def _path_of(location: Location, paths: Mapping[Location, Path], *, branch: bool = False) -> Path:
    """The source path of ``location``, or of its nearest ancestor that has one.

    With ``branch``, the location is a branch's flow and the path wanted is its probability's:
    a branch that states one is written ``{probability, flow}``, so it sits beside the flow.
    """
    at = location
    while True:
        found = paths.get(at)
        if found is not None:
            if branch and at == location and found and found[-1] == "flow":
                return Path((*found[:-1], "probability"))
            return found
        if not at:
            return Path(("workflow",))
        at = at[:-1]


def _describe(node: Node) -> str:
    if isinstance(node, TaskNode):
        return f"task {node.task!r}"
    if isinstance(node, EmptyNode):
        return "an empty step"
    if isinstance(node, Sequence):
        return "a sequence (seq)"
    if isinstance(node, Parallel):
        return "a parallel split (and)"
    if isinstance(node, Exclusive):
        return "an exclusive choice (xor)"
    if isinstance(node, Repeat):
        return "a loop"
    return type(node).__name__


def _plural(node: Node, count: int) -> str:
    word = "step" if isinstance(node, Sequence) else "branch"
    if count == 1:
        return word
    return word + ("es" if word == "branch" else "s")


def _times(node: Repeat) -> str:
    if node.count is not None:
        return f"count {node.count!r}"
    if node.expected is not None:
        return f"expected {node.expected!r}"
    return "with no stated count"

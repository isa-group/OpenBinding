"""What a composition says that does not hold together, reported in the author's text.

These are the checks the ``c2y_*`` codes were declared for in F0 and that nothing made.
They are **semantic**: the document is well-formed, the schema accepts it, every reader
reads it, and it still says something that cannot be true -- a workflow step naming a task
nobody declared, a goal over a property that does not exist, probabilities that do not add
up.

The container catches all of them. It catches them against a resource and a JSON pointer,
one compile later and one layer further away, which is the right address for a generated
document and the wrong one for a person editing YAML. Moving them here does not make the
container's checks redundant; it makes them late.

**Every check is measured against the gate before it is enforced.** All eight refuse none of
the 82 packages of specification section 11.2, which is what makes it safe to refuse them at
authoring time: a check that rejected a package in the corpus would be a claim about the
language contradicted by the language's own examples. The measurement is a test, not a note.

**One declared code is deliberately absent.** Section 14 named
``c2y_exclusive_condition`` for "a branch carries both a probability and a condition", and
section 5.2 says the opposite in as many words -- a condition is prose, Studio-side, never
compiled, "so a condition and a probability on the same branch are not in conflict: the
guiding case has both". The guiding case does: ``fleet-management-v2``'s ``solver_choice``
carries 0.8/0.2 and a reason on each branch. Implementing that row would have refused the
project's own example, so the row goes rather than the example.

All diagnostics are collected, not raised one at a time, because an editor wants a marker
per problem and a person wants to fix a document once.

A limitation worth stating: a diagnostic about a **workflow node** is addressed to
``workflow`` rather than to the node, because the model does not carry where a node came
from. ``spans.locate`` can find ``workflow.sequence[0].task``; the ``Sequence`` object in
hand cannot say it is the first step of the top-level sequence. Giving nodes a source path
is its own change, and until then the underline covers the block.
"""

from __future__ import annotations

from . import diagnostics as codes
from .diagnostics import Diagnostic
from .model import (
    Composition,
    Exclusive,
    Node,
    OpenTask,
    Parallel,
    Repeat,
    Sequence,
    TaskNode,
)


def _tasks_used(node: Node, found: set[str] | None = None) -> set[str]:
    found = set() if found is None else found
    if isinstance(node, TaskNode):
        found.add(node.task)
    elif isinstance(node, (Sequence, Parallel)):
        for child in node.children:
            _tasks_used(child, found)
    elif isinstance(node, Repeat):
        _tasks_used(node.body, found)
    elif isinstance(node, Exclusive):
        for branch in node.branches:
            _tasks_used(branch.flow, found)
    return found


def _exclusives(node: Node, found: list[Exclusive] | None = None) -> list[Exclusive]:
    found = [] if found is None else found
    if isinstance(node, (Sequence, Parallel)):
        for child in node.children:
            _exclusives(child, found)
    elif isinstance(node, Repeat):
        _exclusives(node.body, found)
    elif isinstance(node, Exclusive):
        found.append(node)
        for branch in node.branches:
            _exclusives(branch.flow, found)
    return found


def _repeats(node: Node, found: list[Repeat] | None = None) -> list[Repeat]:
    found = [] if found is None else found
    if isinstance(node, (Sequence, Parallel)):
        for child in node.children:
            _repeats(child, found)
    elif isinstance(node, Repeat):
        found.append(node)
        _repeats(node.body, found)
    elif isinstance(node, Exclusive):
        for branch in node.branches:
            _repeats(branch.flow, found)
    return found


def _capabilities(composition: Composition) -> set[str]:
    """Every capability the catalog offers, counting a fixed task's minted one.

    A fixed task's candidate is minted by the emitter rather than written by the author
    (``emit._fixed_candidates``), so its capability is provided even though no row says so.
    Leaving it out would refuse every composition with a fixed task.
    """
    offered: set[str] = set()
    for candidate in composition.candidates:
        if isinstance(candidate.provides, str):
            offered.add(candidate.provides)
        else:
            offered.update(candidate.provides)
    return offered


def semantic(composition: Composition) -> tuple[Diagnostic, ...]:
    """Everything the composition says that does not hold together, of both kinds."""
    return coherence(composition) + completeness(composition)


def completeness(composition: Composition) -> tuple[Diagnostic, ...]:
    """What a composition still lacks before it can be compiled.

    References across sections and an empty market: a workflow step naming a task nobody
    declared, a declared task the workflow never runs, a goal over a property that does not
    exist, an open task no candidate serves. **None of these is a parse error**, and that was
    measured rather than decided: enforcing them in ``parse`` refused two documents in the
    suite that are drafts -- an open task whose market is not written yet, which is a normal
    state while a composition is being authored. The diff compares drafts and the editor
    loads one at every keystroke, so refusing them there would make an unfinished document
    unreadable. They are refused instead where a composition has to be complete: when a
    version is sealed, because a sealed version is citable and has to compile.
    """
    found: list[Diagnostic] = []
    used = _tasks_used(composition.workflow)

    for name in sorted(used - set(composition.tasks)):
        found.append(Diagnostic(
            code=codes.TASK_UNKNOWN,
            message=f"the workflow runs task {name!r}, which is not declared",
            path="workflow",
        ))
    for name in sorted(set(composition.tasks) - used):
        found.append(Diagnostic(
            code=codes.TASK_UNREACHED,
            message=f"task {name!r} is declared and appears nowhere in the workflow",
            path=f"tasks.{name}",
        ))

    for position, goal in enumerate(composition.goals):
        if goal.property not in composition.properties:
            found.append(Diagnostic(
                code=codes.GOAL_UNKNOWN,
                message=f"the goal reads property {goal.property!r}, which is not declared",
                path=f"goals[{position}].property",
            ))

    offered = _capabilities(composition)
    for name, task in composition.tasks.items():
        if isinstance(task, OpenTask) and task.requires not in offered:
            found.append(Diagnostic(
                code=codes.CANDIDATE_UNMATCHED,
                message=(
                    f"open task {name!r} requires {task.requires!r} and no candidate "
                    "provides it"
                ),
                path=f"tasks.{name}",
            ))

    return tuple(found)


def coherence(composition: Composition) -> tuple[Diagnostic, ...]:
    """What no composition can say, finished or not: one element that contradicts itself.

    Probabilities that do not sum to one, a distribution stated twice, a repeat that is both
    counted and expected. A draft is allowed to be incomplete; it is not allowed to be
    self-contradictory, because a contradiction is not a step on the way to a valid
    document, so these are refused by ``parse``.
    """
    found: list[Diagnostic] = []
    for choice in _exclusives(composition.workflow):
        probabilities = [branch.probability for branch in choice.branches]
        stated = [value for value in probabilities if value is not None]
        if stated and not choice.id:
            found.append(Diagnostic(
                code=codes.EXCLUSIVE_ID,
                message=(
                    "an exclusive with probabilities needs an id of its own: its branch "
                    "ids are derived from it and they are visible in the IR digest"
                ),
                path="workflow",
            ))
        if stated and len(stated) != len(probabilities):
            found.append(Diagnostic(
                code=codes.EXCLUSIVE_PROBABILITIES,
                message=(
                    f"exclusive {choice.id or '(unnamed)'} states "
                    f"{len(stated)} of {len(probabilities)} probabilities: all or none"
                ),
                path="workflow",
            ))
        elif stated and len(stated) == len(probabilities) and sum(stated) != 1:
            # Compared against one without an epsilon, because the container does: the
            # probabilities are read as Decimal from the source text and never recomputed,
            # so ``0.1 + 0.2`` is the author's problem to see here rather than the
            # compiler's to report two layers away.
            found.append(Diagnostic(
                code=codes.EXCLUSIVE_PROBABILITIES,
                message=(
                    f"exclusive {choice.id or '(unnamed)'} has probabilities summing to "
                    f"{sum(stated)}, and they must sum to exactly 1"
                ),
                path="workflow",
            ))
        if choice.distribution and stated:
            found.append(Diagnostic(
                code=codes.EXCLUSIVE_DISTRIBUTION,
                message=(
                    f"exclusive {choice.id or '(unnamed)'} declares a distribution and "
                    "inline probabilities, which say the same thing two ways"
                ),
                path="workflow",
            ))

    for repeat in _repeats(composition.workflow):
        if (repeat.count is None) == (repeat.expected is None):
            found.append(Diagnostic(
                code=codes.REPEAT_COUNT,
                message="a repeat states exactly one of count and expectedCount",
                path="workflow",
            ))

    return tuple(found)

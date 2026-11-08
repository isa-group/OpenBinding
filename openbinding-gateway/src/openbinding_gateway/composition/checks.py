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

**Every check is measured against the gate before it is enforced.** All ten refuse none of
the 82 packages of specification section 11.2, which is what makes it safe to refuse them at
authoring time: a check that rejected a package in the corpus would be a claim about the
language contradicted by the language's own examples. The measurement is a test, not a note.

**Two of them guard the emitter.** A property whose neutral cannot be resolved and a goal
with nothing to normalize over used to surface only as exceptions out of ``emit`` -- the
first naming no property -- on documents ``parse`` accepted and sealing would have sealed.
Both are asked here through the emitter's own functions, so the check and the package cannot
disagree, and a complete composition is one ``emit`` can write.

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
from .emit import EmitError, criterion_range, property_neutral
from .neutral import OutsideDomain, Unbounded
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


#: The domain kinds a property may have; any other is the schema's to refuse.
_DOMAIN_KINDS = frozenset({"real", "integer", "ratio"})


def _bound(value: float | None) -> str:
    return "unbounded" if value is None else f"{value:g}"


def _number(value: object) -> bool:
    """Absent, or a number the schema would accept as one (a bool is not)."""
    return value is None or (isinstance(value, (int, float)) and not isinstance(value, bool))


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
        prop = composition.properties.get(goal.property)
        if prop is None:
            found.append(Diagnostic(
                code=codes.GOAL_UNKNOWN,
                message=f"the goal reads property {goal.property!r}, which is not declared",
                path=f"goals[{position}].property",
            ))
        elif goal.normalize is None:
            # The emitter's own function, so the check and the package cannot disagree about
            # which goals have a range. Here rather than in coherence because it is a goal and
            # a property read together, like the unknown property above, and a draft whose
            # property has not been given its bounds yet is unfinished, not contradictory.
            try:
                criterion_range(goal.property, prop)
            except EmitError as error:
                found.append(Diagnostic(
                    code=codes.GOAL_RANGE, message=str(error), path=f"goals[{position}]",
                ))

    for name, prop in composition.properties.items():
        # A ``min`` property whose domain has no maximum yet, say: the bound is missing, not
        # contradicted, and choosing the ``throughput`` template before typing its bound is
        # the ordinary way to get here. So it is reported where a draft may still be
        # unfinished -- the editor keeps working -- and refused where a version is sealed or
        # compiled, before the emitter would raise on it. Sections 3.2 and 10.1 ask for it to
        # be caught at authoring time, and an ``incomplete`` marker is caught.
        try:
            property_neutral(prop)
        except Unbounded as error:
            side = "max" if error.bound == "maximum" else "min"
            found.append(Diagnostic(
                code=codes.PROPERTY_NEUTRAL,
                message=(
                    f"property {name!r} aggregates a sequence with {error.operator!r} and its "
                    f"domain has no {side}, so it has no neutral yet: give the domain a {side} "
                    "or declare the neutral"
                ),
                path=f"properties.{name}",
            ))
        except (OutsideDomain, TypeError, ValueError, OverflowError):
            continue  # coherence and the schema answer these, on documents that get this far

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
    for name, prop in composition.properties.items():
        # A property whose neutral lies outside its own domain contradicts itself: the domain
        # excludes the value the property contributes where it does not participate. Asked
        # through the emitter's own function, which applies the container's rule -- every
        # neutral, inferred or declared, against the domain, a ratio against [0, 1] -- so the
        # check, the package and the compiler agree.
        if not isinstance(prop.domain.kind, str) or prop.domain.kind not in _DOMAIN_KINDS or not all(
            _number(value) for value in (prop.neutral, prop.domain.minimum, prop.domain.maximum)
        ):
            # Coherence runs before the schema, and a bound written as text, or a kind the
            # language does not have, is the schema's to name: judging a neutral against it
            # would report the wrong problem -- a misspelt ``ratio`` would be checked as a
            # real domain and blamed on the neutral.
            continue
        try:
            property_neutral(prop)
        except Unbounded:
            continue  # nothing contradicts itself yet; completeness reports what is missing
        except OutsideDomain as error:
            found.append(Diagnostic(
                code=codes.PROPERTY_NEUTRAL,
                message=(
                    f"property {name!r} has the neutral {error.value}, which lies outside its "
                    f"own domain [{_bound(error.minimum)}, {_bound(error.maximum)}]"
                ),
                path=f"properties.{name}.neutral" if prop.neutral is not None else f"properties.{name}",
            ))

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

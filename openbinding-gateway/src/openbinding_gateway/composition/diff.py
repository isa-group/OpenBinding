"""What changed between two versions of a composition, as a typed list rather than a table.

Phase F1 step 6. The repository already had a diff -- the compare screen's -- and reusing
its five categories was the obvious move. Measuring it refused the idea: that diff is
computed over the **compiled package**, its notion of "changed" is "these two cells print
differently", and on the guiding case's own version-to-version change it produces 32 rows
of which 27 say only that an identifier exists on one side. Two of its categories report a
real change as *Same*: a goal whose normalization range moves prints the same string, and
every criterion in the gate carries a range. One category, Resources, cannot hold a row for
a composition at all.

So this diffs the **model**, which is the thing the author edits, and says what kind of
change each one is. The verdicts are the point:

* ``renamed`` and ``moved`` are what turn a rename census back into sentences. A task that
  keeps its capability and its candidates but changes its id is one change, not one removal
  and one addition; a task that keeps everything but its position in the workflow is a
  move.
* ``added`` and ``removed`` then mean what they say. On an architecture change like the
  guiding case's version 1 to version 2 nothing matches, every service is added or
  removed, and that *is* the truth about those two versions -- the point is that the
  verdict is earned rather than being all the diff can express.

Three things it reports that a diff over the package cannot, because the emission drops
them by design: a property's domain of applicability, a candidate's solver domain -- the
classical-versus-quantum axis the guiding case exists to study -- and a branch's
human-readable condition. They are Studio-side, and a diff that could not see them would be
blind to the edits an author makes most often.

The sections mirror ``model.py`` rather than the screen. The screen's five buttons are a
projection of this, and the fifth one becomes Properties: 205 of the 320 properties in the
gate carry a direction or an aggregation that is not its template's default, and that is
the class of change whose only other symptom is a digest that does not match.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Iterable

from .model import (
    Candidate,
    Composition,
    EmptyNode,
    Exclusive,
    FixedTask,
    LocalTask,
    Node,
    OpenTask,
    Parallel,
    Property,
    Repeat,
    Sequence,
    TaskNode,
)

#: The sections a change can belong to, in the order a reader wants them.
SECTIONS = (
    "identity",
    "properties",
    "tasks",
    "workflow",
    "candidates",
    "rules",
    "goals",
    "studio",
)

#: What kind of change it is. ``renamed`` and ``moved`` exist so that the other three mean
#: something: without them every rename is a removal plus an addition, which is the shape
#: the compare screen degrades to.
KINDS = ("added", "removed", "changed", "renamed", "moved")


@dataclass(frozen=True, slots=True)
class Change:
    """One difference, in the terms the author wrote rather than the ones the package has."""

    section: str
    #: What the change is about: an id, or an id and the field under it (``cost.direction``).
    subject: str
    kind: str
    was: Any = None
    now: Any = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "section": self.section,
            "subject": self.subject,
            "kind": self.kind,
            "was": self.was,
            "now": self.now,
        }


def _scalar(value: Any) -> Any:
    """A value in a form a reader and a JSON encoder both accept.

    A probability stays exact as text rather than becoming a float: the container compares
    a distribution against ``Decimal(1)`` with no epsilon, so a diff that rounded one would
    report two distributions as equal that the compiler does not.
    """
    if isinstance(value, Decimal):
        return format(value, "f")
    return value


def _field_changes(
    section: str, subject: str, before: Any, after: Any, fields: Iterable[str],
) -> list[Change]:
    """One change per field that differs, named ``subject.field``."""
    found = []
    for name in fields:
        was, now = getattr(before, name), getattr(after, name)
        if was != now:
            found.append(
                Change(section, f"{subject}.{name}", "changed", _scalar(was), _scalar(now)),
            )
    return found


# --------------------------------------------------------------------------- identity


def _identity(before: Composition, after: Composition) -> list[Change]:
    found = _field_changes(
        "identity", before.composition, before, after, ("version", "title", "description"),
    )
    if before.composition != after.composition:
        found.insert(
            0, Change("identity", "composition", "renamed", before.composition, after.composition),
        )
    if (before.pricing is None) != (after.pricing is None):
        found.append(
            Change(
                "identity",
                "pricing",
                "added" if after.pricing is not None else "removed",
                before.pricing.href if before.pricing else None,
                after.pricing.href if after.pricing else None,
            ),
        )
    elif before.pricing is not None and before.pricing != after.pricing:
        found.append(
            Change("identity", "pricing", "changed", before.pricing.href, after.pricing.href),
        )
    return found


# --------------------------------------------------------------------------- properties


#: The fields of a property that are worth naming one by one. The five aggregation
#: operators are flattened into this list because "the aggregation changed" is not a
#: finding a reader can act on -- which operator changed is.
PROPERTY_FIELDS = ("unit", "direction", "scope", "applies_to", "neutral", "title")
AGGREGATION_FIELDS = ("sequence", "parallel", "exclusive", "repeat", "selection")
DOMAIN_FIELDS = ("kind", "minimum", "maximum")


def _property(subject: str, before: Property, after: Property) -> list[Change]:
    found = _field_changes("properties", subject, before, after, PROPERTY_FIELDS)
    found += _field_changes(
        "properties", f"{subject}.aggregation", before.aggregation, after.aggregation,
        AGGREGATION_FIELDS,
    )
    found += _field_changes(
        "properties", f"{subject}.domain", before.domain, after.domain, DOMAIN_FIELDS,
    )
    return found


def _properties(before: Composition, after: Composition) -> list[Change]:
    found: list[Change] = []
    for name in sorted(set(before.properties) | set(after.properties)):
        was, now = before.properties.get(name), after.properties.get(name)
        if was is None:
            found.append(Change("properties", name, "added", None, now.unit))
        elif now is None:
            found.append(Change("properties", name, "removed", was.unit, None))
        else:
            found += _property(name, was, now)
    return found


# --------------------------------------------------------------------------- tasks


def _task_kind(task: OpenTask | FixedTask | LocalTask) -> str:
    if isinstance(task, OpenTask):
        return "open"
    return "fixed" if isinstance(task, FixedTask) else "local"


def _capability(task: OpenTask | FixedTask | LocalTask) -> str | None:
    return task.requires if isinstance(task, OpenTask) else None


def _match_tasks(
    before: Composition, after: Composition,
) -> tuple[dict[str, str], set[str], set[str]]:
    """Pair the tasks that only changed their id, and report the rest as gone or new.

    The evidence for a rename is deliberately strong: the same kind and the same
    capability, and that capability unique on both sides. A weaker rule would pair two
    unrelated open tasks that happen to buy the same thing and report one rename where the
    truth is one removal and one addition.
    """
    gone = set(before.tasks) - set(after.tasks)
    new = set(after.tasks) - set(before.tasks)
    renamed: dict[str, str] = {}
    for old in sorted(gone):
        was = before.tasks[old]
        capability = _capability(was)
        if capability is None:
            continue
        matches = [
            fresh
            for fresh in sorted(new)
            if _task_kind(after.tasks[fresh]) == _task_kind(was)
            and _capability(after.tasks[fresh]) == capability
        ]
        rivals = [
            name for name in before.tasks if _capability(before.tasks[name]) == capability
        ]
        if len(matches) == 1 and len(rivals) == 1:
            renamed[old] = matches[0]
            new.discard(matches[0])
    return renamed, gone - set(renamed), new


def _tasks(before: Composition, after: Composition, renamed: dict[str, str]) -> list[Change]:
    found: list[Change] = []
    _, gone, new = _match_tasks(before, after)
    for old, fresh in sorted(renamed.items()):
        found.append(Change("tasks", old, "renamed", old, fresh))
    for name in sorted(gone):
        found.append(Change("tasks", name, "removed", _task_kind(before.tasks[name]), None))
    for name in sorted(new):
        found.append(Change("tasks", name, "added", None, _task_kind(after.tasks[name])))
    for name in sorted(set(before.tasks) & set(after.tasks)):
        found += _one_task(name, before.tasks[name], after.tasks[name])
    for old, fresh in sorted(renamed.items()):
        found += _one_task(fresh, before.tasks[old], after.tasks[fresh])
    return found


def _one_task(subject: str, was: Any, now: Any) -> list[Change]:
    if _task_kind(was) != _task_kind(now):
        return [Change("tasks", f"{subject}.kind", "changed", _task_kind(was), _task_kind(now))]
    if isinstance(was, OpenTask):
        return _field_changes("tasks", subject, was, now, ("requires", "title"))
    if isinstance(was, FixedTask):
        return _field_changes("tasks", subject, was, now, ("provider", "domain", "title")) + (
            [Change("tasks", f"{subject}.properties", "changed", was.properties, now.properties)]
            if was.properties != now.properties
            else []
        )
    return _field_changes("tasks", subject, was, now, ("title",))


# --------------------------------------------------------------------------- workflow


def _walk(node: Node, path: str = "") -> list[tuple[str, str, Node]]:
    """Every node with the path that reaches it, so a move can be named rather than implied."""
    found = [(path or "/", type(node).__name__, node)]
    if isinstance(node, (Sequence, Parallel)):
        kind = "sequence" if isinstance(node, Sequence) else "parallel"
        for position, child in enumerate(node.children):
            found += _walk(child, f"{path}/{kind}[{position}]")
    elif isinstance(node, Exclusive):
        for position, branch in enumerate(node.branches):
            found += _walk(branch.flow, f"{path}/exclusive[{position}]")
    elif isinstance(node, Repeat):
        found += _walk(node.body, f"{path}/repeat")
    return found


def _invocations(node: Node) -> dict[str, list[str]]:
    """Where each task is invoked, in order. A task may appear more than once."""
    found: dict[str, list[str]] = {}
    for path, _name, item in _walk(node):
        if isinstance(item, TaskNode):
            found.setdefault(item.task, []).append(path)
    return found


def _shape(node: Node) -> str:
    """The workflow's block structure, with the task ids left out.

    Two versions whose tasks were all renamed still share a shape, and saying so is the
    difference between "everything changed" and "the same plan, with new names".
    """
    if isinstance(node, TaskNode):
        return "task"
    if isinstance(node, EmptyNode):
        return "empty"
    if isinstance(node, Sequence):
        return "sequence(" + ",".join(_shape(child) for child in node.children) + ")"
    if isinstance(node, Parallel):
        return "parallel(" + ",".join(_shape(child) for child in node.children) + ")"
    if isinstance(node, Exclusive):
        return "exclusive(" + ",".join(_shape(b.flow) for b in node.branches) + ")"
    if isinstance(node, Repeat):
        return f"repeat({_shape(node.body)})"
    return type(node).__name__


def _workflow(before: Composition, after: Composition, renamed: dict[str, str]) -> list[Change]:
    found: list[Change] = []
    was_shape, now_shape = _shape(before.workflow), _shape(after.workflow)
    if was_shape != now_shape:
        found.append(Change("workflow", "structure", "changed", was_shape, now_shape))

    was_at = _invocations(before.workflow)
    now_at = _invocations(after.workflow)
    # A renamed task keeps its identity across the comparison, so its move is a move.
    was_at = {renamed.get(name, name): paths for name, paths in was_at.items()}
    for name in sorted(set(was_at) | set(now_at)):
        here, there = was_at.get(name, []), now_at.get(name, [])
        if not here:
            found.append(Change("workflow", name, "added", None, there))
        elif not there:
            found.append(Change("workflow", name, "removed", here, None))
        elif here != there:
            kind = "changed" if len(here) != len(there) else "moved"
            found.append(Change("workflow", name, kind, here, there))

    found += _distributions(before, after)
    return found


def _exclusives(node: Node) -> list[Exclusive]:
    found: list[Exclusive] = []
    for _path, _name, item in _walk(node):
        if isinstance(item, Exclusive):
            found.append(item)
    return found


def _distributions(before: Composition, after: Composition) -> list[Change]:
    """How each choice is weighted, which the compiled package keeps in another document."""
    found: list[Change] = []
    was = {node.id: node for node in _exclusives(before.workflow)}
    now = {node.id: node for node in _exclusives(after.workflow)}
    for name in sorted(set(was) & set(now)):
        here, there = was[name], now[name]
        if here.distribution != there.distribution:
            found.append(
                Change(
                    "workflow", f"{name}.distribution", "changed",
                    here.distribution, there.distribution,
                ),
            )
        if len(here.branches) != len(there.branches):
            # Reported rather than zipped away: a choice that gained or lost a branch is
            # the change, and comparing only the common ones would hide it.
            found.append(
                Change(
                    "workflow", f"{name}.branches", "changed",
                    len(here.branches), len(there.branches),
                ),
            )
        for position, (one, other) in enumerate(
            zip(here.branches, there.branches, strict=False), start=1,
        ):
            if one.probability != other.probability:
                found.append(
                    Change(
                        "workflow", f"{name}.branch[{position}].probability", "changed",
                        _scalar(one.probability), _scalar(other.probability),
                    ),
                )
            if one.condition != other.condition:
                found.append(
                    Change(
                        "workflow", f"{name}.branch[{position}].condition", "changed",
                        one.condition, other.condition,
                    ),
                )
    return found


# --------------------------------------------------------------------------- candidates


def _provides(candidate: Candidate) -> tuple[str, ...]:
    return (candidate.provides,) if isinstance(candidate.provides, str) else candidate.provides


def _candidates(before: Composition, after: Composition) -> list[Change]:
    found: list[Change] = []
    was = {candidate.id: candidate for candidate in before.candidates}
    now = {candidate.id: candidate for candidate in after.candidates}

    gone = set(was) - set(now)
    new = set(now) - set(was)
    renamed: dict[str, str] = {}
    for old in sorted(gone):
        # Strong evidence again: the same capabilities in the same order and the same
        # values. Anything looser pairs two candidates of one provider by accident.
        matches = [
            fresh
            for fresh in sorted(new)
            if _provides(now[fresh]) == _provides(was[old])
            and now[fresh].properties == was[old].properties
        ]
        if len(matches) == 1:
            renamed[old] = matches[0]
            new.discard(matches[0])
    for old, fresh in sorted(renamed.items()):
        found.append(Change("candidates", old, "renamed", old, fresh))
    for name in sorted(gone - set(renamed)):
        found.append(Change("candidates", name, "removed", list(_provides(was[name])), None))
    for name in sorted(new):
        found.append(Change("candidates", name, "added", None, list(_provides(now[name]))))

    pairs = [(name, name) for name in sorted(set(was) & set(now))]
    pairs += sorted(renamed.items())
    for old, fresh in pairs:
        here, there = was[old], now[fresh]
        if _provides(here) != _provides(there):
            found.append(
                Change(
                    "candidates", f"{fresh}.provides", "changed",
                    list(_provides(here)), list(_provides(there)),
                ),
            )
        found += _field_changes(
            "candidates", fresh, here, there, ("provider", "domain", "title"),
        )
        for name in sorted(set(here.properties) | set(there.properties)):
            one, other = here.properties.get(name), there.properties.get(name)
            if one != other:
                found.append(
                    Change("candidates", f"{fresh}.{name}", "changed", one, other),
                )

    for name in sorted(set(before.providers) | set(after.providers)):
        if name not in before.providers:
            found.append(Change("candidates", f"provider {name}", "added", None, name))
        elif name not in after.providers:
            found.append(Change("candidates", f"provider {name}", "removed", name, None))
        elif before.providers[name] != after.providers[name]:
            found.append(
                Change(
                    "candidates", f"provider {name}.title", "changed",
                    before.providers[name].title, after.providers[name].title,
                ),
            )
    return found


# --------------------------------------------------------------------------- rules, goals


def _rules(before: Composition, after: Composition) -> list[Change]:
    found: list[Change] = []
    was = {rule.id: rule for rule in before.rules}
    now = {rule.id: rule for rule in after.rules}
    for name in sorted(set(was) | set(now)):
        here, there = was.get(name), now.get(name)
        if here is None:
            found.append(Change("rules", name, "added", None, there.assertion))
        elif there is None:
            found.append(Change("rules", name, "removed", here.assertion, None))
        else:
            found += _field_changes(
                "rules", name, here, there, ("assertion", "enforcement", "penalty", "weight"),
            )
    order_was = [rule.id for rule in before.rules if rule.enforcement == "soft"]
    order_now = [rule.id for rule in after.rules if rule.enforcement == "soft"]
    if order_was != order_now and set(order_was) == set(order_now):
        # The penalties list is ordered in the IR while the constraint map is not, so a
        # reordering is a real change that nothing else in this section would report.
        found.append(Change("rules", "penalty order", "moved", order_was, order_now))
    return found


def _goals(before: Composition, after: Composition) -> list[Change]:
    found: list[Change] = []
    was = {goal.property: goal for goal in before.goals}
    now = {goal.property: goal for goal in after.goals}
    for name in sorted(set(was) | set(now)):
        here, there = was.get(name), now.get(name)
        if here is None:
            found.append(Change("goals", name, "added", None, name))
        elif there is None:
            found.append(Change("goals", name, "removed", name, None))
        elif here.normalize != there.normalize:
            # The range is an independent number in the IR, which is exactly what the
            # compare screen cannot see: it renders the direction and the feature only.
            found.append(
                Change(
                    "goals", f"{name}.normalize", "changed",
                    _range(here.normalize), _range(there.normalize),
                ),
            )
    order_was = [goal.property for goal in before.goals]
    order_now = [goal.property for goal in after.goals]
    if order_was != order_now and set(order_was) == set(order_now):
        found.append(Change("goals", "order", "moved", order_was, order_now))
    return found


def _range(normalize: Any) -> Any:
    if normalize is None:
        return None
    return {"min": normalize.minimum, "max": normalize.maximum, "clamp": normalize.clamp}


def _studio(before: Composition, after: Composition) -> list[Change]:
    """Studio data is inert in the package and still worth reporting: the author edited it."""
    found: list[Change] = []
    for name in sorted(set(before.studio) | set(after.studio)):
        here, there = before.studio.get(name), after.studio.get(name)
        if here == there:
            continue
        kind = "added" if name not in before.studio else "removed" if name not in after.studio else "changed"
        found.append(Change("studio", name, kind, here, there))
    return found


# --------------------------------------------------------------------------- the diff


def diff(before: Composition, after: Composition) -> tuple[Change, ...]:
    """Everything that changed between two versions of one composition.

    The result is empty when the two models are equal, which is the property worth holding
    on to: it makes an empty diff evidence that nothing moved rather than evidence that the
    comparison is shallow.
    """
    renamed, _gone, _new = _match_tasks(before, after)
    found = [
        *_identity(before, after),
        *_properties(before, after),
        *_tasks(before, after, renamed),
        *_workflow(before, after, renamed),
        *_candidates(before, after),
        *_rules(before, after),
        *_goals(before, after),
        *_studio(before, after),
    ]
    order = {section: position for position, section in enumerate(SECTIONS)}
    return tuple(sorted(found, key=lambda change: (order[change.section], change.subject)))


def as_documents(changes: Iterable[Change]) -> list[dict[str, Any]]:
    """The changes as plain data, for a response body or a fixture."""
    return [change.as_dict() for change in changes]

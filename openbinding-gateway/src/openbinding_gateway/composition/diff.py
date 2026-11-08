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

from collections import Counter, defaultdict
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Iterable

from .model import (
    Candidate,
    CapacityRule,
    Composition,
    EmptyNode,
    Endpoint,
    Exclusive,
    FixedTask,
    GlobalLatency,
    LocalTask,
    Node,
    OpenTask,
    Parallel,
    Placement,
    PoolDemand,
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
    "placement",
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
    # Indexed once rather than rescanned per task, which was quadratic -- and the diff is a
    # route anyone may call. The same rule: a capability held by exactly one task before,
    # and by exactly one new task of the same kind still unpaired.
    rivals = Counter(_capability(task) for task in before.tasks.values())
    waiting: dict[tuple[str, str | None], set[str]] = defaultdict(set)
    for fresh in new:
        waiting[(_task_kind(after.tasks[fresh]), _capability(after.tasks[fresh]))].add(fresh)
    for old in sorted(gone):
        was = before.tasks[old]
        capability = _capability(was)
        if capability is None or rivals[capability] != 1:
            continue
        matches = waiting[(_task_kind(was), capability)]
        if len(matches) == 1:
            fresh = next(iter(matches))
            renamed[old] = fresh
            matches.discard(fresh)
            new.discard(fresh)
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
        # The count is in the shape rather than in a subject of its own, because it is the
        # one node field that changes the plan rather than naming a part of it -- and
        # measured on ``examples/demo/06_loops``, moving it moves the IR digest, so leaving
        # it out of the shape made it a change this module reported nowhere.
        times = f"count={node.count}" if node.count is not None else f"expected={node.expected}"
        return f"repeat[{times}]({_shape(node.body)})"
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
    # The union, not the intersection: a renamed exclusive used to fall out of both sides
    # and be reported nowhere, while its id is the join key the routing overlay is written
    # against -- so renaming it moves the digest of every package that derives branch ids.
    for name in sorted(set(was) | set(now)):
        if name not in now:
            found.append(Change("workflow", f"{name}.distribution", "removed", name, None))
            continue
        if name not in was:
            found.append(Change("workflow", f"{name}.distribution", "added", None, name))
            continue
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
            if one.id != other.id:
                # A branch id is the routing overlay's join key and lives in the
                # Application, which ``ir_digest`` keeps: renaming one is a different
                # package. Section 5.2 keeps the explicit id for exactly that reason.
                found.append(
                    Change(
                        "workflow", f"{name}.branch[{position}].id", "changed",
                        one.id, other.id,
                    ),
                )
    return found


# --------------------------------------------------------------------------- candidates


def _provides(candidate: Candidate) -> tuple[str, ...]:
    return (candidate.provides,) if isinstance(candidate.provides, str) else candidate.provides


def _evidence(candidate: Candidate) -> tuple[Any, ...]:
    """What pairs a removed candidate with an added one: its capabilities, in order, and its
    values -- as a key, so equal values (``1`` and ``1.0`` included) meet in one bucket."""
    return (
        tuple(_provides(candidate)),
        tuple(sorted((name, value) for name, value in candidate.properties.items())),
    )


def _candidates(before: Composition, after: Composition) -> list[Change]:
    found: list[Change] = []
    was = {candidate.id: candidate for candidate in before.candidates}
    now = {candidate.id: candidate for candidate in after.candidates}

    gone = set(was) - set(now)
    new = set(now) - set(was)
    renamed: dict[str, str] = {}
    # Indexed by what a pairing compares, once, instead of a scan of every new candidate per
    # removed one, which was quadratic on a route anyone may call.
    waiting: dict[tuple[Any, ...], set[str]] = defaultdict(set)
    for fresh in new:
        waiting[_evidence(now[fresh])].add(fresh)
    for old in sorted(gone):
        # Strong evidence again: the same capabilities in the same order and the same
        # values. Anything looser pairs two candidates of one provider by accident.
        matches = waiting[_evidence(was[old])]
        if len(matches) == 1:
            fresh = next(iter(matches))
            renamed[old] = fresh
            matches.discard(fresh)
            new.discard(fresh)
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
        # The container's own map, which is not the numeric one above. The ``attributes``
        # segment keeps a description off the subject a feature of the same name would
        # take. It is a convention and not a guarantee: a symbol may contain a dot, so a
        # feature literally named ``attributes.cost`` would still land on one subject --
        # which is true of every dotted subject in this module, not of this one.
        for name in sorted(set(here.attributes) | set(there.attributes)):
            one, other = here.attributes.get(name), there.attributes.get(name)
            if one != other:
                found.append(
                    Change("candidates", f"{fresh}.attributes.{name}", "changed", one, other),
                )
        if here.placement != there.placement:
            found.append(
                Change(
                    "placement", f"{fresh}.demand", "changed",
                    _demand(here.placement), _demand(there.placement),
                ),
            )

    for name in sorted(set(before.providers) | set(after.providers)):
        if name not in before.providers:
            found.append(Change("candidates", f"provider {name}", "added", None, name))
        elif name not in after.providers:
            found.append(Change("candidates", f"provider {name}", "removed", name, None))
        else:
            here, there = before.providers[name], after.providers[name]
            if here.title != there.title:
                found.append(
                    Change(
                        "candidates", f"provider {name}.title", "changed",
                        here.title, there.title,
                    ),
                )
            # A provider's own map reaches the IR, so a change in it is a change in the
            # problem. Reporting it under ``.title`` would have printed None -> None.
            for key in sorted(set(here.properties) | set(there.properties)):
                one, other = here.properties.get(key), there.properties.get(key)
                if one != other:
                    found.append(
                        Change(
                            "candidates", f"provider {name}.properties.{key}", "changed",
                            one, other,
                        ),
                    )
    return found


# ------------------------------------------------------------------------------- placement


def _demand(demand: PoolDemand | None) -> Any:
    if demand is None:
        return None
    return {"pool": demand.pool, "resources": dict(sorted(demand.resources.items()))}


def _endpoint(endpoint: Endpoint) -> Any:
    """A transition endpoint as plain data: a bare id for a task, ``{event: id}`` for an event."""
    return {"event": endpoint.id} if endpoint.event else endpoint.id


def _latency(latency: GlobalLatency | None) -> Any:
    """The global latency as plain data, spelled the way the surface spells it.

    ``_scalar`` converts a Decimal and returns everything else untouched, so handing it a
    dataclass put one in ``was``/``now`` and made ``as_documents`` refuse to encode -- and
    ``model_dump`` would have shipped ``include_execution`` where the schema and the text
    layer both say ``includeExecution``.
    """
    if latency is None:
        return None
    return {
        "feature": latency.feature,
        "includeExecution": latency.include_execution,
        "exclusive": latency.exclusive,
        "parallel": latency.parallel,
    }


def _rule(rule: CapacityRule) -> dict[str, Any]:
    """A capacity rule as plain data, scope included: the scope is what the container reads."""
    return {"resources": sorted(rule.resources), "scope": rule.scope}


def _edges(placement: Placement | None) -> dict[tuple[str, str], float]:
    return {} if placement is None else {(e.source, e.target): e.latency for e in placement.network}


def _placement(before: Composition, after: Composition) -> list[Change]:
    """What moved in the placement, by name rather than by position.

    A demand is reported per candidate by ``_candidates``, which is where the candidate
    already is; everything here is about the pools and the distances between them. The
    network is keyed by its endpoints rather than by index, because the model holds the
    completed directed list and a mirror appended at import time would otherwise shift
    every edge after it and report the whole network as changed.
    """
    found: list[Change] = []
    here, there = before.placement, after.placement
    if here is None and there is None:
        return found
    if here is None:
        return [Change("placement", "placement", "added", None, len(there.pools))]
    if there is None:
        return [Change("placement", "placement", "removed", len(here.pools), None)]

    was = {pool.id: pool for pool in here.pools}
    now = {pool.id: pool for pool in there.pools}
    for name in sorted(set(was) | set(now)):
        if name not in was:
            found.append(Change("placement", f"pool {name}", "added", None, now[name].kind))
        elif name not in now:
            found.append(Change("placement", f"pool {name}", "removed", was[name].kind, None))
        else:
            found += _field_changes(
                "placement", f"pool {name}", was[name], now[name], ("kind", "name"),
            )
            for key in sorted(set(was[name].capacity) | set(now[name].capacity)):
                one, other = was[name].capacity.get(key), now[name].capacity.get(key)
                if one != other:
                    found.append(
                        Change("placement", f"pool {name}.capacity.{key}", "changed", one, other),
                    )
            for key in sorted(set(was[name].properties) | set(now[name].properties)):
                one, other = was[name].properties.get(key), now[name].properties.get(key)
                if one != other:
                    found.append(
                        Change(
                            "placement", f"pool {name}.properties.{key}", "changed", one, other,
                        ),
                    )

    old_edges, new_edges = _edges(here), _edges(there)
    for pair in sorted(set(old_edges) | set(new_edges)):
        one, other = old_edges.get(pair), new_edges.get(pair)
        if one != other:
            subject = f"network {pair[0]}->{pair[1]}"
            kind = "added" if one is None else "removed" if other is None else "changed"
            found.append(Change("placement", subject, kind, one, other))
    # Keying by the endpoints says which edge moved; it says nothing about where it sits in
    # the list, and the list's order **is** in the IR digest (measured: reversing the
    # network of any placement package moves it). Without this row two different problems
    # compared equal, which is the one thing an empty change list must never mean. One row
    # for the whole order, guarded on set equality so it never piles onto an added or
    # removed row above.
    old_order = [(edge.source, edge.target) for edge in here.network]
    new_order = [(edge.source, edge.target) for edge in there.network]
    if set(old_edges) == set(new_edges) and old_order != new_order:
        found.append(
            Change(
                "placement", "network order", "moved",
                [f"{source}->{target}" for source, target in old_order],
                [f"{source}->{target}" for source, target in new_order],
            ),
        )

    old_events = {event.id: event for event in here.events}
    new_events = {event.id: event for event in there.events}
    for name in sorted(set(old_events) | set(new_events)):
        one, other = old_events.get(name), new_events.get(name)
        if one == other:
            continue
        if one is None or other is None:
            kind = "added" if one is None else "removed"
            found.append(
                Change(
                    "placement", f"event {name}", kind,
                    None if one is None else one.pool,
                    None if other is None else other.pool,
                ),
            )
            continue
        # Name the field. Printing the pool for every change reported ``was p_edge, now
        # p_edge`` whenever a latency row moved, which is a row that says nothing.
        found += _field_changes("placement", f"event {name}", one, other, ("pool",))
        for position, (a, b) in enumerate(
            zip(one.latency, other.latency, strict=False), start=1,
        ):
            if a != b:
                found.append(
                    Change(
                        "placement", f"event {name}.latency[{position}]", "changed",
                        {"pool": a.pool, "latency": a.latency},
                        {"pool": b.pool, "latency": b.latency},
                    ),
                )
        if len(one.latency) != len(other.latency):
            found.append(
                Change(
                    "placement", f"event {name}.latency", "changed",
                    len(one.latency), len(other.latency),
                ),
            )

    old_transitions = {t.id: t for t in here.transitions}
    new_transitions = {t.id: t for t in there.transitions}
    for name in sorted(set(old_transitions) | set(new_transitions)):
        one, other = old_transitions.get(name), new_transitions.get(name)
        if one == other:
            continue
        if one is None or other is None:
            kind = "added" if one is None else "removed"
            found.append(
                Change(
                    "placement", f"transition {name}", kind,
                    None if one is None else one.maximum,
                    None if other is None else other.maximum,
                ),
            )
            continue
        found += _field_changes(
            "placement", f"transition {name}", one, other, ("maximum", "feature"),
        )
        for end in ("source", "target"):
            a, b = getattr(one, end), getattr(other, end)
            if a != b:
                found.append(
                    Change(
                        "placement", f"transition {name}.{end}", "changed",
                        _endpoint(a), _endpoint(b),
                    ),
                )

    if here.capacity_rules != there.capacity_rules:
        # The whole rule, scope included. Rendering only the resources printed
        # ``was [['memory']], now [['memory']]`` for a scope flip the container does read.
        found.append(
            Change(
                "placement", "capacityRules", "changed",
                [_rule(rule) for rule in here.capacity_rules],
                [_rule(rule) for rule in there.capacity_rules],
            ),
        )
    if here.global_latency != there.global_latency:
        found.append(
            Change(
                "placement", "globalLatency", "changed",
                _latency(here.global_latency), _latency(there.global_latency),
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
        *_placement(before, after),
        *_rules(before, after),
        *_goals(before, after),
        *_studio(before, after),
    ]
    order = {section: position for position, section in enumerate(SECTIONS)}
    return tuple(sorted(found, key=lambda change: (order[change.section], change.subject)))


def as_documents(changes: Iterable[Change]) -> list[dict[str, Any]]:
    """The changes as plain data, for a response body or a fixture."""
    return [change.as_dict() for change in changes]

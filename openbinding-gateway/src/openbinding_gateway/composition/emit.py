"""Emit a composition as an ordinary BIM v1 package: the model to bytes, and nothing else.

This is the half of phase F1 that has no text layer. A :class:`~.model.Composition` goes in
and a mapping of file name to bytes comes out, ready for the container's
``InstancePackage``. There is no YAML here and no parser: the text layer is a separate
property, proved separately, and inverting it must not be entangled with proving the
translation right.

The gate this exists to pass is **IR-digest equality with an existing package**
(specification section 11.2: the live normalized golden's 82 packages minus the seven that
declare a Placement resource, so 75). That is what makes every rule below load-bearing
rather than cosmetic. Three of them cost a package each if written the obvious way, and
each was measured rather than read off the prose:

* **A feature's ``scope`` is copied, never defaulted.** The schema enumerates two values
  and ``examples/demo/14_shared_candidates`` declares ``selectedCandidate`` on its ``cost``
  feature. The compiler branches on it, so defaulting to ``"invocation"`` loses that
  package with no diagnostic anywhere.
* **A candidate's ``provides`` keeps its order and its multiplicity.** The same package has
  the tree's only plural ``provides``, and reversing or deduplicating that list moves the
  digest. It is the one digest-visible list section 11 does not enumerate.
* **A criterion's ``clamp`` is written as it is.** The container defaults it to *false*,
  and five of the gate's 243 criteria omit the key, so a hardcoded ``true`` loses three
  packages while a hardcoded ``false`` loses the other 72.

What this module deliberately does not emit, because each one either moves the digest or is
refused outright: a node ``id`` at any level, ``spec.extensions`` anywhere, a feature's
``name`` or a provider's or candidate's ``name``, ``metadata.version`` or
``metadata.description`` on a resource document, ``metadata.annotations`` anywhere at all,
and a ``when`` on a branch. The Studio block, a pricing reference, a property's domain of
applicability and a candidate's title have no destination in a package by design; they are
Studio-side and belong to provenance, which is not a declared resource.

The file set is exactly ``instance.json`` plus the documents the manifest declares. Any
other entry -- a ``provenance.json``, a ``README``, the composition source itself -- is
refused by the compiler as ``undeclared_resource``.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from . import ids
from .model import (
    Branch,
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
from .neutral import resolve_neutral

#: The profile every emitted package declares.
PROFILE = "qos-binding/v1"
#: The api version of the five resource documents.
RESOURCE_API_VERSION = "qos-binding/v1"

#: File name per resource id. The ids are normative because they reach the IR; the file
#: names are not -- renaming all five at once leaves the digest byte-identical (measured) --
#: but they are fixed here so that two emissions of one composition are the same bytes.
FILES: dict[str, str] = {
    ids.APPLICATION: "application.json",
    ids.CATALOG: "candidates.json",
    ids.ROUTING: "routing.json",
    ids.CONSTRAINTS: "constraints.json",
    ids.OPTIMIZATION: "optimization.json",
}


def _document(composition: Composition, resource: str, kind: str, spec: dict[str, Any]) -> dict[str, Any]:
    """One resource document's envelope.

    A resource document's ``metadata`` carries a name and nothing else. The corpus is
    unanimous -- no resource document in the 82 carries a version -- and although
    ``ir_digest`` strips metadata whole, so nothing would catch a stray key, emitting one
    would make the Studio's packages differ in shape from every package in the tree for no
    reason anybody could later reconstruct.
    """
    return {
        "apiVersion": RESOURCE_API_VERSION,
        "kind": kind,
        "metadata": {"name": ids.document_name(composition.composition, resource)},
        "spec": spec,
    }


def _domain(prop: Property) -> dict[str, Any]:
    """``domain`` for one feature, with an unset bound omitted rather than written null."""
    domain: dict[str, Any] = {"kind": prop.domain.kind}
    if prop.domain.minimum is not None:
        domain["minimum"] = prop.domain.minimum
    if prop.domain.maximum is not None:
        domain["maximum"] = prop.domain.maximum
    return domain


def _feature(name: str, prop: Property) -> dict[str, Any]:
    """One entry of ``Application.spec.features``.

    ``neutral`` is always written explicitly. The container would infer the same value from
    the sequence operator and the domain, and ``test_neutral_matches_compiler.py`` keeps the
    two rules in step over every feature of every package -- but the deterministic profile
    imputes nothing for a candidate that lacks a feature, so the Studio needs a value it
    can also write on a candidate (section 10.2), and having two sources for one number is
    how they drift.

    The aggregation is written as the full five-key block, never as the container's
    shorthand string. Both lower to the same IR, so the choice is digest-neutral, and the
    block is the form that cannot be misread: a shorthand expands to five operators that a
    *partial* block does not reproduce.
    """
    domain = _domain(prop)
    aggregation = {
        "sequence": prop.aggregation.sequence,
        "parallel": prop.aggregation.parallel,
        "exclusive": prop.aggregation.exclusive,
        "repeat": prop.aggregation.repeat,
        "selection": prop.aggregation.selection,
    }
    # The neutral is resolved from the shapes about to be emitted, not from the model's
    # own objects: the rule it shares with the container is stated over the emitted
    # document, and ``test_neutral_matches_compiler.py`` compares the two that way.
    neutral, _source = resolve_neutral(
        aggregation=aggregation, domain=domain, declared=prop.neutral,
    )
    return {
        "unit": prop.unit,
        "direction": prop.direction,
        "scope": prop.scope,
        "domain": domain,
        "aggregation": aggregation,
        "neutral": float(neutral),
    }


def _task(task_id: str, task: OpenTask | FixedTask | LocalTask) -> Any:
    """One entry of ``Application.spec.tasks``.

    A service task whose only content is its requirement is written as the container's bare
    string shorthand, which is what the corpus does; a title forces the object form, since
    the shorthand has nowhere to put one. A fixed task is a service task requiring a
    capability minted for it alone, so that exactly one candidate can match. A local task
    is a kind of its own and is forbidden a requirement.
    """
    if isinstance(task, LocalTask):
        body: dict[str, Any] = {"kind": "local"}
        if task.title is not None:
            body["name"] = task.title
        return body
    requires = (
        ids.fixed_capability(task_id) if isinstance(task, FixedTask) else task.requires
    )
    if task.title is None:
        return requires
    return {"kind": "service", "requires": requires, "name": task.title}


def _task_ref(task_id: str) -> dict[str, Any]:
    return {"task": {"resource": ids.APPLICATION, "id": task_id}}


def _node(node: Node) -> dict[str, Any]:
    """One workflow node.

    No node carries an ``id``: no package in the corpus uses one, the container copies it
    into the IR, and its sequence flattening refuses to flatten a nested sequence that has
    one. Nested sequences are therefore left exactly as the author wrote them -- the
    container canonicalizes them, and doing it here as well, differently, is how an import
    and an emit stop agreeing.

    Every list below keeps author order. For ``parallel`` that is not a formality: the order
    is in the digest, and 27 of the 29 gate packages that contain a parallel block hold one
    whose children are not in id order.
    """
    if isinstance(node, TaskNode):
        return _task_ref(node.task)
    if isinstance(node, EmptyNode):
        return {"empty": True}
    if isinstance(node, Sequence):
        return {"sequence": [_node(child) for child in node.children]}
    if isinstance(node, Parallel):
        return {"parallel": [_node(child) for child in node.children]}
    if isinstance(node, Exclusive):
        return {
            "exclusive": [
                {"id": _branch_id(node, position, branch), "flow": _node(branch.flow)}
                for position, branch in enumerate(node.branches, start=1)
            ],
        }
    if isinstance(node, Repeat):
        body: dict[str, Any] = {"body": _node(node.body)}
        if node.count is not None:
            body["count"] = node.count
        else:
            body["expectedCount"] = node.expected
        return {"repeat": body}
    raise TypeError(f"not a workflow node: {type(node).__name__}")


def _branch_id(exclusive: Exclusive, position: int, branch: Branch) -> str:
    """The branch id, which is the join key between the application and the overlay.

    The author may name it, and that escape is what makes a package with unschematic branch
    ids reproducible at all; otherwise it is derived from the exclusive's id and the
    one-based position in source order, so the same composition gives the same ids on every
    machine.
    """
    return branch.id or ids.branch_id(exclusive.id, position)


def _exclusives(node: Node) -> list[Exclusive]:
    """Every exclusive choice in the workflow, in source order."""
    if isinstance(node, Exclusive):
        return [node, *(found for branch in node.branches for found in _exclusives(branch.flow))]
    if isinstance(node, (Sequence, Parallel)):
        return [found for child in node.children for found in _exclusives(child)]
    if isinstance(node, Repeat):
        return _exclusives(node.body)
    return []


def _application(composition: Composition) -> dict[str, Any]:
    return _document(
        composition,
        ids.APPLICATION,
        "Application",
        {
            "tasks": {
                task_id: _task(task_id, composition.tasks[task_id])
                for task_id in sorted(composition.tasks)
            },
            "features": {
                name: _feature(name, composition.properties[name])
                for name in sorted(composition.properties)
            },
            "workflow": _node(composition.workflow),
        },
    )


def _provides(candidate: Candidate) -> Any:
    """The capability or capabilities a candidate offers, in the author's order."""
    if isinstance(candidate.provides, str):
        return candidate.provides
    return list(candidate.provides)


def _candidate(composition: Composition, candidate: Candidate) -> dict[str, Any]:
    body: dict[str, Any] = {
        "provides": _provides(candidate),
        "features": {
            name: candidate.properties[name] for name in sorted(candidate.properties)
        },
    }
    if candidate.provider is not None:
        body["provider"] = {"resource": ids.CATALOG, "id": candidate.provider}
    return body


def _fixed_candidates(composition: Composition) -> list[Candidate]:
    """One candidate per fixed task, carrying the values the author wrote on the task."""
    return [
        Candidate(
            id=ids.fixed_candidate(task_id),
            provides=ids.fixed_capability(task_id),
            properties=dict(task.properties),
            provider=task.provider,
        )
        for task_id, task in sorted(composition.tasks.items())
        if isinstance(task, FixedTask)
    ]


def _catalog(composition: Composition) -> dict[str, Any]:
    """The candidate catalog, including the singleton candidate of every fixed task.

    ``featureBindings`` is the identity map: this version shares property names between the
    application and the catalog, so a catalog slot named differently from the feature it
    binds is not expressible (section 12).
    """
    candidates = [*composition.candidates, *_fixed_candidates(composition)]
    providers = dict.fromkeys(
        sorted({*composition.providers, *(c.provider for c in candidates if c.provider)}),
    )
    return _document(
        composition,
        ids.CATALOG,
        "CandidateCatalog",
        {
            "providers": {name: {} for name in providers},
            "featureBindings": {
                name: {"resource": ids.APPLICATION, "id": name}
                for name in sorted(composition.properties)
            },
            "candidates": {
                candidate.id: _candidate(composition, candidate)
                for candidate in sorted(candidates, key=lambda item: item.id)
            },
        },
    )


def _routing(composition: Composition) -> dict[str, Any] | None:
    """The routing overlay, emitted only when some exclusive states a distribution.

    An exclusive with neither probabilities nor ``distribution: uniform`` leaves its
    distribution unstated, which is not the same as uniform, and the Studio never promotes
    one into the other. ``uniform`` emits the container's own flag rather than computed
    quotas, because the container compares the quotas against ``Decimal(1)`` with no
    epsilon and three equal literals do not sum to one.
    """
    entries: list[dict[str, Any]] = []
    uniform: list[Exclusive] = []
    for exclusive in _exclusives(composition.workflow):
        if exclusive.distribution == "uniform":
            uniform.append(exclusive)
            continue
        probabilities = [branch.probability for branch in exclusive.branches]
        if any(value is None for value in probabilities):
            continue
        for position, branch in enumerate(exclusive.branches, start=1):
            entries.append({
                "target": {
                    "resource": ids.APPLICATION,
                    "id": _branch_id(exclusive, position, branch),
                },
                "probability": _number(branch.probability),
            })
    if not entries and not uniform:
        return None
    spec: dict[str, Any] = {"uniform": True} if uniform and not entries else {"entries": entries}
    return _document(composition, ids.ROUTING, "RoutingOverlay", spec)


def _number(value: Decimal | float | None) -> Any:
    """A probability as a JSON number, parsed from the source text and never recomputed.

    The container compares a distribution against ``Decimal(1)`` exactly, so the arithmetic
    stays in ``Decimal`` and only the serialization turns it into a JSON number.
    """
    if isinstance(value, Decimal):
        return float(value) if value != value.to_integral_value() else int(value)
    return value


def _constraints(composition: Composition) -> dict[str, Any] | None:
    """The constraint set, emitted only when the composition states a rule."""
    if not composition.rules:
        return None
    constraints: dict[str, Any] = {}
    for rule in composition.rules:
        # ``enforcement`` is required by the schema, for a hard constraint too: omitting it
        # is a compile error, not a default. The penalty lives inside the constraint it
        # belongs to -- there is no separate penalties list.
        body: dict[str, Any] = {"assert": rule.assertion, "enforcement": rule.enforcement}
        if rule.penalty is not None:
            body["penalty"] = rule.penalty
        constraints[rule.id] = body
    return _document(
        composition, ids.CONSTRAINTS, "ConstraintSet", {"constraints": constraints},
    )


def _optimization(composition: Composition) -> dict[str, Any]:
    """The criteria, in author order, each normalizing over a range it states.

    A criterion's id is the property name: the container requires an id and reads it from
    the source, and no criterion in the corpus names anything other than the feature it
    reads. ``normalize`` defaults to the property's domain and the goal may override it,
    because the range is an independent number in the IR and 14 packages use that.
    """
    # A soft constraint has to be referenced from here, not merely marked soft where it is
    # declared: the compiler refuses a package whose soft constraint is "not in
    # Optimization". The list is ordered in the digest and takes the order of
    # ``Composition.rules``; the weight is a second number, independent of the penalty the
    # constraint itself charges, and ``None`` writes no key at all.
    penalties = []
    for rule in composition.rules:
        if rule.enforcement != "soft":
            continue
        entry: dict[str, Any] = {
            "constraint": {"resource": ids.CONSTRAINTS, "id": rule.id},
        }
        if rule.weight is not None:
            entry["weight"] = rule.weight
        penalties.append(entry)

    criteria = []
    for goal in composition.goals:
        prop = composition.properties[goal.property]
        if goal.normalize is not None:
            minimum, maximum, clamp = goal.normalize.minimum, goal.normalize.maximum, goal.normalize.clamp
        else:
            minimum, maximum, clamp = prop.domain.minimum, prop.domain.maximum, True
        criteria.append({
            "id": goal.property,
            "feature": {"resource": ids.APPLICATION, "id": goal.property},
            "normalize": {"min": minimum, "max": maximum, "clamp": clamp},
        })
    spec: dict[str, Any] = {}
    if penalties:
        spec["penalties"] = penalties
    spec["criteria"] = criteria
    return _document(composition, ids.OPTIMIZATION, "Optimization", spec)


def _instance(composition: Composition, resources: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """The manifest, declaring exactly the documents that were emitted.

    ``metadata.name`` is the bare composition id, not a suffixed document name: the five
    resource documents are suffixed and the manifest is not. No annotations are written,
    here or anywhere -- the Studio block is emitted nowhere, which is what makes it inert by
    construction rather than inert by test.
    """
    declared: dict[str, dict[str, str]] = {}
    for resource, role in (
        (ids.APPLICATION, "application"),
        (ids.CATALOG, "candidateCatalog"),
        (ids.ROUTING, "candidateCatalog"),
        (ids.CONSTRAINTS, "constraintSet"),
        (ids.OPTIMIZATION, "optimization"),
    ):
        if resource in resources:
            declared.setdefault(role, {})[resource] = FILES[resource]
    metadata: dict[str, Any] = {
        "name": composition.composition,
        "version": composition.version,
    }
    if composition.description is not None:
        metadata["description"] = composition.description
    return {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": metadata,
        "spec": {"profile": PROFILE, "resources": declared},
    }


def documents(composition: Composition) -> dict[str, dict[str, Any]]:
    """The emitted documents, keyed by resource id, before serialization."""
    emitted: dict[str, dict[str, Any]] = {
        ids.APPLICATION: _application(composition),
        ids.CATALOG: _catalog(composition),
        ids.OPTIMIZATION: _optimization(composition),
    }
    routing = _routing(composition)
    if routing is not None:
        emitted[ids.ROUTING] = routing
    constraints = _constraints(composition)
    if constraints is not None:
        emitted[ids.CONSTRAINTS] = constraints
    return emitted


def emit(composition: Composition) -> dict[str, bytes]:
    """One composition as the bytes of an ordinary BIM v1 package.

    The result is exactly ``instance.json`` plus the documents the manifest declares, and
    nothing else: the compiler refuses any package entry its manifest does not name.
    """
    emitted = documents(composition)
    files = {
        FILES[resource]: _serialize(document) for resource, document in emitted.items()
    }
    files["instance.json"] = _serialize(_instance(composition, emitted))
    return dict(sorted(files.items()))


def _serialize(document: dict[str, Any]) -> bytes:
    """A document's bytes.

    The container canonicalizes before hashing, so this layout is for a human reading a
    generated package, not for the digest. Floats are written by ``repr`` through
    ``json.dumps``, which is the shortest round-tripping form -- the corpus contains
    0.9984999999999999 and it survives only that way.
    """
    return (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

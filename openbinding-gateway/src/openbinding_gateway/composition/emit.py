"""Emit a composition as an ordinary BIM v1 package: the model to bytes, and nothing else.

This is the half of phase F1 that has no text layer. A :class:`~.model.Composition` goes in
and a mapping of file name to bytes comes out, ready for the container's
``InstancePackage``. There is no YAML here and no parser: the text layer is a separate
property, proved separately, and inverting it must not be entangled with proving the
translation right.

The gate this exists to pass is **IR-digest equality with an existing package**
(specification section 11.2: the live normalized golden's 82 packages, all of them). That is
what makes every rule below load-bearing
rather than cosmetic. Three of them cost a package each if written the obvious way, and
each was measured rather than read off the prose:

* **A feature's ``scope`` is copied, never defaulted.** The schema enumerates two values
  and ``examples/demo/14_shared_candidates`` declares ``selectedCandidate`` on its ``cost``
  feature. The compiler branches on it, so defaulting to ``"invocation"`` loses that
  package with no diagnostic anywhere.
* **A candidate's ``provides`` keeps its order and its multiplicity.** Twelve candidates in
  five packages write a list, and reversing or deduplicating one moves the digest. It is
  the one digest-visible list section 11 does not enumerate.
* **A criterion's ``clamp`` is written as it is.** The container defaults it to *false*,
  and eight of the gate's 266 criteria omit the key, so a hardcoded ``true`` loses four
  packages while a hardcoded ``false`` loses the other 78.

What this module deliberately does not emit, because each one either moves the digest or is
refused outright: a node ``id`` at any level, ``spec.extensions`` anywhere, a feature's
``name`` or a candidate's ``name``, ``metadata.version`` or ``metadata.description`` on a
resource document, ``metadata.annotations`` anywhere at all, and a ``when`` on a branch.

A provider's ``name`` **is** emitted, and so is a task's: 2 of the corpus's 82 packages
carry a provider name and 18 carry a task name, so leaving either out moves those packages'
digests -- which is exactly what kept ``examples/demo/16_json_complete`` out of the gate.
A feature's and a candidate's stay unwritten for the opposite reason and not a different
one: the container keeps all four (measured -- each moves the IR digest), and no package in
the corpus carries a feature name or a candidate name, so there is nothing to write.

The Studio block, a pricing reference and a property's domain of applicability have no
destination in a package by design; they are Studio-side and belong to provenance, which is
not a declared resource.

The file set is exactly ``instance.json`` plus the documents the manifest declares. Any
other entry -- a ``provenance.json``, a ``README``, the composition source itself -- is
refused by the compiler as ``undeclared_resource``.
"""

from __future__ import annotations

import json
from collections import Counter
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
#: The api version of the five ``qos-binding/v1`` resource documents. The Placement
#: document is the sixth this module writes and belongs to a dialect, so it carries
#: ``PLACEMENT_API_VERSION`` instead.
RESOURCE_API_VERSION = "qos-binding/v1"

#: File name per resource id. The ids are normative because they reach the IR; the file
#: names are not -- renaming them all at once leaves the digest byte-identical (measured) --
#: but they are fixed here so that two emissions of one composition are the same bytes.
PLACEMENT = "placement"
#: The api version of the Placement document. It belongs to a dialect the container
#: installs as a built-in, so declaring one needs nothing installed and nothing invented.
PLACEMENT_API_VERSION = "qos-binding-placement/v1"

FILES: dict[str, str] = {
    ids.APPLICATION: "application.json",
    ids.CATALOG: "candidates.json",
    ids.ROUTING: "routing.json",
    ids.CONSTRAINTS: "constraints.json",
    ids.OPTIMIZATION: "optimization.json",
    PLACEMENT: "placement.json",
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
    # Through the one function ``checks`` also asks, so a property the checks accept is one
    # this writes: it resolves the neutral from the same emitted shapes -- the rule it shares
    # with the container is stated over the emitted document, and
    # ``test_neutral_matches_compiler.py`` compares the two that way.
    neutral, _source = property_neutral(prop)
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


def _applies(prop: Property, candidate: Candidate) -> bool:
    """Whether a property is meaningful for this candidate.

    ``applies_to`` and a candidate's ``domain`` are both Studio concepts with no
    counterpart in the container, and this is the only place they meet.
    """
    return prop.applies_to == "all" or candidate.domain == "all" or prop.applies_to == candidate.domain


def _features(
    composition: Composition, candidate: Candidate, scopes: "_Scopes | None" = None,
) -> dict[str, Any]:
    """A candidate's feature values, with a neutral where a property does not apply.

    The deterministic profile imputes nothing: a candidate that an eligible task could bind
    must carry every feature a criterion, a constraint or a global latency reads, or the
    compile fails. So when a property does not apply to a candidate -- a quantum property on
    a classical solver -- the Studio writes **that property's own neutral**, which is the
    semantically right value rather than a placeholder: under ``sum`` the candidate
    contributes nothing, under ``product`` it does not degrade the result, and under ``min``
    the domain's upper bound does not constrain the minimum.

    An *applicable* property the author simply left out is not filled in here. Inventing a
    value for a property that does mean something for this candidate would make a number up
    and hide the omission; the container refuses it by name instead.
    """
    values = dict(candidate.properties)
    for name, prop in (scopes or _Scopes(composition)).inapplicable(candidate):
        if name not in values:
            values[name] = property_neutral(prop)[0]
    return {name: values[name] for name in sorted(values)}


class _Scopes:
    """The properties that do not apply to each candidate domain, found once per domain.

    Whether a property applies depends only on its ``applies_to`` and the candidate's domain,
    of which there are three. Asking every property for every candidate cost candidates times
    properties -- seconds, for thousands of each -- to find what is the same answer per domain.
    """

    def __init__(self, composition: Composition) -> None:
        self._properties = composition.properties
        self._by_domain: dict[str, list[tuple[str, Property]]] = {}

    def inapplicable(self, candidate: Candidate) -> list[tuple[str, Property]]:
        """The properties that do not apply to this candidate, in name order."""
        if candidate.domain == "all":
            return []
        found = self._by_domain.get(candidate.domain)
        if found is None:
            found = self._by_domain[candidate.domain] = sorted(
                (name, prop)
                for name, prop in self._properties.items()
                if not _applies(prop, candidate)
            )
        return found


def emitted_size(composition: Composition) -> tuple[int, int]:
    """How many feature values the catalog will hold, and how many of them are substitutions.

    A candidate carries its own values and, for every property that does not apply to it, a
    neutral (section 10.2). The second grows with candidates times properties while the source
    grows with their sum, so a short document can emit a long package: this counts it first,
    without building it, so a caller can refuse before the work rather than after. Counted by
    applicability class rather than pair by pair, which would cost the product it measures.
    """
    by_scope = Counter(prop.applies_to for prop in composition.properties.values())
    everywhere = by_scope.get("all", 0)
    values = substitutions = 0
    for candidate in (*composition.candidates, *_fixed_candidates(composition)):
        missing = 0
        if candidate.domain != "all":
            missing = len(composition.properties) - everywhere - by_scope.get(candidate.domain, 0)
            missing -= sum(
                1
                for name in candidate.properties
                if name in composition.properties
                and not _applies(composition.properties[name], candidate)
            )
        values += len(candidate.properties) + missing
        substitutions += missing
    return values, substitutions


def property_neutral(prop: Property) -> tuple[float, str]:
    """A property's neutral and where it came from, for the value and for the record.

    Public because ``checks`` asks the same question before anything is emitted, so the
    check and the emitter cannot disagree about which properties have one: a neutral,
    declared or inferred, outside its domain (a ratio's being [0, 1]) is refused by
    coherence; a ``min`` with no domain maximum and no declared neutral is reported by
    completeness as something still missing.

    Raises:
        Unbounded: when nothing determines the neutral.
        OutsideDomain: when the neutral lies outside the domain.
    """
    value, source = resolve_neutral(
        aggregation={
            "sequence": prop.aggregation.sequence,
            "parallel": prop.aggregation.parallel,
            "exclusive": prop.aggregation.exclusive,
            "repeat": prop.aggregation.repeat,
            "selection": prop.aggregation.selection,
        },
        domain=_domain(prop),
        declared=prop.neutral,
    )
    return float(value), getattr(source, "value", str(source))


def _candidate(
    composition: Composition, candidate: Candidate, scopes: _Scopes | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "provides": _provides(candidate),
        "features": _features(composition, candidate, scopes),
    }
    if candidate.attributes:
        body["properties"] = dict(sorted(candidate.attributes.items()))
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
            domain=task.domain,
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
    scopes = _Scopes(composition)
    providers = dict.fromkeys(
        sorted({*composition.providers, *(c.provider for c in candidates if c.provider)}),
    )
    return _document(
        composition,
        ids.CATALOG,
        "CandidateCatalog",
        {
            "providers": {
                name: _drop_empty({
                    "name": composition.providers[name].title
                    if name in composition.providers
                    else None,
                    "properties": dict(sorted(composition.providers[name].properties.items()))
                    if name in composition.providers and composition.providers[name].properties
                    else None,
                })
                for name in providers
            },
            "featureBindings": {
                name: {"resource": ids.APPLICATION, "id": name}
                for name in sorted(composition.properties)
            },
            "candidates": {
                candidate.id: _candidate(composition, candidate, scopes)
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


class EmitError(Exception):
    """The composition cannot be written as a package, and says which part."""


def criterion_range(name: str, prop: Property) -> tuple[float, float]:
    """The range a criterion normalizes over when the goal states none.

    A ``ratio`` domain is bounded to [0, 1] by the container and needs no explicit bounds
    (section 3.2), so a goal over one has a range even though the property declares none.
    Any other domain with an open end has nothing to normalize over, and that is refused
    here rather than emitted as a null the schema rejects three layers down -- and, before
    that, by ``checks.completeness`` as ``c2y_goal_range``, which calls this function so the
    two cannot disagree.
    """
    minimum = prop.domain.minimum
    maximum = prop.domain.maximum
    if prop.domain.kind == "ratio":
        minimum = 0.0 if minimum is None else minimum
        maximum = 1.0 if maximum is None else maximum
    if minimum is None or maximum is None:
        raise EmitError(
            f"goal {name!r} normalizes over the domain of a property that has no "
            f"{'lower' if minimum is None else 'upper'} bound: give the property a domain "
            "or the goal an explicit normalize range",
        )
    return minimum, maximum


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
            minimum, maximum, clamp = *criterion_range(goal.property, prop), True
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


def _reference(resource: str, name: str) -> dict[str, str]:
    return {"resource": resource, "id": name}


def _placement(composition: Composition) -> dict[str, Any] | None:
    """The Placement document, emitted only when the composition places its candidates.

    Three shapes the lowering erases are deliberately not written: ``defaults``, which it
    inlines into every demand; ``groups``, which it expands to one demand per candidate;
    and ``networkMode: symmetric``, whose completion this emitter has already applied, so
    the list goes out directed. Writing any of them changes the source and not the IR, and
    a source form the model cannot recover is how an import and an emit stop agreeing.

    Which of this document's lists are ordered was measured rather than assumed, because
    the corpus answers only half of it -- every package has exactly one capacity rule and
    one event, so nothing in the gate would notice either way:

    * the **demand** list is **not** digest-visible, so this sorts it by candidate id.
      That is a canonicalization and not luck: reversing the 44 demands of
      ``examples/placement/02_stock_market_sample`` leaves its IR digest where it was.
    * the **network** list **is**, so it goes out exactly as the model holds it.
    * a **capacity rule**'s position **is**, measured by adding a second rule to
      ``examples/placement/01_small_placement`` and swapping the two.
    * the rows of an **event**'s latency list **are**, measured on that package's three.
    """
    placement = composition.placement
    if placement is None:
        return None
    spec: dict[str, Any] = {
        "pools": {
            pool.id: _drop_empty({
                "capacity": dict(sorted(pool.capacity.items())),
                "kind": pool.kind if pool.kind != "generic" else None,
                "name": pool.name,
                "properties": dict(sorted(pool.properties.items())) if pool.properties else None,
            })
            for pool in placement.pools
        },
    }
    demands = [
        {
            "candidate": _reference(ids.CATALOG, candidate.id),
            "pool": _reference(PLACEMENT, candidate.placement.pool),
            "resources": dict(sorted(candidate.placement.resources.items())),
        }
        for candidate in sorted(composition.candidates, key=lambda item: item.id)
        if candidate.placement is not None
    ]
    if demands:
        spec["demands"] = demands
    if placement.network:
        # Written directed, because the list is already complete. The order is data: both
        # sorting it and prepending the mirrors move the digest.
        spec["network"] = [
            {
                "from": _reference(PLACEMENT, edge.source),
                "to": _reference(PLACEMENT, edge.target),
                "latency": edge.latency,
            }
            for edge in placement.network
        ]
        spec["networkMode"] = "directed"
    if placement.events:
        spec["events"] = {
            event.id: {
                "pool": _reference(PLACEMENT, event.pool),
                "latency": [
                    {"pool": _reference(PLACEMENT, entry.pool), "latency": entry.latency}
                    for entry in event.latency
                ],
            }
            for event in placement.events
        }
    if placement.transitions:
        spec["transitions"] = {
            transition.id: {
                "from": _endpoint(transition.source),
                "to": _endpoint(transition.target),
                "feature": _reference(ids.APPLICATION, transition.feature),
                "maximum": transition.maximum,
            }
            for transition in placement.transitions
        }
    if placement.capacity_rules:
        spec["capacityRules"] = [
            {"resources": sorted(rule.resources), "scope": rule.scope}
            for rule in placement.capacity_rules
        ]
    if placement.global_latency is not None:
        latency = placement.global_latency
        spec["globalLatency"] = {
            "feature": _reference(ids.APPLICATION, latency.feature),
            "includeExecution": latency.include_execution,
            "exclusive": latency.exclusive,
            "parallel": latency.parallel,
        }
    return {
        "apiVersion": PLACEMENT_API_VERSION,
        "kind": "Placement",
        "metadata": {"name": ids.document_name(composition.composition, PLACEMENT)},
        "spec": spec,
    }


def _endpoint(endpoint: Any) -> dict[str, str]:
    return _reference(PLACEMENT if endpoint.event else ids.APPLICATION, endpoint.id)


def _drop_empty(mapping: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in mapping.items() if value is not None}


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
        (PLACEMENT, "candidateCatalog"),
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
    placement = _placement(composition)
    if placement is not None:
        emitted[PLACEMENT] = placement
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


def provenance(composition: Composition) -> list[dict[str, Any]]:
    """What the Studio decided that the package cannot say, one record per substitution.

    Today that is section 10.2's neutral: every value written into a candidate because a
    property does not apply to it, with the two domains that did not match, the value, and
    whether the neutral was declared by the author or inferred from the sequence operator
    and the domain.

    It is deliberately **not** part of :func:`emit`. A package holds exactly its manifest
    and the documents the manifest declares -- the compiler refuses any other entry -- and
    this cannot live inside the IR either: the container's source map entries carry a
    resource, a path and an optional pointer, element or span, with no slot for
    "synthesized because the property does not apply", and anything written under
    ``spec.extensions`` would move the IR digest and break the round trip the gate rests
    on. So it is written beside the package, in ``provenance.json``, by whoever writes the
    package out.
    """
    records: list[dict[str, Any]] = []
    candidates = [
        (None, candidate) for candidate in composition.candidates
    ] + [
        (task_id, candidate)
        for task_id, candidate in zip(
            [t for t, task in sorted(composition.tasks.items()) if isinstance(task, FixedTask)],
            _fixed_candidates(composition),
            strict=True,
        )
    ]
    scopes = _Scopes(composition)
    for task_id, candidate in candidates:
        for name, prop in scopes.inapplicable(candidate):
            if name in candidate.properties:
                continue
            value, source = property_neutral(prop)
            record: dict[str, Any] = {
                "candidate": candidate.id,
                "property": name,
                "value": value,
                "reason": "domain_mismatch",
                "candidateDomain": candidate.domain,
                "propertyDomain": prop.applies_to,
                "neutralSource": source,
            }
            if task_id is not None:
                record = {"task": task_id, **record}
            if source == "inferred":
                record["inferredFrom"] = {
                    "sequence": prop.aggregation.sequence,
                    "domain": _domain(prop),
                }
            records.append(record)
    return records


def provenance_bytes(composition: Composition) -> bytes:
    """``provenance.json``'s bytes, for a caller writing the package out to a directory."""
    return (
        json.dumps({"substitutions": provenance(composition)}, indent=2, ensure_ascii=False) + "\n"
    ).encode("utf-8")

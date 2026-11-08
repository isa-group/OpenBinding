"""Read an existing BIM v1 package back into a composition: the emitter's inverse.

Phase F1 step 2 needs this only to prove step 1. The gate is
``ir_digest(compile(emit(import_bim(d)))) == ir_digest(compile(d))`` over all 82 packages of
specification section 11.2, and without an importer there is no way to run it at scale:
hand-writing 82 compositions would prove the author's patience rather than the translation.

So this is a **test instrument first and an authoring convenience second**, and it is honest
about the difference. It recovers everything the IR digest can see and deliberately drops
everything it cannot:

* A document's ``metadata`` -- names, versions, descriptions, annotations -- is stripped by
  ``ir_digest``, so a package's own annotations do not survive the trip. Reproducing a
  package *byte for byte* would need an opaque passthrough, which section 9 already asks
  for and this does not provide.
* A task's and a feature's ``name`` **do** reach the IR -- each moves the digest, measured,
  as a candidate's and a provider's do. An earlier version of this line said the opposite.
  What is true is that a title is read here only where the model has a home for it, and the
  model has one for a task's and a provider's because the corpus carries those (18 packages
  and 2 of 82); it has none for a feature's or a candidate's, which no package carries.
* A fixed task is not recovered as one. In a package a fixed task is indistinguishable from
  a service task whose capability happens to have a single candidate, and guessing would
  turn one author's open market into another's fixed choice. Every service task comes back
  as an open task, which re-emits identically.

Two things it must recover exactly, because they are in the digest and a plausible default
is wrong:

* **Branch ids are kept verbatim**, as explicit ids on the branches, rather than trusting
  them to the ``{exclusive id}_branch_{n}`` derivation. The derivation reproduces the
  guiding case, but a package whose ids follow no scheme is reproducible only by naming
  them -- which is exactly what section 5.2 keeps the explicit id for.
* **A criterion's ``clamp`` is read with the container's default, which is false.** Reading
  it as true would silently change four of the gate's packages.
"""

from __future__ import annotations

import json
from dataclasses import replace
from decimal import Decimal
from typing import Any

from . import ids
from .bpmn import Compile, reduce_package
from .emit import FILES, PLACEMENT
from .model import (
    Aggregation,
    Branch,
    Candidate,
    Composition,
    Domain,
    EmptyNode,
    Exclusive,
    Goal,
    LocalTask,
    Node,
    Normalize,
    CapacityRule,
    Endpoint,
    Event,
    EventLatency,
    GlobalLatency,
    NetworkEdge,
    OpenTask,
    Parallel,
    Placement,
    Pool,
    PoolDemand,
    Property,
    Provider,
    Repeat,
    Rule,
    Sequence,
    TaskNode,
    Transition,
)
from .neutral import expand_aggregation

#: The container's defaults for a feature that declares neither. Measured from a compiled
#: IR rather than assumed: a bare ``{"unit": "ms"}`` feature becomes ``minimize`` and
#: ``invocation`` with an unbounded real domain.
DEFAULT_DIRECTION = "minimize"
DEFAULT_SCOPE = "invocation"
DEFAULT_DOMAIN_KIND = "real"


class ImportError_(Exception):
    """A package this version of the language cannot express."""


def _json(files: dict[str, bytes], name: str) -> dict[str, Any]:
    return json.loads(files[name].decode("utf-8"))


def _resource_files(manifest: dict[str, Any]) -> dict[str, str]:
    """Resource id to file name, flattened across the roles."""
    found: dict[str, str] = {}
    for members in manifest["spec"]["resources"].values():
        for resource, path in members.items():
            found[resource] = path
    return found


def _property(feature: Any) -> Property:
    """One feature back into a property.

    ``aggregation`` is expanded through the same helper the emitter's neutral rule uses, so
    a shorthand string, a partial block and an absent aggregation all come back as the five
    operators the container would have inferred -- which is what makes the shorthand and
    the block interchangeable without the importer having to know which the author wrote.
    """
    if isinstance(feature, str):  # the container's own feature shorthand
        feature = {"unit": feature}
    domain = feature.get("domain")
    domain = {"kind": domain} if isinstance(domain, str) else dict(domain or {})
    expanded = expand_aggregation(feature.get("aggregation"))
    return Property(
        unit=feature.get("unit", "1"),
        direction=feature.get("direction", DEFAULT_DIRECTION),
        aggregation=Aggregation(
            sequence=expanded["sequence"],
            parallel=expanded["parallel"],
            exclusive=expanded["exclusive"],
            repeat=expanded["repeat"],
            selection=expanded["selection"],
        ),
        domain=Domain(
            kind=domain.get("kind", DEFAULT_DOMAIN_KIND),
            minimum=domain.get("minimum"),
            maximum=domain.get("maximum"),
        ),
        scope=feature.get("scope", DEFAULT_SCOPE),
        title=feature.get("name"),
        neutral=feature.get("neutral"),
    )


def _task(body: Any) -> OpenTask | LocalTask:
    """One task back into an open or a local task.

    A bare string is the container's shorthand for a service task requiring that
    capability. A service task comes back open even when exactly one candidate matches it:
    see the module docstring on why a fixed task is not guessed at.
    """
    if isinstance(body, str):
        return OpenTask(requires=body)
    kind = body.get("kind", "service")
    if kind == "local":
        return LocalTask(title=body.get("name"))
    requires = body.get("requires")
    if isinstance(requires, dict):  # the IR's shape, not a source document's
        requires = requires.get("type")
    return OpenTask(requires=requires, title=body.get("name"))


def _node(source: Any, counter: list[int]) -> Node:
    """One workflow node back into the model.

    ``counter`` mints a stem for an exclusive whose branch ids follow no scheme. The stem is
    never emitted -- the branches carry their ids explicitly -- but the model requires one,
    and it must be derived from position rather than from a clock so that two imports of one
    package agree.
    """
    if "task" in source:
        reference = source["task"]
        return TaskNode(reference["id"] if isinstance(reference, dict) else reference)
    if "empty" in source:
        return EmptyNode()
    if "sequence" in source:
        return Sequence(tuple(_node(child, counter) for child in source["sequence"]))
    if "parallel" in source:
        return Parallel(tuple(_node(child, counter) for child in source["parallel"]))
    if "exclusive" in source:
        counter[0] += 1
        branches = tuple(
            Branch(flow=_node(entry["flow"], counter), id=entry.get("id"))
            for entry in source["exclusive"]
        )
        return Exclusive(
            id=ids.exclusive_stem(branches[0].id if branches else None, counter[0]),
            branches=branches,
        )
    if "repeat" in source:
        body = source["repeat"]
        return Repeat(
            body=_node(body["body"], counter),
            count=body.get("count"),
            expected=body.get("expectedCount"),
        )
    if "bpmn" in source:
        raise ImportError_("a BPMN workflow is lowered by the container, not read here")
    raise ImportError_(f"unknown workflow node: {sorted(source)}")


def _exclusives(node: Node) -> list[Exclusive]:
    if isinstance(node, Exclusive):
        return [node, *(found for branch in node.branches for found in _exclusives(branch.flow))]
    if isinstance(node, (Sequence, Parallel)):
        return [found for child in node.children for found in _exclusives(child)]
    if isinstance(node, Repeat):
        return _exclusives(node.body)
    return []


def _with_distribution(node: Node, probabilities: dict[str, Decimal], uniform: bool) -> Node:
    """Re-build the workflow with each exclusive carrying the overlay's distribution."""
    if isinstance(node, Sequence):
        return Sequence(tuple(_with_distribution(c, probabilities, uniform) for c in node.children))
    if isinstance(node, Parallel):
        return Parallel(tuple(_with_distribution(c, probabilities, uniform) for c in node.children))
    if isinstance(node, Repeat):
        return Repeat(
            body=_with_distribution(node.body, probabilities, uniform),
            count=node.count,
            expected=node.expected,
        )
    if isinstance(node, Exclusive):
        branches = tuple(
            Branch(
                flow=_with_distribution(branch.flow, probabilities, uniform),
                probability=None if uniform else probabilities.get(branch.id or ""),
                id=branch.id,
            )
            for branch in node.branches
        )
        return Exclusive(
            id=node.id,
            branches=branches,
            distribution="uniform" if uniform else None,
        )
    return node


def _candidates(catalog: dict[str, Any]) -> tuple[tuple[Candidate, ...], dict[str, Provider]]:
    spec = catalog["spec"]
    candidates = []
    for candidate_id, body in (spec.get("candidates") or {}).items():
        provides = body["provides"]
        provider = body.get("provider")
        candidates.append(
            Candidate(
                id=candidate_id,
                # Order and multiplicity are in the digest: a tuple, never a set.
                provides=tuple(provides) if isinstance(provides, list) else provides,
                properties=dict(body.get("features") or {}),
                attributes=dict(body.get("properties") or {}),
                provider=(provider or {}).get("id") if isinstance(provider, dict) else provider,
            ),
        )
    providers = {
        name: Provider(
            title=(body or {}).get("name"),
            properties=dict((body or {}).get("properties") or {}),
        )
        for name, body in (spec.get("providers") or {}).items()
    }
    return tuple(candidates), providers


def _rules(constraints: dict[str, Any], optimization: dict[str, Any]) -> tuple[Rule, ...]:
    """The constraints, ordered so the soft ones keep the optimization's penalty order.

    A soft constraint is referenced from the Optimization document, and that list is
    ordered in the digest while the constraint map is not. So the order of
    ``Composition.rules`` is taken from the penalties list, with the hard constraints after
    it: re-emitting then reproduces the list the package had.
    """
    weights: dict[str, Any] = {}
    order: list[str] = []
    for entry in optimization["spec"].get("penalties") or []:
        reference = entry.get("constraint")
        rule_id = reference["id"] if isinstance(reference, dict) else reference
        order.append(rule_id)
        # An absent weight is not a weight of one: three gate packages omit the key.
        weights[rule_id] = entry.get("weight", None)

    declared = constraints["spec"].get("constraints") or {}
    ordered = [rule_id for rule_id in order if rule_id in declared]
    placed = set(ordered)
    ordered += [rule_id for rule_id in declared if rule_id not in placed]

    found = []
    for rule_id in ordered:
        body = declared[rule_id]
        assertion = body["assert"]
        if not isinstance(assertion, str):
            raise ImportError_(
                f"constraint {rule_id!r} states its assertion as an expression tree, which "
                "this version writes only as text",
            )
        found.append(
            Rule(
                id=rule_id,
                assertion=assertion,
                enforcement=body.get("enforcement", "hard"),
                penalty=body.get("penalty"),
                weight=weights.get(rule_id),
            ),
        )
    return tuple(found)


def _goals(optimization: dict[str, Any]) -> tuple[Goal, ...]:
    found = []
    for criterion in optimization["spec"].get("criteria") or []:
        feature = criterion.get("feature")
        name = feature["id"] if isinstance(feature, dict) else feature
        if criterion.get("id") != name:
            raise ImportError_(
                f"criterion {criterion.get('id')!r} names the feature {name!r}; this version "
                "derives a criterion's id from its property",
            )
        normalize = criterion.get("normalize") or {}
        found.append(
            Goal(
                property=name,
                normalize=Normalize(
                    minimum=normalize["min"],
                    maximum=normalize["max"],
                    # The container's default, and the one a plausible guess gets wrong.
                    clamp=bool(normalize.get("clamp", False)),
                )
                if normalize
                else None,
            ),
        )
    return tuple(found)


def _ref(value: Any) -> str:
    """The id of a `{resource, id}` reference, or of the bare string form."""
    return value["id"] if isinstance(value, dict) else value


def _placement(document: dict[str, Any]) -> tuple[Placement, dict[str, PoolDemand]]:
    """The Placement document as a model, and the demand each candidate carries.

    Three shapes are expanded here rather than kept, because the container erases all three
    and a source form the model cannot recover is how an import and an emit stop agreeing.
    ``defaults`` is merged into every demand, exactly as the lowering does. ``groups``
    become one demand per candidate, with the group's own resources winning over the
    defaults member by member. And a ``symmetric`` network is **completed**: the mirror of
    every off-diagonal edge is appended, in the author's order, skipping a pair that is
    already there. The model therefore holds the directed list the IR sees, which is why
    the emitter can always write ``networkMode: "directed"``.
    """
    spec = document["spec"]
    pools = tuple(
        Pool(
            id=name,
            capacity=dict((body or {}).get("capacity") or {}),
            kind=(body or {}).get("kind", "generic"),
            name=(body or {}).get("name"),
            properties=dict((body or {}).get("properties") or {}),
        )
        for name, body in (spec.get("pools") or {}).items()
    )

    defaults = dict(spec.get("defaults") or {})
    demands: dict[str, PoolDemand] = {}
    # Groups first, then the explicit demands, because that is the precedence the container
    # has: measured on ``examples/placement/01_small_placement`` with one candidate named by
    # both, the compiled IR digest is the one the demand alone produces. Reading them in the
    # other order round-trips such a package to a different problem with nothing to show for
    # it -- no package in the corpus writes both, so the gate would not catch it either.
    for group in (spec.get("groups") or {}).values():
        if "candidates" not in group:
            raise ImportError_(
                "a placement group that names a capability instead of its candidates is "
                "not expressible: this version writes one demand per candidate",
            )
        for candidate in group["candidates"]:
            demands[_ref(candidate)] = PoolDemand(
                pool=_ref(group["pool"]),
                resources={**defaults, **dict(group.get("resources") or {})},
            )
    for demand in spec.get("demands") or []:
        demands[_ref(demand["candidate"])] = PoolDemand(
            pool=_ref(demand["pool"]),
            resources={**defaults, **dict(demand.get("resources") or {})},
        )

    network = [
        NetworkEdge(source=_ref(edge["from"]), target=_ref(edge["to"]), latency=edge["latency"])
        for edge in spec.get("network") or []
    ]
    if spec.get("networkMode") == "symmetric":
        present = {(edge.source, edge.target) for edge in network}
        for edge in list(network):
            pair = (edge.target, edge.source)
            if edge.source != edge.target and pair not in present:
                network.append(NetworkEdge(source=edge.target, target=edge.source, latency=edge.latency))
                present.add(pair)

    events = tuple(
        Event(
            id=name,
            pool=_ref(body["pool"]),
            latency=tuple(
                EventLatency(pool=_ref(entry["pool"]), latency=entry["latency"])
                for entry in body.get("latency") or []
            ),
        )
        for name, body in (spec.get("events") or {}).items()
    )

    transitions = []
    for name, body in (spec.get("transitions") or {}).items():
        if body.get("enforcement") == "soft":
            raise ImportError_(
                f"transition {name!r} is soft, which needs a penalty row in the "
                "Optimization keyed by a placement reference; this version writes none",
            )
        transitions.append(
            Transition(
                id=name,
                source=_endpoint(body["from"]),
                target=_endpoint(body["to"]),
                feature=_ref(body["feature"]),
                maximum=body["maximum"],
            ),
        )

    latency = spec.get("globalLatency")
    return (
        Placement(
            pools=pools,
            network=tuple(network),
            events=events,
            transitions=tuple(transitions),
            capacity_rules=tuple(
                CapacityRule(resources=frozenset(rule["resources"]), scope=rule["scope"])
                for rule in spec.get("capacityRules") or []
            ),
            global_latency=GlobalLatency(
                feature=_ref(latency["feature"]),
                include_execution=latency["includeExecution"],
                exclusive=latency["exclusive"],
                parallel=latency["parallel"],
            )
            if latency
            else None,
        ),
        demands,
    )


def _endpoint(reference: Any) -> Endpoint:
    resource = reference.get("resource") if isinstance(reference, dict) else None
    return Endpoint(id=_ref(reference), event=resource == PLACEMENT)


def import_bim(files: dict[str, bytes], *, compile: Compile | None = None) -> Composition:
    """An existing BIM v1 package as a composition.

    ``files`` is the package's entries, as ``InstancePackage`` takes them. Raises
    :class:`ImportError_` for a package this version of the language cannot express -- an
    assertion written as a tree, a resource with no destination in the model -- rather
    than returning a composition that would quietly re-emit as something else.

    A BPMN workflow is read by delegation and so needs ``compile``, a function from the
    package's entries to the compiled document: the reduction a BPMN process stands for
    is the container's, and reimplementing it here would be a second one to keep in step.
    Without it a BPMN workflow is refused, naming what to pass, rather than yielding a
    composition whose workflow is silently empty. The trip is exact rather than
    approximate: ``examples/demo/15_bpmn_complete`` and ``examples/demo/16_json_complete``
    are the same composition in the two notations and compile to one IR digest, so the
    JSON workflow this emits back is the document the BPMN one already was.
    """
    manifest = _json(files, "instance.json")
    resources = _resource_files(manifest)
    unknown = set(resources) - set(FILES)
    if ids.APPLICATION not in resources:
        # The BPMN reference has to be read out of the Application, and the Application has
        # to be found by the id this version expects. A package that names it something else
        # is one this version cannot express, and saying so beats the bare ``KeyError`` that
        # reading it first would raise.
        raise ImportError_(f"resources this version cannot express: {sorted(unknown)}")
    application = _json(files, resources[ids.APPLICATION])
    reference = application["spec"]["workflow"].get("bpmn")

    if reference is not None:
        # The resource the reference names is expressible after all, by delegation: the
        # reduced workflow has a destination in the model even though the BPMN bytes do not.
        unknown.discard(reference["resource"] if isinstance(reference, dict) else reference)
    if unknown:
        raise ImportError_(f"resources this version cannot express: {sorted(unknown)}")

    catalog = _json(files, resources[ids.CATALOG])
    optimization = _json(files, resources[ids.OPTIMIZATION])

    if reference is None:
        workflow = _node(application["spec"]["workflow"], [0])
    elif compile is None:
        raise ImportError_(
            "the workflow is a BPMN process, which is read by delegation: pass compile= "
            "to import_bim, a function from the package's entries to the compiled document",
        )
    else:
        workflow = reduce_package(files, compile)
    uniform = False
    probabilities: dict[str, Decimal] = {}
    if ids.ROUTING in resources:
        routing = _json(files, resources[ids.ROUTING])["spec"]
        uniform = bool(routing.get("uniform"))
        for entry in routing.get("entries") or []:
            target = entry["target"]
            probabilities[target["id"] if isinstance(target, dict) else target] = Decimal(
                str(entry["probability"]),
            )
    if probabilities or uniform:
        workflow = _with_distribution(workflow, probabilities, uniform)

    placement = None
    demands: dict[str, PoolDemand] = {}
    if PLACEMENT in resources:
        placement, demands = _placement(_json(files, resources[PLACEMENT]))

    candidates, providers = _candidates(catalog)
    if demands:
        # ``replace`` rather than a field-by-field rebuild: a rebuild silently drops
        # whatever field is added to Candidate next, and the loss shows up as a moved
        # digest on one package rather than as an error here.
        candidates = tuple(
            replace(candidate, placement=demands.get(candidate.id)) for candidate in candidates
        )
    return Composition(
        composition=manifest["metadata"]["name"],
        version=manifest["metadata"].get("version", "1.0.0"),
        description=manifest["metadata"].get("description"),
        properties={
            name: _property(body)
            for name, body in (application["spec"].get("features") or {}).items()
        },
        tasks={
            task_id: _task(body)
            for task_id, body in (application["spec"].get("tasks") or {}).items()
        },
        workflow=workflow,
        providers=providers,
        candidates=candidates,
        rules=_rules(_json(files, resources[ids.CONSTRAINTS]), optimization)
        if ids.CONSTRAINTS in resources
        else (),
        goals=_goals(optimization),
        placement=placement,
    )

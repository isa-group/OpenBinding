"""Read an existing BIM v1 package back into a composition: the emitter's inverse.

Phase F1 step 2 needs this only to prove step 1. The gate is
``ir_digest(compile(emit(import_bim(d)))) == ir_digest(compile(d))`` over the 75 packages of
specification section 11.2, and without an importer there is no way to run it at scale:
hand-writing 75 compositions would prove the author's patience rather than the translation.

So this is a **test instrument first and an authoring convenience second**, and it is honest
about the difference. It recovers everything the IR digest can see and deliberately drops
everything it cannot:

* A document's ``metadata`` -- names, versions, descriptions, annotations -- is stripped by
  ``ir_digest``, so a package's own annotations do not survive the trip. Reproducing a
  package *byte for byte* would need an opaque passthrough, which section 9 already asks
  for and this does not provide.
* A task's or a feature's ``name`` does not reach the IR either, so a title read here is
  kept only when the model has a home for it.
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
  it as true would silently change three of the 75 packages.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from . import ids
from .emit import FILES
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
    OpenTask,
    Parallel,
    Property,
    Provider,
    Repeat,
    Rule,
    Sequence,
    TaskNode,
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
        return Exclusive(id=_stem(branches, counter[0]), branches=branches)
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


def _stem(branches: tuple[Branch, ...], position: int) -> str:
    """A stem for an exclusive, recovered from its branch ids when they follow the scheme."""
    first = branches[0].id if branches else None
    if first and first.endswith("_branch_1"):
        return first[: -len("_branch_1")]
    return f"exclusive_{position}"


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
                provider=(provider or {}).get("id") if isinstance(provider, dict) else provider,
            ),
        )
    providers = {name: Provider() for name in (spec.get("providers") or {})}
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
    ordered += [rule_id for rule_id in declared if rule_id not in set(ordered)]

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


def import_bim(files: dict[str, bytes]) -> Composition:
    """An existing BIM v1 package as a composition.

    ``files`` is the package's entries, as ``InstancePackage`` takes them. Raises
    :class:`ImportError_` for a package this version of the language cannot express -- a
    Placement resource, a BPMN workflow, an assertion written as a tree -- rather than
    returning a composition that would quietly re-emit as something else.
    """
    manifest = _json(files, "instance.json")
    resources = _resource_files(manifest)
    unknown = set(resources) - set(FILES)
    if unknown:
        raise ImportError_(f"resources this version cannot express: {sorted(unknown)}")

    application = _json(files, resources[ids.APPLICATION])
    catalog = _json(files, resources[ids.CATALOG])
    optimization = _json(files, resources[ids.OPTIMIZATION])

    workflow = _node(application["spec"]["workflow"], [0])
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

    candidates, providers = _candidates(catalog)
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
    )

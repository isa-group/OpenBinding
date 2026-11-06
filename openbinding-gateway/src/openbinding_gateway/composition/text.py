"""The YAML surface of a composition: the text layer, proved as its own property.

Phase F1 step 3. The order of the phase is deliberate and it is why this module exists on
its own: step 2 won the IR-digest gate with no text in sight, so the translation's
correctness is already settled and nothing here can put it back in question. What this
layer owes is a different property,

    parse(serialise(m)) == m

over every model the gate produces. When step 3 fails it is the syntax, never the
translation.

Two things the surface does on purpose:

* **It omits what the model already defaults.** A property's scope when it is
  ``invocation``, a domain's ``real`` kind, a rule's ``hard`` enforcement, a goal's
  ``clamp`` when it is the default -- writing them all would make a hand-written
  composition unreadable, and the parse restores the same defaults, so the property holds.
* **It does not write templates.** A ``template`` fills direction, scope and aggregation at
  parse time and leaves no trace in the model, so there is nothing for the serializer to
  recover. The parser accepts them; the writer always states the policy. That asymmetry is
  the reason a round trip through the Visual editor normalizes the text, which section 12
  records as a cost rather than a surprise.

A probability is read back as a ``Decimal`` from the text, never as a float, because the
container compares a distribution against ``Decimal(1)`` with no epsilon.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import yaml

from .model import (
    Aggregation,
    Branch,
    Candidate,
    Composition,
    Domain,
    EmptyNode,
    Exclusive,
    FixedTask,
    Goal,
    LocalTask,
    Node,
    Normalize,
    OpenTask,
    Parallel,
    PricingRef,
    Property,
    Provider,
    Repeat,
    Rule,
    Sequence,
    TaskNode,
    TEMPLATES,
)
from .neutral import expand_aggregation


class TextError(Exception):
    """The document is not a composition this version can read."""


# --------------------------------------------------------------------------- writing


def _drop(mapping: dict[str, Any]) -> dict[str, Any]:
    """Remove the members whose value is None, which is how a default is omitted."""
    return {key: value for key, value in mapping.items() if value is not None}


def _property_text(prop: Property) -> dict[str, Any]:
    domain = _drop({
        "kind": prop.domain.kind if prop.domain.kind != "real" else None,
        "min": prop.domain.minimum,
        "max": prop.domain.maximum,
    })
    return _drop({
        "title": prop.title,
        "unit": prop.unit,
        "direction": prop.direction,
        "scope": prop.scope if prop.scope != "invocation" else None,
        "applies_to": prop.applies_to if prop.applies_to != "all" else None,
        "domain": domain or None,
        "aggregate": {
            "sequence": prop.aggregation.sequence,
            "parallel": prop.aggregation.parallel,
            "exclusive": prop.aggregation.exclusive,
            "repeat": prop.aggregation.repeat,
            "selection": prop.aggregation.selection,
        },
        "neutral": prop.neutral,
    })


def _task_text(task: OpenTask | FixedTask | LocalTask) -> dict[str, Any]:
    if isinstance(task, OpenTask):
        return _drop({"open": True, "requires": task.requires, "title": task.title})
    if isinstance(task, LocalTask):
        return _drop({"local": True, "title": task.title})
    return {
        "fixed": _drop({
            "title": task.title,
            "provider": task.provider,
            "properties": task.properties,
        }),
    }


def _node_text(node: Node) -> dict[str, Any]:
    if isinstance(node, TaskNode):
        return {"task": node.task}
    if isinstance(node, EmptyNode):
        return {"empty": True}
    if isinstance(node, Sequence):
        return {"sequence": [_node_text(child) for child in node.children]}
    if isinstance(node, Parallel):
        return {"parallel": [_node_text(child) for child in node.children]}
    if isinstance(node, Exclusive):
        return {
            "exclusive": _drop({
                "id": node.id,
                "distribution": node.distribution,
                "branches": [
                    _drop({
                        "id": branch.id,
                        "probability": _probability_text(branch.probability),
                        "condition": branch.condition,
                        "flow": _node_text(branch.flow),
                    })
                    for branch in node.branches
                ],
            }),
        }
    if isinstance(node, Repeat):
        return {
            "repeat": _drop({
                "body": _node_text(node.body),
                "count": node.count,
                "expected": node.expected,
            }),
        }
    raise TextError(f"not a workflow node: {type(node).__name__}")


def _probability_text(value: Decimal | None) -> Any:
    """A probability as the shortest scalar that reads back to the same ``Decimal``."""
    if value is None:
        return None
    text = format(value, "f")
    return int(value) if value == value.to_integral_value() else float(text)


def serialise(composition: Composition) -> str:
    """One composition as YAML text."""
    document = _drop({
        "composition": composition.composition,
        "version": composition.version,
        "title": composition.title,
        "description": composition.description,
        "pricing": _drop({
            "href": composition.pricing.href,
            "digest": composition.pricing.digest,
        })
        if composition.pricing is not None
        else None,
        "properties": {
            name: _property_text(prop) for name, prop in composition.properties.items()
        },
        "tasks": {name: _task_text(task) for name, task in composition.tasks.items()},
        "workflow": _node_text(composition.workflow),
        "candidates": _drop({
            "providers": {
                name: _drop({"title": provider.title})
                for name, provider in composition.providers.items()
            }
            or None,
            "rows": [
                _drop({
                    "id": candidate.id,
                    "provides": list(candidate.provides)
                    if isinstance(candidate.provides, tuple)
                    else candidate.provides,
                    "provider": candidate.provider,
                    "title": candidate.title,
                    "properties": candidate.properties,
                })
                for candidate in composition.candidates
            ]
            or None,
        })
        or None,
        "rules": [
            _drop({
                "id": rule.id,
                "assert": rule.assertion,
                "enforcement": rule.enforcement if rule.enforcement != "hard" else None,
                "penalty": rule.penalty,
                "weight": rule.weight,
            })
            for rule in composition.rules
        ]
        or None,
        "goals": [
            _drop({
                "property": goal.property,
                "normalize": _drop({
                    "min": goal.normalize.minimum,
                    "max": goal.normalize.maximum,
                    "clamp": goal.normalize.clamp if goal.normalize.clamp is not True else None,
                })
                if goal.normalize is not None
                else None,
            })
            for goal in composition.goals
        ]
        or None,
        "studio": composition.studio or None,
    })
    return yaml.safe_dump(document, sort_keys=False, allow_unicode=True, default_flow_style=False)


# --------------------------------------------------------------------------- reading


def _decimal(value: Any) -> Decimal | None:
    """A probability as a ``Decimal`` built from the text, never from a float's value."""
    if value is None:
        return None
    return Decimal(str(value))


def _property_model(name: str, source: Any) -> Property:
    if not isinstance(source, dict):
        raise TextError(f"property {name!r} is not a mapping")
    template = source.get("template")
    if template is not None and template not in TEMPLATES:
        raise TextError(f"property {name!r} names an unknown template {template!r}")
    direction, aggregation = TEMPLATES[template] if template else (None, None)
    declared = source.get("aggregate")
    if aggregation is None and declared is None:
        raise TextError(f"property {name!r} declares neither a template nor an aggregate")
    # An aggregate beside a template is merged operator by operator, which is what lets the
    # guiding case be written at all: section 3.1.
    merged = {
        "sequence": aggregation.sequence if aggregation else None,
        "parallel": aggregation.parallel if aggregation else None,
        "exclusive": aggregation.exclusive if aggregation else None,
        "repeat": aggregation.repeat if aggregation else None,
        "selection": aggregation.selection if aggregation else None,
    }
    if declared is not None:
        if not declared:
            raise TextError(f"property {name!r} declares an empty aggregate")
        merged.update({key: value for key, value in declared.items() if value is not None})
    if any(value is None for value in merged.values()):
        expanded = expand_aggregation({k: v for k, v in merged.items() if v is not None})
        merged = expanded
    domain = source.get("domain") or {}
    return Property(
        unit=source.get("unit", "1"),
        direction=source.get("direction", direction or "minimize"),
        aggregation=Aggregation(**{key: merged[key] for key in
                                   ("sequence", "parallel", "exclusive", "repeat", "selection")}),
        domain=Domain(
            kind=domain.get("kind", "real"),
            minimum=domain.get("min"),
            maximum=domain.get("max"),
        ),
        scope=source.get("scope", "invocation"),
        title=source.get("title"),
        applies_to=source.get("applies_to", "all"),
        neutral=source.get("neutral"),
    )


def _task_model(name: str, source: Any) -> OpenTask | FixedTask | LocalTask:
    if not isinstance(source, dict):
        raise TextError(f"task {name!r} is not a mapping")
    if source.get("local"):
        return LocalTask(title=source.get("title"))
    if "fixed" in source:
        fixed = source["fixed"] or {}
        return FixedTask(
            properties=dict(fixed.get("properties") or {}),
            title=fixed.get("title"),
            provider=fixed.get("provider"),
        )
    if source.get("open"):
        return OpenTask(requires=source["requires"], title=source.get("title"))
    raise TextError(f"task {name!r} is not exactly one of open, fixed or local")


def _node_model(source: Any) -> Node:
    if not isinstance(source, dict) or len(source) != 1:
        raise TextError(f"a workflow node is one of task, empty, sequence, parallel, "
                        f"exclusive or repeat, got {source!r}")
    if "task" in source:
        return TaskNode(source["task"])
    if "empty" in source:
        return EmptyNode()
    if "sequence" in source:
        return Sequence(tuple(_node_model(child) for child in source["sequence"]))
    if "parallel" in source:
        return Parallel(tuple(_node_model(child) for child in source["parallel"]))
    if "exclusive" in source:
        body = source["exclusive"]
        return Exclusive(
            id=body["id"],
            branches=tuple(
                Branch(
                    flow=_node_model(entry["flow"]),
                    probability=_decimal(entry.get("probability")),
                    id=entry.get("id"),
                    condition=entry.get("condition"),
                )
                for entry in body["branches"]
            ),
            distribution=body.get("distribution"),
        )
    if "repeat" in source:
        body = source["repeat"]
        return Repeat(
            body=_node_model(body["body"]),
            count=body.get("count"),
            expected=body.get("expected"),
        )
    raise TextError(f"unknown workflow node: {sorted(source)}")


def parse(text: str) -> Composition:
    """One YAML document as a composition."""
    document = yaml.safe_load(text)
    if not isinstance(document, dict):
        raise TextError("a composition is a mapping")
    candidates = document.get("candidates") or {}
    pricing = document.get("pricing")
    if isinstance(pricing, str):
        pricing = {"href": pricing}
    return Composition(
        composition=document["composition"],
        version=document["version"],
        title=document.get("title"),
        description=document.get("description"),
        pricing=PricingRef(href=pricing["href"], digest=pricing.get("digest"))
        if pricing
        else None,
        properties={
            name: _property_model(name, body)
            for name, body in (document.get("properties") or {}).items()
        },
        tasks={
            name: _task_model(name, body)
            for name, body in (document.get("tasks") or {}).items()
        },
        workflow=_node_model(document["workflow"]),
        providers={
            name: Provider(title=(body or {}).get("title"))
            for name, body in (candidates.get("providers") or {}).items()
        },
        candidates=tuple(
            Candidate(
                id=row["id"],
                provides=tuple(row["provides"])
                if isinstance(row["provides"], list)
                else row["provides"],
                properties=dict(row.get("properties") or {}),
                provider=row.get("provider"),
                title=row.get("title"),
            )
            for row in (candidates.get("rows") or [])
        ),
        rules=tuple(
            Rule(
                id=rule["id"],
                assertion=rule["assert"],
                enforcement=rule.get("enforcement", "hard"),
                penalty=rule.get("penalty"),
                weight=rule.get("weight"),
            )
            for rule in (document.get("rules") or [])
        ),
        goals=tuple(
            Goal(
                property=goal["property"],
                normalize=Normalize(
                    minimum=goal["normalize"]["min"],
                    maximum=goal["normalize"]["max"],
                    clamp=goal["normalize"].get("clamp", True),
                )
                if goal.get("normalize")
                else None,
            )
            for goal in (document.get("goals") or [])
        ),
        studio=dict(document.get("studio") or {}),
    )

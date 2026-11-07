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

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml

from . import diagnostics as codes
from .checks import coherence
from .diagnostics import CompositionError, Diagnostic, TextError
from .spans import locate
from .model import (
    Aggregation,
    Branch,
    Candidate,
    CapacityRule,
    Composition,
    Domain,
    EmptyNode,
    Endpoint,
    Event,
    EventLatency,
    Exclusive,
    FixedTask,
    GlobalLatency,
    Goal,
    LocalTask,
    NetworkEdge,
    Node,
    Normalize,
    OpenTask,
    Parallel,
    Placement,
    Pool,
    PoolDemand,
    PricingRef,
    Property,
    Provider,
    Repeat,
    Rule,
    Sequence,
    TaskNode,
    Transition,
    RATIO_TEMPLATES,
    TEMPLATES,
)
from .neutral import expand_aggregation


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
            "domain": task.domain if task.domain != "all" else None,
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


def _endpoint_text(endpoint: Endpoint) -> Any:
    """A transition endpoint: the bare id when it names a task, a mapping when an event."""
    return {"event": endpoint.id} if endpoint.event else endpoint.id


def _placement_text(placement: Placement) -> dict[str, Any]:
    """The placement block.

    The network is written as the model holds it, which is the completed directed list: a
    document that declared ``networkMode: symmetric`` comes back with both directions
    written out. The lowering erases the mode, so this is the same placement and not an
    approximation of it -- what the mode saves is typing, and re-deriving it from a list
    of edges would be a guess about the author's intent.
    """
    return _drop({
        "pools": [
            _drop({
                "id": pool.id,
                "kind": pool.kind if pool.kind != "generic" else None,
                "name": pool.name,
                "capacity": pool.capacity,
                "properties": pool.properties or None,
            })
            for pool in placement.pools
        ],
        "network": [
            {"from": edge.source, "to": edge.target, "latency": edge.latency}
            for edge in placement.network
        ]
        or None,
        "events": [
            _drop({
                "id": event.id,
                "pool": event.pool,
                "latency": [
                    {"pool": row.pool, "latency": row.latency} for row in event.latency
                ]
                or None,
            })
            for event in placement.events
        ]
        or None,
        "transitions": [
            _drop({
                "id": transition.id,
                "from": _endpoint_text(transition.source),
                "to": _endpoint_text(transition.target),
                "feature": transition.feature if transition.feature != "latency" else None,
                "max": transition.maximum,
            })
            for transition in placement.transitions
        ]
        or None,
        "capacityRules": [
            _drop({
                "resources": sorted(rule.resources),
                "scope": rule.scope if rule.scope != "selectedCandidate" else None,
            })
            for rule in placement.capacity_rules
        ]
        or None,
        "globalLatency": _drop({
            "feature": placement.global_latency.feature
            if placement.global_latency.feature != "latency"
            else None,
            "includeExecution": placement.global_latency.include_execution
            if placement.global_latency.include_execution is not True
            else None,
            "exclusive": placement.global_latency.exclusive
            if placement.global_latency.exclusive != "routing"
            else None,
            "parallel": placement.global_latency.parallel
            if placement.global_latency.parallel != "max"
            else None,
        })
        if placement.global_latency is not None
        else None,
    })


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
                name: _drop({
                    "title": provider.title,
                    "properties": provider.properties or None,
                })
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
                    "domain": candidate.domain if candidate.domain != "all" else None,
                    "properties": candidate.properties,
                    # ``attributes`` rather than a second ``properties``: the container
                    # calls this map properties and the numeric one features, and the
                    # surface has had properties mean the numeric one since section 3.
                    "attributes": candidate.attributes or None,
                    "placement": _drop({
                        "pool": candidate.placement.pool,
                        "resources": candidate.placement.resources or None,
                    })
                    if candidate.placement is not None
                    else None,
                })
                for candidate in composition.candidates
            ]
            or None,
        })
        or None,
        "placement": _placement_text(composition.placement)
        if composition.placement is not None
        else None,
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
        raise codes.refuse(codes.SCHEMA, f"property {name!r} is not a mapping",
                           f"properties.{name}")
    template = source.get("template")
    if template is not None and template not in TEMPLATES:
        raise codes.refuse(
            codes.PROPERTY_TEMPLATE,
            f"property {name!r} names an unknown template {template!r}",
            f"properties.{name}.template",
        )
    direction, aggregation = TEMPLATES[template] if template else (None, None)
    declared = source.get("aggregate")
    if aggregation is None and declared is None:
        raise codes.refuse(
            codes.PROPERTY_TEMPLATE,
            f"property {name!r} declares neither a template nor an aggregate",
            f"properties.{name}",
        )
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
            raise codes.refuse(
                codes.PROPERTY_TEMPLATE, f"property {name!r} declares an empty aggregate",
                f"properties.{name}.aggregate",
            )
        merged.update({key: value for key, value in declared.items() if value is not None})
    if any(value is None for value in merged.values()):
        expanded = expand_aggregation({k: v for k, v in merged.items() if v is not None})
        merged = expanded
    domain = source.get("domain") or {}
    # ``availability`` and ``reliability`` are ratios, and a ratio is bounded to [0, 1] by
    # the container, which is why those two templates need no explicit bounds (section
    # 3.2). Reading them as the ``real`` default would leave a goal over one of them with
    # no range to normalize over.
    kind = domain.get("kind") or ("ratio" if template in RATIO_TEMPLATES else "real")
    return Property(
        unit=source.get("unit", "1"),
        direction=source.get("direction", direction or "minimize"),
        aggregation=Aggregation(**{key: merged[key] for key in
                                   ("sequence", "parallel", "exclusive", "repeat", "selection")}),
        domain=Domain(
            kind=kind,
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
        raise codes.refuse(codes.SCHEMA, f"task {name!r} is not a mapping", f"tasks.{name}")
    if source.get("local"):
        return LocalTask(title=source.get("title"))
    if "fixed" in source:
        fixed = source["fixed"] or {}
        return FixedTask(
            properties=dict(fixed.get("properties") or {}),
            title=fixed.get("title"),
            provider=fixed.get("provider"),
            domain=fixed.get("domain", "all"),
        )
    if source.get("open"):
        return OpenTask(requires=source["requires"], title=source.get("title"))
    raise codes.refuse(
        codes.TASK_KIND, f"task {name!r} is not exactly one of open, fixed or local",
        f"tasks.{name}",
    )


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


def _endpoint_model(source: Any) -> Endpoint:
    if isinstance(source, dict):
        if "event" in source:
            return Endpoint(id=source["event"], event=True)
        if "task" in source:
            return Endpoint(id=source["task"])
        raise TextError(f"a transition endpoint names a task or an event: {sorted(source)}")
    return Endpoint(id=source)


def _placement_model(source: Any) -> Placement:
    if not isinstance(source, dict):
        raise codes.refuse(codes.SCHEMA, "placement is a mapping", "placement")
    pools = source.get("pools")
    if not pools:
        raise codes.refuse(
            codes.SCHEMA, "a placement declares at least one pool", "placement.pools",
        )
    # A pool, an event and a transition are each keyed by id in the emitted document, so a
    # repeated id is not a list with two entries: it is one entry, silently the last. The
    # schema cannot say this -- JSON Schema has no uniqueness-by-key -- so it is said here,
    # where the message can name the id the author repeated.
    for label, rows in (
        ("pools", pools),
        ("events", source.get("events") or []),
        ("transitions", source.get("transitions") or []),
    ):
        seen = [row["id"] for row in rows if isinstance(row, dict) and "id" in row]
        repeated = sorted({name for name in seen if seen.count(name) > 1})
        if repeated:
            raise codes.refuse(
                codes.SCHEMA, f"two entries of {label} share an id: {repeated}",
                f"placement.{label}",
            )
    latency = source.get("globalLatency")
    return Placement(
        pools=tuple(
            Pool(
                id=pool["id"],
                capacity=dict(pool.get("capacity") or {}),
                kind=pool.get("kind", "generic"),
                name=pool.get("name"),
                properties=dict(pool.get("properties") or {}),
            )
            for pool in pools
        ),
        network=tuple(
            NetworkEdge(source=edge["from"], target=edge["to"], latency=edge["latency"])
            for edge in (source.get("network") or [])
        ),
        events=tuple(
            Event(
                id=event["id"],
                pool=event["pool"],
                latency=tuple(
                    EventLatency(pool=row["pool"], latency=row["latency"])
                    for row in (event.get("latency") or [])
                ),
            )
            for event in (source.get("events") or [])
        ),
        transitions=tuple(
            Transition(
                id=transition["id"],
                source=_endpoint_model(transition["from"]),
                target=_endpoint_model(transition["to"]),
                maximum=transition["max"],
                feature=transition.get("feature", "latency"),
            )
            for transition in (source.get("transitions") or [])
        ),
        capacity_rules=tuple(
            CapacityRule(
                resources=frozenset(rule["resources"]),
                scope=rule.get("scope", "selectedCandidate"),
            )
            for rule in (source.get("capacityRules") or [])
        ),
        global_latency=GlobalLatency(
            feature=latency.get("feature", "latency"),
            include_execution=latency.get("includeExecution", True),
            exclusive=latency.get("exclusive", "routing"),
            parallel=latency.get("parallel", "max"),
        )
        if latency is not None
        else None,
    )


def _path_of(error) -> str:
    """A jsonschema error's location as the dotted path ``spans.locate`` speaks.

    ``absolute_path`` is a deque of mapping keys and sequence indices, which is the same
    walk, written differently: ``["candidates", "rows", 0, "id"]`` is
    ``candidates.rows[0].id``.
    """
    parts: list[str] = []
    for step in error.absolute_path:
        if isinstance(step, int):
            parts.append(f"[{step}]")
        else:
            parts.append(f".{step}" if parts else str(step))
    return "".join(parts)


def _schema_diagnostics(document: object) -> tuple[Diagnostic, ...]:
    """Every way the document breaks its own schema, addressed in the author's terms.

    The schema was already the authority on a composition's shape -- it is what
    ``test_spec_example_validates.py`` exercises rule by rule -- and ``parse`` did not
    consult it. So a document the schema refuses could still be read: a task declared both
    ``open`` and ``local`` is the example that found this, since the reader takes the first
    kind it recognises while the schema's ``oneOf`` refuses the pair.

    Reported rather than raised one at a time, because a schema tells you everything that
    is wrong at once and an editor wants every marker, not the first.
    """
    try:
        from jsonschema import Draft202012Validator  # noqa: PLC0415
    except ImportError:  # pragma: no cover - jsonschema ships with the gateway
        return ()
    path = (
        Path(__file__).resolve().parent
        / "resources" / "composition2yaml" / "v1" / "composition.schema.json"
    )
    if not path.is_file():  # pragma: no cover - the schema travels with the package
        return ()
    validator = Draft202012Validator(json.loads(path.read_text(encoding="utf-8")))
    return tuple(
        Diagnostic(code=codes.SCHEMA, message=error.message, path=_path_of(error))
        for error in sorted(validator.iter_errors(document), key=lambda item: list(item.path))
    )


def parse(text: str) -> Composition:
    """One YAML document as a composition, refusing with located diagnostics.

    The readers below hold a value and not the source, so their refusals name a path and
    carry no position. This is the one place that holds the text, so it is the one place
    that attaches spans: a refusal is caught here and re-raised through
    ``CompositionError.located``, which fills in what ``spans.locate`` found. A valid
    document pays nothing for it -- ``locate`` is called only on the way to a refusal.
    """
    document = yaml.safe_load(text)
    try:
        composition = _compose(document)
    except CompositionError as error:
        # The readers first and the schema second, which was worth measuring rather than
        # assuming. The schema catches every shape error the readers do, so asking it first
        # made the specific codes unreachable: an unknown template came back as
        # ``c2y_schema`` where ``c2y_property_template`` names the property and says what is
        # wrong with it. Three of the property refusals were shadowed that way.
        raise error.located(locate(text)) from None
    except Exception as error:
        # A reader that hits a sharp edge -- a missing key, a value of the wrong type -- on a
        # document the schema can explain. The schema's message is the better one here, and
        # the raw error is kept as the cause.
        broken = _schema_diagnostics(document)
        if broken:
            raise CompositionError(broken).located(locate(text)) from error
        raise
    # Then what no document can say, finished or not: one element contradicting itself.
    # Before the schema, for the reason the readers come before it: the schema refuses a
    # distribution stated beside inline probabilities too, and asked first its generic
    # ``c2y_schema`` shadowed ``c2y_exclusive_distribution``, which names the exclusive and
    # says what is wrong with it. The same ordering mistake, one level down, measured again.
    # Only coherence here -- what a composition still lacks is ``checks.completeness``,
    # refused when a version is sealed, because a draft may be unfinished and both the diff
    # and the editor read drafts.
    unsound = coherence(composition)
    if unsound:
        raise CompositionError(unsound).located(locate(text))
    # And the schema as the backstop, because the readers accept things it refuses: a task
    # declared both ``open`` and ``local`` is read as whichever kind comes first, so the
    # document meant something the author did not write. Measured -- it is the one case of
    # the five where the readers say nothing at all.
    broken = _schema_diagnostics(document)
    if broken:
        raise CompositionError(broken).located(locate(text))
    return composition


def _compose(document: object) -> Composition:
    """The document as a composition. Refusals name a path; ``parse`` gives them a span."""
    if not isinstance(document, dict):
        raise codes.refuse(codes.SCHEMA, "a composition is a mapping", "")
    candidates = document.get("candidates") or {}
    # A candidate placed with nowhere to put it. The emitter writes the demands inside the
    # Placement document, so with no placement block the demand reaches no file at all --
    # the composition compiles and means something else. Refused here rather than dropped.
    if document.get("placement") is None and any(
        isinstance(row, dict) and row.get("placement") for row in (candidates.get("rows") or [])
    ):
        raise codes.refuse(
            codes.SCHEMA,
            "a candidate names a pool but the composition declares no placement block",
            "placement",
        )
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
            name: Provider(
                title=(body or {}).get("title"),
                properties=dict((body or {}).get("properties") or {}),
            )
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
                domain=row.get("domain", "all"),
                attributes=dict(row.get("attributes") or {}),
                placement=PoolDemand(
                    pool=row["placement"]["pool"],
                    resources=dict(row["placement"].get("resources") or {}),
                )
                if row.get("placement") is not None
                else None,
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
        placement=_placement_model(document["placement"])
        if document.get("placement") is not None
        else None,
        studio=dict(document.get("studio") or {}),
    )

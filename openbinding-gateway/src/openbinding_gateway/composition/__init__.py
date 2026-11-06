"""Composition2Yaml: the Studio's high-level composition language.

A composition -- a name, a workflow, tasks, properties and versions -- is the central
entity of OpenBinding Studio, and QoS binding is one analysis performed on it. This
package holds the language: its model, its schema, the identifiers a composition compiles
to, and the neutral values the translation writes explicitly.

Composition2Yaml has no semantics of its own. It is defined by its translation into
``qos-binding/v1`` documents, specified rule by rule in ``docs/COMPOSITION2YAML.md``, and
the container's compiler remains the only authority on what those documents mean. The
source is never a package entry: a composition compiles *into* an ordinary package, and
nothing downstream can tell that package was generated.

This layer stays free of the web layer and of the container's internals, so it can be
lifted into a distribution of its own when the Studio needs one. The architecture test
enforces that by listing ``composition`` among the protected layers.
"""

from __future__ import annotations

from . import emit, ids, read, text
from .diagnostics import CompositionError, Diagnostic, Span
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
from .neutral import NeutralSource, Unbounded, expand_aggregation, infer_neutral, resolve_neutral

#: The version of the language this package implements. It is also the id of the Dialect
#: the container installs for it: a real, installed, JSON-only dialect that declares no
#: resource type and one inline extension point, which costs no existing digest at all --
#: measured, an untouched package compiled with it installed keeps both its ``irDigest``
#: and its ``compilationDigest``. What is *not* free is the notation marker that dialect
#: makes room for: ``ir_digest`` keeps ``spec.extensions``, so a package carrying the
#: marker has a different IR digest from the same package without it. A discriminator in
#: the application schema, the faithful reading of "the mechanism BPMN uses", is a third
#: thing again and is the one that moves every live golden.
#: ``docs/COMPOSITION2YAML.md`` section 13 prices all three.
LANGUAGE_ID = "composition2yaml/v1"

__all__ = [
    "Aggregation",
    "Branch",
    "Candidate",
    "Composition",
    "CompositionError",
    "Diagnostic",
    "Domain",
    "EmptyNode",
    "Exclusive",
    "FixedTask",
    "Goal",
    "LANGUAGE_ID",
    "LocalTask",
    "NeutralSource",
    "Node",
    "Normalize",
    "OpenTask",
    "Parallel",
    "PricingRef",
    "Property",
    "Provider",
    "Repeat",
    "Rule",
    "Sequence",
    "Span",
    "TEMPLATES",
    "TaskNode",
    "Unbounded",
    "expand_aggregation",
    "emit",
    "ids",
    "read",
    "text",
    "infer_neutral",
    "resolve_neutral",
]

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

from . import ids
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

#: The version of the language this package implements. It is also the id of the virtual
#: dialect descriptor recorded in a compiled composition's provenance -- "virtual" because
#: it is never installed into the container: a real dialect would need a discriminator in
#: the application schema, and that moves every golden IR digest in the repository.
#: ``docs/COMPOSITION2YAML.md`` section 13 prices that change.
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
    "ids",
    "infer_neutral",
    "resolve_neutral",
]

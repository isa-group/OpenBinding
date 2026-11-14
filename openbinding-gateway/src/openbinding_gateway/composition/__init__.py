"""Building blocks for the Composition API of F1.

The problem-authoring Composition2Yaml of the Studio was removed in F0b, because
composition problems are written in BIM. What stays here is what F1 reuses to derive a
composition from a problem and a binding: reading a BIM package into a model (``read``,
with ``bpmn`` for BPMN workflows and ``neutral`` for the neutral values the compiler
infers), the workflow tree and its identifiers (``model``, ``ids``), the model diff
(``diff``), and located YAML with its diagnostics (``syntax``, ``spans``,
``diagnostics``). F1 prunes the problem-side types it does not need.

This layer stays free of the web layer and of the container's internals. The architecture
test enforces that by listing ``composition`` among the protected layers.
"""

from __future__ import annotations

from . import bpmn, diff, ids, read
from .diagnostics import CompositionError, Diagnostic, Span
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
    TEMPLATES,
)
from .neutral import NeutralSource, Unbounded, expand_aggregation, infer_neutral, resolve_neutral

__all__ = [
    "Aggregation",
    "bpmn",
    "Branch",
    "Candidate",
    "CapacityRule",
    "Composition",
    "CompositionError",
    "Diagnostic",
    "diff",
    "Domain",
    "EmptyNode",
    "Endpoint",
    "Event",
    "EventLatency",
    "Exclusive",
    "expand_aggregation",
    "FixedTask",
    "GlobalLatency",
    "Goal",
    "ids",
    "infer_neutral",
    "LocalTask",
    "NetworkEdge",
    "NeutralSource",
    "Node",
    "Normalize",
    "OpenTask",
    "Parallel",
    "Placement",
    "Pool",
    "PoolDemand",
    "PricingRef",
    "Property",
    "Provider",
    "read",
    "Repeat",
    "resolve_neutral",
    "Rule",
    "Sequence",
    "Span",
    "TaskNode",
    "TEMPLATES",
    "Transition",
    "Unbounded",
]

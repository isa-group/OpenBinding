"""The Composition2Yaml library: located YAML, its diagnostics and the workflow tree.

* ``syntax`` reads YAML narrowed to JSON's data model and writes it back, bounded in bytes;
* ``spans`` places a path in the source text, so a diagnostic can be underlined;
* ``diagnostics`` is the located finding (code, severity, dotted path and JSON Pointer);
* ``ids`` holds the identifier patterns shared with the container;
* ``workflow`` is the workflow tree, lifted from a compiled IR, normalised and compared.

The library is pure: it imports neither the web layer, the database nor the toolchain.
Facts about a problem reach it as plain data read from the stored IR. The import-linter
contract ``composition-library-pure`` enforces it, and the architecture test lists
``composition`` among the protected layers.
"""

from __future__ import annotations

from . import ids, workflow
from .diagnostics import CompositionError, Diagnostic, Path, Span, at
from .workflow import (
    Branch,
    EmptyNode,
    Exclusive,
    Mismatch,
    Node,
    Parallel,
    Repeat,
    Sequence,
    TaskNode,
    WorkflowError,
)

__all__ = [
    "at",
    "Branch",
    "CompositionError",
    "Diagnostic",
    "EmptyNode",
    "Exclusive",
    "ids",
    "Mismatch",
    "Node",
    "Parallel",
    "Path",
    "Repeat",
    "Sequence",
    "Span",
    "TaskNode",
    "workflow",
    "WorkflowError",
]

"""The Composition2Yaml library: located YAML, the workflow tree and the Composition2Yaml document.

* ``syntax`` reads YAML narrowed to JSON's data model and writes it back, bounded in bytes;
* ``spans`` places a path in the source text, so a diagnostic can be underlined;
* ``diagnostics`` is the located finding (code, severity, dotted path and JSON Pointer);
* ``ids`` holds the identifier patterns: the container's own, and the document's grammar;
* ``workflow`` is the workflow tree, lifted from a compiled IR, normalised and compared;
* ``document`` is the Composition2Yaml document in memory;
* ``text`` reads a document from YAML (or JSON) with located diagnostics, and writes its
  canonical form; it also ships the language's JSON Schema;
* ``diff`` lists what changed between two documents.

The library is pure: it imports neither the web layer, the database nor the toolchain.
Facts about a problem reach it as plain data read from the stored IR. The import-linter
contract ``composition-library-pure`` enforces it, and the architecture test lists
``composition`` among the protected layers.
"""

from __future__ import annotations

from . import diff, document, ids, text, workflow
from .diagnostics import CompositionError, Diagnostic, Path, Span, at
from .document import (
    SUPPORTED_SYNTAX_VERSIONS,
    SYNTAX_VERSION,
    Document,
    Entry,
    Evidence,
    Offering,
    ProblemLink,
    ProblemRef,
    Provenance,
    Value,
)
from .text import Context, Reading
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

#: The language's name, as the platform refers to it. Its versions are ``syntaxVersion``.
LANGUAGE_ID = "composition2yaml"

__all__ = [
    "at",
    "Context",
    "diff",
    "document",
    "Document",
    "Entry",
    "Evidence",
    "LANGUAGE_ID",
    "Offering",
    "ProblemLink",
    "ProblemRef",
    "Provenance",
    "Reading",
    "SUPPORTED_SYNTAX_VERSIONS",
    "SYNTAX_VERSION",
    "text",
    "Value",
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

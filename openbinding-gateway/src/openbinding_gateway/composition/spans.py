"""Where each element of a composition sits in its source text.

``diagnostics.Diagnostic`` carries a ``Span`` so an editor can underline the element at
fault, and until now nothing could produce one: ``text.parse`` reads with
``yaml.safe_load``, which returns values and discards positions, and the refusals it raises
name a path in prose.

This is the missing half. ``locate`` composes the document a second time -- ``yaml.compose``
returns the same tree as nodes carrying ``start_mark`` and ``end_mark`` -- and maps a dotted
path to the region of source that produced it. The parse itself is untouched: it still reads
values, and a span is looked up only when something is about to be refused, so a valid
document pays nothing but one extra compose.

**The span of a mapping entry runs from its key to the end of its value**, which is what an
editor should underline for "this property is wrong": the name is the part the author
recognises. A sequence item spans itself. The marks PyYAML reports are zero-based and a
``Span`` is one-based, as a person counts lines.

Paths are the ones a reader would write: ``properties.cost``, ``properties.cost.domain``,
``candidates.rows[0].id``, ``goals[1].property``. A path that is not in the document simply
has no span, and a diagnostic without one falls back to naming its path -- which is what
``Diagnostic.__str__`` already does.
"""

from __future__ import annotations

from typing import Any

import yaml

from .diagnostics import Span


def _span(start: Any, end: Any) -> Span:
    """One node's region, from zero-based marks to one-based lines and columns."""
    return Span(
        line=start.line + 1,
        column=start.column + 1,
        end_line=end.line + 1,
        end_column=end.column + 1,
    )


def _walk(node: Any, prefix: str, found: dict[str, Span]) -> None:
    if isinstance(node, yaml.MappingNode):
        for key, value in node.value:
            if not isinstance(key, yaml.ScalarNode):
                continue
            path = f"{prefix}.{key.value}" if prefix else str(key.value)
            # From the key, not from the value: the name is what the author recognises, and
            # underlining only the value leaves "property cost is wrong" pointing at a number.
            found[path] = _span(key.start_mark, value.end_mark)
            _walk(value, path, found)
    elif isinstance(node, yaml.SequenceNode):
        for position, item in enumerate(node.value):
            path = f"{prefix}[{position}]"
            found[path] = _span(item.start_mark, item.end_mark)
            _walk(item, path, found)


def locate(text: str) -> dict[str, Span]:
    """Every dotted path of the document, mapped to the source it came from.

    Returns an empty map for a document that does not compose -- a caller that is about to
    refuse the text for being unreadable has nothing to underline anyway, and raising a
    second parse error here would hide the first.
    """
    try:
        root = yaml.compose(text)
    except yaml.YAMLError:
        return {}
    if root is None:
        return {}
    # The root under the empty path, because a schema error about the document as a whole --
    # an unknown top-level key, say -- reports no path, and pointing at line 1 beats
    # pointing nowhere.
    found: dict[str, Span] = {"": _span(root.start_mark, root.end_mark)}
    _walk(root, "", found)
    return found

"""Where each element of a composition sits in its source text.

``diagnostics.Diagnostic`` carries a ``Span`` so an editor can underline the element at
fault, and until now nothing could produce one: ``text.parse`` reads values, which discard
positions, and the refusals it raises name a path in prose.

This is the missing half. ``locate`` composes the document a second time -- composing
returns the same tree as nodes carrying ``start_mark`` and ``end_mark``, by the rules of
:mod:`.syntax` so that an alias is refused rather than walked once per use -- and maps a dotted
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

from collections.abc import Iterable
from typing import Any

import yaml

from .diagnostics import CompositionError, Span
from .syntax import Lines, compose


def _walk(node: Any, prefix: str, found: dict[str, Span], lines: Lines) -> None:
    if isinstance(node, yaml.MappingNode):
        for key, value in node.value:
            if not isinstance(key, yaml.ScalarNode):
                continue
            path = f"{prefix}.{key.value}" if prefix else str(key.value)
            # From the key, not from the value: the name is what the author recognises, and
            # underlining only the value leaves "property cost is wrong" pointing at a number.
            found[path] = lines.span(key.start_mark, value.end_mark)
            _walk(value, path, found, lines)
    elif isinstance(node, yaml.SequenceNode):
        for position, item in enumerate(node.value):
            path = f"{prefix}[{position}]"
            found[path] = lines.span(item.start_mark, item.end_mark)
            _walk(item, path, found, lines)


def locate(text: str, paths: Iterable[str] | None = None) -> dict[str, Span]:
    """The dotted paths of the document, mapped to the source they came from.

    With ``paths``, only those are placed -- the paths of the diagnostics about to be
    located -- and each is found by walking down from the root, so the cost follows the
    paths asked for rather than the size of the document. Without, every path is mapped,
    which is what the tests that pin the span rules read. Building every path of a large
    document was the expensive part: a path is a string as long as every key above it, so a
    long key over a long list cost their product in memory.

    Returns an empty map for a document that does not compose -- a caller that is about to
    refuse the text for being unreadable has nothing to underline anyway, and raising a
    second parse error here would hide the first.
    """
    try:
        # By the loader's own rules, so an alias is refused here too rather than walked once
        # per use: a walk visits a node every time the tree reaches it.
        root = compose(text)
    except yaml.YAMLError:
        return {}
    if root is None:
        return {}
    # The root under the empty path, because a schema error about the document as a whole --
    # an unknown top-level key, say -- reports no path, and pointing at line 1 beats
    # pointing nowhere.
    lines = Lines(text)
    found: dict[str, Span] = {"": lines.span(root.start_mark, root.end_mark)}
    if paths is None:
        _walk(root, "", found, lines)
        return found
    finder = _Finder(lines)
    for path in set(paths):
        if path and path not in found:
            span = finder.find(root, path)
            if span is not None:
                found[path] = span
    return found


class _Finder:
    """One path's span, read down from the root the way :func:`_walk` writes paths.

    A key may contain a dot or a bracket, so the dotted path does not say where a key ends.
    At a mapping, every key the rest of the path starts with -- ending where the path ends or
    at a separator -- is tried, shortest first, and a key whose remainder leads nowhere gives
    way to the next. Shortest first, because a path is written from the structure the checks
    hold: ``properties.cost.neutral`` is far likelier to mean the neutral of ``cost`` than a
    property named ``cost.neutral``, and when it does mean the latter, the shorter reading
    leads nowhere and gives way. Only lengths some key of that mapping has are tried, so the
    cost follows the mapping's keys rather than the path's separators, and every
    (node, remainder) is answered once, so trying is never repeated however the keys overlap.
    """

    def __init__(self, lines: Lines) -> None:
        self._lines = lines
        self._keys: dict[int, tuple[dict[str, tuple[Any, Any]], list[int]]] = {}
        self._known: dict[tuple[int, int], Span | None] = {}

    def find(self, root: Any, path: str) -> Span | None:
        self._path = path
        self._known = {}
        return self._from(root, 0)

    def _from(self, node: Any, at: int) -> Span | None:
        memo = (id(node), at)
        if memo not in self._known:
            self._known[memo] = self._resolve(node, at)
        return self._known[memo]

    def _resolve(self, node: Any, at: int) -> Span | None:
        path = self._path
        if isinstance(node, yaml.SequenceNode):
            if not path.startswith("[", at):
                return None
            close = path.find("]", at)
            if close < 0:
                return None
            try:
                position = int(path[at + 1:close])
            except ValueError:
                return None
            if not 0 <= position < len(node.value):
                return None
            item = node.value[position]
            return self._next(item, close + 1, self._lines.span(item.start_mark, item.end_mark))
        if not isinstance(node, yaml.MappingNode):
            return None
        index, lengths = self._index(node)
        rest = len(path) - at
        for length in lengths:
            if length > rest:
                continue
            if length < rest and path[at + length] not in ".[":
                continue
            entry = index.get(path[at:at + length])
            if entry is None:
                continue
            key, value = entry
            found = self._next(value, at + length, self._lines.span(key.start_mark, value.end_mark))
            if found is not None:
                return found
        return None

    def _next(self, node: Any, at: int, span: Span) -> Span | None:
        """The span reached, if the path ends here; otherwise the rest of the path's."""
        if at < len(self._path) and self._path[at] == ".":
            at += 1
        elif at < len(self._path) and self._path[at] != "[":
            return None
        if at >= len(self._path):
            return span
        return self._from(node, at)

    def _index(self, node: Any) -> tuple[dict[str, tuple[Any, Any]], list[int]]:
        cached = self._keys.get(id(node))
        if cached is None:
            index = {
                key.value: (key, value)
                for key, value in node.value
                if isinstance(key, yaml.ScalarNode)
            }
            cached = self._keys[id(node)] = (index, sorted({len(name) for name in index}))
        return cached


def placed(error: CompositionError, text: str) -> CompositionError:
    """The error's diagnostics with their spans filled in from ``text``.

    Only the paths of the diagnostics that have no span yet are looked for, so placing a
    refusal costs what the refusal names, not what the document holds.
    """
    return error.located(locate(text, (item.path for item in error.diagnostics if item.span is None)))

"""What changed between two Composition2Yaml documents.

Ported from SPHERE (SCORELabUS/SPHERE, MIT licence, revision 73779a8a),
``frontend/src/modules/pricing/utils/pricing-diff.ts``: the same JSON shape and the same rules, applied to
the canonical form of a composition instead of a pricing.

A comparison has ``general`` changes (top-level fields that are not a section) and three ``sections``:

* ``binding``, one entry per task;
* ``values``, one entry per property;
* ``offering``, one entry, ``source``.

An entry was ``added``, ``removed`` or ``changed``, and lists its field ``changes``, each a dotted ``path``
within the entry with the value ``before`` and ``after`` (``null`` where the field is absent). Mappings are
flattened to their leaves; lists are compared whole, since their order means something. The workflow is
compared whole, as one general change: a positional tree has no stable keys to flatten by. ``version`` and
``evidence`` differ between two versions by definition and are not reported. Two values are the same when
their JSON is, so ``30`` and ``30.0`` differ, as their canonical bytes do.

``totals`` counts the entries of each kind, plus each general change as ``changed``; ``isEmpty`` says there
is nothing to show. ``comparison`` says whether the two sides' values can be compared at all
(``comparable``): only when both are verified on the same problem and compilation, or both declared on the
same link (or none). Value changes are never reported between incomparable sides, since a toolchain's value
and an author's, or the values of two problems, differ for reasons a diff cannot show; the ``values``
section is then empty and ``comparison`` says why.
"""

from __future__ import annotations

import json
from typing import Any, Literal

from .document import Document
from .text import document as canonical

ChangeKind = Literal["added", "removed", "changed"]
ValueStatus = Literal["verified", "declared"]

#: The sections, in the order they are listed, with their labels.
SECTIONS: tuple[tuple[str, str], ...] = (("binding", "Binding"), ("values", "Values"), ("offering", "Offering"))
#: The kinds of entry change.
KINDS: tuple[ChangeKind, ...] = ("added", "removed", "changed")
#: Top-level keys that are no general change: the sections, and what differs between versions by definition.
IGNORED_GENERAL_KEYS = frozenset({"version", "evidence", *(key for key, _ in SECTIONS)})
#: Top-level keys compared whole rather than flattened.
WHOLE_KEYS = frozenset({"workflow"})
#: The one entry of the ``offering`` section.
OFFERING_ENTRY = "source"

_ABSENT = object()


def _flatten(value: Any, prefix: str = "", whole: frozenset[str] = frozenset()) -> dict[str, Any]:
    """The leaves of ``value`` by dotted path; a non-mapping is one leaf at ``prefix``."""
    flat: dict[str, Any] = {}
    if value is None or value is _ABSENT:
        return flat
    if not isinstance(value, dict):
        flat[prefix] = value
        return flat
    for key, child in value.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(child, dict) and path not in whole:
            nested = _flatten(child, path)
            if not nested:
                flat[path] = child
            flat.update(nested)
        else:
            flat[path] = child
    return flat


def _same(one: Any, other: Any) -> bool:
    return json.dumps(one, sort_keys=True) == json.dumps(other, sort_keys=True)


def _fields(before: Any, after: Any, whole: frozenset[str] = frozenset()) -> list[dict[str, Any]]:
    """Every leaf that differs, in the order the paths first appear (``before``'s, then ``after``'s new ones)."""
    was, now = _flatten(before, whole=whole), _flatten(after, whole=whole)
    changes: list[dict[str, Any]] = []
    for path in (*was, *(path for path in now if path not in was)):
        if path in was and path in now and _same(was[path], now[path]):
            continue
        changes.append({"path": path, "before": was.get(path), "after": now.get(path)})
    return changes


def _entries(before: dict[str, Any], after: dict[str, Any]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for name in (*before, *(name for name in after if name not in before)):
        if name not in after:
            entries.append({"name": name, "kind": "removed", "changes": _fields(before[name], _ABSENT)})
        elif name not in before:
            entries.append({"name": name, "kind": "added", "changes": _fields(_ABSENT, after[name])})
        else:
            changes = _fields(before[name], after[name])
            if changes:
                entries.append({"name": name, "kind": "changed", "changes": changes})
    return entries


def value_status(doc: Document) -> ValueStatus:
    """``verified`` when the toolchain computed the document's values, as a sealed linked version says."""
    evidence = doc.evidence
    if doc.problem is not None and evidence is not None and evidence.evaluated_by == "gateway":
        return "verified"
    return "declared"


def comparison(before: Document, after: Document) -> dict[str, Any]:
    """Whether the values of the two documents can be compared, and what tells them apart if not."""
    statuses = {"before": value_status(before), "after": value_status(after)}
    ref_changed = (
        (str(before.problem.ref) if before.problem else None) != (str(after.problem.ref) if after.problem else None)
    )
    compilation_changed = (
        (before.problem.compilation if before.problem else None)
        != (after.problem.compilation if after.problem else None)
    )
    return {
        "comparable": statuses["before"] == statuses["after"] and not ref_changed and not compilation_changed,
        "problemRefChanged": ref_changed,
        "compilationChanged": compilation_changed,
        "valueStatus": statuses,
    }


def _sections(written: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Each section as named entries: values always as ``{value, unit}``, the offering as one ``source``."""
    values = {
        name: value if isinstance(value, dict) else {"value": value, "unit": "1"}
        for name, value in written.get("values", {}).items()
    }
    offering = written.get("offering")
    return {
        "binding": dict(written.get("binding", {})),
        "values": values,
        "offering": {OFFERING_ENTRY: offering} if offering is not None else {},
    }


def diff(before: Document, after: Document) -> dict[str, Any]:
    """What changed from ``before`` (the older document) to ``after``, as JSON-native data."""
    was, now = canonical(before), canonical(after)
    compared = comparison(before, after)
    general = _fields(
        {key: value for key, value in was.items() if key not in IGNORED_GENERAL_KEYS},
        {key: value for key, value in now.items() if key not in IGNORED_GENERAL_KEYS},
        whole=WHOLE_KEYS,
    )
    was_sections, now_sections = _sections(was), _sections(now)
    sections = []
    for key, label in SECTIONS:
        entries = _entries(was_sections[key], now_sections[key])
        if key == "values" and not compared["comparable"]:
            entries = []
        sections.append({"key": key, "label": label, "entries": entries})
    totals = {kind: 0 for kind in KINDS}
    for section in sections:
        for entry in section["entries"]:
            totals[entry["kind"]] += 1
    totals["changed"] += len(general)
    return {
        "general": general,
        "sections": sections,
        "totals": totals,
        "isEmpty": sum(totals.values()) == 0,
        "comparison": compared,
    }


__all__ = [
    "IGNORED_GENERAL_KEYS",
    "KINDS",
    "OFFERING_ENTRY",
    "SECTIONS",
    "WHOLE_KEYS",
    "ChangeKind",
    "ValueStatus",
    "comparison",
    "diff",
    "value_status",
]

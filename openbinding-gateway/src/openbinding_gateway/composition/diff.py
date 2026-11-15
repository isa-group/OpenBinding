"""What changed between two Composition2Yaml documents.

A comparison of two versions of a composition is read section by section: its identity, the
problem it links, its workflow, its binding, its values, its offering and its evidence. Each
:class:`Change` names its section, the subject within it (a task, a property, a field), and
whether it was ``added``, ``removed``, ``changed`` or ``moved``, with the value it had and has.
Values are written the way a response carries them: text, numbers, lists and mappings.

The workflow is compared the way :mod:`.workflow` compares trees: positionally. A different
block structure is one ``shape`` change; a task invoked at other places is ``moved``; an
exclusive choice whose probabilities or ``uniform`` changed is reported at the choice. A
number is compared and reported by its ``repr``, so ``30`` and ``30.0`` differ, as their
canonical bytes do.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .document import Document, Entry, Evidence, Offering, Provenance, Value
from .text import canonical_binding
from .workflow import Exclusive, Location, invocations, shape, walk

#: The sections, in the order changes are listed.
SECTIONS: tuple[str, ...] = ("identity", "problem", "workflow", "binding", "values", "offering", "evidence")
#: What happened to a subject.
KINDS: tuple[str, ...] = ("added", "removed", "changed", "moved")


@dataclass(frozen=True, slots=True)
class Change:
    """One difference between two documents."""

    section: str
    subject: str
    kind: str
    was: Any = None
    now: Any = None

    def as_dict(self) -> dict[str, Any]:
        return {"section": self.section, "subject": self.subject, "kind": self.kind, "was": self.was, "now": self.now}


def as_documents(changes: Iterable[Change]) -> list[dict[str, Any]]:
    """The changes as JSON-native mappings."""
    return [change.as_dict() for change in changes]


def diff(before: Document, after: Document) -> tuple[Change, ...]:
    """Every difference from ``before`` to ``after``, sorted by section, then subject."""
    found: list[Change] = []
    found += _identity(before, after)
    found += _problem(before, after)
    found += _workflow(before, after)
    found += _binding(before, after)
    found += _values(before, after)
    found += _offering(before.offering, after.offering)
    found += _evidence(before.evidence, after.evidence)
    return tuple(sorted(found, key=lambda change: (SECTIONS.index(change.section), change.subject)))


def _field(section: str, subject: str, was: Any, now: Any) -> list[Change]:
    """The change of one optional field: absent is ``None``."""
    if was == now:
        return []
    if was is None:
        return [Change(section, subject, "added", now=now)]
    if now is None:
        return [Change(section, subject, "removed", was=was)]
    return [Change(section, subject, "changed", was=was, now=now)]


def _identity(before: Document, after: Document) -> list[Change]:
    found: list[Change] = []
    for subject, was, now in (
        ("syntaxVersion", before.syntax_version, after.syntax_version),
        ("composition", before.composition, after.composition),
        ("version", before.version, after.version),
        ("kind", before.kind, after.kind),
    ):
        found += _field("identity", subject, was, now)
    return found


def _problem(before: Document, after: Document) -> list[Change]:
    was, now = before.problem, after.problem
    return _field(
        "problem", "ref", str(was.ref) if was else None, str(now.ref) if now else None,
    ) + _field(
        "problem", "compilation", was.compilation if was else None, now.compilation if now else None,
    )


# --------------------------------------------------------------------------- workflow


def _where(document: Document, location: Location) -> str:
    """A location as the source path it was read from, or by its positions for a document built in code."""
    path = document.paths.nodes.get(location)
    if path is not None:
        return path.dotted
    return "workflow" + "".join(f"[{position}]" for position in location)


def _choice(node: Exclusive) -> dict[str, Any]:
    return {"uniform": node.uniform, "probabilities": [branch.probability for branch in node.branches]}


def _workflow(before: Document, after: Document) -> list[Change]:
    found: list[Change] = []
    was_shape, now_shape = shape(before.workflow), shape(after.workflow)
    if was_shape != now_shape:
        found.append(Change("workflow", "shape", "changed", was=was_shape, now=now_shape))
    was_at, now_at = invocations(before.workflow), invocations(after.workflow)
    for task in (*was_at, *(task for task in now_at if task not in was_at)):
        old, new = was_at.get(task), now_at.get(task)
        old_text = [_where(before, location) for location in old] if old else None
        new_text = [_where(after, location) for location in new] if new else None
        if old is None:
            found.append(Change("workflow", task, "added", now=new_text))
        elif new is None:
            found.append(Change("workflow", task, "removed", was=old_text))
        elif old != new:
            found.append(Change("workflow", task, "moved", was=old_text, now=new_text))
    choices = {location: node for location, node in walk(after.workflow) if isinstance(node, Exclusive)}
    for location, node in walk(before.workflow):
        other = choices.get(location)
        if not isinstance(node, Exclusive) or other is None or len(other.branches) != len(node.branches):
            continue
        was, now = _choice(node), _choice(other)
        if [repr(p) for p in was["probabilities"]] != [repr(p) for p in now["probabilities"]] or (
            was["uniform"] != now["uniform"]
        ):
            found.append(Change("workflow", _where(after, location), "changed", was=was, now=now))
    return found


# --------------------------------------------------------------------------- binding and values


def _entry_text(entry: Entry) -> dict[str, Any]:
    written: dict[str, Any] = {}
    if entry.candidate is not None:
        written["candidate"] = entry.candidate
    if entry.local:
        written["local"] = True
    if entry.source is not None:
        written["from"] = _provenance_text(entry.source)
    return written


def _provenance_text(source: Provenance) -> dict[str, Any]:
    written = {
        key: value
        for key, value in (
            ("sphere", source.sphere), ("registry", source.registry),
            ("version", source.version), ("plan", source.plan),
        )
        if value is not None
    }
    if source.addons:
        written["addons"] = list(source.addons)
    return written


def _binding(before: Document, after: Document) -> list[Change]:
    found: list[Change] = []
    was_entries = dict(canonical_binding(before.workflow, before.binding))
    now_entries = dict(canonical_binding(after.workflow, after.binding))
    for task in (*was_entries, *(task for task in now_entries if task not in was_entries)):
        was, now = was_entries.get(task), now_entries.get(task)
        if was is None:
            found.append(Change("binding", task, "added", now=_entry_text(now)))  # type: ignore[arg-type]
            continue
        if now is None:
            found.append(Change("binding", task, "removed", was=_entry_text(was)))
            continue
        found += _field("binding", f"{task}.candidate", was.candidate, now.candidate)
        if was.local != now.local:
            found.append(Change("binding", f"{task}.local", "changed", was=was.local, now=now.local))
        found += _source(task, was.source, now.source)
    return found


def _source(task: str, was: Provenance | None, now: Provenance | None) -> list[Change]:
    subject = f"{task}.from"
    if was is None or now is None:
        return _field(
            "binding", subject,
            None if was is None else _provenance_text(was),
            None if now is None else _provenance_text(now),
        )
    found: list[Change] = []
    for key in ("sphere", "registry", "version", "plan"):
        found += _field("binding", f"{subject}.{key}", getattr(was, key), getattr(now, key))
    if set(was.addons) != set(now.addons):
        found.append(Change(
            "binding", f"{subject}.addons", "changed", was=sorted(set(was.addons)), now=sorted(set(now.addons)),
        ))
    return found


def _value_text(value: Value) -> dict[str, Any]:
    return {"value": repr(value.value), "unit": value.unit}


def _values(before: Document, after: Document) -> list[Change]:
    found: list[Change] = []
    was_values, now_values = dict(before.values), dict(after.values)
    for name in sorted({*was_values, *now_values}):
        was, now = was_values.get(name), now_values.get(name)
        if was is None:
            found.append(Change("values", name, "added", now=_value_text(now)))  # type: ignore[arg-type]
        elif now is None:
            found.append(Change("values", name, "removed", was=_value_text(was)))
        else:
            found += _field("values", f"{name}.value", repr(was.value), repr(now.value))
            found += _field("values", f"{name}.unit", was.unit, now.unit)
    return found


# --------------------------------------------------------------------------- offering and evidence


def _offering_text(offering: Offering | None) -> dict[str, str] | None:
    if offering is None:
        return None
    return {
        key: value
        for key, value in (("sphere", offering.sphere), ("registry", offering.registry), ("url", offering.url))
        if value is not None
    }


def _offering(was: Offering | None, now: Offering | None) -> list[Change]:
    return _field("offering", "source", _offering_text(was), _offering_text(now))


def _evidence(was: Evidence | None, now: Evidence | None) -> list[Change]:
    old, new = was or Evidence(), now or Evidence()
    found: list[Change] = []
    for subject, before, after in (
        ("run", old.run, new.run),
        ("point", old.point, new.point),
        ("manual", old.manual or None, new.manual or None),
        ("evaluatedBy", old.evaluated_by, new.evaluated_by),
        ("toolchain", old.toolchain, new.toolchain),
    ):
        found += _field("evidence", subject, before, after)
    return found

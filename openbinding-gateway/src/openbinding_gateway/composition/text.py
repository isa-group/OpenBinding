"""The text of a Composition2Yaml document: read it, write it, and judge its shape.

Reading goes YAML text -> located :class:`~.document.Document`; writing goes ``Document`` ->
canonical mapping -> canonical bytes. Both directions are built on :mod:`.syntax` (YAML
narrowed to JSON's data model) and :mod:`.spans` (where each element sits in the text).

**Reading never raises for a document's own problems.** :func:`read` returns a
:class:`Reading`: the document when nothing refuses it, and every diagnostic found, each with
its path, JSON Pointer and span. :func:`parse` is the same, raising
:class:`~.diagnostics.CompositionError` when there is an error. The stages run in this order,
and every finding of a stage is collected before the next one runs:

1. the size, in UTF-8 bytes (``c2y_too_long``);
2. the YAML (``c2y_syntax``, located where the reader stopped);
3. the root, which must be a mapping;
4. the section readers. They report, in this order, problem content (``c2y_problem_content``:
   alternatives, constraints and objectives are the BIM problem's), keys the language does
   not have, required keys that are absent, values of the wrong JSON type, and then each
   section's own codes. They build the workflow tree and keep the source path of every node;
5. the coherence checks of :mod:`.checks`, only when the readers built a document: how its
   sections agree with one another, and the rules that depend on the deployment or the entity;
6. the JSON Schema, as a backstop: a finding at, above or below the path of an earlier error
   is the same problem said less precisely, so it is dropped.

The readers come before the schema on purpose, as measured in the layer this replaces:
asked first, the schema's generic ``c2y_schema`` shadowed every specific code. A key the
language does not have is reported at the key itself, where the schema's
``additionalProperties`` would report it at the parent and put the span on the wrong line.

Spans are filled once, on the way out, and only when there is something to report, so a
clean document never pays for locating. A missing key has no text of its own: it is reported
at its own path and underlined at its parent, and so is any finding whose path the text does
not have, at its nearest ancestor that it does.

**Writing is canonical** (:func:`document`, :func:`serialise`): one key order, the binding in
the order a depth-first walk of the workflow first meets each task, the values sorted by
name, a dimensionless value as a bare number, block style, no anchors, no folding, and
PyYAML's float form, which every float reads back from as the same double. Two equal
documents write the same bytes, and the bytes of a document read back to it: sealing,
deduplication and derivation rely on both.

:func:`compose` judges a document that never was YAML (a JSON request body) by the same
readers and schema, after :func:`unrepresentable` refuses what JSON cannot hold; there is no
text, so its diagnostics have a path and a pointer and no span. :func:`read_stored` reads the
canonical bytes of a sealed version, skipping the checks that depend on the deployment or the
entity, so a version stays readable after a registry alias leaves the configuration.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, replace
from functools import lru_cache
from itertools import islice
from pathlib import Path as FilePath
from typing import Any, Iterable, Mapping

from jsonschema import Draft202012Validator

from . import diagnostics as codes
from . import checks, ids, spans, syntax
from .diagnostics import MAX_LISTED, CompositionError, Diagnostic, Path, Severity, Span, at, clipped, listed
from .document import (
    DIMENSIONLESS,
    ENTRY_PROBLEM_KEYS,
    KINDS,
    OFFERING_CONTENT_KEYS,
    PROBLEM_KEYS,
    REQUIRED_KEYS,
    ROOT_KEYS,
    SUPPORTED_SYNTAX_VERSIONS,
    SYNTAX_VERSION,
    Document,
    Entry,
    Evidence,
    Offering,
    Paths,
    ProblemLink,
    ProblemRef,
    Provenance,
    Value,
)
from .workflow import (
    Branch,
    EmptyNode,
    Exclusive,
    Location,
    Node,
    Parallel,
    Repeat,
    Sequence,
    TaskNode,
    normal_form,
    tasks,
)

#: The longest a document may be, in UTF-8 bytes: 256 KiB, the source and its canonical text alike.
MAX_SOURCE_BYTES = 262_144


@dataclass(frozen=True, slots=True)
class Context:
    """What a reading may depend on beyond the text: the deployment and the entity.

    ``registries`` are the SPHERE registry aliases the deployment defines; empty means it
    defines none, so every alias is unknown. ``entity_slug`` is the slug of the composition
    the document is submitted to, when there is one. ``stored`` reads a sealed version: the
    checks that depend on either are skipped. The library never reads settings: the caller
    passes them in.
    """

    registries: frozenset[str] = frozenset()
    entity_slug: str | None = None
    stored: bool = False


_PLAIN = Context()
_STORED = Context(stored=True)


@dataclass(frozen=True, slots=True)
class Reading:
    """What reading a document found: the document, unless an error refuses it, and every diagnostic."""

    document: Document | None
    diagnostics: tuple[Diagnostic, ...] = ()

    @property
    def errors(self) -> tuple[Diagnostic, ...]:
        return self._of("error")

    @property
    def warnings(self) -> tuple[Diagnostic, ...]:
        return self._of("warning")

    @property
    def infos(self) -> tuple[Diagnostic, ...]:
        return self._of("info")

    @property
    def valid(self) -> bool:
        """Whether no diagnostic refuses the document; warnings and infos only inform."""
        return not self.errors

    def _of(self, severity: Severity) -> tuple[Diagnostic, ...]:
        return tuple(item for item in self.diagnostics if item.severity == severity)


class StoredContentError(Exception):
    """The stored bytes of a sealed version do not read: a bug, since they read when sealed."""

    def __init__(self, diagnostics: Iterable[Diagnostic]) -> None:
        self.diagnostics = tuple(diagnostics)
        super().__init__("; ".join(str(item) for item in self.diagnostics))


# --------------------------------------------------------------------------- reading


def read(text: str, *, context: Context = _PLAIN) -> Reading:
    """One YAML document, judged; never raises for the document's own problems."""
    size = len(text.encode("utf-8", errors="surrogatepass"))
    if size > MAX_SOURCE_BYTES:
        return Reading(None, (at(
            (), codes.TOO_LONG,
            f"the document is {size} bytes long, past the {MAX_SOURCE_BYTES} bytes a document may be",
        ),))
    try:
        loaded = syntax.load(text)
    except CompositionError as error:
        return Reading(None, tuple(_pointed(item) for item in error.diagnostics))
    document, found = _judge(loaded, context)
    if not found:
        return Reading(document, ())
    return Reading(document, _located(found, text))


def parse(text: str, *, context: Context = _PLAIN) -> Document:
    """One YAML document; raises :class:`CompositionError` (every diagnostic, located) on an error."""
    reading = read(text, context=context)
    if reading.document is None:
        raise CompositionError(reading.diagnostics)
    return reading.document


def read_stored(content: str) -> Document:
    """The canonical bytes of a sealed version, read without the deployment's or the entity's checks.

    Any error is a bug -- the bytes passed the full reading when they were sealed -- and
    raises :class:`StoredContentError`.
    """
    reading = read(content, context=_STORED)
    if reading.document is None:
        raise StoredContentError(reading.diagnostics)
    return reading.document


def compose(source: Any, *, context: Context = _PLAIN) -> Reading:
    """An already-loaded document (a JSON body), judged by the same readers and schema as text.

    There is no text to point into, so the diagnostics carry a path and a pointer and no span.
    """
    problems = unrepresentable(source)
    if problems:
        return Reading(None, problems)
    document, found = _judge(source, context)
    return Reading(document, found)


def _judge(source: Any, context: Context) -> tuple[Document | None, tuple[Diagnostic, ...]]:
    """The readers, the coherence checks and the schema over a loaded document; the diagnostics
    listed, errors first."""
    reader = _Reader()
    document = reader.document(source)
    found = reader.diagnostics()
    if document is not None:
        found += checks.coherence(document, context=context)
    errors = [item for item in found if item.severity == "error"]
    more = False
    if len(errors) <= MAX_LISTED:
        backstop, more = _schema_diagnostics(source)
        taken = [_segments(item) for item in errors]
        found += tuple(item for item in backstop if not _related(_segments(item), taken))
    ordered = CompositionError(found).diagnostics
    if any(item.severity == "error" for item in ordered):
        document = None
    return document, _listing(ordered, more)


def _segments(item: Diagnostic) -> tuple[str, ...]:
    return tuple(Path.from_pointer(item.pointer or ""))


def _related(path: tuple[str, ...], taken: list[tuple[str, ...]]) -> bool:
    """Whether ``path`` is at, above or below one of ``taken``."""
    return any(path[: len(other)] == other or other[: len(path)] == path for other in taken)


def _listing(found: tuple[Diagnostic, ...], more: bool) -> tuple[Diagnostic, ...]:
    if len(found) > MAX_LISTED:
        return listed(found, counted=not more)
    if more:
        return found + (Diagnostic(
            code=codes.MORE, message="more problems were found and are not listed: fix these first",
            path="", severity="info", pointer="",
        ),)
    return found


def _pointed(item: Diagnostic) -> Diagnostic:
    """A diagnostic about the whole document, with the root's pointer."""
    return replace(item, pointer="") if item.pointer is None and item.path == "" else item


def located(found: Iterable[Diagnostic], text: str) -> tuple[Diagnostic, ...]:
    """``found`` with the spans of the elements they name in ``text``, the document they are about.

    For findings made after reading -- against a problem, say -- by the same rule as the reader's
    own: a path the text does not have is underlined at its nearest ancestor that it does have.
    A diagnostic that already has a span keeps it.
    """
    return _located(tuple(found), text)


def _located(found: tuple[Diagnostic, ...], text: str) -> tuple[Diagnostic, ...]:
    """The diagnostics with their spans: one composition of the text for all of them.

    A path the text does not have -- a missing key, a ``from`` without its version -- is
    underlined at its nearest ancestor that it does have; the root always has a span.
    """
    wanted: dict[int, Path] = {}
    for position, item in enumerate(found):
        if item.span is None and item.pointer is not None and item.code != codes.MORE:
            wanted[position] = Path.from_pointer(item.pointer)
    if not wanted:
        return found
    asked = {Path(path[:end]) for path in wanted.values() for end in range(len(path) + 1)}
    placed = spans.locate(text, asked)

    def nearest(path: Path) -> Span | None:
        for end in range(len(path), -1, -1):
            span = placed.get(Path(path[:end]))
            if span is not None:
                return span
        return None

    return tuple(
        replace(item, span=nearest(wanted[position])) if position in wanted else item
        for position, item in enumerate(found)
    )


# --------------------------------------------------------------------------- the section readers

# The order a stage's findings are listed in.
_CONTENT, _UNKNOWN, _MISSING, _TYPE, _SECTION = range(5)

_OPERATORS = ("seq", "and", "xor", "loop")
_MODIFIERS: Mapping[str, tuple[str, ...]] = {"seq": (), "and": (), "xor": ("uniform",), "loop": ("count", "expected")}
_BRANCH_KEYS = ("probability", "flow")
_ENTRY_KEYS = ("candidate", "local", "from")
_FROM_KEYS = ("sphere", "registry", "version", "plan", "addons")
_VALUE_KEYS = ("value", "unit")
_PROBLEM_LINK_KEYS = ("ref", "compilation")
_EVIDENCE_KEYS = ("run", "point", "manual", "evaluatedBy", "toolchain")
_OFFERING_KEYS = ("sphere", "registry", "url")

#: What an unknown key most likely meant, said in its message.
_HINTS: Mapping[str, str] = {
    "presentation": "renderer hints are not part of the document",
    "contentHash": "the content hash is internal to snapshots, and a pinned version names the content",
}


def _what(value: Any) -> str:
    """A value's JSON type, as a message names it."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "a boolean"
    if isinstance(value, (int, float)):
        return "a number"
    if isinstance(value, str):
        return "a string"
    if isinstance(value, list):
        return "a list"
    if isinstance(value, dict):
        return "a mapping"
    return f"a {type(value).__name__}"


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class _Reader:
    """The section readers over one loaded document, collecting what they find."""

    def __init__(self) -> None:
        self._found: list[tuple[int, int, Diagnostic]] = []
        self._nodes: dict[Location, Path] = {}
        self._leaves: dict[str, Path] = {}

    def diagnostics(self) -> tuple[Diagnostic, ...]:
        return tuple(item for _, _, item in sorted(self._found, key=lambda entry: entry[:2]))

    def _report(self, category: int, path: Iterable[str | int], code: str, message: str) -> None:
        self._found.append((category, len(self._found), at(path, code, message)))

    def _unknown(self, path: Path, key: str, allowed: Iterable[str], where: str) -> None:
        hint = _HINTS.get(key)
        message = f"{key!r} is not a key of {where}; its keys are {', '.join(allowed)}"
        self._report(_UNKNOWN, path.child(key), codes.UNKNOWN_KEY, f"{message} ({hint})" if hint else message)

    def _keys(self, value: dict[str, Any], path: Path, allowed: tuple[str, ...], where: str) -> bool:
        clean = True
        for key in value:
            if key not in allowed:
                self._unknown(path, key, allowed, where)
                clean = False
        return clean

    def _type(self, path: Iterable[str | int], expected: str, value: Any) -> None:
        self._report(_TYPE, path, codes.TYPE, f"expected {expected}, found {_what(value)}")

    def _text(self, value: dict[str, Any], key: str, path: Path) -> tuple[str | None, bool]:
        """``value[key]`` when it is a string; ``None`` when absent; reports any other type."""
        if key not in value:
            return None, True
        found = value[key]
        if isinstance(found, str):
            return found, True
        self._type(path.child(key), "a string", found)
        return None, False

    # ------------------------------------------------------------------ the root

    def document(self, source: Any) -> Document | None:
        if not isinstance(source, dict):
            self._report(
                _TYPE, (), codes.TYPE,
                f"a Composition2Yaml document is a mapping of its sections, not {_what(source)}",
            )
            return None
        root = Path()
        for key in source:
            if key in PROBLEM_KEYS:
                self._report(
                    _CONTENT, (key,), codes.PROBLEM_CONTENT,
                    f"{key!r} belongs in the BIM problem: a Composition2Yaml document declares the "
                    "final composition, and the alternatives, constraints and objectives are the problem's",
                )
            elif key not in ROOT_KEYS:
                self._unknown(root, key, ROOT_KEYS, "the document")
        for key in REQUIRED_KEYS:
            if key not in source:
                self._report(_MISSING, (key,), codes.MISSING_KEY, _MISSING_MESSAGES[key])
        parts = {
            "syntaxVersion": self._syntax_version,
            "composition": self._composition,
            "version": self._version,
            "kind": self._kind,
            "problem": self._problem,
            "workflow": self._workflow,
            "values": self._values,
            "offering": self._offering,
            "evidence": self._evidence,
        }
        read: dict[str, Any] = {}
        clean = True
        for key, reader in parts.items():
            if key in source:
                value, ok = reader(source[key])
                read[key] = value
                clean = clean and ok
        workflow = read.get("workflow")
        entries, ok = self._binding(source["binding"]) if "binding" in source else ({}, True)
        clean = clean and ok
        if not clean or self._found or any(key not in source for key in REQUIRED_KEYS):
            return None
        written = tasks(workflow)
        order = {task: position for position, task in enumerate(written)}
        binding = tuple(sorted(
            entries.items(), key=lambda item: (0, order[item[0]]) if item[0] in order else (1, 0)
        ))
        normal, nodes = normal_form(workflow, self._nodes)
        return Document(
            syntax_version=read["syntaxVersion"],
            composition=read["composition"],
            version=read["version"],
            kind=read["kind"],
            problem=read.get("problem"),
            workflow=normal,
            binding=binding,
            values=read["values"],
            offering=read.get("offering"),
            evidence=read.get("evidence"),
            paths=Paths(nodes=nodes, leaves=dict(self._leaves)),
        )

    def _syntax_version(self, value: Any) -> tuple[str | None, bool]:
        path = ("syntaxVersion",)
        if not isinstance(value, str) or not ids.SYNTAX_VERSION.fullmatch(value):
            if _number(value):
                message = (
                    f'syntaxVersion is the string "{SYNTAX_VERSION}", not the number {value!r}: quote it '
                    "so YAML does not read it as a number"
                )
            else:
                found = repr(value) if isinstance(value, str) else _what(value)
                message = f'syntaxVersion is a quoted "<major>.<minor>" string such as "{SYNTAX_VERSION}", not {found}'
            self._report(_SECTION, path, codes.SYNTAX_VERSION_TYPE, message)
            return None, False
        if value not in SUPPORTED_SYNTAX_VERSIONS:
            self._report(
                _SECTION, path, codes.SYNTAX_VERSION_UNSUPPORTED,
                f"syntaxVersion {value!r} is not supported; this reader reads "
                + ", ".join(f'"{version}"' for version in SUPPORTED_SYNTAX_VERSIONS),
            )
            return None, False
        return value, True

    def _composition(self, value: Any) -> tuple[str | None, bool]:
        if not isinstance(value, str):
            self._type(("composition",), "a slug", value)
            return None, False
        if not ids.SLUG.fullmatch(value):
            self._report(
                _SECTION, ("composition",), codes.SLUG_INVALID,
                f"{value!r} is not a slug: lower-case letters, digits and inner hyphens, at most 64 characters",
            )
            return None, False
        return value, True

    def _version(self, value: Any) -> tuple[str | None, bool]:
        path = ("version",)
        if _number(value):
            self._report(
                _SECTION, path, codes.VERSION_NOT_SEMVER,
                f"YAML read the version as the number {value!r}: write the full label "
                f"(such as {value}.0) or quote it",
            )
            return None, False
        if not isinstance(value, str):
            self._type(path, "a semantic version label", value)
            return None, False
        if len(value) > ids.MAX_SEMVER_CHARS or not ids.SEMVER.fullmatch(value):
            self._report(
                _SECTION, path, codes.VERSION_NOT_SEMVER,
                f"{value!r} is not a semantic version label such as 1.3.0 "
                f"(at most {ids.MAX_SEMVER_CHARS} characters)",
            )
            return None, False
        return value, True

    def _kind(self, value: Any) -> tuple[str | None, bool]:
        if not isinstance(value, str):
            self._type(("kind",), "one of " + ", ".join(KINDS), value)
            return None, False
        if value not in KINDS:
            self._report(
                _SECTION, ("kind",), codes.KIND_UNKNOWN,
                f"{value!r} is not a kind; a composition is one of {', '.join(KINDS)}",
            )
            return None, False
        return value, True

    def _problem(self, value: Any) -> tuple[ProblemLink | None, bool]:
        path = Path(("problem",))
        if not isinstance(value, dict):
            self._type(path, "a mapping {ref, compilation}", value)
            return None, False
        clean = self._keys(value, path, _PROBLEM_LINK_KEYS, "problem")
        for key in _PROBLEM_LINK_KEYS:
            if key not in value:
                self._report(_MISSING, path.child(key), codes.MISSING_KEY, f"problem has no {key!r}")
                clean = False
        ref_text, ok = self._text(value, "ref", path)
        clean = clean and ok
        compilation, ok = self._text(value, "compilation", path)
        clean = clean and ok
        ref = None
        if ref_text is not None:
            match = ids.REF.fullmatch(ref_text)
            if match is None:
                self._report(
                    _SECTION, path.child("ref"), codes.PROBLEM_REF,
                    f"{ref_text!r} is not a problem revision: write <organization>/problems/<problem>@<revision>",
                )
                clean = False
            else:
                ref = ProblemRef(**match.groupdict())
        if compilation is not None and not ids.DIGEST.fullmatch(compilation):
            self._report(
                _SECTION, path.child("compilation"), codes.PROBLEM_REF,
                f"{compilation!r} is not a compilation digest: write sha256- and 64 lower-case hex digits",
            )
            clean = False
        if not clean or ref is None or compilation is None:
            return None, False
        return ProblemLink(ref=ref, compilation=compilation), True

    # ------------------------------------------------------------------ the workflow

    def _workflow(self, value: Any) -> tuple[Node | None, bool]:
        node = self._node(value, Path(("workflow",)), ())
        return node, node is not None

    def _node(self, value: Any, path: Path, location: Location) -> Node | None:
        self._nodes[location] = path
        if value is None:
            return EmptyNode()
        if isinstance(value, str):
            if not ids.SYMBOL.fullmatch(value):
                self._report(
                    _SECTION, path, codes.TASK_ID_INVALID,
                    f"{value!r} is not a task id: a letter, then letters, digits, '_', '.' or '-', "
                    "at most 128 characters",
                )
                return None
            self._leaves.setdefault(value, path)
            return TaskNode(value)
        if isinstance(value, dict):
            return self._block(value, path, location)
        message = f"a workflow step is a task id, null, or a mapping with one of seq, and, xor or loop, not {_what(value)}"
        if isinstance(value, list):
            message += " (write a list of steps under seq)"
        elif isinstance(value, bool):
            message += " (YAML reads yes, no, on and off as booleans: quote a task with such a name)"
        self._report(_SECTION, path, codes.WORKFLOW_MALFORMED, message)
        return None

    def _block(self, value: dict[str, Any], path: Path, location: Location) -> Node | None:
        operators = [key for key in value if key in _OPERATORS]
        if len(operators) != 1:
            if operators:
                message = f"a workflow block has exactly one of seq, and, xor or loop; this one has {', '.join(operators)}"
            elif any(key in value for key in _BRANCH_KEYS):
                message = "a branch {probability, flow} is written inside an xor"
            else:
                message = "a workflow block has one of seq, and, xor or loop; this one has none"
            self._report(_SECTION, path, codes.WORKFLOW_MALFORMED, message)
            return None
        operator = operators[0]
        clean = True
        for key in value:
            if key == operator or key in _MODIFIERS[operator]:
                continue
            clean = False
            if key in ("uniform", "count", "expected", *_BRANCH_KEYS):
                owner = {"uniform": "an xor", "count": "a loop", "expected": "a loop"}.get(key, "a branch of an xor")
                self._report(
                    _SECTION, path.child(key), codes.WORKFLOW_MALFORMED,
                    f"{key!r} belongs to {owner}, not to {operator}",
                )
            else:
                self._unknown(path, key, (operator, *_MODIFIERS[operator]), f"a {operator} block")
        body = value[operator]
        if operator in ("seq", "and"):
            children = self._steps(body, path.child(operator), location, operator)
            if children is None or not clean:
                return None
            return Sequence(children) if operator == "seq" else Parallel(children)
        if operator == "xor":
            return self._xor(value, body, path, location, clean)
        return self._loop(value, body, path, location, clean)

    def _list(self, body: Any, path: Path, operator: str, what: str) -> bool:
        if not isinstance(body, list):
            self._report(
                _SECTION, path, codes.WORKFLOW_MALFORMED,
                f"{operator} takes a list of {what}, not {_what(body)}",
            )
            return False
        if not body:
            self._report(_SECTION, path, codes.WORKFLOW_MALFORMED, f"{operator} needs at least one of its {what}")
            return False
        return True

    def _steps(self, body: Any, path: Path, location: Location, operator: str) -> tuple[Node, ...] | None:
        if not self._list(body, path, operator, "steps" if operator == "seq" else "branches"):
            return None
        children = [
            self._node(item, path.child(position), (*location, position))
            for position, item in enumerate(body)
        ]
        if any(child is None for child in children):
            return None
        return tuple(children)  # type: ignore[arg-type]

    def _xor(self, value: dict[str, Any], body: Any, path: Path, location: Location, clean: bool) -> Node | None:
        uniform = value.get("uniform", False)
        if not isinstance(uniform, bool):
            self._type(path.child("uniform"), "true", uniform)
            clean = False
        if not self._list(body, path.child("xor"), "xor", "branches"):
            return None
        branches: list[Branch] = []
        for position, item in enumerate(body):
            branch = self._branch(item, path.child("xor", position), (*location, position))
            if branch is None:
                clean = False
            else:
                branches.append(branch)
        if not clean:
            return None
        return Exclusive(branches=tuple(branches), uniform=uniform)

    def _branch(self, item: Any, path: Path, location: Location) -> Branch | None:
        weighted = (
            isinstance(item, dict)
            and any(key in item for key in _BRANCH_KEYS)
            and not any(key in item for key in _OPERATORS)
        )
        if not weighted:
            flow = self._node(item, path, location)
            return None if flow is None else Branch(flow=flow)
        clean = self._keys(item, path, _BRANCH_KEYS, "a branch")
        flow: Node | None = None
        if "flow" not in item:
            self._nodes[location] = path
            self._report(
                _SECTION, path, codes.WORKFLOW_MALFORMED,
                "a branch {probability, flow} needs its flow",
            )
            clean = False
        else:
            flow = self._node(item["flow"], path.child("flow"), location)
        probability = item.get("probability")
        if "probability" not in item:
            self._report(
                _SECTION, path, codes.WORKFLOW_MALFORMED,
                "a branch written as a mapping states its probability; write the flow alone for a "
                "branch without one",
            )
            clean = False
        elif not _number(probability):
            self._type(path.child("probability"), "a number between 0 and 1", probability)
            clean = False
        elif not 0 <= probability <= 1:
            self._report(
                _SECTION, path.child("probability"), codes.WORKFLOW_MALFORMED,
                f"a probability is between 0 and 1, not {probability!r}",
            )
            clean = False
        if not clean or flow is None:
            return None
        return Branch(flow=flow, probability=probability)

    def _loop(self, value: dict[str, Any], body: Any, path: Path, location: Location, clean: bool) -> Node | None:
        inner = self._node(body, path.child("loop"), (*location, 0))
        count = value.get("count")
        expected = value.get("expected")
        if "count" in value:
            if not isinstance(count, int) or isinstance(count, bool):
                self._type(path.child("count"), "a whole number of iterations", count)
                clean = False
            elif count < 0:
                self._report(
                    _SECTION, path.child("count"), codes.WORKFLOW_MALFORMED,
                    f"a loop runs zero or more times, not {count!r}",
                )
                clean = False
        if "expected" in value:
            if not _number(expected):
                self._type(path.child("expected"), "an expected number of iterations", expected)
                clean = False
            elif expected < 0:
                self._report(
                    _SECTION, path.child("expected"), codes.WORKFLOW_MALFORMED,
                    f"a loop runs zero or more times on average, not {expected!r}",
                )
                clean = False
        if "count" in value and "expected" in value:
            self._report(
                _SECTION, path, codes.WORKFLOW_MALFORMED,
                "a loop states its count or its expected iterations, not both",
            )
            clean = False
        if inner is None or not clean:
            return None
        return Repeat(body=inner, count=count, expected=expected)

    # ------------------------------------------------------------------ binding and values

    def _binding(self, value: Any) -> tuple[dict[str, Entry], bool]:
        path = Path(("binding",))
        if not isinstance(value, dict):
            self._type(path, "a mapping of tasks to their candidates", value)
            return {}, False
        entries: dict[str, Entry] = {}
        clean = True
        for task, body in value.items():
            where = path.child(task)
            if not ids.SYMBOL.fullmatch(task):
                self._report(
                    _SECTION, where, codes.TASK_ID_INVALID,
                    f"{task!r} is not a task id: a letter, then letters, digits, '_', '.' or '-', "
                    "at most 128 characters",
                )
                clean = False
            entry = self._entry(body, where)
            if entry is None:
                clean = False
            else:
                entries[task] = entry
        return entries, clean

    def _entry(self, value: Any, path: Path) -> Entry | None:
        if not isinstance(value, dict):
            self._type(path, "a mapping {candidate: <id>} or {local: true}", value)
            return None
        clean = True
        for key in value:
            if key in ENTRY_PROBLEM_KEYS:
                self._report(
                    _CONTENT, path.child(key), codes.PROBLEM_CONTENT,
                    f"{key!r} belongs in the BIM problem: a binding names the one candidate chosen",
                )
                clean = False
            elif key not in _ENTRY_KEYS:
                self._unknown(path, key, _ENTRY_KEYS, "a binding entry")
                clean = False
        candidate, ok = self._text(value, "candidate", path)
        clean = clean and ok
        if candidate is not None and not ids.CANDIDATE.fullmatch(candidate):
            self._report(
                _SECTION, path.child("candidate"), codes.CANDIDATE_REF_INVALID,
                f"{candidate!r} is not a candidate: write its id, or <resource>/<id> when two "
                "catalogs give the task the same id",
            )
            clean = False
        local = value.get("local", False)
        if not isinstance(local, bool):
            self._type(path.child("local"), "true", local)
            clean = False
        elif "local" in value and not local:
            self._report(
                _SECTION, path.child("local"), codes.BINDING_ENTRY,
                "local is only ever true: leave it out when a candidate is bound",
            )
            clean = False
        source = None
        if "from" in value:
            source = self._provenance(value["from"], path.child("from"))
            clean = clean and source is not None
        if not clean:
            return None
        return Entry(candidate=candidate, local=local, source=source)

    def _provenance(self, value: Any, path: Path) -> Provenance | None:
        if not isinstance(value, dict):
            self._type(path, "a mapping {sphere, version, plan}", value)
            return None
        clean = self._keys(value, path, _FROM_KEYS, "from")
        texts: dict[str, str | None] = {}
        for key in ("sphere", "registry", "version", "plan"):
            texts[key], ok = self._text(value, key, path)
            clean = clean and ok
        addons = value.get("addons", [])
        if not isinstance(addons, list):
            self._type(path.child("addons"), "a list of add-on names", addons)
            clean = False
            addons = []
        for position, addon in enumerate(addons):
            if not isinstance(addon, str):
                self._type(path.child("addons", position), "an add-on name", addon)
                clean = False
        if not clean:
            return None
        return Provenance(
            sphere=texts["sphere"], version=texts["version"], plan=texts["plan"],
            registry=texts["registry"], addons=tuple(addons),
        )

    def _values(self, value: Any) -> tuple[tuple[tuple[str, Value], ...] | None, bool]:
        path = Path(("values",))
        if not isinstance(value, dict):
            self._type(path, "a mapping of properties to their values", value)
            return None, False
        found: dict[str, Value] = {}
        clean = True
        for name, body in value.items():
            where = path.child(name)
            if not ids.SYMBOL.fullmatch(name):
                self._report(
                    _SECTION, where, codes.PROPERTY_ID_INVALID,
                    f"{name!r} is not a property id: a letter, then letters, digits, '_', '.' or '-', "
                    "at most 128 characters",
                )
                clean = False
            item = self._value(body, where)
            if item is None:
                clean = False
            else:
                found[name] = item
        if not clean:
            return None, False
        return tuple(sorted(found.items(), key=lambda entry: entry[0])), True

    def _value(self, value: Any, path: Path) -> Value | None:
        # A boolean is a number to Python; whether a value may be one is a coherence rule.
        if isinstance(value, (int, float)):
            return Value(value=value)
        if not isinstance(value, dict):
            self._type(path, "a number or a mapping {value, unit}", value)
            return None
        clean = self._keys(value, path, _VALUE_KEYS, "a value")
        for key in _VALUE_KEYS:
            if key not in value:
                self._report(_MISSING, path.child(key), codes.MISSING_KEY, f"a value written as a mapping has its {key!r}")
                clean = False
        number = value.get("value")
        if "value" in value and not isinstance(number, (int, float)):
            self._type(path.child("value"), "a number", number)
            clean = False
        unit, ok = self._text(value, "unit", path)
        clean = clean and ok
        if not clean or unit is None:
            return None
        return Value(value=number, unit=unit)

    # ------------------------------------------------------------------ offering and evidence

    def _offering(self, value: Any) -> tuple[Offering | None, bool]:
        """The offering's keys and their types, all ``c2y_offering_shape``.

        Its other rules -- exactly one source, a pricing or an HTTPS URL, a configured
        registry -- are the coherence checks'. These two need the mapping as written, which
        the document does not keep.
        """
        path = Path(("offering",))
        if not isinstance(value, dict):
            self._report(
                _TYPE, path, codes.OFFERING_SHAPE,
                "an offering is a mapping {sphere: <owner>/<name>} or {url: https://...}, "
                f"not {_what(value)}",
            )
            return None, False
        clean = True
        for key, item in value.items():
            if key in _OFFERING_KEYS:
                if not isinstance(item, str):
                    self._report(
                        _TYPE, path.child(key), codes.OFFERING_SHAPE,
                        f"the offering's {key} is a string, not {_what(item)}",
                    )
                    clean = False
                continue
            clean = False
            if key == "version":
                message = (
                    "the offering has no version in the document; the version used is stored with "
                    "each evaluation"
                )
            elif key in OFFERING_CONTENT_KEYS:
                message = f"{key!r}: the offering's plans, prices and limits live outside the document"
            else:
                message = f"{key!r} is not a key of an offering; its keys are {', '.join(_OFFERING_KEYS)}"
            self._report(_UNKNOWN, path.child(key), codes.OFFERING_SHAPE, message)
        if not clean:
            return None, False
        return Offering(sphere=value.get("sphere"), registry=value.get("registry"), url=value.get("url")), True

    def _evidence(self, value: Any) -> tuple[Evidence | None, bool]:
        path = Path(("evidence",))
        if not isinstance(value, dict):
            self._type(path, "a mapping {run, point, manual, evaluatedBy, toolchain}", value)
            return None, False
        clean = self._keys(value, path, _EVIDENCE_KEYS, "evidence")
        run, ok = self._text(value, "run", path)
        clean = clean and ok
        evaluated_by, ok = self._text(value, "evaluatedBy", path)
        clean = clean and ok
        toolchain, ok = self._text(value, "toolchain", path)
        clean = clean and ok
        point = value.get("point")
        if "point" in value and (not isinstance(point, int) or isinstance(point, bool)):
            self._type(path.child("point"), "a solution index", point)
            clean = False
        manual = value.get("manual", False)
        if not isinstance(manual, bool):
            self._type(path.child("manual"), "true", manual)
            clean = False
        if not clean:
            return None, False
        return Evidence(
            run=run, point=point, manual=manual,
            evaluated_by=evaluated_by,  # type: ignore[arg-type]
            toolchain=toolchain,
        ), True


_MISSING_MESSAGES: Mapping[str, str] = {
    "syntaxVersion": f'the document has no syntaxVersion: start it with syntaxVersion: "{SYNTAX_VERSION}"',
    "composition": "the document has no composition: name it with its slug",
    "version": "the document has no version: label it with a semantic version such as 1.0.0",
    "kind": "the document has no kind: one of " + ", ".join(KINDS),
    "workflow": "the document has no workflow",
    "binding": "the document has no binding: write binding: {} when the workflow has no task",
    "values": "the document has no values: write values: {} when it declares none",
}


# --------------------------------------------------------------------------- what JSON cannot hold


def unrepresentable(source: object) -> tuple[Diagnostic, ...]:
    """Every value of an already-loaded document that JSON cannot hold, by path, as ``c2y_syntax``.

    The YAML loader refuses all of these as ``c2y_syntax``; a document that never was YAML --
    a request body whose JSON reader accepts ``NaN`` -- reaches :func:`compose` without that
    guard, so it is refused here with the same code: a type JSON has no value for, a key that
    is not a string, a number that is not finite, an integer past +-(2^53 - 1), a string with
    a lone surrogate, and nesting past :data:`.syntax.MAX_DEPTH`.

    Walked with a stack rather than by recursion, because one of the things it refuses is a
    document nested deeply enough to exhaust the stack of anything that recurses. Each node
    keeps only a link to its parent, and a path is written out only for a node that is
    reported: building one per node cost a long key's length times the size of the list
    under it.
    """
    found: list[Diagnostic] = []
    steps: list[tuple[int, str | int | None]] = [(-1, None)]
    stack: list[tuple[object, int, int]] = [(source, 0, 1)]
    total = 0

    def report(index: int, message: str) -> None:
        nonlocal total
        total += 1
        if len(found) < MAX_LISTED:
            found.append(at(_steps_path(steps, index), codes.SYNTAX, message))

    while stack:
        value, index, depth = stack.pop()
        if depth > syntax.MAX_DEPTH:
            report(index, f"the document nests deeper than {syntax.MAX_DEPTH} levels")
            continue
        if isinstance(value, dict):
            for key, item in reversed(list(value.items())):
                if not isinstance(key, str):
                    report(index, f"a key of type {type(key).__name__} is not a string")
                    continue
                if not _is_text(key):
                    report(index, "a key is not valid Unicode text")
                    continue
                steps.append((index, key))
                stack.append((item, len(steps) - 1, depth + 1))
        elif isinstance(value, list):
            for position in reversed(range(len(value))):
                steps.append((index, position))
                stack.append((value[position], len(steps) - 1, depth + 1))
        elif isinstance(value, bool) or value is None:
            continue
        elif isinstance(value, int):
            if abs(value) > syntax.MAX_SAFE_INTEGER:
                report(index, "an integer past +-(2^53 - 1): JSON readers lose its digits and the container refuses it")
        elif isinstance(value, float):
            if not math.isfinite(value):
                report(index, f"{value} is not a finite number: JSON cannot hold it and the container refuses it")
        elif isinstance(value, str):
            if not _is_text(value):
                report(index, "the string is not valid Unicode text")
        else:
            report(index, f"a {type(value).__name__} is not a value JSON can hold")
    return listed(found, total)


def _steps_path(steps: list[tuple[int, str | int | None]], index: int) -> Path:
    """The path of one node, from its chain of parent links."""
    parts: list[str | int] = []
    while index > 0:
        index, step = steps[index]
        parts.append(step)  # type: ignore[arg-type]
    return Path(reversed(parts))


def _is_text(value: str) -> bool:
    """Whether a string is text a UTF-8 encoder can write: no lone surrogates."""
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


# --------------------------------------------------------------------------- writing


def _drop(mapping: dict[str, Any]) -> dict[str, Any]:
    """The members whose value is not ``None``: an absent part is omitted."""
    return {key: value for key, value in mapping.items() if value is not None}


def canonical_binding(workflow: Node, binding: Iterable[tuple[str, Entry]]) -> tuple[tuple[str, Entry], ...]:
    """``binding`` in the order a depth-first walk of ``workflow`` first meets each task.

    Entries for tasks the workflow does not have (a coherence error) follow, in their order.
    """
    order = {task: position for position, task in enumerate(tasks(workflow))}
    return tuple(sorted(binding, key=lambda item: (0, order[item[0]]) if item[0] in order else (1, 0)))


def document(doc: Document) -> dict[str, Any]:
    """The canonical form of a document, JSON-native: ``dict``, ``list``, ``str``, numbers, ``bool``, ``None``."""
    written: dict[str, Any] = {
        "syntaxVersion": doc.syntax_version,
        "composition": doc.composition,
        "version": doc.version,
        "kind": doc.kind,
    }
    if doc.problem is not None:
        written["problem"] = {"ref": str(doc.problem.ref), "compilation": doc.problem.compilation}
    written["workflow"] = _node_text(doc.workflow)
    written["binding"] = {
        task: _entry_text(entry) for task, entry in canonical_binding(doc.workflow, doc.binding)
    }
    written["values"] = {
        name: value.value if value.unit == DIMENSIONLESS else {"value": value.value, "unit": value.unit}
        for name, value in sorted(doc.values, key=lambda item: item[0])
    }
    if doc.offering is not None:
        written["offering"] = _drop({
            "sphere": doc.offering.sphere, "registry": doc.offering.registry, "url": doc.offering.url,
        })
    if doc.evidence is not None:
        evidence = doc.evidence
        written["evidence"] = _drop({
            "run": evidence.run,
            "point": evidence.point,
            "manual": True if evidence.manual else None,
            "evaluatedBy": evidence.evaluated_by,
            "toolchain": evidence.toolchain,
        })
    return written


def _node_text(node: Node) -> Any:
    if isinstance(node, TaskNode):
        return node.task
    if isinstance(node, EmptyNode):
        return None
    if isinstance(node, Sequence):
        return {"seq": [_node_text(child) for child in node.children]}
    if isinstance(node, Parallel):
        return {"and": [_node_text(child) for child in node.children]}
    if isinstance(node, Exclusive):
        written: dict[str, Any] = {"xor": [
            _node_text(branch.flow) if branch.probability is None
            else {"probability": branch.probability, "flow": _node_text(branch.flow)}
            for branch in node.branches
        ]}
        if node.uniform:
            written["uniform"] = True
        return written
    if isinstance(node, Repeat):
        written = {"loop": _node_text(node.body)}
        if node.count is not None:
            written["count"] = node.count
        if node.expected is not None:
            written["expected"] = node.expected
        return written
    raise TypeError(f"not a workflow node: {node!r}")


def _entry_text(entry: Entry) -> dict[str, Any]:
    source = entry.source
    return _drop({
        "candidate": entry.candidate,
        "local": True if entry.local else None,
        "from": None if source is None else _drop({
            "sphere": source.sphere,
            "registry": source.registry,
            "version": source.version,
            "plan": source.plan,
            "addons": list(source.addons) if source.addons else None,
        }),
    })


def serialise(doc: Document) -> str:
    """The canonical bytes of a document, as text; ``c2y_too_long`` past :data:`MAX_SOURCE_BYTES` UTF-8 bytes."""
    try:
        return syntax.dump(document(doc), limit=MAX_SOURCE_BYTES)
    except syntax.TooLong:
        raise CompositionError((at(
            (), codes.TOO_LONG,
            f"the canonical text of this document is longer than the {MAX_SOURCE_BYTES} bytes a document may be",
        ),)) from None


# --------------------------------------------------------------------------- the schema

_RESOURCES = FilePath(__file__).resolve().parent / "resources" / "composition2yaml"


def _schema_file(syntax_version: str) -> FilePath:
    if syntax_version not in SUPPORTED_SYNTAX_VERSIONS:
        raise ValueError(
            f"syntaxVersion {syntax_version!r} is not supported; supported: {', '.join(SUPPORTED_SYNTAX_VERSIONS)}"
        )
    return _RESOURCES / syntax_version / "composition.schema.json"


@lru_cache(maxsize=None)
def schema_text(syntax_version: str = SYNTAX_VERSION) -> str:
    """The JSON Schema of a syntax version, as the bytes it ships in (``GET /v1/compositions/schema``)."""
    return _schema_file(syntax_version).read_text(encoding="utf-8")


def schema(syntax_version: str = SYNTAX_VERSION) -> dict[str, Any]:
    """The JSON Schema of a syntax version, as it ships: a fresh copy on each call."""
    return json.loads(schema_text(syntax_version))


@lru_cache(maxsize=None)
def _validator(syntax_version: str = SYNTAX_VERSION) -> Draft202012Validator:
    """The schema's validator, built once: the schema does not change while a process runs."""
    return Draft202012Validator(schema(syntax_version))


def _schema_diagnostics(source: object) -> tuple[tuple[Diagnostic, ...], bool]:
    """The schema's findings, at most :data:`MAX_LISTED`, sorted by path; and whether there were more.

    The errors are taken as the validator finds them, one more than are listed, so a document
    wrong in every one of twenty thousand rules is not validated to the end only to list a
    hundred; the message is clipped because it quotes the value at fault.
    """
    errors = list(islice(_validator().iter_errors(source), MAX_LISTED + 1))
    shown = sorted(
        errors[:MAX_LISTED],
        key=lambda error: [(0, step) if isinstance(step, int) else (1, step) for step in error.absolute_path],
    )
    found = tuple(at(Path(error.absolute_path), codes.SCHEMA, clipped(error.message)) for error in shown)
    return found, len(errors) > MAX_LISTED

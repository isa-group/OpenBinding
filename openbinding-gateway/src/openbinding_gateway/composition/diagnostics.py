"""Diagnostics for Composition2Yaml, located in the source text.

The container's compiler reports against a resource and a JSON Pointer, which is the
right address for a generated document and the wrong one for a person editing YAML. A
diagnostic here therefore carries the span of the element at fault in the source, so the
editor can underline it, a code prefixed ``c2y_`` so it is never confused with a container
code, and a severity: errors refuse the document, warnings and infos only inform.

Every diagnostic is addressed by a :class:`Path`, a tuple of key and index segments. The
dotted form (``binding.t1.from.version``, ``workflow.seq[1].and[0]``) is what a person
reads; the JSON Pointer (RFC 6901) is what a program follows. Both are built from the same
segments by :func:`at`, so they never disagree. The dotted form alone is ambiguous, since a
task id may contain a dot; the pointer is not.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Iterable, Literal

#: The text is not YAML at all, or is YAML that JSON cannot hold (an alias, a duplicate key,
#: a key that is not a string, a number that is not finite -- see ``syntax``). The most
#: common error while typing, and PyYAML reports where it found the problem, so it is located
#: like every other diagnostic.
SYNTAX = "c2y_syntax"
#: The JSON Schema backstop refused the document.
SCHEMA = "c2y_schema"
#: More problems were found than a refusal lists; the first ones are listed.
MORE = "c2y_more"
#: The source, or the canonical text written from a document, is longer than a document may be.
TOO_LONG = "c2y_too_long"
#: A value of the wrong JSON type: a list where a mapping goes, a number where text goes.
TYPE = "c2y_type"
#: A key the language does not have.
UNKNOWN_KEY = "c2y_unknown_key"
#: A required key is absent; the diagnostic's path is the key's.
MISSING_KEY = "c2y_missing_key"
#: ``syntaxVersion`` is not a quoted ``<major>.<minor>`` string.
SYNTAX_VERSION_TYPE = "c2y_syntax_version_type"
#: ``syntaxVersion`` names a version this reader does not support.
SYNTAX_VERSION_UNSUPPORTED = "c2y_syntax_version_unsupported"
#: ``composition`` is not a slug.
SLUG_INVALID = "c2y_slug_invalid"
#: ``version`` is not a Semantic Versioning label.
VERSION_NOT_SEMVER = "c2y_version_not_semver"
#: ``kind`` is not one of the four kinds.
KIND_UNKNOWN = "c2y_kind_unknown"
#: Content that belongs in the BIM problem: candidates, constraints, objectives, tasks...
PROBLEM_CONTENT = "c2y_problem_content"
#: ``problem.ref`` or ``problem.compilation`` is malformed.
PROBLEM_REF = "c2y_problem_ref"
#: A workflow node that is not a task, ``null`` or one well-formed block.
WORKFLOW_MALFORMED = "c2y_workflow_malformed"
#: A task id that is not one the container accepts.
TASK_ID_INVALID = "c2y_task_id_invalid"
#: A property id that is not one the container accepts.
PROPERTY_ID_INVALID = "c2y_property_id_invalid"
#: A binding's candidate that is neither an id nor ``<resource>/<id>``.
CANDIDATE_REF_INVALID = "c2y_candidate_ref_invalid"
#: A task of the workflow has no binding entry.
TASK_UNBOUND = "c2y_task_unbound"
#: A binding entry names a task the workflow does not have.
BINDING_UNKNOWN_TASK = "c2y_binding_unknown_task"
#: A binding entry that is not exactly one of a candidate or ``local: true``, or a ``from``
#: beside ``local: true``.
BINDING_ENTRY = "c2y_binding_entry"
#: Some branches of an ``xor`` state a probability and some do not, or ``uniform: true`` is
#: written beside stated probabilities.
XOR_PROBABILITIES = "c2y_xor_probabilities"
#: The stated probabilities of an ``xor`` do not add up to exactly 1.
XOR_SUM = "c2y_xor_sum"
#: A ``from`` without the version it pins.
FROM_VERSION_MISSING = "c2y_from_version_missing"
#: A ``from`` without its ``sphere`` or its ``plan``.
FROM_INCOMPLETE = "c2y_from_incomplete"
#: A ``from`` field that is not well formed, or an add-on listed twice.
FROM_SHAPE = "c2y_from_shape"
#: A ``from`` on a registry the deployment does not define.
FROM_REGISTRY_UNKNOWN = "c2y_from_registry_unknown"
#: An offering with no source, or with more than one.
OFFERING_SOURCES = "c2y_offering_sources"
#: An offering that is not a well-formed reference: a key, a type or a value it may not have.
OFFERING_SHAPE = "c2y_offering_shape"
#: An offering URL that is not an absolute ``https://`` URL.
OFFERING_URL_NOT_HTTPS = "c2y_offering_url_not_https"
#: An offering on a registry the deployment does not define; a warning.
OFFERING_REGISTRY_UNKNOWN = "c2y_offering_registry_unknown"
#: A value that is a boolean, or a unit that is empty.
VALUE_SHAPE = "c2y_value_shape"
#: Evidence that does not hold together: a run and ``manual``, a point without a run, a run
#: that is not a UUID, an unknown ``evaluatedBy``.
EVIDENCE_SHAPE = "c2y_evidence_shape"
#: ``evaluatedBy: gateway`` on a composition linked to no problem.
EVIDENCE_GATEWAY_WITHOUT_PROBLEM = "c2y_evidence_gateway_without_problem"
#: A run on a composition linked to no problem.
EVIDENCE_RUN_WITHOUT_PROBLEM = "c2y_evidence_run_without_problem"
#: The document's slug is not the slug of the composition it is submitted to; an info.
SLUG_MISMATCH = "c2y_slug_mismatch"

# Against a compiled problem (``problem``). The workflow, property, unit and untranslatable
# candidate findings are errors whatever the toolchain says; ``c2y_candidate_not_allowed`` and
# ``c2y_task_local_mismatch`` explain the toolchain's refusal of a binding, and are reported only
# when it refuses.

#: The workflow is not the problem's.
WORKFLOW_MISMATCH = "c2y_workflow_mismatch"
#: ``local: true`` on a service task of the problem, or a candidate on a task done in house.
TASK_LOCAL_MISMATCH = "c2y_task_local_mismatch"
#: No catalog of the problem holds the candidate.
CANDIDATE_UNKNOWN = "c2y_candidate_unknown"
#: The candidate exists, but the task may not take it.
CANDIDATE_NOT_ALLOWED = "c2y_candidate_not_allowed"
#: Two catalogs give the task the same candidate id: write ``<resource>/<id>``.
CANDIDATE_AMBIGUOUS = "c2y_candidate_ambiguous"
#: A value of a property the problem does not have.
PROPERTY_UNKNOWN = "c2y_property_unknown"
#: A bare number for a property the problem measures in a unit.
UNIT_MISSING = "c2y_unit_missing"
#: A unit that is not the problem's.
UNIT_MISMATCH = "c2y_unit_mismatch"
#: A declared value that is not the one the toolchain computes; a warning, the computed one is kept.
VALUE_DIFFERS = "c2y_value_differs"
#: A declared value of a property the toolchain does not compute; a warning, the value is dropped.
VALUE_NOT_COMPUTED = "c2y_value_not_computed"
#: The binding violates a hard constraint of the problem.
CONSTRAINT_VIOLATED = "c2y_constraint_violated"
#: The binding does not meet a soft constraint of the problem; a warning, with its penalty.
CONSTRAINT_SOFT = "c2y_constraint_soft"

Severity = Literal["error", "warning", "info"]

#: The order diagnostics are listed in: what refuses the document first.
SEVERITIES: tuple[Severity, ...] = ("error", "warning", "info")

#: How many diagnostics one refusal lists. A document can be wrong in as many places as it
#: has elements, and an editor needs the first ones, not a response as long as the document.
MAX_LISTED = 100

#: How long a message may be. The schema's messages quote the value at fault, and a value
#: can be as long as the document.
MAX_MESSAGE_CHARS = 300


def clipped(message: str) -> str:
    """A message no longer than :data:`MAX_MESSAGE_CHARS`."""
    return message if len(message) <= MAX_MESSAGE_CHARS else message[: MAX_MESSAGE_CHARS - 1] + "…"


def listed(
    found: list["Diagnostic"] | tuple["Diagnostic", ...],
    total: int | None = None,
    *,
    counted: bool = True,
) -> tuple["Diagnostic", ...]:
    """At most :data:`MAX_LISTED` diagnostics, and one saying there were more.

    ``counted`` is false when the search stopped at the first one past the list -- the
    schema's does, so as not to validate a document to the end only to list a hundred -- and
    then the note says there were more without pretending to know how many.
    """
    if found and found[-1].code == MORE and len(found) <= MAX_LISTED + 1:
        return tuple(found)  # already listed
    total = len(found) if total is None else total
    if total <= MAX_LISTED:
        return tuple(found)
    message = (
        f"{total - MAX_LISTED} more problems were found and are not listed"
        if counted
        else "more problems were found and are not listed: fix these first"
    )
    return tuple(found[:MAX_LISTED]) + (Diagnostic(code=MORE, message=message, path="", severity="info", pointer=""),)


class Path(tuple):
    """Where an element sits in a document: its key and index segments from the root.

    A ``str`` segment is a mapping key and an ``int`` one a sequence index. The empty path
    is the document itself.
    """

    __slots__ = ()

    def __new__(cls, segments: Iterable[str | int] = ()) -> "Path":
        return super().__new__(cls, segments)

    def __add__(self, other: Iterable[str | int]) -> "Path":  # type: ignore[override]
        return Path((*self, *other))

    def child(self, *segments: str | int) -> "Path":
        """This path extended by ``segments``."""
        return Path((*self, *segments))

    @property
    def dotted(self) -> str:
        """The path as a person reads it: ``binding.t1.from``, ``workflow.seq[1].and[0]``."""
        text = ""
        for segment in self:
            if isinstance(segment, int):
                text += f"[{segment}]"
            else:
                text = f"{text}.{segment}" if text else segment
        return text

    @property
    def pointer(self) -> str:
        """The path as an RFC 6901 JSON Pointer: ``/binding/t1/from``, ``/workflow/seq/1``."""
        return "".join(
            "/" + str(segment).replace("~", "~0").replace("/", "~1") for segment in self
        )

    @classmethod
    def from_pointer(cls, pointer: str) -> "Path":
        """The segments of an RFC 6901 pointer. Every segment is a ``str``: whether ``"0"`` is
        a key or an index depends on the document it is followed in, and the span locator
        decides by the node it reaches."""
        if not pointer:
            return cls()
        if not pointer.startswith("/"):
            raise ValueError(f"a JSON Pointer starts with '/': {pointer!r}")
        return cls(part.replace("~1", "/").replace("~0", "~") for part in pointer[1:].split("/"))

    def __repr__(self) -> str:
        return f"Path({tuple(self)!r})"


@dataclass(frozen=True, slots=True)
class Span:
    """A half-open region of the source document, one-based lines and columns."""

    line: int
    column: int
    end_line: int
    end_column: int


@dataclass(frozen=True, slots=True)
class Diagnostic:
    """One finding, addressed to the author rather than to the compiler."""

    code: str
    message: str
    #: Dotted path of the element at fault, e.g. ``binding.t1.candidate``.
    path: str
    span: Span | None = None
    severity: Severity = "error"
    #: The same path as an RFC 6901 JSON Pointer, unambiguous where the dotted path is not.
    pointer: str | None = None

    def __str__(self) -> str:
        where = f"{self.span.line}:{self.span.column}" if self.span else self.path
        return f"{where}: {self.severity} {self.code}: {self.message}"


def at(
    path: Iterable[str | int],
    code: str,
    message: str,
    *,
    severity: Severity = "error",
) -> Diagnostic:
    """A diagnostic about the element at ``path``, its dotted path and pointer from the same segments."""
    where = path if isinstance(path, Path) else Path(path)
    return Diagnostic(
        code=code,
        message=clipped(message),
        path=where.dotted,
        severity=severity,
        pointer=where.pointer,
    )


def _rank(item: Diagnostic) -> tuple[bool, int]:
    # The "more were found" note stays last whatever its severity: it is about the list.
    return (item.code == MORE, SEVERITIES.index(item.severity))


class CompositionError(Exception):
    """A document with at least one error; carries every diagnostic found, errors first."""

    def __init__(self, diagnostics: Iterable[Diagnostic]) -> None:
        self.diagnostics: tuple[Diagnostic, ...] = tuple(sorted(diagnostics, key=_rank))
        super().__init__("; ".join(str(d) for d in self.diagnostics))

    @property
    def errors(self) -> tuple[Diagnostic, ...]:
        """The diagnostics that refuse the document."""
        return tuple(item for item in self.diagnostics if item.severity == "error")

    def located(self, spans: dict[str, Span]) -> "CompositionError":
        """The same diagnostics with their spans filled in from the source.

        The refusals are raised deep in the readers, which hold a value and not the text.
        ``parse`` holds the text, so it catches and re-raises through this: one place
        attaches positions, and the readers stay functions of their input.
        """
        return CompositionError(tuple(
            item if item.span is not None else replace(item, span=spans.get(item.path))
            for item in self.diagnostics
        ))

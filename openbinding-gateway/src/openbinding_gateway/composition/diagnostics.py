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
    return tuple(found[:MAX_LISTED]) + (Diagnostic(code=MORE, message=message, path=""),)


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

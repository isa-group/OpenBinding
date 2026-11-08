"""Authoring diagnostics for Composition2Yaml, located in the source text.

The container's compiler reports against a resource and a JSON Pointer, which is the
right address for a generated document and the wrong one for a person editing YAML. A
Studio diagnostic therefore carries the span of the element at fault in the source, so
the editor can underline it, and a code prefixed ``c2y_`` so it is never confused with a
container code.

Compilation is all-or-nothing, as it is in the container: a document with any error
produces no package. Refusing at this layer is the point — most of these codes exist to
catch, at authoring time, something that would otherwise compile into a package that
fails later and further away.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

#: The text is not YAML at all, or is YAML that JSON cannot hold (an alias, a duplicate key,
#: a key that is not a string, a number that is not finite -- see ``syntax``). The most
#: common error while typing, and PyYAML reports where it found the problem, so it is located
#: like every other diagnostic.
SYNTAX = "c2y_syntax"
#: A property whose neutral cannot be resolved: a ``min``/``max`` aggregation with no domain
#: bound on the side it needs and no declared neutral (incomplete), or a neutral, declared or
#: inferred, outside the domain -- a ratio's being [0, 1] (an error). The container emits
#: ``feature_neutral`` and ``feature_neutral_domain`` for the two; this names the property.
PROPERTY_NEUTRAL = "c2y_property_neutral"
PROPERTY_TEMPLATE = "c2y_property_template"
SCHEMA = "c2y_schema"
TASK_KIND = "c2y_task_kind"
TASK_UNKNOWN = "c2y_task_unknown"
TASK_UNREACHED = "c2y_task_unreached"
#: An exclusive with probabilities needs an author-given id: its branch ids are visible
#: in the IR digest, so an invented one would be both unstable and digest-visible.
EXCLUSIVE_ID = "c2y_exclusive_id"
EXCLUSIVE_PROBABILITIES = "c2y_exclusive_probabilities"
#: ``distribution`` and inline probabilities say the same thing two ways.
EXCLUSIVE_DISTRIBUTION = "c2y_exclusive_distribution"
REPEAT_COUNT = "c2y_repeat_count"
CANDIDATE_PROPERTY = "c2y_candidate_property"
CANDIDATE_UNMATCHED = "c2y_candidate_unmatched"
#: More problems were found than a refusal lists; the first ones are listed.
MORE = "c2y_more"
GOAL_UNKNOWN = "c2y_goal_unknown"
#: A goal with no ``normalize`` range over a property whose domain has an open end: the
#: criterion would have nothing to normalize over.
GOAL_RANGE = "c2y_goal_range"
RULE_EXPRESSION = "c2y_rule_expression"


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


@dataclass(frozen=True, slots=True)
class Span:
    """A half-open region of the source document, one-based lines and columns."""

    line: int
    column: int
    end_line: int
    end_column: int


@dataclass(frozen=True, slots=True)
class Diagnostic:
    """One refusal, addressed to the author rather than to the compiler."""

    code: str
    message: str
    #: Dotted path of the offending element, e.g. ``properties.throughput``.
    path: str
    span: Span | None = None

    def __str__(self) -> str:
        where = f"{self.span.line}:{self.span.column}" if self.span else self.path
        return f"{where}: {self.code}: {self.message}"


class TextError(Exception):
    """A document that cannot be read as a composition at all.

    Kept as the base of :class:`CompositionError` rather than replaced by it, so that
    ``except TextError`` keeps catching every refusal: two callers outside this package
    rely on it -- the library's content validator and the diff route -- and neither should
    have had to change to gain diagnostics it does not read.
    """


class CompositionError(TextError):
    """Raised when a composition cannot be translated; carries every diagnostic."""

    def __init__(self, diagnostics: tuple[Diagnostic, ...]) -> None:
        self.diagnostics = diagnostics
        super().__init__("; ".join(str(d) for d in diagnostics))

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


def refuse(code: str, message: str, path: str) -> CompositionError:
    """One diagnostic, ready to raise. The span is attached later, by ``parse``."""
    return CompositionError((Diagnostic(code=code, message=message, path=path),))

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

from dataclasses import dataclass

#: A ``min``/``max`` property with no bound on the relevant side has no neutral. The
#: container would emit ``feature_neutral``; refusing here names the property instead.
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
EXCLUSIVE_CONDITION = "c2y_exclusive_condition"
REPEAT_COUNT = "c2y_repeat_count"
CANDIDATE_PROPERTY = "c2y_candidate_property"
CANDIDATE_UNMATCHED = "c2y_candidate_unmatched"
GOAL_UNKNOWN = "c2y_goal_unknown"
RULE_EXPRESSION = "c2y_rule_expression"


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


class CompositionError(Exception):
    """Raised when a composition cannot be translated; carries every diagnostic."""

    def __init__(self, diagnostics: tuple[Diagnostic, ...]) -> None:
        self.diagnostics = diagnostics
        super().__init__("; ".join(str(d) for d in diagnostics))

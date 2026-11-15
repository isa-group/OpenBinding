"""What the Composition2Yaml services read and answer, as HTTP documents."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class CompositionSpan(BaseModel):
    """Where a finding sits in the document's text: one-based lines and columns, the end exclusive."""

    line: int = Field(ge=1)
    column: int = Field(ge=1)
    end_line: int = Field(ge=1)
    end_column: int = Field(ge=1)


class CompositionDiagnosticView(BaseModel):
    """One finding about a Composition2Yaml document."""

    code: str = Field(description="A `c2y_*` code (docs/ERRORS.md).")
    message: str
    severity: Literal["error", "warning", "info"] = Field(
        description="An error refuses the document; a warning or an info only informs.",
    )
    path: str = Field(description="Dotted path of the element at fault (`binding.t1.from`); empty for the document.")
    pointer: str = Field(description="The same path as an RFC 6901 JSON Pointer, unambiguous where the dotted one is not.")
    span: Optional[CompositionSpan] = Field(
        description="Where the element is in the text; null when there is no text (a JSON document).",
    )


class ValidateResult(BaseModel):
    """The lint of one document: 200 whether or not it is valid."""

    valid: bool = Field(description="Whether no diagnostic is an error.")
    diagnostics: list[CompositionDiagnosticView]


class ParseResult(BaseModel):
    """A valid document as its canonical JSON model, with its warnings and infos."""

    document: dict[str, Any] = Field(description="The canonical form of the document, as JSON.")
    diagnostics: list[CompositionDiagnosticView]


class DiffRequest(BaseModel):
    """Two documents to compare, each as YAML text."""

    model_config = ConfigDict(extra="forbid")

    before: str = Field(description="The earlier document, as Composition2Yaml text.")
    after: str = Field(description="The later document, as Composition2Yaml text.")


class ChangeView(BaseModel):
    """One difference between two documents."""

    section: Literal["identity", "problem", "workflow", "binding", "values", "offering", "evidence"]
    subject: str = Field(description="What changed within the section: a task, a property, a field.")
    kind: Literal["added", "removed", "changed", "moved"]
    was: Any = Field(default=None, description="The value before; null when added.")
    now: Any = Field(default=None, description="The value after; null when removed.")


class DiffResult(BaseModel):
    """What changed, sorted by section and then subject."""

    changes: list[ChangeView]

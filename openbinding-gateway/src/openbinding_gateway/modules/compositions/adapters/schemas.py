"""What the compositions routes read and answer, as HTTP documents.

The Composition2Yaml services (diagnostics, lint, parse, diff) and the compositions of an organization.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from ....models.platform import SLUG

#: What a composition composes, as Composition2Yaml's ``kind`` spells it.
CompositionKindName = Literal["application", "workflow", "pipeline", "system"]


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


# -- Compositions of an organization ---------------------------------------------------------------------


class CompositionCreate(BaseModel):
    """A new, empty composition."""

    model_config = ConfigDict(extra="forbid")

    slug: str = Field(pattern=SLUG, description="Unique within the organization: 1 to 64 lowercase letters, digits and hyphens.")
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    kind: CompositionKindName = Field(
        default="application",
        description="What the composition composes; once a version exists it follows the latest version's `kind`.",
    )


class CompositionUpdate(BaseModel):
    """The fields to change; absent fields stay. `kind` follows the versions and is not edited here."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=2000)
    archived: Optional[bool] = None


class CompositionOrganization(BaseModel):
    """The organization a composition belongs to."""

    id: uuid.UUID
    slug: str


class CompositionView(BaseModel):
    """A composition of an organization."""

    id: uuid.UUID
    slug: str
    name: str
    description: str
    kind: CompositionKindName
    archived: bool
    organization: CompositionOrganization
    latest_version: None = Field(default=None, description="The latest sealed version; null while it has none.")
    version_count: int = Field(default=0, ge=0, description="How many versions it has.")
    created_by_id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class CompositionList(BaseModel):
    """One page of an organization's compositions, and how many match in all."""

    compositions: list[CompositionView]
    total: int
    limit: int
    offset: int

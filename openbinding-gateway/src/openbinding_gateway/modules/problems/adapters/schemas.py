"""What the problems API reads and answers, as HTTP documents."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class ProblemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=2000)


class CompilationSummary(BaseModel):
    """A compilation as a list shows it: its identities and the size of the binding space."""

    id: uuid.UUID
    compilation_digest: str
    compiler_digest: str
    semantic_digest: str = Field(
        description="The digest of what the compiled problem means; equal across toolchains that read it alike.",
    )
    ir_digest: str
    binding_space: str
    created_at: datetime
    current: bool = Field(description="Whether the installed toolchain made this compilation.")


class LatestRevision(BaseModel):
    id: uuid.UUID
    revision: int
    package_digest: str
    created_at: datetime
    current_compilation: Optional[CompilationSummary] = None


class ProblemView(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    slug: str
    name: str
    description: str
    created_by_id: uuid.UUID
    created_at: datetime
    updated_at: datetime
    latest_revision: Optional[LatestRevision] = None


class ProblemList(BaseModel):
    problems: list[ProblemView]
    total: int
    limit: int
    offset: int


class PackageFile(BaseModel):
    path: str
    role: str
    resource_id: Optional[str] = None
    digest: str
    media_type: str


class RevisionView(BaseModel):
    id: uuid.UUID
    problem_id: uuid.UUID
    revision: int
    package_digest: str
    instance_digest: Optional[str] = None
    package_size: int
    provenance: Optional[dict[str, Any]] = None
    created_by_id: uuid.UUID
    created_at: datetime


class RevisionDetail(RevisionView):
    document: dict[str, Any]
    files: list[PackageFile]
    resource_digests: dict[str, str] = Field(default_factory=dict)
    compilations: list[CompilationSummary] = Field(default_factory=list)


class ProblemUpload(BaseModel):
    """What an upload made: the problem, the revision (new or the one the package already is) and its compilation."""

    problem: ProblemView
    revision: RevisionView
    compilation: CompilationSummary
    created: bool = Field(description="False when the package was already a revision of the problem (200).")


class ResourceContract(BaseModel):
    role: Optional[str] = None
    path: Optional[str] = None
    apiVersion: Optional[str] = None
    kind: Optional[str] = None
    dialect: Optional[Any] = None


class ProblemAnalysis(BaseModel):
    tasks: int
    candidates: int
    constraints: int
    placement: bool
    bindingSpace: str


class CompilationView(CompilationSummary):
    """The compilation of a revision by the installed toolchain, with what a run needs to know of it."""

    revision_id: uuid.UUID
    toolchain: dict[str, Any] = Field(default_factory=dict)
    analysis: ProblemAnalysis
    resources: dict[str, ResourceContract] = Field(default_factory=dict)
    compatible_modes: list[dict[str, Any]] = Field(default_factory=list)


class CompilationIr(BaseModel):
    id: uuid.UUID
    ir_digest: str
    ir: dict[str, Any]
    source_map: dict[str, Any] = Field(default_factory=dict)

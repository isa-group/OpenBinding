"""Wire contracts for collaborative, reproducible binding work."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

SLUG = r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
DIGEST = r"^sha256-[0-9a-f]{64}$"


class OrganizationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(..., pattern=SLUG)
    name: str = Field(..., min_length=1, max_length=160)
    parent_id: Optional[uuid.UUID] = None
    billing_sponsor_user_id: Optional[uuid.UUID] = None


class OrganizationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    parent_id: Optional[uuid.UUID] = None
    move_to_root: bool = False
    billing_sponsor_user_id: Optional[uuid.UUID] = None


class OrganizationView(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    parent_id: Optional[uuid.UUID]
    billing_sponsor_user_id: uuid.UUID
    effective_role: Optional[Literal["OWNER", "ADMIN", "MEMBER", "VIEWER"]] = None
    created_at: datetime


class MemberUpsert(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: uuid.UUID
    role: Literal["OWNER", "ADMIN", "MEMBER", "VIEWER"]


class MemberView(MemberUpsert):
    id: uuid.UUID
    organization_id: uuid.UUID
    username: Optional[str] = None
    email: Optional[EmailStr] = None
    created_at: datetime


class MemberBatchChange(BaseModel):
    """One staged membership mutation; a null role removes the direct membership."""

    model_config = ConfigDict(extra="forbid")
    user_id: uuid.UUID
    role: Optional[Literal["OWNER", "ADMIN", "MEMBER", "VIEWER"]] = None


class MemberBatchUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    changes: list[MemberBatchChange] = Field(..., min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_users(self) -> "MemberBatchUpdate":
        user_ids = [change.user_id for change in self.changes]
        if len(user_ids) != len(set(user_ids)):
            raise ValueError("Each user may appear only once in a membership batch.")
        return self


class InvitationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    role: Literal["OWNER", "ADMIN", "MEMBER", "VIEWER"] = "MEMBER"


class InvitationCreated(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    email: EmailStr
    role: str
    expires_at: datetime
    token: str = Field(..., description="Shown once; send it to the invited person.")


class InvitationAccept(BaseModel):
    token: str = Field(..., min_length=32)


class ProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(..., pattern=SLUG)
    name: str = Field(..., min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    visibility: Literal["private", "public"] = "private"


class ProjectUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=2000)
    visibility: Optional[Literal["private", "public"]] = None


class ProjectView(ProjectCreate):
    id: uuid.UUID
    organization_id: uuid.UUID
    created_by_id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class BindingCaseCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(..., pattern=SLUG)
    name: str = Field(..., min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)


class BindingCaseView(BindingCaseCreate):
    id: uuid.UUID
    project_id: uuid.UUID
    created_by_id: uuid.UUID
    created_at: datetime


class CaseRevisionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document: dict[str, Any]
    source_snapshot_id: Optional[uuid.UUID] = None


class CaseRevisionView(BaseModel):
    id: uuid.UUID
    binding_case_id: uuid.UUID
    revision: int
    digest: str
    document: dict[str, Any]
    source_snapshot_id: Optional[uuid.UUID]
    created_at: datetime


class ProjectResourceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(..., pattern=SLUG)
    name: str = Field(..., min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    kind: str = Field(default="bim-resource", min_length=1, max_length=128)


class ProjectResourceView(ProjectResourceCreate):
    id: uuid.UUID
    project_id: uuid.UUID
    created_by_id: uuid.UUID
    created_at: datetime


class ProjectResourceRevisionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document: dict[str, Any]


class ProjectResourceRevisionView(BaseModel):
    id: uuid.UUID
    project_resource_id: uuid.UUID
    revision: int
    digest: str
    document: dict[str, Any]
    created_at: datetime


class CollectionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(..., pattern=SLUG)
    name: str = Field(..., min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)


class CollectionView(CollectionCreate):
    id: uuid.UUID
    project_id: uuid.UUID
    created_by_id: uuid.UUID
    created_at: datetime


class CollectionItemInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_kind: Literal["case", "resource", "result", "report"]
    target_digest: str = Field(..., pattern=DIGEST)
    target_ref: dict[str, Any]


class CollectionRevisionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[CollectionItemInput] = Field(..., max_length=1000)

    @model_validator(mode="after")
    def unique_targets(self):
        identities = {(item.target_kind, item.target_digest) for item in self.items}
        if len(identities) != len(self.items):
            raise ValueError("a collection revision cannot repeat a target")
        return self


class CollectionRevisionView(BaseModel):
    id: uuid.UUID
    collection_id: uuid.UUID
    revision: int
    digest: str
    items: list[CollectionItemInput]
    created_at: datetime


class StudyDefinition(BaseModel):
    """The reproducible Cartesian product behind a comparative study."""

    model_config = ConfigDict(extra="forbid")
    case_revision_ids: list[uuid.UUID] = Field(default_factory=list, max_length=250)
    engines: list[dict[str, str]] = Field(..., min_length=1, max_length=50)
    parameter_sets: list[dict[str, Any]] = Field(default_factory=lambda: [{}], min_length=1, max_length=100)
    seeds: list[int] = Field(default_factory=lambda: [0], min_length=1, max_length=100)
    collection_revision_id: Optional[uuid.UUID] = None

    @model_validator(mode="after")
    def bounded_matrix(self):
        if not self.case_revision_ids and self.collection_revision_id is None:
            raise ValueError("provide case_revision_ids or collection_revision_id")
        if len(set(self.case_revision_ids)) != len(self.case_revision_ids):
            raise ValueError("case_revision_ids contains duplicates")
        if len(set(self.seeds)) != len(self.seeds):
            raise ValueError("seeds contains duplicates")
        if len({json.dumps(value, sort_keys=True, separators=(",", ":")) for value in self.parameter_sets}) != len(self.parameter_sets):
            raise ValueError("parameter_sets contains duplicates")
        identities = {
            tuple(engine.get(key, "") for key in ("namespace", "name", "version", "digest", "mode"))
            for engine in self.engines
        }
        if len(identities) != len(self.engines):
            raise ValueError("engines contains duplicate revisions")
        cells = max(1, len(self.case_revision_ids)) * len(self.engines) * len(self.parameter_sets) * len(self.seeds)
        if self.case_revision_ids and cells > 10_000:
            raise ValueError("a study run may contain at most 10,000 cells")
        required = {"namespace", "name", "version", "digest"}
        allowed = required | {"mode"}
        if any(not required <= set(engine) or not set(engine) <= allowed for engine in self.engines):
            raise ValueError("every engine must be an exact immutable reference with an optional mode")
        if any(not re.fullmatch(DIGEST, engine.get("digest", "")) for engine in self.engines):
            raise ValueError("every engine digest must be sha256- followed by 64 lowercase hex characters")
        return self


class StudyCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(..., pattern=SLUG)
    name: str = Field(..., min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    definition: StudyDefinition


class StudyView(StudyCreate):
    id: uuid.UUID
    project_id: uuid.UUID
    state: str
    created_by_id: uuid.UUID
    created_at: datetime


class StudyRunView(BaseModel):
    id: uuid.UUID
    study_id: uuid.UUID
    run_number: int
    state: str
    matrix_digest: str
    cells: int
    summary: dict[str, Any]
    created_at: datetime
    finished_at: Optional[datetime]


class StudyCellResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: uuid.UUID


class StudyCellView(BaseModel):
    id: uuid.UUID
    study_run_id: uuid.UUID
    ordinal: int
    binding_case_revision_id: uuid.UUID
    engine_ref: dict[str, str]
    parameters: dict[str, Any]
    seed: int
    fingerprint: str
    job_id: Optional[uuid.UUID]
    state: str
    metrics: dict[str, Any]


class ReportCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(..., pattern=SLUG)
    title: str = Field(..., min_length=1, max_length=240)
    study_run_id: Optional[uuid.UUID] = None
    document: dict[str, Any]


class ReportView(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    study_run_id: Optional[uuid.UUID]
    slug: str
    title: str
    document: dict[str, Any]
    digest: str
    state: str
    created_at: datetime


class PublicationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    report_id: uuid.UUID
    slug: str = Field(..., pattern=SLUG)
    citation: dict[str, Any] = Field(default_factory=dict)


class PublicationView(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    report_id: uuid.UUID
    slug: str
    citation: dict[str, Any]
    published_at: datetime


class ArtifactView(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    project_id: uuid.UUID
    digest: str
    media_type: str
    size_bytes: int
    public: bool
    created_at: datetime


class NotificationView(BaseModel):
    id: uuid.UUID
    kind: str
    subject: str
    body: str
    payload: dict[str, Any]
    read_at: Optional[datetime]
    created_at: datetime


class JobView(BaseModel):
    id: uuid.UUID
    engine_id: str
    status: str
    cancellation_requested: bool
    retry_of_id: Optional[uuid.UUID]
    organization_id: Optional[uuid.UUID]
    project_id: Optional[uuid.UUID]
    created_at: datetime
    finished_at: Optional[datetime]


class AnalyticsView(BaseModel):
    cells: int
    completed: int
    failed: int
    feasible: int
    infeasible: int
    objective_distributions: dict[str, list[float]]
    runtimes_s: list[float]
    pareto: list[dict[str, Any]]
    stability: dict[str, Any]

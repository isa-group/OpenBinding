"""Wire contracts for collaborative, reproducible binding work."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from typing import Any, Literal, Mapping, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from ..security.redaction import (
    redact_options,
    redact_original_request,
    redact_provenance,
    redact_result,
)

SLUG = r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
DIGEST = r"^sha256-[0-9a-f]{64}$"


class OrganizationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(..., pattern=SLUG)
    name: str = Field(..., min_length=1, max_length=160)
    parent_id: Optional[uuid.UUID] = None


class OrganizationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    parent_id: Optional[uuid.UUID] = None
    move_to_root: bool = False


class OrganizationView(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    parent_id: Optional[uuid.UUID]
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
    created_by_id: Optional[uuid.UUID] = Field(
        default=None,
        description="The creator. Null for read-only visitors of a public project (access `public_read`).",
    )
    created_at: datetime
    updated_at: datetime
    effective_role: Optional[Literal["OWNER", "ADMIN", "MEMBER", "VIEWER"]] = Field(
        default=None,
        description="The caller's membership role. Null when the caller is not a member (see `access`).",
    )
    access: Literal["member", "public_read"] = Field(
        default="member",
        description=(
            "How the caller reaches the project: `member` (a membership role, see `effective_role`) "
            "or `public_read` (a non-member reading a public project; GET only, never a role)."
        ),
    )


class ProjectResourceView(BaseModel):
    # Project resources are read-only since M9.6; the fields and their schema are those of the former create body.
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(..., pattern=SLUG)
    name: str = Field(..., min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    kind: str = Field(default="bim-resource", min_length=1, max_length=128)
    id: uuid.UUID
    project_id: uuid.UUID
    created_by_id: uuid.UUID
    created_at: datetime


class ProjectResourceRevisionView(BaseModel):
    id: uuid.UUID
    project_resource_id: uuid.UUID
    revision: int
    digest: str
    document: dict[str, Any]
    created_at: datetime


class StudyDefinition(BaseModel):
    """The reproducible Cartesian product behind a comparative study."""

    model_config = ConfigDict(extra="forbid")
    case_revision_ids: list[uuid.UUID] = Field(default_factory=list, max_length=250)
    engines: list[dict[str, Any]] = Field(..., min_length=1, max_length=50)
    parameter_sets: list[dict[str, Any]] = Field(default_factory=lambda: [{}], min_length=1, max_length=100)
    seeds: list[int] = Field(default_factory=lambda: [0], min_length=1, max_length=100)

    @model_validator(mode="after")
    def bounded_matrix(self):
        if not self.case_revision_ids:
            raise ValueError("provide case_revision_ids")
        if len(set(self.case_revision_ids)) != len(self.case_revision_ids):
            raise ValueError("case_revision_ids contains duplicates")
        if len(set(self.seeds)) != len(self.seeds):
            raise ValueError("seeds contains duplicates")
        if len({json.dumps(value, sort_keys=True, separators=(",", ":")) for value in self.parameter_sets}) != len(self.parameter_sets):
            raise ValueError("parameter_sets contains duplicates")
        identities = {
            (tuple(engine.get(key, "") for key in ("namespace", "name", "version", "digest", "mode")), json.dumps(engine.get("optimization", {}), sort_keys=True, separators=(",", ":")))
            for engine in self.engines
        }
        if len(identities) != len(self.engines):
            raise ValueError("engines contains duplicate revisions")
        cells = max(1, len(self.case_revision_ids)) * len(self.engines) * len(self.parameter_sets) * len(self.seeds)
        if self.case_revision_ids and cells > 10_000:
            raise ValueError("a study run may contain at most 10,000 cells")
        required = {"namespace", "name", "version", "digest"}
        allowed = required | {"mode", "optimization"}
        if any(not required <= set(engine) or not set(engine) <= allowed for engine in self.engines):
            raise ValueError("every engine must be an exact immutable reference with mode and optimization")
        for engine in self.engines:
            optimization = engine.get("optimization")
            if not engine.get("mode"):
                raise ValueError("every study engine must select an explicit mode")
            if not isinstance(optimization, dict) or not isinstance(optimization.get("type"), str) or not isinstance(optimization.get("scalarization"), str):
                raise ValueError("every study engine must define an optimization type and scalarization")
        if any(not re.fullmatch(DIGEST, engine.get("digest", "")) for engine in self.engines):
            raise ValueError("every engine digest must be sha256- followed by 64 lowercase hex characters")
        return self


class StudyMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(..., pattern=SLUG)
    name: str = Field(..., min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)


class StudyCreate(StudyMetadata):
    definition: Optional[StudyDefinition] = None
    definition_version_id: Optional[uuid.UUID] = None

    @model_validator(mode="after")
    def exact_definition_source(self):
        if (self.definition is None) == (self.definition_version_id is None):
            raise ValueError("Specify either definition or definition_version_id.")
        return self


class StudyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    archived: Optional[bool] = None
    definition_version_id: Optional[uuid.UUID] = None
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=2000)


class StudyView(StudyMetadata):
    definition: StudyDefinition
    archived: bool
    definition_artifact_id: uuid.UUID
    definition_version_id: uuid.UUID
    id: uuid.UUID
    project_id: uuid.UUID
    state: str
    created_by_id: uuid.UUID
    created_at: datetime


class StudyRunView(BaseModel):
    definition_version_id: uuid.UUID
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
    engine_ref: dict[str, Any]
    parameters: dict[str, Any]
    seed: int
    fingerprint: str
    job_id: Optional[uuid.UUID]
    state: str
    metrics: dict[str, Any]


class NotificationView(BaseModel):
    id: uuid.UUID
    kind: str
    subject: str
    body: str
    payload: dict[str, Any]
    read_at: Optional[datetime]
    created_at: datetime


class JobOrganizationRef(BaseModel):
    id: uuid.UUID
    slug: str


class JobProblemRef(BaseModel):
    id: uuid.UUID
    slug: str
    name: str


class JobRevisionRef(BaseModel):
    id: uuid.UUID
    revision: int


class JobCompilationRef(BaseModel):
    id: uuid.UUID
    compilation_digest: str
    ir_digest: str


class JobView(BaseModel):
    id: uuid.UUID
    engine_id: str
    status: str
    cancellation_requested: bool
    retry_of_id: Optional[uuid.UUID]
    organization_id: uuid.UUID
    project_id: Optional[uuid.UUID]
    #: What the run is of: the organization, problem, revision and compilation it names.
    organization: Optional[JobOrganizationRef] = None
    problem: Optional[JobProblemRef] = None
    revision: Optional[JobRevisionRef] = None
    compilation: Optional[JobCompilationRef] = None
    created_at: datetime
    finished_at: Optional[datetime]
    result: Optional[dict[str, Any]] = None
    termination: Optional[str] = None
    options: Optional[dict[str, Any]] = None
    original_request: Optional[dict[str, Any]] = None
    provenance: Optional[dict[str, Any]] = None


def job_view(
    job: Any, viewer: Any, *, include_results: bool = True, redact: bool = False,
    refs: Optional[Mapping[str, Any]] = None,
) -> JobView:
    """A ``JobView`` of an ORM job as ``viewer`` may see it.

    Provenance is copied, never edited in place. ``redact`` is for readers who
    may follow a project's work but not its inputs (a VIEWER): options are cut
    to the non-sensitive allow-list, ``original_request`` to the pinned
    choices, and the options echoed in the provenance and the result likewise
    (``security/redaction.py``). The stored row is never touched. ``refs`` are
    the run's organization, problem, revision and compilation
    (``repositories.jobs.refs_for``).
    """
    provenance = dict(job.provenance) if include_results and job.provenance is not None else None
    result = job.result if include_results else None
    original_request = job.original_request if include_results else None
    options = job.options
    if redact:
        provenance = redact_provenance(provenance)
        result = redact_result(result)
        original_request = redact_original_request(original_request)
        options = redact_options(options)
    return JobView(
        id=job.id, engine_id=job.engine_id, status=job.state.value,
        cancellation_requested=job.cancellation_requested,
        retry_of_id=job.retry_of_id, organization_id=job.organization_id,
        project_id=job.project_id, created_at=job.created_at, finished_at=job.finished_at,
        result=result, termination=job.termination,
        options=options,
        original_request=original_request,
        provenance=provenance,
        **(dict(refs) if refs else {}),
    )


class SnapshotView(BaseModel):
    id: uuid.UUID
    owner_id: Optional[uuid.UUID] = None
    instance_digest: str
    package_digest: str
    archive_size: int
    created_at: datetime
    ir: Optional[dict[str, Any]] = None


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
    binding_space: Optional[dict[str, Any]] = None

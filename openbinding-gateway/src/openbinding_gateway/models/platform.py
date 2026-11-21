"""Wire contracts for collaborative, reproducible binding work."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from typing import Any, Literal, Mapping, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .avatars import AvatarDescriptor, avatar_of
from ..security.redaction import (
    redact_options,
    redact_original_request,
    redact_provenance,
    redact_result,
)

SLUG = r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
DIGEST = r"^sha256-[0-9a-f]{64}$"


#: Organization slugs that would collide with an address: the static children of the organization page
#: (``/orgs/new``, ``/orgs/join/:code``; the frontend's route table is read by its test
#: ``src/routes/reservedSlugs.test.ts`` to keep the two equal) and ``public``, which would shadow
#: ``GET /v1/organizations/public``. A slug derived from a name never takes one either.
RESERVED_ORGANIZATION_SLUGS = frozenset({"new", "join", "public"})

#: A colour the avatar pickers produce: ``#rgb`` or ``#rrggbb``.
HEX_COLOR = r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"

Role = Literal["OWNER", "ADMIN", "MEMBER", "VIEWER"]


class OrganizationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: Absent: derived from the name and made unique with a suffix, as SPHERE does.
    slug: Optional[str] = Field(default=None, pattern=SLUG)
    name: str = Field(..., min_length=1, max_length=160)
    description: str = Field(default="", max_length=500)
    parent_id: Optional[uuid.UUID] = None


class OrganizationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=500)
    parent_id: Optional[uuid.UUID] = None
    move_to_root: bool = False


class OrganizationStats(BaseModel):
    """What an organization holds: its direct members and sub-organizations, and its own resources."""

    members: int
    sub_organizations: int
    compositions: int
    problems: int
    runs: int
    studies: int


class OrganizationAvatar(BaseModel):
    """How an organization is drawn: an image URL (a predefined avatar or an upload) and its colours.

    ``url`` is a path of the gateway (``/v1/avatars/avatar-3.svg``, ``/v1/organizations/{id}/avatar/{digest}``),
    null for the initials. A predefined avatar is drawn in ``fg_color`` over ``bg_color``.
    """

    url: Optional[str] = None
    kind: Optional[Literal["predefined", "upload"]] = None
    bg_color: Optional[str] = None
    fg_color: Optional[str] = None


class OrganizationRef(BaseModel):
    id: uuid.UUID
    slug: str
    name: str


class OrganizationView(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    description: str = ""
    avatar: OrganizationAvatar = Field(default_factory=OrganizationAvatar)
    parent_id: Optional[uuid.UUID]
    effective_role: Optional[Role] = None
    #: The organization whose membership gives ``effective_role``: this one, or an ancestor (``tree=true``).
    role_source: Optional[OrganizationRef] = None
    stats: Optional[OrganizationStats] = None
    #: The sub-organizations the caller holds a role in, by name (``tree=true`` only).
    children: Optional[list["OrganizationView"]] = None
    created_at: datetime


class PublicOrganizationView(BaseModel):
    """What anybody reads of an organization with a public composition: who it is and what it publishes."""

    id: uuid.UUID
    slug: str
    name: str
    description: str
    avatar: OrganizationAvatar
    public_compositions: int


class PublicOrganizationList(BaseModel):
    items: list[PublicOrganizationView]
    total: int


class HierarchyNode(BaseModel):
    """One organization of a branch (``GET /v1/organizations/{org}/hierarchy``), and whether the caller opens it."""

    id: uuid.UUID
    slug: str
    name: str
    avatar: OrganizationAvatar
    parent_id: Optional[uuid.UUID]
    has_access: bool
    effective_role: Optional[Role] = None


class AvatarSelection(BaseModel):
    """A predefined avatar, or none (the initials), and the colours to draw it with."""

    model_config = ConfigDict(extra="forbid")
    avatar: Optional[str] = Field(
        default=None, max_length=80,
        description="A predefined avatar's file name (`GET /v1/avatars`), or null for the initials. Absent "
        "keeps the current image.",
    )
    bg_color: Optional[str] = Field(default=None, pattern=HEX_COLOR)
    fg_color: Optional[str] = Field(default=None, pattern=HEX_COLOR)


class MemberUpsert(BaseModel):
    """A direct role to set. The owner's seat is not one of them: it moves only by ``PUT .../owner``."""

    model_config = ConfigDict(extra="forbid")
    user_id: uuid.UUID
    role: Literal["ADMIN", "MEMBER", "VIEWER"]


class MemberView(BaseModel):
    user_id: uuid.UUID
    role: Literal["OWNER", "ADMIN", "MEMBER", "VIEWER"]
    id: uuid.UUID
    organization_id: uuid.UUID
    username: Optional[str] = None
    email: Optional[str] = None
    display_name: Optional[str] = Field(default=None, description="The member's display name; null if none.")
    avatar: Optional[AvatarDescriptor] = Field(default=None, description="The member's avatar; null draws the initials.")
    created_at: datetime


class OwnerTransfer(BaseModel):
    """Who takes the organization over: a member, here or above."""

    model_config = ConfigDict(extra="forbid")
    user_id: uuid.UUID


class MemberBatchChange(BaseModel):
    """One staged membership mutation; a null role removes the direct membership."""

    model_config = ConfigDict(extra="forbid")
    user_id: uuid.UUID
    role: Optional[Literal["ADMIN", "MEMBER", "VIEWER"]] = None


class MemberBatchUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    changes: list[MemberBatchChange] = Field(..., min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_users(self) -> "MemberBatchUpdate":
        user_ids = [change.user_id for change in self.changes]
        if len(user_ids) != len(set(user_ids)):
            raise ValueError("Each user may appear only once in a membership batch.")
        return self


class CodeInvitationCreate(BaseModel):
    """A shareable invitation code (SPHERE's ``createInvitation``): whoever holds it joins as MEMBER."""

    model_config = ConfigDict(extra="forbid")
    expires_in_days: Optional[int] = Field(
        default=7, ge=1, le=365, description="Days the code is valid for; null for a code that never expires.",
    )
    max_uses: Optional[int] = Field(default=None, ge=1, le=10_000, description="How many may join with it; null for any.")


class UserRef(BaseModel):
    """A user as another user may see them: never an email."""

    id: uuid.UUID
    username: str
    display_name: Optional[str] = Field(
        default=None,
        description="The name the person shows (SCORETech Identity's display name, or the one set in local mode); null if none.",
    )
    avatar: Optional[AvatarDescriptor] = Field(
        default=None,
        description="The person's avatar: SCORETech Identity's descriptor (colours as hex); null draws the initials.",
    )

    @classmethod
    def of(cls, user: Any) -> "UserRef":
        """The reference of a ``users`` row: its id, username, display name and avatar."""
        return cls(id=user.id, username=user.username, display_name=user.display_name, avatar=avatar_of(user.avatar))


class CodeInvitationView(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    code: str
    created_by: Optional[UserRef]
    expires_at: Optional[datetime]
    max_uses: Optional[int]
    use_count: int
    created_at: datetime


class InviteUsers(BaseModel):
    """Invite named users: one code with a use for each, and a notification to each of them."""

    model_config = ConfigDict(extra="forbid")
    user_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=50)

    @model_validator(mode="after")
    def unique_users(self) -> "InviteUsers":
        if len(set(self.user_ids)) != len(self.user_ids):
            raise ValueError("Each user may appear only once.")
        return self


class InvitationPreview(BaseModel):
    """What a code invites to, before joining (``GET /v1/invitations/{code}/preview``)."""

    code: str
    organization: "PublicOrganizationView"
    expires_at: Optional[datetime]
    invited_by: Optional[UserRef]


def study_preset_ref(engine: Mapping[str, Any]) -> str | None:
    """The run preset a study engine entry starts from (``{"preset": <slug or id>}``), else ``None``."""
    if set(engine) == {"preset"} and isinstance(engine["preset"], str) and engine["preset"]:
        return engine["preset"]
    return None


def study_engine_identity(engine: Mapping[str, Any]) -> tuple[Any, ...]:
    """What makes two study engines the same: the exact revision, the mode, the optimization and the options.

    A preset entry not yet expanded is named by its reference; ``preset`` provenance is not part of it.
    """
    ref = study_preset_ref(engine)
    if ref is not None:
        return ("preset", ref)
    return (
        tuple(engine.get(key, "") for key in ("namespace", "name", "version", "digest", "mode")),
        json.dumps(engine.get("optimization", {}), sort_keys=True, separators=(",", ":")),
        json.dumps(engine.get("options") or {}, sort_keys=True, separators=(",", ":")),
    )


class StudyDefinition(BaseModel):
    """The reproducible Cartesian product behind a comparative study: problem revisions of the study's
    organization, engines, parameter sets and seeds.

    An engine is an exact engine revision with a mode, an optimization and, optionally, ``options``; or
    ``{"preset": <slug or id>}``, a run preset of the organization that each run expands into one (and records
    as ``preset: {id, slug}``, which an exact entry copied from a run may keep).
    """

    model_config = ConfigDict(extra="forbid")
    revision_ids: list[uuid.UUID] = Field(default_factory=list, max_length=250)
    engines: list[dict[str, Any]] = Field(..., min_length=1, max_length=50)
    parameter_sets: list[dict[str, Any]] = Field(default_factory=lambda: [{}], min_length=1, max_length=100)
    seeds: list[int] = Field(default_factory=lambda: [0], min_length=1, max_length=100)

    @model_validator(mode="after")
    def bounded_matrix(self):
        if not self.revision_ids:
            raise ValueError("provide revision_ids")
        if len(set(self.revision_ids)) != len(self.revision_ids):
            raise ValueError("revision_ids contains duplicates")
        if len(set(self.seeds)) != len(self.seeds):
            raise ValueError("seeds contains duplicates")
        if len({json.dumps(value, sort_keys=True, separators=(",", ":")) for value in self.parameter_sets}) != len(self.parameter_sets):
            raise ValueError("parameter_sets contains duplicates")
        if len({study_engine_identity(engine) for engine in self.engines}) != len(self.engines):
            raise ValueError("engines contains duplicate revisions")
        cells = max(1, len(self.revision_ids)) * len(self.engines) * len(self.parameter_sets) * len(self.seeds)
        if self.revision_ids and cells > 10_000:
            raise ValueError("a study run may contain at most 10,000 cells")
        exact = [engine for engine in self.engines if study_preset_ref(engine) is None]
        required = {"namespace", "name", "version", "digest"}
        allowed = required | {"mode", "optimization", "options", "preset"}
        if any(not required <= set(engine) or not set(engine) <= allowed for engine in exact):
            raise ValueError(
                "every engine must be an exact immutable reference with mode and optimization, or {preset}"
            )
        for engine in exact:
            if not isinstance(engine.get("options", {}), dict):
                raise ValueError("an engine's options is an object")
            provenance = engine.get("preset")
            if provenance is not None and (
                not isinstance(provenance, dict) or set(provenance) != {"id", "slug"}
            ):
                raise ValueError("an engine's preset is the {id, slug} of the preset it came from")
            optimization = engine.get("optimization")
            if not engine.get("mode"):
                raise ValueError("every study engine must select an explicit mode")
            if not isinstance(optimization, dict) or not isinstance(optimization.get("type"), str) or not isinstance(optimization.get("scalarization"), str):
                raise ValueError("every study engine must define an optimization type and scalarization")
        if any(not re.fullmatch(DIGEST, engine.get("digest", "")) for engine in exact):
            raise ValueError("every engine digest must be sha256- followed by 64 lowercase hex characters")
        return self


class StudyMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(..., pattern=SLUG)
    name: str = Field(..., min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)


class StudyCreate(StudyMetadata):
    definition: StudyDefinition


class StudyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    archived: Optional[bool] = None
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=2000)
    #: The new current matrix. Runs keep the copy they froze.
    definition: Optional[StudyDefinition] = None


class StudyView(StudyMetadata):
    id: uuid.UUID
    organization_id: uuid.UUID
    definition: StudyDefinition
    definition_digest: str
    archived: bool
    state: str
    created_by_id: uuid.UUID
    created_at: datetime


class StudyRunProblem(BaseModel):
    """One problem revision of a study run, with the compilation every cell of it runs."""

    revisionId: uuid.UUID
    problemId: uuid.UUID
    revision: int
    packageDigest: str
    compilationId: uuid.UUID
    compilationDigest: str
    irDigest: str


class StudyRunDefinition(BaseModel):
    """The definition a study run froze when it was created (``openbinding/study-run/v1``)."""

    apiVersion: str
    problems: list[StudyRunProblem]
    engines: list[dict[str, Any]]
    parameterSets: list[dict[str, Any]]
    seeds: list[int]


class StudyRunView(BaseModel):
    id: uuid.UUID
    study_id: uuid.UUID
    run_number: int
    state: str
    matrix_digest: str
    definition: StudyRunDefinition
    definition_digest: str
    cells: int
    summary: dict[str, Any]
    created_at: datetime
    finished_at: Optional[datetime]


class StudyExportRef(BaseModel):
    id: uuid.UUID
    slug: str
    name: str


class StudyRunExportRef(BaseModel):
    id: uuid.UUID
    run_number: int
    state: str
    matrix_digest: str
    definition_digest: str
    created_at: datetime
    finished_at: Optional[datetime]


class StudyCellExport(BaseModel):
    id: uuid.UUID
    ordinal: int
    problem: str = Field(description="The slug of the problem the cell's revision belongs to.")
    revision: int
    binding_case_revision_id: uuid.UUID
    compilation_id: uuid.UUID
    engine: dict[str, Any] = Field(description="The exact engine, mode and optimization the cell ran.")
    parameters: dict[str, Any]
    seed: int
    fingerprint: str
    job_id: Optional[uuid.UUID]
    state: str
    metrics: dict[str, Any]


class StudyRunExport(BaseModel):
    """A study run exported whole (``exportStudyRun?format=json``): the frozen definition and every cell."""

    study: StudyExportRef
    run: StudyRunExportRef
    definition: StudyRunDefinition
    cells: list[StudyCellExport]


class StudyCellResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: uuid.UUID


class StudyCellView(BaseModel):
    id: uuid.UUID
    study_run_id: uuid.UUID
    ordinal: int
    binding_case_revision_id: uuid.UUID
    compilation_id: uuid.UUID
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


class JobCreatorRef(BaseModel):
    id: uuid.UUID
    username: str


class JobView(BaseModel):
    """A run of an organization, as a list shows it; ``RunView`` adds what one run's page shows."""

    id: uuid.UUID
    engine_id: str
    status: str
    cancellation_requested: bool
    retry_of_id: Optional[uuid.UUID]
    organization_id: uuid.UUID
    #: What the run is of: the organization, problem, revision and compilation it names.
    organization: Optional[JobOrganizationRef] = None
    problem: Optional[JobProblemRef] = None
    revision: Optional[JobRevisionRef] = None
    compilation: Optional[JobCompilationRef] = None
    #: The member who launched (or retried) the run.
    created_by: Optional[JobCreatorRef] = None
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
    may follow the organization's work but not its inputs (a VIEWER): options are cut
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
        created_at=job.created_at, finished_at=job.finished_at,
        result=result, termination=job.termination,
        options=options,
        original_request=original_request,
        provenance=provenance,
        **(dict(refs) if refs else {}),
    )


class RunList(BaseModel):
    """A page of an organization's runs (``listRuns``) and how many match the filters."""

    runs: list[JobView]
    total: int


class RunView(JobView):
    """One run (``getRun``): the summary, the result and its error, and what the engine said about itself.

    ``remote`` is ``result.provenance.engineReported`` (empty until the engine answered); ``error``
    repeats ``result.error`` for a failed run. Both are redacted with the result.
    """

    error: Optional[str] = None
    remote: dict[str, Any] = {}


def run_view(job: Any, viewer: Any, *, redact: bool = False, refs: Optional[Mapping[str, Any]] = None) -> RunView:
    """A ``RunView`` of an ORM job as ``viewer`` may see it (``job_view`` plus ``error`` and ``remote``)."""
    base = job_view(job, viewer, redact=redact, refs=refs)
    result = base.result if isinstance(base.result, dict) else {}
    provenance = result.get("provenance") if isinstance(result.get("provenance"), dict) else {}
    remote = provenance.get("engineReported") if isinstance(provenance.get("engineReported"), dict) else {}
    error = result.get("error") if isinstance(result.get("error"), str) else None
    return RunView(**base.model_dump(), error=error, remote=dict(remote))


class ParetoProblem(BaseModel):
    slug: str


class ParetoPoint(BaseModel):
    """A feasible solution no other solution of its front dominates."""

    cell_id: uuid.UUID
    job_id: uuid.UUID
    solution_index: int = Field(description="The run solution the point is: the `point` to derive a composition from.")
    engine: str
    objectives: dict[str, float]


class ParetoFront(BaseModel):
    """The non-dominated points of one problem revision and one set of objective names (minimisation)."""

    revision_id: uuid.UUID
    problem: ParetoProblem
    revision: int
    objectives: list[str]
    points: list[ParetoPoint]


class AnalyticsView(BaseModel):
    cells: int
    completed: int
    failed: int
    feasible: int
    infeasible: int
    objective_distributions: dict[str, list[float]]
    runtimes_s: list[float]
    pareto: list[ParetoFront] = Field(
        default_factory=list,
        description="One front per problem revision and objective-name set, from the feasible solutions of "
        "completed cells.",
    )
    stability: dict[str, Any]
    binding_space: Optional[dict[str, Any]] = None

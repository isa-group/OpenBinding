"""What the compositions routes read and answer, as HTTP documents.

The Composition2Yaml services (diagnostics, lint, parse, diff) and the compositions of an organization.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ....composition import ids
from ....models.analysis import CounterfactualMove, NeighborhoodDocument
from ....models.platform import SLUG

#: What a composition composes, as Composition2Yaml's ``kind`` spells it.
CompositionKindName = Literal["application", "workflow", "pipeline", "system"]

#: Who reads a composition: its organization's members (``private``) or anybody (``public``).
Visibility = Literal["private", "public"]

#: Said of every field a public reader gets as null.
_MEMBERS_ONLY = "Null for a reader who is not a member of the organization (a public composition's reader)."


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


ValuesStatusName = Literal["verified", "declared"]


class FieldChangeView(BaseModel):
    """One field that differs: its dotted path within the entry (or the document), and both values."""

    path: str = Field(description="Dotted path of the field: `candidate`, `from.version`, `value`, `problem.ref`, `workflow`.")
    before: Any = Field(default=None, description="The value before; null when the field is absent before.")
    after: Any = Field(default=None, description="The value after; null when the field is absent after.")


class EntryDiffView(BaseModel):
    """One entry of a section (a task, a property, the offering's `source`) that was added, removed or changed."""

    name: str
    kind: Literal["added", "removed", "changed"]
    changes: list[FieldChangeView]


class SectionDiffView(BaseModel):
    """The entries of one section that differ."""

    key: Literal["binding", "values", "offering"]
    label: str
    entries: list[EntryDiffView]


class DiffTotals(BaseModel):
    """How many entries were added, removed and changed; each general change counts as changed."""

    added: int = Field(ge=0)
    removed: int = Field(ge=0)
    changed: int = Field(ge=0)


class ValueStatusPair(BaseModel):
    """Whose values each side holds: the toolchain's (`verified`) or the author's (`declared`)."""

    before: ValuesStatusName
    after: ValuesStatusName


class DiffComparison(BaseModel):
    """Whether the values of the two sides can be compared, and what tells them apart if not."""

    model_config = ConfigDict(populate_by_name=True)

    comparable: bool = Field(
        description=(
            "Both sides verified on the same problem revision and compilation, or both declared on the same link "
            "(or none). Otherwise the `values` section is empty: value changes are not shown."
        ),
    )
    problem_ref_changed: bool = Field(alias="problemRefChanged")
    compilation_changed: bool = Field(alias="compilationChanged")
    value_status: ValueStatusPair = Field(alias="valueStatus")


class DiffResult(BaseModel):
    """What changed between two documents, in SPHERE's PricingDiff shape.

    `general` holds the top-level fields that changed (`syntaxVersion`, `composition`, `kind`, `problem.*`, and
    `workflow` compared whole); `version` and `evidence` are not reported. `sections` are always `binding`
    (one entry per task), `values` (one per property) and `offering` (one, `source`).
    """

    model_config = ConfigDict(populate_by_name=True)

    general: list[FieldChangeView]
    sections: list[SectionDiffView]
    totals: DiffTotals
    is_empty: bool = Field(alias="isEmpty", description="Whether nothing changed that a diff reports.")
    comparison: DiffComparison


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
    visibility: Optional[Visibility] = Field(
        default=None,
        description=(
            "`public`: anybody reads the composition, every version's document included; `private`: only the "
            "organization's members. Changing it needs ADMIN."
        ),
    )


class CompositionOrganization(BaseModel):
    """The organization a composition belongs to."""

    id: uuid.UUID
    slug: str
    name: str = Field(description="The organization's display name.")


class CompositionView(BaseModel):
    """A composition of an organization."""

    id: uuid.UUID
    slug: str
    name: str
    description: str
    kind: CompositionKindName
    archived: bool
    visibility: Visibility = Field(
        description="`private` (the default): the organization's members read it; `public`: anybody does.",
    )
    organization: CompositionOrganization
    latest_version: Optional["CompositionVersionSummary"] = Field(
        default=None, description="The latest sealed version; null while it has none.",
    )
    version_count: int = Field(default=0, ge=0, description="How many versions it has.")
    created_by_id: Optional[uuid.UUID] = Field(description=_MEMBERS_ONLY)
    created_at: datetime
    updated_at: datetime
    derivedVersions: Optional[list["DerivedVersion"]] = Field(
        default=None,
        description="With `run`: its versions derived from that run, and the environments each is in effect in; "
        "null otherwise.",
    )


class DerivedVersion(BaseModel):
    """A version derived from a run's solution, and where it is in effect."""

    id: uuid.UUID
    label: str
    sealedAt: datetime
    inEffect: list[str] = Field(description="The slugs of the environments that have it in effect.")


class OwnerFacet(BaseModel):
    """An organization of a list's matches, and how many of them it holds."""

    slug: str
    name: str
    count: int


class HistogramBucket(BaseModel):
    value: str = Field(description="`a-b` (from a, up to b) or `p+` (p and above), as SPHERE's slider histograms.")
    count: int


class RangeFacet(BaseModel):
    """A number of a list's matches: its extent and SPHERE's ten-bucket histogram; nulls when none has it."""

    min: Optional[float] = None
    max: Optional[float] = None
    data: list[HistogramBucket] = Field(default_factory=list)


class RangeFacets(BaseModel):
    tasks: RangeFacet
    providers: RangeFacet
    cost: RangeFacet


class CompositionFacets(BaseModel):
    """What every match of a list (not one page) holds: its organizations and the extent of its numbers, each
    facet ignoring its own filter. From what each latest version stored: its analytics' `tasks` and `providers`,
    and the `cost` value of its latest evaluation."""

    owners: list[OwnerFacet]
    ranges: RangeFacets


class CompositionList(BaseModel):
    """One page of an organization's compositions, and how many match in all."""

    compositions: list[CompositionView]
    total: int
    limit: int
    offset: int
    facets: Optional[CompositionFacets] = None


class PublicCompositionOrganization(BaseModel):
    """The organization a public composition belongs to, as its URLs and its header name it."""

    slug: str
    name: str = Field(description="The organization's display name.")


class VersionFigures(BaseModel):
    """What a list shows of a version's size and cost: ``tasks`` and ``providers`` from the analytics stored at
    seal, ``cost`` from the latest evaluation's ``cost`` value; each null when the version has none."""

    tasks: Optional[int] = None
    providers: Optional[int] = None
    cost: Optional[float] = None
    cost_unit: Optional[str] = Field(default=None, description="The unit the evaluation gave the cost, if any.")


class PublicVersionSummary(BaseModel):
    """The latest version of a public composition, as a list shows it."""

    label: str = Field(description="The document's `version:` (Semantic Versioning).")
    ordinal: int = Field(ge=1)
    values_status: ValuesStatusName
    verified: bool = Field(description="Whether the current evaluation verified the binding and computed the values.")
    created_at: datetime
    figures: VersionFigures = Field(default_factory=VersionFigures)


class PublicCompositionView(BaseModel):
    """A public composition in the list of every organization's: what anybody reads, and no member id or
    lineage."""

    organization: PublicCompositionOrganization
    slug: str
    name: str
    description: str
    kind: CompositionKindName
    latest_version: PublicVersionSummary
    version_count: int = Field(ge=1, description="How many versions it has.")
    updated_at: datetime


class PublicCompositionList(BaseModel):
    """One page of the public compositions of every organization, and how many match in all."""

    compositions: list[PublicCompositionView]
    total: int
    limit: int
    offset: int
    facets: Optional[CompositionFacets] = None


# -- Versions and their evaluations ----------------------------------------------------------------------


class CompositionVersionSummary(BaseModel):
    """A version, named, and the status of its values."""

    id: uuid.UUID
    ordinal: int = Field(ge=1, description="1 for the first version sealed, then one more each time.")
    label: str = Field(description="The document's `version:` (Semantic Versioning).")
    values_status: ValuesStatusName
    verified: bool = Field(description="Whether the current evaluation verified the binding and computed the values.")
    created_at: datetime
    figures: VersionFigures = Field(default_factory=VersionFigures)


class VersionProblem(BaseModel):
    """The problem a version links. Its slug is in the document's `problem.ref`; the problem stays private."""

    id: Optional[uuid.UUID] = Field(description=_MEMBERS_ONLY)
    slug: str
    name: Optional[str] = Field(description=_MEMBERS_ONLY)


class VersionRevision(BaseModel):
    """The revision of the problem a version links."""

    id: Optional[uuid.UUID] = Field(description=_MEMBERS_ONLY)
    revision: int


class VersionCompilation(BaseModel):
    """The compilation a version's document names."""

    id: Optional[uuid.UUID] = Field(description=_MEMBERS_ONLY)
    compilation_digest: str
    semantic_digest: str


class VersionLink(BaseModel):
    """The problem revision a version is judged against, and the compilation its document names."""

    problem: VersionProblem
    revision: VersionRevision
    linked_compilation: VersionCompilation


class EvaluationCompilation(BaseModel):
    """The compilation an evaluation evaluated: the toolchain's of that release."""

    id: Optional[uuid.UUID] = Field(description=_MEMBERS_ONLY)
    compilation_digest: str
    compiler_digest: str
    semantic_digest: str
    toolchain: dict[str, Any]


class ValueView(BaseModel):
    """A global value: the toolchain's float as it returned it, or the author's number, and its unit."""

    value: int | float
    unit: str = Field(description='The problem\'s unit; `"1"` for a dimensionless value.')


class EvaluationOffering(BaseModel):
    """The offering version read when the evaluation was created; names and dates, never a digest."""

    status: Literal["read", "unreadable", "invalid_pricing", "registry_unknown"]
    versionName: Optional[str] = Field(description="The version's name in SPHERE, or null (a URL, or nothing read).")
    createdAt: Optional[str] = Field(description="When SPHERE says that version was published.")
    snapshot: Optional[uuid.UUID] = Field(description="The pricing snapshot read (`…/pricing-snapshots/{snapshot}`).")


class EvaluationView(BaseModel):
    """One evaluation of a version: by one toolchain release (`bim`), or the author's values (`declared`)."""

    id: uuid.UUID
    basis: Literal["bim", "declared"]
    outcome: Literal["verified", "binding_invalid", "semantics_changed", "declared"]
    values: dict[str, ValueView]
    violations: list[dict[str, Any]] = Field(
        description="The constraint violations the toolchain reported; empty for a public composition's reader.",
    )
    diagnostics: list[CompositionDiagnosticView] = Field(
        description=(
            "What the evaluation found, located in the version's content (null span where it has no place there); "
            "empty for a public composition's reader."
        ),
    )
    compilation: Optional[EvaluationCompilation]
    binding: Optional[dict[str, str]] = Field(
        description=(
            "The candidate the toolchain was given for each service task, `{task: \"<resource>/<id>\"}` (the key "
            "a problem's facts give each candidate); local tasks are absent. Null for a declared evaluation, "
            "and for a public composition's reader."
        ),
    )
    current: bool = Field(description="Whether this is the version's current evaluation.")
    created_at: datetime
    offering: Optional[EvaluationOffering] = Field(
        default=None,
        description="The offering version read when this evaluation was created; null for a document without an offering.",
    )


class EvaluationSummaryCompilation(BaseModel):
    """The compilation an evaluation evaluated, as a row of a version list names it."""

    compilation_digest: str
    semantic_digest: str
    toolchain: dict[str, Any]


class EvaluationSummary(BaseModel):
    """A version's current evaluation, named: what a list row shows without the evaluations themselves."""

    id: uuid.UUID
    basis: Literal["bim", "declared"]
    outcome: Literal["verified", "binding_invalid", "semantics_changed", "declared"]
    compilation: Optional[EvaluationSummaryCompilation] = Field(description="Null for a declared evaluation.")
    created_at: datetime


class VersionDerivationRun(BaseModel):
    """The run a version was derived from (`evidence.run` in its document); the run itself stays private."""

    id: uuid.UUID


class VersionDerivationRevision(BaseModel):
    """The problem revision a version was derived from."""

    id: Optional[uuid.UUID] = Field(description=_MEMBERS_ONLY)
    revision: int


class VersionDerivation(BaseModel):
    """Where a derived version came from: a run's solution (`run`, `point`) or a binding given with a revision."""

    source: Literal["run", "binding"]
    run: Optional[VersionDerivationRun] = Field(description="The run, for a version derived from one.")
    point: Optional[int] = Field(description="The solution of the run, for a version derived from one.")
    revision: VersionDerivationRevision


class EvidenceRun(BaseModel):
    """The run a version's evidence names (`evidence.run` in its document); the run itself stays private."""

    id: uuid.UUID


class ForkedFromOrganization(BaseModel):
    """The organization a version was forked from, as it was named then."""

    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    name: str = Field(description="Its slug (SPHERE's organization `name`).")
    display_name: str = Field(alias="displayName", description="Its display name.")


class ForkedFrom(BaseModel):
    """What a version was forked from, as it was named when it was forked.

    For a reader who is not a member, the source is named only while it is public (or is this same
    composition); otherwise every field but `droppedProblem` is null.
    """

    model_config = ConfigDict(populate_by_name=True)

    composition_id: Optional[uuid.UUID] = Field(default=None, alias="compositionId")
    version_id: Optional[uuid.UUID] = Field(default=None, alias="versionId")
    label: Optional[str] = None
    organization: Optional[ForkedFromOrganization] = None
    slug: Optional[str] = None
    name: Optional[str] = None
    dropped_problem: bool = Field(
        alias="droppedProblem",
        description="The fork removed the source's problem link and evidence, so its values are the source's, declared.",
    )


class CompositionVersionView(BaseModel):
    """A sealed version of a composition: immutable."""

    id: uuid.UUID
    ordinal: int = Field(ge=1)
    label: str = Field(description="The document's `version:` (Semantic Versioning).")
    syntax_version: str = Field(description="The `syntaxVersion` the version was sealed with.")
    kind: CompositionKindName
    values_status: ValuesStatusName = Field(
        description="`verified`: the values are the toolchain's; `declared`: they are the author's.",
    )
    verified: bool = Field(description="Whether the current evaluation verified the binding and computed the values.")
    content_digest: str = Field(description="Digest of the canonical bytes; the content's `ETag`.")
    size_bytes: int = Field(ge=1)
    values: dict[str, ValueView] = Field(description="The values of the current evaluation.")
    problem: Optional[VersionLink] = Field(description="The problem the version links; null for a declared one.")
    offering: Optional[dict[str, str]] = Field(description="The offering's source: `{sphere, registry?}` or `{url}`.")
    evidence_run: Optional[EvidenceRun]
    based_on: Optional[dict[str, Any]] = Field(
        description=(
            "The version it was forked from, as data: `{composition_id, version_id, label}`. For a reader who is "
            "not a member, null unless that source is public now."
        ),
    )
    forked_from: Optional[ForkedFrom] = Field(
        default=None, description="What it was forked from; null when it was not forked.",
    )
    analytics: Optional[dict[str, Any]] = Field(
        default=None,
        description=(
            "A summary of the document computed at seal: `tasks`, `boundTasks`, `localTasks`, `providers`, "
            "`upstreamPricings`, `workflow{depth, xor, and, loop}`, `hasOffering`. In a list, only with "
            "`include=analytics`."
        ),
    )
    derivation: Optional[VersionDerivation] = Field(
        description="Where it was derived from; null for a version sealed from a document or forked.",
    )
    evaluations: list[EvaluationView] = Field(
        description=(
            "Its evaluations, oldest first; only the current one for a reader who is not a member. In a list, "
            "only with `include=evaluations` (else empty)."
        ),
    )
    current_evaluation_id: Optional[uuid.UUID]
    current_evaluation: Optional[EvaluationSummary] = Field(
        description="The current evaluation, named; null while the version has none.",
    )
    document: Optional[dict[str, Any]] = Field(
        default=None,
        description=(
            "The version's content as the canonical JSON model (as `parseComposition` answers it), read as it "
            "was sealed; only with `include=document`."
        ),
    )
    created_by_id: Optional[uuid.UUID] = Field(description=_MEMBERS_ONLY)
    created_at: datetime


class CompositionVersionList(BaseModel):
    """One page of a composition's versions, and how many it has."""

    versions: list[CompositionVersionView]
    total: int
    limit: int
    offset: int


class SealResult(BaseModel):
    """A sealed version, the evaluation stored for it, and what the seal found in the submitted text."""

    version: CompositionVersionView
    evaluation: EvaluationView
    diagnostics: list[CompositionDiagnosticView] = Field(
        description="Every warning and info, located in the submitted text.",
    )


class CheckResult(BaseModel):
    """The lint of a document against its problem: 200 whether or not it is valid; nothing is stored."""

    valid: bool = Field(description="Whether a seal would accept the document.")
    values_status: Optional[ValuesStatusName] = Field(
        description="What a seal would store: `verified` for a linked document, `declared` for one with no problem.",
    )
    values: Optional[dict[str, ValueView]] = Field(description="The values a seal would store; null when not valid.")
    content: Optional[str] = Field(description="The exact canonical text a seal would store; null when not valid.")
    diagnostics: list[CompositionDiagnosticView]


CompositionView.model_rebuild()


# -- Diff and fork ---------------------------------------------------------------------------------------


class VersionName(BaseModel):
    """A version, by id and label."""

    id: uuid.UUID
    label: str


class CompositionVersionDiff(DiffResult):
    """What changed from one version of a composition to another."""

    from_version: VersionName = Field(alias="from", description="The earlier side.")
    to_version: VersionName = Field(alias="to", description="The later side.")


class CompositionFork(BaseModel):
    """A version of a composition to fork into another organization, as a new composition there."""

    model_config = ConfigDict(extra="forbid", populate_by_name=False)

    version: str = Field(min_length=1, max_length=64, description="The version to fork: its id, label or ordinal.")
    target_organization: str = Field(
        alias="targetOrganization", min_length=1, max_length=64,
        description="The organization to fork into (slug or id); not the source's own.",
    )
    slug: Optional[str] = Field(
        default=None, pattern=SLUG,
        description="The new composition's slug; the source's by default. Taken by default is 200 `nameTaken`, taken when given is 409.",
    )
    name: Optional[str] = Field(default=None, min_length=1, max_length=160, description="The source's by default.")
    description: Optional[str] = Field(default=None, max_length=2000, description="The source's by default.")
    drop_problem: bool = Field(
        default=False, alias="dropProblem",
        description=(
            "Fork a version that links a problem anyway: its `problem` and `evidence` are removed and its values "
            "sealed as declared. Without it, such a fork is 409 `composition_fork_problem_unreadable`."
        ),
    )


class ForkResult(BaseModel):
    """The new composition and its first version, sealed from the source's document."""

    model_config = ConfigDict(populate_by_name=True)

    composition: CompositionView
    version: CompositionVersionView
    dropped_problem: bool = Field(
        alias="droppedProblem", description="Whether the source's problem link was removed (`dropProblem`).",
    )


class ExistingComposition(BaseModel):
    """The composition that holds the slug a fork would take."""

    id: uuid.UUID
    slug: str
    name: str


class ForkNameTaken(BaseModel):
    """Nothing was forked: the source's slug is taken in the target organization; name another `slug`."""

    model_config = ConfigDict(populate_by_name=True)

    name_taken: Literal[True] = Field(alias="nameTaken")
    existing_composition: ExistingComposition = Field(alias="existingComposition")


# -- Re-evaluation, other bindings and the neighbourhood --------------------------------------------------


class CompositionEvaluate(BaseModel):
    """A version of a composition to evaluate, with some of its tasks bound otherwise."""

    model_config = ConfigDict(extra="forbid")

    version: Optional[str] = Field(
        default=None, min_length=1, max_length=64,
        description="The version to evaluate: its id, label or ordinal; the latest by default.",
    )
    binding: Optional[dict[str, str]] = Field(
        default=None, max_length=1024,
        description=(
            "Tasks to bind otherwise, each to a candidate as a document names it (its id, or `<resource>/<id>`); "
            "the other tasks keep the version's binding."
        ),
    )
    users: Optional[int] = Field(
        default=None, ge=1, le=1_000_000_000,
        description="The users the upstream cost is divided by: the answer then carries the margins per plan.",
    )
    revision: Optional[int] = Field(
        default=None, ge=1, le=2**31 - 1,
        description=(
            "Evaluate against this revision of the linked problem instead (a demand variant), in memory: nothing is "
            "stored and the version keeps its link."
        ),
    )


class EvaluateResult(BaseModel):
    """A binding of a version as the toolchain evaluated it; nothing is stored."""

    version: VersionName
    valid: bool = Field(description="Whether the binding holds: the toolchain reports no hard violation.")
    values: dict[str, ValueView] = Field(description="The global values the toolchain computed for this binding.")
    violations: list[dict[str, Any]] = Field(description="The constraint violations the toolchain reported.")
    diagnostics: list[CompositionDiagnosticView] = Field(
        description="What the evaluation found; a finding about a task the request rebinds points at `/binding/<task>`.",
    )
    revision: Optional["EvaluatedRevision"] = Field(
        default=None, description="The problem revision evaluated, and the capacity demand its recipe states.",
    )
    margins: Optional["CompositionMargins"] = Field(
        default=None,
        description=(
            "The margins per plan of these values, against the offering version the version's current evaluation "
            "read; present when `users` is given or that evaluation read an offering."
        ),
    )


class EvaluatedDemand(BaseModel):
    name: str
    value: Optional[float]
    unit: str


class EvaluatedRevision(BaseModel):
    number: int
    demand: list[EvaluatedDemand] = Field(description="Empty for a problem not generated from SPHERE.")


class CompositionMove(CounterfactualMove):
    """One alternative of the version's binding: one task bound to another candidate."""

    candidate: str = Field(description="The candidate the move binds (`to`), as a document names it.")


class CompositionNeighborhoodResponse(NeighborhoodDocument):
    """The toolchain's one-task alternatives of a version's binding."""

    moves: list[CompositionMove]
    version: VersionName


# -- Derivation ------------------------------------------------------------------------------------------


class CompositionDerive(BaseModel):
    """A binding of a problem to derive a version from: a run's solution, or a binding given with a revision."""

    model_config = ConfigDict(extra="forbid")

    run: Optional[uuid.UUID] = Field(default=None, description="The run whose solution is derived (with `point`).")
    point: Optional[int] = Field(
        default=None, ge=0, description="The solution of the run: its index in the run's result; 0 by default.",
    )
    revision: Optional[str] = Field(
        default=None, min_length=3, max_length=200,
        description="The problem revision to derive from (with `binding`): `<problem>@<revision>`, each by slug, id or number.",
    )
    binding: Optional[dict[str, str]] = Field(
        default=None, max_length=1024,
        description=(
            "With `revision`: each service task's candidate, as a document names it (its id, or `<resource>/<id>`). "
            "Local tasks are bound `local: true` on their own."
        ),
    )
    version: str = Field(
        min_length=5, max_length=ids.MAX_SEMVER_CHARS, pattern=ids.SEMVER.pattern,
        description="The derived version's `version:` (Semantic Versioning). Required: it is part of the bytes.",
    )
    kind: Optional[CompositionKindName] = Field(default=None, description="The composition's by default.")
    offering: Optional[dict[str, Any]] = Field(
        default=None,
        description="The composition's offering, `{sphere, registry?}` or `{url}`; a derivation writes none by default.",
    )
    seal: bool = Field(default=True, description="Store the version (`true`), or only answer the document it would be.")

    @model_validator(mode="after")
    def _one_source(self) -> "CompositionDerive":
        if (self.run is None) == (self.revision is None):
            raise ValueError("give exactly one source: `run` (and `point`), or `revision` and `binding`")
        if self.run is not None and self.binding is not None:
            raise ValueError("`binding` goes with `revision`; a run's binding is its solution at `point`")
        if self.revision is not None and self.binding is None:
            raise ValueError("`revision` needs `binding`: each service task's candidate")
        if self.revision is not None and self.point is not None:
            raise ValueError("`point` goes with `run`")
        return self


class DerivationView(BaseModel):
    """How a version was derived: the binding, where it came from and where the toolchain evaluated it."""

    id: uuid.UUID
    source: Literal["run", "binding"]
    revision_id: uuid.UUID
    compilation_id: uuid.UUID = Field(description="The compilation the derived document links (the run's, for a run).")
    job_id: Optional[uuid.UUID] = Field(description="The run it was derived from.")
    point: Optional[int] = Field(description="The solution of the run.")
    binding: dict[str, dict[str, str]] = Field(description="`{task: {resource, id}}`, as the toolchain was given it.")
    binding_digest: str
    provenance: dict[str, Any] = Field(
        description=(
            "`{toolchain, irDigest, semanticDigest, evaluatedCompilationId, run}`: the compilation evaluated and, "
            "for a run, its `{engine, engineDigest, mode, evaluatorDigest}`."
        ),
    )
    created_by_id: uuid.UUID
    created_at: datetime


class DeriveResult(BaseModel):
    """A derived version, sealed: the version, its evaluation, its derivation and what deriving found."""

    version: CompositionVersionView
    evaluation: EvaluationView
    derivation: DerivationView
    diagnostics: list[CompositionDiagnosticView] = Field(
        description="Every warning and info, located in the version's content.",
    )


class DeriveDraft(BaseModel):
    """The version a derivation would seal (`seal: false`); nothing is stored."""

    content: str = Field(description="The exact canonical text a seal would store.")
    document: dict[str, Any] = Field(description="The same document, as JSON.")
    values: dict[str, ValueView] = Field(description="The values the toolchain computed for the binding.")
    diagnostics: list[CompositionDiagnosticView] = Field(description="Every warning and info, located in `content`.")


# -- Graph, follows and permanent links ------------------------------------------------------------------


class GraphEdge(BaseModel):
    """The version a version was forked from."""

    composition_id: uuid.UUID
    version_id: Optional[uuid.UUID] = None
    label: Optional[str] = None


class GraphVersion(BaseModel):
    id: Optional[uuid.UUID] = Field(description="Null on an unavailable lane, which knows only labels.")
    label: str
    created_at: Optional[datetime] = None
    forked_from: Optional[GraphEdge] = None


class GraphOrganization(BaseModel):
    id: Optional[uuid.UUID] = None
    slug: Optional[str] = None
    name: Optional[str] = None


class GraphLane(BaseModel):
    """A composition of the graph: this one (`current`) or one a version was forked from (`source`)."""

    role: Literal["current", "source"]
    available: bool = Field(description="False for a source the caller does not read: only what its forks name.")
    composition_id: uuid.UUID
    organization: Optional[GraphOrganization] = None
    slug: Optional[str] = None
    name: Optional[str] = None
    versions: list[GraphVersion]


class CompositionGraph(BaseModel):
    """The version graph of a composition, as SPHERE's pricing version graph: newest versions first."""

    lanes: list[GraphLane]
    truncated: bool = Field(description="More source lanes exist than were drawn (at most 20).")


class FollowState(BaseModel):
    following: bool


class PermanentLink(BaseModel):
    location: str = Field(
        description="The application path of the composition (`/compositions/{org}/{composition}`), with "
        "`?version=` when the link names a version the caller reads.",
    )


# -- Upstream pricings (``getCompositionUpstream``) --------------------------------------------------------------------


class UpstreamSnapshot(BaseModel):
    """A stored pricing snapshot, by names and dates: the renderer reads its YAML at `…/pricing-snapshots/{id}/yaml`."""

    id: uuid.UUID
    title: str
    owner: Optional[str]
    slug: Optional[str]
    pricingId: Optional[str]
    versionId: Optional[str]
    versionName: Optional[str]
    createdAt: Optional[str]
    registry: Optional[str]
    url: Optional[str]
    permanentUrl: Optional[str] = Field(description="SPHERE's permanent link to that version.")


class UpstreamPlan(BaseModel):
    name: str
    price: dict[str, Any] = Field(description="`{kind: fixed, amount}`, `{kind: expression, source, value}` or `{kind: label, text}`.")
    unit: Optional[str]
    private: bool


class UpstreamEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    task: str
    candidate: str
    from_: Optional[dict[str, Any]] = Field(alias="from", description="The entry's `from`, as the document writes it.")
    status: Literal["snapshotted", "not_snapshotted", "registry_unknown"]
    snapshot: Optional[UpstreamSnapshot]
    plan: Optional[UpstreamPlan] = Field(description="The plan in the snapshot, when the entry names one it has.")


class UpstreamValue(BaseModel):
    sources: list[Literal["priced", "guarantee", "limit", "feature", "manual"]] = Field(
        description="The kinds of source the bound candidates' values of this global value have.",
    )
    manualOnly: bool = Field(description="No bound candidate's value of it was read from a pricing.")


class UpstreamOffering(BaseModel):
    source: dict[str, str] = Field(description="The offering's source as the version keeps it: `{sphere, registry?}` or `{url}`.")
    status: Optional[Literal["read", "unreadable", "invalid_pricing", "registry_unknown"]]
    versionName: Optional[str]
    createdAt: Optional[str]
    snapshot: Optional[UpstreamSnapshot]


class UpstreamView(BaseModel):
    """A version's upstream plans, the sources of its global values and its offering: stored data only."""

    version: str
    entries: list[UpstreamEntry]
    values: dict[str, UpstreamValue]
    offering: Optional[UpstreamOffering] = Field(description="The offering version the current evaluation read.")


# -- Composition environments ----------------------------------------------------------------------------

#: Who may adopt in an environment: the weakest role.
AdoptRoleName = Literal["MEMBER", "ADMIN"]
_ENVIRONMENT_SLUG = r"^[a-z][a-z0-9-]{0,39}$"
_USERS = {"ge": 1, "le": 1_000_000_000}


class EnvironmentPerson(BaseModel):
    """A person as an environment names one: never an email."""

    username: str
    displayName: str


class EnvironmentOperator(EnvironmentPerson):
    """The member answerable for an environment."""

    member: bool = Field(description="False once they are no longer a member of the organization.")


class EnvironmentVersion(BaseModel):
    id: uuid.UUID
    label: str
    ordinal: int


class EnvironmentEvaluation(BaseModel):
    """The evaluation an adoption pinned: the environment's margins read it."""

    id: uuid.UUID
    basisKey: str
    valuesStatus: Literal["verified", "declared"]
    outcome: Literal["verified", "binding_invalid", "semantics_changed", "declared"]


class EnvironmentOffering(BaseModel):
    """The offering version the pinned evaluation read; names and dates, never a digest."""

    status: Literal["read", "unreadable", "invalid_pricing", "registry_unknown"]
    versionName: Optional[str]
    createdAt: Optional[str]


class EnvironmentBound(BaseModel):
    candidate: str


class EnvironmentInEffect(BaseModel):
    """What an environment's feed serves: the version adopted last, and who adopted it."""

    adoption: int = Field(description="The adoption's number in this environment (1, 2, 3 …).")
    version: EnvironmentVersion
    adoptedAt: datetime
    adoptedBy: Optional[EnvironmentPerson]
    note: str
    evaluation: Optional[EnvironmentEvaluation]
    offering: Optional[EnvironmentOffering]
    binding: dict[str, EnvironmentBound] = Field(description="The candidate each bound task names, as the document binds it.")


class EnvironmentFeed(BaseModel):
    path: str = Field(description="The feed's address; it never changes.")
    etag: Optional[str] = Field(description="The feed's current `ETag`, for API clients; null while nothing is adopted.")


class EnvironmentKeyView(BaseModel):
    """A feed key as its environment lists it: never its secret."""

    id: uuid.UUID
    hint: str = Field(description="The key's prefix, to recognise it: `obe_1a2b3c4d…`.")
    label: str
    createdAt: datetime
    createdBy: Optional[str] = Field(description="The username of whoever created it.")
    creatorIsMember: bool = Field(description="False once its creator is no longer a member: rotate it deliberately.")
    lastUsedAt: Optional[datetime]
    revokedAt: Optional[datetime]


class CompositionEnvironmentView(BaseModel):
    """A composition environment: where an application reads the version in effect."""

    id: uuid.UUID
    slug: str
    name: str
    description: str
    operator: Optional[EnvironmentOperator]
    adoptRole: AdoptRoleName
    expectedUsers: Optional[int]
    inEffect: Optional[EnvironmentInEffect] = Field(description="Null while nothing is adopted.")
    feed: EnvironmentFeed
    keys: Optional[list[EnvironmentKeyView]] = Field(
        description="Live feed keys and the five most recently revoked; ADMIN only (null for others).",
    )
    keyCount: int = Field(description="How many live feed keys the environment has.")
    createdAt: datetime
    updatedAt: datetime


class CompositionEnvironmentList(BaseModel):
    environments: list[CompositionEnvironmentView]


class CompositionEnvironmentCreate(BaseModel):
    """A new environment; its slug is part of its feed's address and never changes."""

    model_config = ConfigDict(extra="forbid")

    slug: str = Field(pattern=_ENVIRONMENT_SLUG, description="1 to 40 lowercase letters, digits and hyphens, a letter first.")
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    operator: Optional[str] = Field(default=None, min_length=1, max_length=64, description="A member's username.")
    adoptRole: AdoptRoleName = Field(default="ADMIN", description="The weakest role that may adopt in it.")
    expectedUsers: Optional[int] = Field(default=None, **_USERS, description="The users its margins assume.")


class CompositionEnvironmentUpdate(BaseModel):
    """What may change of an environment; its slug never does. A field left out stays as it is."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    description: Optional[str] = Field(default=None, max_length=500)
    operator: Optional[str] = Field(default=None, min_length=1, max_length=64, description="A member's username; null for none.")
    adoptRole: Optional[AdoptRoleName] = None
    expectedUsers: Optional[int] = Field(default=None, **_USERS, description="Null for none.")


class EnvironmentAdopt(BaseModel):
    """The version to adopt in an environment, and why."""

    model_config = ConfigDict(extra="forbid")

    version: str = Field(min_length=1, max_length=64, description="The version's id, label or ordinal.")
    note: str = Field(default="", max_length=500, description="Why it is adopted; kept in the history.")


class AdoptionEvaluation(BaseModel):
    id: uuid.UUID
    basisKey: str
    valuesStatus: Literal["verified", "declared"]


class AdoptionOffering(BaseModel):
    versionName: Optional[str]
    createdAt: Optional[str]


class CompositionAdoptionView(BaseModel):
    """One adoption of an environment's history: insert only."""

    ordinal: int = Field(description="The adoption's number in its environment (1, 2, 3 …).")
    version: VersionName
    previousVersion: Optional[VersionName] = Field(description="The version in effect before; null for the first.")
    adoptedAt: datetime
    adoptedBy: Optional[EnvironmentPerson]
    note: str
    evaluation: Optional[AdoptionEvaluation] = Field(description="The evaluation the adoption pinned.")
    offering: Optional[AdoptionOffering] = Field(description="The offering version that evaluation read.")
    feedEtag: str = Field(description="The feed's `ETag` after this adoption: the version's content digest, quoted.")


class CompositionAdoptionList(BaseModel):
    adoptions: list[CompositionAdoptionView] = Field(description="Newest first.")
    nextBefore: Optional[int] = Field(description="Send as `before` for the next page; null on the last one.")


class EnvironmentAdoptResult(BaseModel):
    """The environment with its new version in effect, and the adoption that put it there."""

    environment: CompositionEnvironmentView
    adoption: CompositionAdoptionView


class FeedKeyCreate(BaseModel):
    """A new feed key of an environment."""

    model_config = ConfigDict(extra="forbid")

    label: str = Field(default="", max_length=80, description="What reads with it, to recognise it later.")


class FeedKeyCreated(BaseModel):
    """A new feed key: its secret is shown here once and never again."""

    key: EnvironmentKeyView
    secret: str = Field(description="The whole key (`obe_…`): configure the application with it now.")


class CheckVersion(BaseModel):
    id: uuid.UUID
    label: str


class CheckBinding(BaseModel):
    status: Literal["valid", "invalid", "declared"] = Field(
        description="The stored content assessed on the installed toolchain, as `versions/check` assesses a document.",
    )
    toolchain: Optional[str] = Field(description="The installed toolchain's digest; null for a declared version.")
    diagnostics: list[CompositionDiagnosticView]


class CheckPinned(BaseModel):
    versionId: Optional[str]
    name: Optional[str]
    createdAt: Optional[str]


class CheckUpstream(BaseModel):
    """One bound task's upstream pricing: the version it pins against the one its source calls latest now."""

    task: str
    sphere: Optional[str]
    plan: Optional[str]
    pinned: Optional[CheckPinned]
    latest: Optional[CheckPinned]
    status: Literal["current", "newer", "unavailable", "not_snapshotted"]


class CheckOfferingVersion(BaseModel):
    versionName: Optional[str]
    createdAt: Optional[str]


class CheckOffering(BaseModel):
    source: Optional[dict[str, str]]
    pinned: Optional[CheckOfferingVersion] = Field(description="The version the adoption's evaluation read.")
    latest: Optional[CheckOfferingVersion]
    status: Literal["current", "newer", "unavailable", "none"]


class EnvironmentCheck(BaseModel):
    """What the composition in effect pins against what its sources publish now; nothing was written."""

    checkedAt: datetime
    version: CheckVersion
    binding: CheckBinding
    upstream: list[CheckUpstream]
    offering: CheckOffering


# -- Margins ---------------------------------------------------------------------------------------------

MarginsStatus = Literal[
    "ok", "users_required", "no_offering", "offering_unreadable", "offering_invalid", "offering_registry_unknown",
    "no_cost_value", "ambiguous_cost", "currency_mismatch", "binding_invalid", "semantics_changed",
    "amount_out_of_range",
]
_AMOUNT = "A fixed six-place decimal string."


class MarginsEvaluation(BaseModel):
    id: uuid.UUID
    basisKey: str
    valuesStatus: Literal["verified", "declared"]
    outcome: Literal["verified", "binding_invalid", "semantics_changed", "declared"]


class MarginsOffering(BaseModel):
    source: Optional[dict[str, str]]
    status: Optional[Literal["read", "unreadable", "invalid_pricing", "registry_unknown"]]
    versionName: Optional[str]
    createdAt: Optional[str]
    snapshot: Optional[uuid.UUID] = Field(description="The pricing snapshot read (`…/pricing-snapshots/{snapshot}`).")
    currency: Optional[str]


class MarginsCost(BaseModel):
    """The global value taken as the composition's upstream cost, and its monthly amount."""

    name: str
    value: Optional[str] = Field(description=_AMOUNT + " Null when it is out of range.")
    unit: str
    monthly: Optional[str] = Field(description=_AMOUNT)


class MarginsBilling(BaseModel):
    id: str
    multiplier: str


class MarginRow(BaseModel):
    """One plan of the offering, alone or with one add-on: its revenue per subscription and month, and margin."""

    plan: str
    planName: str
    addOns: list[str]
    basis: Literal["subscription", "seat"] = Field(description="`seat`: a per-seat price counted for one seat.")
    private: bool
    requiresQuote: bool = Field(description="A price that is a label or an expression that failed: no revenue.")
    outOfRange: bool = Field(description="An amount beyond 10^12 or not finite: no revenue or margin.")
    excludedParts: list[str] = Field(description="Parts without a period (one-off or metered), left out of the revenue.")
    revenue: Optional[str] = Field(description=_AMOUNT)
    cost: Optional[str] = Field(description="The cost per user. " + _AMOUNT)
    margin: Optional[str] = Field(description="`revenue - cost`. " + _AMOUNT)


class CompositionMargins(BaseModel):
    """Margin per offering plan: revenue minus the upstream cost per user, apportioned uniformly.

    Every amount is a six-place decimal string in `currency` per month. `status` is `ok` only when every margin
    could be computed; otherwise the rows carry their revenue and null margins (or there are no rows when the
    offering could not be read).
    """

    version: VersionName
    evaluation: Optional[MarginsEvaluation] = Field(
        description="The stored evaluation read; null for the margins of a what-if binding (`evaluateComposition`).",
    )
    offering: Optional[MarginsOffering]
    cost: Optional[MarginsCost]
    users: Optional[int]
    billing: Optional[MarginsBilling]
    apportionment: Literal["uniform"]
    status: MarginsStatus
    currency: Optional[str]
    costPerUser: Optional[str] = Field(description=_AMOUNT)
    rowsTruncated: bool = Field(description="More than 200 rows: the first 200, in declared order.")
    rows: list[MarginRow]
    warnings: list[Literal["declared_values", "rows_truncated", "amount_out_of_range"]]


EvaluateResult.model_rebuild()


# -- Composition templates (F4-B) ------------------------------------------------------------------------------

_TEMPLATE_ID = r"^[a-z][a-z0-9-]{0,39}$"


class CompositionTemplateSummary(BaseModel):
    """A template a member starts a composition from: a problem and a composition derived from it."""

    id: str
    title: str
    summary: str
    kind: CompositionKindName
    tasks: list[str] = Field(description="The tasks the composition binds, in the manifest's order.")
    hasOffering: bool = Field(description="Whether the composition names an offering (margins are computed from it).")
    available: bool = Field(description="Whether this deployment can instantiate it now.")
    unavailableReason: Optional[Literal["sphere_disabled"]] = Field(
        description="Why it is not available: `sphere_disabled` for a template that reads SPHERE while SPHERE is off.",
    )


class CompositionTemplateList(BaseModel):
    templates: list[CompositionTemplateSummary]


class TemplateProblemView(BaseModel):
    slug: str = Field(description="The problem's default slug.")
    name: str
    revisions: int = Field(ge=1, description="The revisions instantiating makes: 1, then one per SPHERE recipe.")


class TemplateCompositionView(BaseModel):
    slug: str = Field(description="The composition's default slug.")
    name: str
    label: str = Field(description="The first version's label.")
    workflow: Any = Field(description="The workflow the derived document writes, in Composition2Yaml's form.")
    binding: dict[str, str] = Field(description="Task -> the candidate the first version binds.")
    offering: Optional[dict[str, str]] = Field(description="The offering the first version names (`sphere` or `url`).")


class TemplateOperation(BaseModel):
    expectedUsers: Optional[int] = Field(
        default=None, description="A default for a later environment form; instantiating creates no environment.",
    )


class CompositionTemplateView(CompositionTemplateSummary):
    """One template with the problem it makes and the composition it derives."""

    problem: TemplateProblemView
    composition: TemplateCompositionView
    operation: TemplateOperation


class CompositionFromTemplate(BaseModel):
    """Instantiate a template in an organization: its problem and its composition, under these slugs."""

    model_config = ConfigDict(extra="forbid")

    template: str = Field(pattern=_TEMPLATE_ID, description="The template's id.")
    slug: Optional[str] = Field(default=None, pattern=SLUG, description="The composition's slug; the template's by default.")
    name: Optional[str] = Field(default=None, min_length=1, max_length=160, description="The composition's name.")
    problemSlug: Optional[str] = Field(default=None, pattern=SLUG, description="The problem's slug; the template's by default.")


class InstantiatedProblem(BaseModel):
    slug: str
    revision: int = Field(ge=1, description="The latest revision, which the first version links.")


class CompositionInstantiated(BaseModel):
    """What instantiating a template made."""

    template: str
    composition: CompositionView
    problem: InstantiatedProblem
    version: CompositionVersionView
    evaluation: EvaluationView
    operation: TemplateOperation

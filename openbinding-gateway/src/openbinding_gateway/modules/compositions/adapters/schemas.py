"""What the compositions routes read and answer, as HTTP documents.

The Composition2Yaml services (diagnostics, lint, parse, diff) and the compositions of an organization.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from ....models.analysis import CounterfactualMove, NeighborhoodDocument
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
    latest_version: Optional["CompositionVersionSummary"] = Field(
        default=None, description="The latest sealed version; null while it has none.",
    )
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


# -- Versions and their evaluations ----------------------------------------------------------------------


class CompositionVersionSummary(BaseModel):
    """A version, named."""

    id: uuid.UUID
    ordinal: int = Field(ge=1, description="1 for the first version sealed, then one more each time.")
    label: str = Field(description="The document's `version:` (Semantic Versioning).")
    values_status: ValuesStatusName
    created_at: datetime


class VersionProblem(BaseModel):
    """The problem a version links."""

    id: uuid.UUID
    slug: str
    name: str


class VersionRevision(BaseModel):
    """The revision of the problem a version links."""

    id: uuid.UUID
    revision: int


class VersionCompilation(BaseModel):
    """The compilation a version's document names."""

    id: uuid.UUID
    compilation_digest: str
    semantic_digest: str


class VersionLink(BaseModel):
    """The problem revision a version is judged against, and the compilation its document names."""

    problem: VersionProblem
    revision: VersionRevision
    linked_compilation: VersionCompilation


class EvaluationCompilation(BaseModel):
    """The compilation an evaluation evaluated: the toolchain's of that release."""

    id: uuid.UUID
    compilation_digest: str
    compiler_digest: str
    semantic_digest: str
    toolchain: dict[str, Any]


class ValueView(BaseModel):
    """A global value: the toolchain's float as it returned it, or the author's number, and its unit."""

    value: int | float
    unit: str = Field(description='The problem\'s unit; `"1"` for a dimensionless value.')


class EvaluationView(BaseModel):
    """One evaluation of a version: by one toolchain release (`bim`), or the author's values (`declared`)."""

    id: uuid.UUID
    basis: Literal["bim", "declared"]
    outcome: Literal["verified", "binding_invalid", "semantics_changed", "declared"]
    values: dict[str, ValueView]
    violations: list[dict[str, Any]] = Field(description="The constraint violations the toolchain reported.")
    diagnostics: list[CompositionDiagnosticView] = Field(
        description="What the evaluation found, located in the version's content (null span where it has no place there).",
    )
    compilation: Optional[EvaluationCompilation]
    current: bool = Field(description="Whether this is the version's current evaluation.")
    created_at: datetime


class EvidenceRun(BaseModel):
    """The run a version's evidence names."""

    id: uuid.UUID


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
        description="The version it was forked from, as data: `{composition_id, version_id, label}`.",
    )
    forked_from: Optional[dict[str, Any]] = Field(
        default=None,
        description=(
            "What it was forked from, as it was named when it was forked: `{compositionId, versionId, label, "
            "organization{id, name, displayName}, slug, name, droppedProblem}`. `droppedProblem` says the fork "
            "removed the source's problem link and evidence, so its values are the source's, declared."
        ),
    )
    analytics: Optional[dict[str, Any]] = Field(
        default=None,
        description=(
            "A summary of the document computed at seal: `tasks`, `boundTasks`, `localTasks`, `providers`, "
            "`upstreamPricings`, `workflow{depth, xor, and, loop}`, `hasOffering`. In a list, only with "
            "`include=analytics`."
        ),
    )
    evaluations: list[EvaluationView]
    current_evaluation_id: Optional[uuid.UUID]
    created_by_id: uuid.UUID
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


class EvaluateResult(BaseModel):
    """A binding of a version as the toolchain evaluated it; nothing is stored."""

    version: VersionName
    valid: bool = Field(description="Whether the binding holds: the toolchain reports no hard violation.")
    values: dict[str, ValueView] = Field(description="The global values the toolchain computed for this binding.")
    violations: list[dict[str, Any]] = Field(description="The constraint violations the toolchain reported.")
    diagnostics: list[CompositionDiagnosticView] = Field(
        description="What the evaluation found; a finding about a task the request rebinds points at `/binding/<task>`.",
    )


class CompositionMove(CounterfactualMove):
    """One alternative of the version's binding: one task bound to another candidate."""

    candidate: str = Field(description="The candidate the move binds (`to`), as a document names it.")


class CompositionNeighborhoodResponse(NeighborhoodDocument):
    """The toolchain's one-task alternatives of a version's binding."""

    moves: list[CompositionMove]
    version: VersionName

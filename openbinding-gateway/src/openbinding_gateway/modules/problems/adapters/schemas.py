"""What the problems API reads and answers, as HTTP documents."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

from ..domain.origin import ProblemOrigin


def _origin() -> Any:
    return Field(
        description="Where the revision came from: `upload`, `editor` (the problem editor), `qacoforge` or `sphere`; "
        "read from the upload's producer when it was stored.",
    )


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
    origin: ProblemOrigin = _origin()
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
    revision_count: int = Field(default=0, ge=0, description="How many revisions the problem has.")


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


class RevisionSphereSource(BaseModel):
    title: str
    versionLabel: Optional[str]


class RevisionSphere(BaseModel):
    """What a SPHERE import generated the revision from: the recipe's digest and the pricings it read."""

    recipeDigest: str
    sources: list[RevisionSphereSource]


class RevisionView(BaseModel):
    id: uuid.UUID
    problem_id: uuid.UUID
    revision: int
    package_digest: str
    instance_digest: Optional[str] = None
    package_size: int
    provenance: Optional[dict[str, Any]] = None
    origin: ProblemOrigin = _origin()
    created_by_id: uuid.UUID
    created_at: datetime
    sphere: Optional[RevisionSphere] = Field(
        default=None, description="For a revision a SPHERE import generated: its recipe digest and pricings.",
    )


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


# -- The facts of a compiled problem (``getProblemCompilationFacts``, ``validateBimPackage?include=facts``) --


class ProblemFactsEligible(BaseModel):
    """A candidate a task may take: its key, and how a Composition2Yaml document writes it for that task."""

    candidate: str = Field(description="`<resource>/<id>`: the candidate's key, the same as `ProblemFactsCandidate.key`.")
    written: str = Field(description="The candidate's id, or `<resource>/<id>` when two catalogs give the task that id.")


class ProblemFactsTask(BaseModel):
    id: str
    kind: Literal["service", "local"]
    eligible: list[ProblemFactsEligible] = Field(description="In the IR's order; empty for a local task.")


class ProblemFactsRange(BaseModel):
    """A range value: an end that is `null` has no limit."""

    min: Union[int, float, None]
    max: Union[int, float, None]


class ValueSourcePricing(BaseModel):
    """The upstream pricing a value was read from: names and immutable ids, never a digest."""

    sphere: Optional[str] = Field(description="`owner/slug` of the family in SPHERE when the value was read.")
    registry: Optional[str] = Field(description="The `SPHERE_REGISTRIES` alias, or null for the default SPHERE.")
    pricingId: str
    versionId: Optional[str]
    versionLabel: Optional[str] = Field(description="The version's name in SPHERE, as read.")
    plan: Optional[str] = Field(description="The plan, as the pricing names it.")
    addOns: list[str] = Field(description="The add-on taken with the plan, as the pricing names it (at most one in F3).")
    permanentUrl: Optional[str] = Field(description="SPHERE's permanent link to that version.")


class ValueSource(BaseModel):
    """Where a value written by a SPHERE import came from."""

    kind: Literal["priced", "guarantee", "limit", "feature", "manual"] = Field(
        description="`priced` (the plan's price per month), `guarantee`, `limit` (a usage limit), `feature`, or "
        "`manual` (set by hand when importing, or a hand-made candidate's value).",
    )
    pricing: Optional[ValueSourcePricing] = Field(description="Null for a value set by hand.")
    detail: dict[str, Any] = Field(
        description="How the value was read: the price parts and formula, the guarantee's table or scale and "
        "`docUrl`, the limit's raw value and unit, the manual key.",
    )
    carried: bool = Field(description="Whether an editor save kept this value (and so its source) from an earlier revision.")


class ProblemValueOrigin(BaseModel):
    """Where the package writes a value: the resource, its file and the JSON Pointer within it; and, for a value a
    SPHERE import wrote, where it came from."""

    kind: Literal["package"]
    resource: str
    path: str
    pointer: str
    source: Optional[ValueSource] = None


class CandidateProvenance(BaseModel):
    """The upstream plan a generated candidate was chosen from: what derive writes as a binding entry's `from`."""

    sphere: Optional[str] = Field(description="`owner/slug` of the family in SPHERE.")
    registry: Optional[str] = None
    version: str = Field(description="The SPHERE version id.")
    versionLabel: Optional[str]
    plan: Optional[str]
    addons: list[str] = Field(default_factory=list)
    pricingId: str
    snapshot: Optional[str] = Field(description="The pricing snapshot the values were read from.")
    permanentUrl: Optional[str]


class ProblemFactsCandidate(BaseModel):
    key: str = Field(description="`<resource>/<id>`, opaque.")
    resource: str
    id: str
    provider: Optional[str] = Field(description="The provider's id in the candidate's catalog.")
    values: dict[str, Union[int, float, ProblemFactsRange]] = Field(description="By application feature.")
    origins: dict[str, ProblemValueOrigin] = Field(description="By application feature.")
    properties: dict[str, Union[bool, int, float, str]] = Field(
        description="The candidate's scalar properties (what a task's requirement predicate reads), by name.",
    )
    propertyOrigins: dict[str, ProblemValueOrigin] = Field(description="By property.")
    provenance: Optional[CandidateProvenance] = Field(
        description="For a candidate a SPHERE import generated: the upstream plan its values were read from.",
    )


class ProblemFactsFeature(BaseModel):
    id: str
    unit: str
    direction: Optional[Literal["min", "max"]]
    required: bool = Field(description="Whether the evaluator reports it for every binding (`requiredFeatures`).")


class ProblemSourceOrigin(BaseModel):
    resource: str
    path: str
    pointer: str


class ProblemFactsConstraint(BaseModel):
    id: str = Field(description="`<resource>/<id>`.")
    enforcement: Literal["hard", "soft"]
    expression: dict[str, Any] = Field(description="The IR expression the constraint asserts.")
    when: Optional[dict[str, Any]] = Field(description="The IR expression that guards it, as the IR has it.")
    penalty: Optional[dict[str, Any]] = Field(description="The IR expression of a soft constraint's penalty.")
    origin: Optional[ProblemSourceOrigin]


class ProblemFactsObjectives(BaseModel):
    criteria: list[dict[str, Any]] = Field(description="`spec.optimization.criteria`, as the IR has them.")
    penalties: list[dict[str, Any]] = Field(description="`spec.optimization.penalties`, as the IR has them.")


class ProblemFactsView(BaseModel):
    """The facts of one compiled problem: what the workflow graph, the candidate matrix and the editors read.

    Computed by the gateway from the stored (or drafted) compilation; nothing in it is evaluated.
    """

    ir_digest: str
    tasks: list[ProblemFactsTask] = Field(description="In the order a depth-first walk of the workflow first meets each.")
    candidates: list[ProblemFactsCandidate] = Field(description="Every candidate of every catalog, by key.")
    features: list[ProblemFactsFeature]
    workflow: Any = Field(
        description="The workflow in the Composition2Yaml shape (`seq`, `and`, `xor`, `loop`): the `workflow:` "
        "a document derived from this compilation writes.",
    )
    constraints: list[ProblemFactsConstraint]
    objectives: ProblemFactsObjectives
    binding_space: Optional[str] = Field(description="The number of bindings, as a decimal string.")


# -- SPHERE imports (``sphere/expand``, ``sphere/apply``, ``sphere/recipe``) -------------------------------------------

#: The recipe; ``main.openapi_with_security_contract`` points it at the component ``SphereImportRecipe``, which is
#: ``resources/sphere-recipe/1/recipe.schema.json`` itself.
Recipe = dict[str, Any]


class SphereBase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1, description="The revision the import builds on: the latest one, for an apply.")


class SphereExpandRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recipe: Recipe
    base: Optional[SphereBase] = Field(
        default=None, description="Null for a new problem, whose slug is the `{problem}` of the address.",
    )


class SphereExpect(BaseModel):
    model_config = ConfigDict(extra="forbid")
    packageDigest: str = Field(pattern=r"^sha256-[0-9a-f]{64}$", description="The preview's `packageDigest`.")


class SphereApplyRequest(SphereExpandRequest):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160, description="A new problem's name.")
    expect: SphereExpect


class SphereFinding(BaseModel):
    """A `sphere_*` finding, or a compiler finding of the generated package."""

    model_config = ConfigDict(extra="allow")
    code: str
    severity: Literal["error", "warning", "info"]
    message: str
    at: str = Field(default="", description="A JSON Pointer into the recipe, a candidate key, or empty.")


class SphereRequirementTerm(BaseModel):
    property: str
    operator: Literal[">=", "=="]
    bound: Union[bool, int, float]
    value: Any
    satisfied: bool
    text: str = Field(description="`emailsPerDay: 100 < 1000`: the term in words, for the preview.")


class SphereCandidateSource(BaseModel):
    pricingId: str
    versionId: str
    registry: Optional[str]
    sphereRef: Optional[str]
    versionLabel: str


class SphereCandidate(BaseModel):
    key: str
    id: str
    task: str
    provider: str
    plan: Optional[str] = Field(description="The plan as the pricing names it; null for a hand-made candidate.")
    addOns: list[str]
    price: Optional[float] = Field(description="The subscription per month, when the recipe prices it.")
    eligible: bool = Field(description="Whether the task's requirements hold (the compiler decides the same).")
    requirements: list[SphereRequirementTerm]
    handMade: bool
    sphere: Optional[SphereCandidateSource]


class SphereSnapshotView(BaseModel):
    """A pricing version the preview read: names and dates, never a digest."""

    id: str
    pricingId: Optional[str]
    versionId: Optional[str]
    versionName: Optional[str]
    createdAt: Optional[str]
    title: str
    owner: Optional[str]
    slug: Optional[str]
    registry: Optional[str]
    currency: Optional[str]
    syntaxVersion: Optional[str]
    latest: Optional[bool] = Field(description="Whether it is the family's latest version (null when not read).")
    permanentUrl: Optional[str]


class SphereChangedCandidate(BaseModel):
    key: str
    values: dict[str, dict[str, Any]] = Field(default_factory=dict, description="`{feature: {before, after}}`.")
    properties: dict[str, dict[str, Any]] = Field(default_factory=dict, description="`{property: {before, after}}`.")


class SphereChanges(BaseModel):
    added: list[str]
    removed: list[str]
    changed: list[SphereChangedCandidate]


class SphereExpandView(BaseModel):
    """The preview of a recipe: what apply would store, and why each candidate is (in)eligible."""

    valid: bool = Field(description="No error: apply would store this package.")
    recipe: Optional[Recipe] = Field(description="The recipe with every version pinned (what apply stores).")
    recipeDigest: Optional[str]
    packageDigest: Optional[str] = Field(description="What apply's `expect.packageDigest` must be.")
    snapshots: list[SphereSnapshotView]
    candidates: list[SphereCandidate]
    changes: SphereChanges = Field(description="Against the base revision's facts.")
    diagnostics: list[SphereFinding]
    facts: Optional[ProblemFactsView] = Field(description="The generated package's facts, with their value sources.")


class SphereRecipeView(BaseModel):
    revision: int = Field(description="The revision the recipe generated.")
    recipeDigest: str
    recipe: Recipe

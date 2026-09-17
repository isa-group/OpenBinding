"""Public contract for bounded, canonical counterfactual analysis."""
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class NeighborhoodCoverage(BaseModel):
    total: int
    attempted: int
    evaluated: int
    complete: bool
    limit: int
    stopReason: Literal["evaluation-limit", "time-budget"] | None
    perTask: dict[str, int]


class CounterfactualMove(BaseModel):
    task: str
    from_ref: dict[str, str] = Field(alias="from")
    to: dict[str, str]
    decision: dict[str, Any]
    features: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, Any] = Field(default_factory=dict)
    objectives: dict[str, Any]
    violations: list[dict[str, Any]]
    feasible: bool
    comparison: Literal["better", "worse", "equal", "trade-off", "infeasible", "repairs-feasibility"]
    componentDeltas: list[dict[str, Any]]
    penaltyDelta: float


class NeighborhoodResponse(BaseModel):
    jobId: str
    solutionIndex: int
    kind: Literal["canonical-one-task-counterfactuals"]
    irDigest: str
    scope: Literal["all-service-tasks", "selected-service-task"]
    task: str | None
    base: dict[str, Any]
    moves: list[CounterfactualMove]
    failures: list[dict[str, Any]]
    coverage: NeighborhoodCoverage
    conclusion: str
    semantics: str


class AnalysisInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Requirement(AnalysisInput):
    dimension: str
    value: float
    space: Literal["raw", "normalized"] = "raw"


class AnalysisQuery(AnalysisInput):
    sources: list[str] = Field(min_length=1, max_length=1000)
    revision: str | None = None
    rule: Literal["balanced", "weighted", "ideal", "topsis", "chebyshev", "reference", "model"] = "balanced"
    weights: dict[str, float] = Field(default_factory=dict)
    reference: dict[str, float] = Field(default_factory=dict)
    requirements: list[Requirement] = Field(default_factory=list, max_length=128)
    axes: list[str] = Field(default_factory=list, max_length=3)
    view: Literal["decision", "budgets", "pareto", "preferences", "evidence"] = "decision"
    paretoScope: Literal["archive", "eligible"] = "archive"
    page: int = Field(0, ge=0)
    pageSize: int = Field(50, ge=1, le=200)
    search: str = Field("", max_length=256)
    status: Literal["all", "eligible", "feasible", "infeasible", "unknown", "excluded"] = "all"
    selected: str | None = None
    compare: list[str] = Field(default_factory=list, max_length=4)
    metric: Literal["euclidean", "manhattan", "hamming", "gower"] = "euclidean"
    neighbors: int = Field(10, ge=1, le=50)
    geometry: Literal["none", "voronoi", "power", "sensitivity"] = "none"
    # Display bounds only: brushing never changes recommendation eligibility.
    viewport: list[float] | None = Field(None, min_length=4, max_length=4)
    layers: bool = False


class AnalysisDimension(BaseModel):
    key: str
    label: str
    direction: Literal["minimize", "maximize"]
    kind: Literal["objective", "penalty"]
    unit: str | None = None
    minimum: float | None = None
    maximum: float | None = None
    rawMinimum: float | None = None
    rawMaximum: float | None = None
    constant: bool = True


class AnalysisSource(BaseModel):
    id: str
    engine: str
    state: str
    projectId: str | None = None
    createdAt: str
    irDigest: str | None = None
    evaluatorDigest: str | None = None
    resultDigest: str | None = None
    resultDigestKind: Literal["canonical-json", "stored-json"] = "canonical-json"
    legacy: bool = True
    compatible: bool | None = None
    diagnostic: bool = False


class AnalysisSources(BaseModel):
    items: list[AnalysisSource]
    nextCursor: str | None = None


class AnalysisRow(BaseModel):
    id: str
    feasible: bool | None
    eligible: bool
    reasons: list[str]
    losses: list[float] | None
    values: list[float] | None
    normalized: list[float] | None
    score: list[float] | None
    modelScore: Any = None
    rank: int | None
    scoreGroup: int | None
    paretoRank: int | None = None
    occurrences: int


class AnalysisResponse(BaseModel):
    version: str
    revision: str
    sources: list[AnalysisSource]
    dimensions: list[AnalysisDimension]
    counts: dict[str, int]
    rule: str
    formula: str
    modelOrderingAvailable: bool
    weights: dict[str, float]
    warnings: list[str]
    winners: list[AnalysisRow]
    winnerCount: int
    next: list[AnalysisRow]
    nextCount: int
    rows: list[AnalysisRow]
    total: int
    page: int
    pageSize: int
    pareto: dict[str, Any]
    plot: dict[str, Any]
    geometry: dict[str, Any] | None = None
    budgets: dict[str, Any] | None = None
    trajectory: list[dict[str, Any]] = Field(default_factory=list)


class AnalysisCandidateResponse(BaseModel):
    revision: str
    row: AnalysisRow
    binding: dict[str, Any]
    violations: list[Any]
    evaluation: dict[str, Any]
    features: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, Any] = Field(default_factory=dict)
    occurrences: list[dict[str, Any]]
    explanation: dict[str, Any]
    comparison: list[dict[str, Any]]
    dominance: dict[str, Any]
    neighbors: list[dict[str, Any]]


class AnalysisExport(AnalysisQuery):
    format: Literal["receipt", "json", "csv"] = "receipt"


class AnalysisReport(AnalysisQuery):
    organization: str
    project: str
    title: str = Field("Binding decision", min_length=1, max_length=200)
    slug: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=120)


class AnalysisTaskView(BaseModel):
    id: str
    revision: str
    state: Literal["queued", "running", "completed", "cancelled", "failed"]
    progress: float
    scope: str
    layers: bool
    error: str | None = None
    result: dict[str, Any] | None = None

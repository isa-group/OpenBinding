"""Public contract for bounded, canonical counterfactual analysis."""
from typing import Any, Literal

from pydantic import BaseModel, Field


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

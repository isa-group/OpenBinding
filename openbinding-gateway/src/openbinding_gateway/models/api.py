import json
from pathlib import Path
from functools import lru_cache
from typing import Dict, Any, Optional, List
from enum import Enum
from pydantic import BaseModel, Field, ConfigDict

from ..core.settings import get_settings

def _general_schema_path() -> Path:
    """Where the general schema lives, in order of preference.

    The configured path is what deployments set; the repository-relative
    path is what local development uses; /app is the Docker image layout.
    """
    env_path = get_settings().general_schema_path
    candidates = [Path(env_path)] if env_path else []
    candidates.append(Path(__file__).parents[4] / "schemas/general/schema.json")
    candidates.append(Path("/app/schemas/general/schema.json"))
    return next((path for path in candidates if path.exists()), candidates[-1])


@lru_cache(maxsize=1)
def general_schema() -> Dict[str, Any]:
    """The general schema, for the OpenAPI description of a solve request.

    Read on first use rather than at import time, and loudly: this used to be
    import-time I/O whose failure was swallowed, leaving the API documented
    with an empty schema and no sign of why.
    """
    path = _general_schema_path()
    if not path.exists():
        raise FileNotFoundError(
            f"General schema not found at {path}. Set GENERAL_SCHEMA_PATH to its location."
        )
    with open(path, "r") as handle:
        return json.load(handle)

class SolveRequest(BaseModel):
    engine_id: str = Field(..., description="ID of the target engine/solver")
    instance: Dict[str, Any] = Field(..., description="The general problem instance", json_schema_extra=lambda schema: schema.update(general_schema()))
    options: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Solver-specific options. E.g. {'iterations_count': 1000} for Random-Search.")
    verbose: bool = Field(default=False, description="If true, return diagnostics and warnings.")
    include_engine_report: bool = Field(
        default=False,
        description=(
            "If true, also return what the engine said before the gateway recomputed it, "
            "with a summary of where the two disagree. Separate from `verbose`, which "
            "controls diagnostics: this has a different purpose and a different size, and "
            "either is useful without the other."
        ),
    )

class SplitRequest(BaseModel):
    instance: Dict[str, Any] = Field(..., description="A whole problem instance to take apart.")


class SplitResponse(BaseModel):
    parts: Dict[str, Dict[str, Any]] = Field(
        ..., description="One entry per component of the tuple, keyed by part name."
    )
    groups: Dict[str, List[str]] = Field(
        ...,
        description=(
            "Which model of I' = (M_A, M'_C, Delta, O) each part belongs to. "
            "Parts that stand outside the tuple are grouped under 'other'."
        ),
    )


class ComposeRequest(BaseModel):
    parts: Dict[str, Dict[str, Any]] = Field(
        ..., description="The parts to merge, keyed by part name, as returned by split."
    )


class ComposeResponse(BaseModel):
    instance: Dict[str, Any] = Field(..., description="The instance the parts make.")


class BindingSpaceRequest(SolveRequest):
    offset: int = Field(default=0, ge=0, description="Offset for pagination (0-based index of the first binding to return).")
    limit: int = Field(default=100, ge=1, le=1000, description="Number of bindings to return (max 1000).")

class BindingSpacePage(BaseModel):
    total_combinations: str = Field(..., description="Total size of the binding space as a string.")
    offset: int
    limit: int
    bindings: List[Dict[str, str]] = Field(..., description="List of bindings, where each binding is a map of Task ID -> Candidate ID.")

class ValidationViolation(BaseModel):
    constraint_id: Optional[str] = None
    message: str
    path: Optional[str] = None
    code: str
    stage: Optional[str] = None
    # Extended fields for solution violations
    penalty: Optional[float] = None
    description: Optional[str] = None

class Solution(BaseModel):
    objective_value: Optional[float] = None
    binding: Dict[str, str] = Field(..., description="Map of Task ID to Candidate ID")
    aggregated_features: Dict[str, float] = Field(default_factory=dict)
    violations: List[ValidationViolation] = Field(default_factory=list)
    feasible: Optional[bool] = Field(
        default=None,
        description="Reference-evaluator verdict: True when no hard constraint is violated.",
    )
    engine_objective_value: Optional[float] = Field(
        default=None,
        description="Objective value as reported by the engine, before canonical re-evaluation.",
    )


class Feasibility(str, Enum):
    FEASIBLE = "FEASIBLE"
    INFEASIBLE = "INFEASIBLE"
    UNKNOWN = "UNKNOWN"

class Provenance(BaseModel):
    engine_id: str
    execution_time_ms: Optional[float] = None
    metadata: Optional[Dict[str, Any]] = None
    
    model_config = ConfigDict(extra='allow')

class BindingSpaceSummary(BaseModel):
    cardinality: str = Field(..., description="Total size of the binding space as a string (product of candidate counts).")
    log10_cardinality: float = Field(..., description="Approximate log10 of the cardinality.")
    per_task_counts: Dict[str, int] = Field(..., description="Map of Task ID to number of available candidates.")
    empty_tasks: List[str] = Field(default_factory=list, description="List of Task IDs that have 0 candidates.")

class AnalyzeWarning(BaseModel):
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None

class AnalyzeResponse(BaseModel):
    status: str = Field(default="validated", description="Validation status. 'validated' or 'failed'.")
    binding_space: Optional[BindingSpaceSummary] = None
    diagnostics: Optional[Dict[str, Any]] = None
    warnings: Optional[List[AnalyzeWarning]] = None
    provenance: Optional[Provenance] = None
    error: Optional[str] = None

class EngineDivergence(BaseModel):
    """Where the engine and the reference evaluator disagree.

    The interesting part of keeping an engine's own numbers. An engine that
    reports a solution feasible which the reference evaluator rejects has a bug
    in its semantics, and that is worth surfacing as a signal rather than
    leaving somebody to compare two lists by eye.
    """

    solutions_compared: int = Field(..., description="How many solutions were checked.")
    feasibility_mismatches: int = Field(
        default=0,
        description="Solutions the engine and the reference evaluator disagree about.",
    )
    max_objective_delta: Optional[float] = Field(
        default=None,
        description="Largest absolute difference between the engine's objective and the canonical one.",
    )
    notes: List[str] = Field(
        default_factory=list,
        description="One line per disagreement, naming the solution and what differs.",
    )

    @property
    def agrees(self) -> bool:
        return self.feasibility_mismatches == 0 and not self.notes


class EngineReport(BaseModel):
    """What the engine said, before the gateway recomputed it.

    The canonical result is the official one: metrics come from one reference
    evaluator rather than from four engines' arithmetic. That is deliberate, but
    it used to mean an engine's own account of its answer was discarded without
    trace. Asked for with ``include_engine_report``, this preserves it.

    Useful for two things. Comparing engines on a benchmark, where what each one
    *claims* is data. And finding the bug when a new engine's numbers drift from
    the reference - which is the divergence below.
    """

    solutions: List[Dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "Solutions as the engine reported them, in the general shape but before "
            "canonicalization - so directly comparable, field by field, with the "
            "canonical ones."
        ),
    )
    provenance: Optional[Dict[str, Any]] = Field(
        default=None, description="The engine's own provenance, before the gateway's is layered on."
    )
    raw: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "The untransformed engine body. What matters for an engine using its own "
            "field names. Size-capped; see `raw_truncated`."
        ),
    )
    raw_truncated: bool = Field(
        default=False,
        description="True when `raw` was dropped for being too large to be worth returning.",
    )
    divergence: Optional[EngineDivergence] = None


class SolveResponse(BaseModel):
    feasibility: Feasibility = Feasibility.UNKNOWN
    solutions: List[Solution]
    provenance: Provenance
    diagnostics: Optional[Dict[str, Any]] = Field(default=None, description="Diagnostic information. May include 'binding_space' if verbose=True.")
    engine_report: Optional[EngineReport] = Field(
        default=None,
        description=(
            "What the engine said before the gateway recomputed it. Present only when "
            "the request asked for it with `include_engine_report`."
        ),
    )

class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"

class JobResponse(BaseModel):
    job_id: str
    status: JobStatus
    result: Optional[SolveResponse] = None
    error: Optional[str] = None

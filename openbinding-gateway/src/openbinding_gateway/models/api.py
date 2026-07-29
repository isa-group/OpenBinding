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

class SolveResponse(BaseModel):
    feasibility: Feasibility = Feasibility.UNKNOWN
    solutions: List[Solution]
    provenance: Provenance
    diagnostics: Optional[Dict[str, Any]] = Field(default=None, description="Diagnostic information. May include 'binding_space' if verbose=True.")

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

import json
import os
from pathlib import Path
from typing import Dict, Any, Optional, List
from enum import Enum
from pydantic import BaseModel, Field, ConfigDict

# Try to look for schema relative to this file or in standard locations
_schema_path = Path(__file__).parents[5] / "schemas/universal/schema.json"
if not _schema_path.exists():
    _schema_path = Path("/app/schemas/universal/schema.json") # Docker default

_UNIVERSAL_SCHEMA = {}
if _schema_path.exists():
    try:
        with open(_schema_path, "r") as _f:
            _UNIVERSAL_SCHEMA = json.load(_f)
    except Exception:
        pass

class SolveRequest(BaseModel):
    engine_id: str = Field(..., description="ID of the target engine/solver")
    instance: Dict[str, Any] = Field(..., description="The universal problem instance", json_schema_extra=_UNIVERSAL_SCHEMA)
    options: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Solver-specific options. E.g. {'iterations_count': 1000} for Many-OBJ.")
    verbose: bool = Field(default=False, description="If true, return diagnostics and warnings.")

class ValidationViolation(BaseModel):
    constraint_id: Optional[str] = None
    message: str
    path: Optional[str] = None
    code: str
    # Extended fields for solution violations
    penalty: Optional[float] = None
    description: Optional[str] = None

class Solution(BaseModel):
    is_feasible: bool = True
    objective_value: Optional[float] = None
    binding: Dict[str, str] = Field(..., description="Map of Task ID to Candidate ID")
    aggregated_features: Dict[str, float] = Field(default_factory=dict)
    violations: List[ValidationViolation] = Field(default_factory=list)

class Provenance(BaseModel):
    engine_id: str
    execution_time_ms: Optional[float] = None
    metadata: Optional[Dict[str, Any]] = None
    
    model_config = ConfigDict(extra='allow')

class SolveResponse(BaseModel):
    solutions: List[Solution]
    provenance: Provenance
    diagnostics: Optional[Dict[str, Any]] = None

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

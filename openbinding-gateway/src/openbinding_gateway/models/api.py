from typing import Dict, Any, Optional, List
from enum import Enum
from pydantic import BaseModel, Field

class SolveRequest(BaseModel):
    engine_id: str = Field(..., description="ID of the target engine/solver")
    instance: Dict[str, Any] = Field(..., description="The universal problem instance")
    options: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Solver-specific options")

class ValidationViolation(BaseModel):
    constraint_id: Optional[str] = None
    message: str
    path: Optional[str] = None
    code: str

class SolveResponse(BaseModel):
    engine_id: str
    solution: Optional[Dict[str, Any]] = None
    provenance: Optional[Dict[str, Any]] = None
    diagnostics: Optional[Dict[str, Any]] = None
    errors: Optional[List[ValidationViolation]] = None

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

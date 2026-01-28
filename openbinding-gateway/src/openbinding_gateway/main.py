from fastapi import FastAPI, HTTPException, status
from contextlib import asynccontextmanager
from typing import List, Dict, Any
import json

from dotenv import load_dotenv

load_dotenv()

from .models.api import SolveRequest, SolveResponse, JobResponse, JobStatus, AnalyzeResponse, AnalyzeWarning, BindingSpaceSummary, Provenance
from .validation.pipeline import ValidationPipeline
from .validation.analysis import compute_binding_space_summary, generate_warnings
from .routing.router import Router
from .registry.engine import EngineRegistry
import time

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: could load plugins dynamically here
    print("Gateway starting up...")
    yield
    print("Gateway shutting down...")

app = FastAPI(title="OpenBinding Gateway", lifespan=lifespan)

from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pipeline = ValidationPipeline()
router = Router()

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/v1/engines")
async def list_engines():
    return EngineRegistry.list_engines()

def validate_and_prepare(request: SolveRequest):
    """
    Shared validation and preparation logic for solve and analyze endpoints.
    Returns a dict with validation results.
    """
    # Validate Engine ID
    try:
        EngineRegistry.get_plugin(request.engine_id)
    except ValueError:
        return {
            "valid": False,
            "error": f"Invalid engine_id: '{request.engine_id}'",
            "code": "engine_not_found"
        }

    # Stage 1: Universal Schema Validation
    violations = pipeline.validate_universal_schema(request.instance)
    if violations:
        return {
            "valid": False,
            "error": f"Universal Schema Violations: {json.dumps([v.model_dump() for v in violations])}",
            "violations": violations
        }

    # Full Validation (Stages 2-4)
    try:
        violations = pipeline.validate_full(request.engine_id, request.instance)
        if violations:
             return {
                "valid": False,
                "error": f"Semantic Violations: {json.dumps([v.model_dump() for v in violations])}",
                "violations": violations
            }
    except ValueError as e:
        return {"valid": False, "error": str(e), "code": "invalid_input"}
    except RuntimeError as e:
        return {"valid": False, "error": str(e), "code": "engine_error"}

    # Validation Passed. Compute Analysis if needed.
    # For analyze -> always compute. For solve -> only if verbose.
    # We can always compute counts/binding space as it's O(N).
    
    binding_space = compute_binding_space_summary(request.instance)
    warnings = generate_warnings(binding_space)
    
    return {
        "valid": True,
        "binding_space": binding_space,
        "warnings": warnings
    }

@app.post("/v1/analyze", response_model=AnalyzeResponse, status_code=status.HTTP_200_OK, response_model_exclude_none=True)
async def analyze(request: SolveRequest):
    start_time = time.time()
    result = validate_and_prepare(request)
    duration = (time.time() - start_time) * 1000

    if not result["valid"]:
        # Return failed analysis
        return AnalyzeResponse(
            status="failed",
            error=result["error"],
            provenance=Provenance(
                engine_id=request.engine_id,
                execution_time_ms=duration
            )
        )
    
    # Success
    binding_space = result["binding_space"]
    warnings = result["warnings"] or []

    # Get Engine-Specific Diagnostics (e.g. from plugin transformation)
    # This emulates router logic to get "engine-aware" diagnostics
    plugin_warnings = []
    try:
        plugin = EngineRegistry.get_plugin(request.engine_id)
        if plugin:
             # We ignore the payload, we just want warnings
             _, p_warnings = plugin.transform_request(request.instance, request.options)
             if p_warnings:
                 plugin_warnings = p_warnings
    except Exception as e:
        # If transformation fails during analysis, we might want to report it or just ignore
        # since validation passed. Let's add it as a warning.
        plugin_warnings = [f"Plugin transformation check failed: {str(e)}"]

    diagnostics = {}
    
    # If verbose, we include plugin warnings in diagnostics
    # BUT we explicitly DO NOT include binding_space as it is a top-level field.
    if request.verbose:
        if plugin_warnings:
             diagnostics["warnings"] = plugin_warnings
    
    return AnalyzeResponse(
        status="validated",
        binding_space=binding_space,
        warnings=warnings if warnings else None, # Top level returns only general warnings
        provenance=Provenance(
            engine_id=request.engine_id,
            execution_time_ms=duration
        ),
        diagnostics=diagnostics if diagnostics else None
    )

@app.post("/v1/solve", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED, response_model_exclude_none=True)
async def solve(request: SolveRequest):
    result = validate_and_prepare(request)
    
    if not result["valid"]:
        return JobResponse(
            job_id="invalid",
            status=JobStatus.FAILED,
            error=result["error"]
        )

    # Valid
    binding_space = result["binding_space"]
    warnings = result["warnings"]

    # Pass diagnostics info to router/job via metadata?
    # Router.route_solve takes request. We can modify request options or use a new arg?
    # Router takes request object.
    # We can inject data into request.options or similar, OR update Router to accept metadata.
    # Current Router signature: route_solve(request: SolveRequest)
    # The Job object is created inside route_solve (if sync) or updated later.
    # Ideally, we pass "warnings" and "binding_space" to route_solve.
    # But route_solve signature is fixed in router.py. I should modify router.py too.
    
    # For now, let's pass it via the request.options hack or modify router.
    # I plan to modify router.py, so let's assume route_solve will take metadata.
    # But route_solve currently takes only SolveRequest.
    # I will modify Router.route_solve to accept `extra_metadata`?
    
    # Actually, I can attach it to request using a temporary attribute if I don't want to change signature,
    # but clean way is to change signature.
    
    # Let's call route_solve with extra arguments provided I update router.py next.
    return await router.route_solve(request, binding_space=binding_space, warnings=warnings)

@app.get("/v1/jobs/{job_id}", response_model=JobResponse, response_model_exclude_none=True)
async def get_job(job_id: str):
    job = await router.get_job_status(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

import os
from fastapi.responses import FileResponse

@app.get("/v1/schemas/{engine_id}")
async def get_engine_schema(engine_id: str):
    # Verify engine exists
    try:
        EngineRegistry.get_plugin(engine_id)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Engine '{engine_id}' not found")

    # In Docker, schemas are mounted at /app/schemas
    # We assume standard naming convention: specializations/{engine_id}.schema.json
    schemas_dir = os.getenv("SCHEMAS_DIR", "/app/schemas")
    schema_path = os.path.join(schemas_dir, "specializations", f"{engine_id}.schema.json")
    
    if not os.path.exists(schema_path):
        raise HTTPException(status_code=404, detail=f"Schema for engine '{engine_id}' not found at {schema_path}")
        
    return FileResponse(schema_path)

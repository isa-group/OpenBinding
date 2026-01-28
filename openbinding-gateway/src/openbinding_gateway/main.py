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
    # We could technically load plugins dynamically here if we wanted to be fancy.
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
    Standard check-and-prep for both solving and analyzing.
    Ensures the engine exists and the instance follows our QoS schemas.
    """
    # Validate Engine ID
    try:
        EngineRegistry.get_plugin(request.engine_id)
    except ValueError:
        return {
            "valid": False,
            "error": f"Engine '{request.engine_id}' isn't registered here.",
            "code": "engine_not_found"
        }

    violations = pipeline.validate_general_schema(request.instance)
    if violations:
        return {
            "valid": False,
            "error": f"The instance doesn't follow the general QoS structure: {json.dumps([v.model_dump() for v in violations])}",
            "violations": violations
        }

    # Stages 2-4: Engine-specific schemas, semantic checks, and logic invariants.
    try:
        violations = pipeline.validate_full(request.engine_id, request.instance)
        if violations:
             return {
                "valid": False,
                "error": f"The problem has semantic or logical errors: {json.dumps([v.model_dump() for v in violations])}",
                "violations": violations
            }
    except ValueError as e:
        return {"valid": False, "error": str(e), "code": "invalid_input"}
    except RuntimeError as e:
        return {"valid": False, "error": str(e), "code": "engine_error"}

    # Everything looks good. Let's calculate the binding space size and check for empty tasks.
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

    # We also check if the engine plugin has any specific warnings (like ignored constraints).
    plugin_warnings = []
    try:
        plugin = EngineRegistry.get_plugin(request.engine_id)
        if plugin:
             _, p_warnings = plugin.transform_request(request.instance, request.options)
             if p_warnings:
                 plugin_warnings = p_warnings
    except Exception as e:
        # If transformation fails here, we just note it as a warning since basic validation passed.
        plugin_warnings = [f"Wait, engine-specific check failed: {str(e)}"]

    diagnostics = {}
    
    # Verbose mode includes these engine-specific details.
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
    
    # Hand the validated request over to the router to find a solution.
    return await router.route_solve(request, binding_space=binding_space, warnings=warnings)

@app.get("/v1/jobs/{job_id}", response_model=JobResponse, response_model_exclude_none=True)
async def get_job(job_id: str):
    job = await router.get_job_status(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

import os
from fastapi.responses import FileResponse

@app.get("/v1/schemas/general")
async def get_general_schema():
    # Serves the central QoS schema that everything should follow.
    schemas_dir = os.getenv("SCHEMAS_DIR", "/app/schemas")
    schema_path = os.path.join(schemas_dir, "general", "schema.json")
    
    if not os.path.exists(schema_path):
        raise HTTPException(status_code=404, detail="General schema not found on server.")
        
    return FileResponse(schema_path)

@app.get("/v1/schemas/{engine_id}")
async def get_engine_schema(engine_id: str):
    # Helps the frontend know which specific constraints an engine has.
    try:
        EngineRegistry.get_plugin(engine_id)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Engine '{engine_id}' isn't here.")

    schemas_dir = os.getenv("SCHEMAS_DIR", "/app/schemas")
    schema_path = os.path.join(schemas_dir, "specializations", f"{engine_id}.schema.json")
    
    if not os.path.exists(schema_path):
        raise HTTPException(status_code=404, detail=f"No specialized schema for {engine_id}.")
        
    return FileResponse(schema_path)

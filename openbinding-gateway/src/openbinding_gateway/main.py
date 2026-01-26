from fastapi import FastAPI, HTTPException, status
from contextlib import asynccontextmanager
from typing import List, Dict, Any
import json

from dotenv import load_dotenv

load_dotenv()

from .models.api import SolveRequest, SolveResponse, JobResponse, JobStatus
from .validation.pipeline import ValidationPipeline
from .routing.router import Router
from .registry.engine import EngineRegistry

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

@app.post("/v1/solve", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED, response_model_exclude_none=True)
async def solve(request: SolveRequest):
    # Validate Engine ID
    try:
        EngineRegistry.get_plugin(request.engine_id)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid engine_id: '{request.engine_id}'")

    # Stage 1: Universal Schema Validation
    violations = pipeline.validate_universal_schema(request.instance)
    if violations:
         # For validation errors, we can either return a failed job immediately or bad request
         # Let's return a Bad Request for sync validation failures for better DX
        # Actually API spec says SolveResponse/JobResponse. Let's wrap in Failed Job
        return JobResponse(
            job_id="invalid",
            status=JobStatus.FAILED,
            error=f"Universal Schema Violations: {json.dumps([v.model_dump() for v in violations])}"
        )

    # Stages 2-4 and Routing
    # Ideally pipeline should be async too or just doing routing inside
    # Current pipeline is sync. We can keep it sync for validation.
    
    # We need to pass the request to router, but we also want to do the validation pipeline.
    # We should probably let the router handle the full flow if we want Gateway to coordinate.
    # But currently Router just forwards.
    
    # Let's do validation here synchronously (fast) then route
    try:
        # Full validation pipeline (Stage 2, 3, 4)
        # Note: Stage 4 might reach out to engine? If so, it should be async or cheap.
        # Our validation is currently sync.
        violations = pipeline.validate_full(request.engine_id, request.instance)
        if violations:
             return JobResponse(
                job_id="invalid-semantic",
                status=JobStatus.FAILED,
                error=f"Semantic Violations: {json.dumps([v.model_dump() for v in violations])}"
            )
            
        # Route to Engine
        return await router.route_solve(request)
        
    except ValueError as e:
        return JobResponse(
            job_id="invalid-input",
            status=JobStatus.FAILED,
            error=str(e)
        )
    except RuntimeError as e:
        return JobResponse(
            job_id="engine-error",
            status=JobStatus.FAILED,
            error=str(e)
        )

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

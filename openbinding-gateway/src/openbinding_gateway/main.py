from fastapi import Depends, FastAPI, HTTPException, status, Request
from contextlib import asynccontextmanager
from typing import Dict, Any, Optional
import json
import asyncio

from dotenv import load_dotenv
import httpx
from sqlalchemy.ext.asyncio import AsyncSession

load_dotenv()

from .access.dependencies import optional_session, solve_caller
from .core.settings import get_settings
from .db import base as db_base
from .db.models import User
from .jobs import JobManager
from .models.api import SolveRequest, JobResponse, JobStatus, AnalyzeResponse, AnalyzeWarning, Provenance, BindingSpaceRequest, BindingSpacePage
from .validation.pipeline import ValidationPipeline
from .validation.analysis import compute_binding_space_summary, generate_warnings, generate_binding_space_subset
from .routing.router import Router, PayloadTooLargeError, PAYLOAD_TOO_LARGE_MESSAGE
from .registry.engine import EngineRegistry
import time

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open what the process needs, and close it on the way out.

    The accounts module is optional: a gateway with no ``DATABASE_URL`` runs
    exactly as it always did, anonymously, and the endpoints that need a
    database say so rather than failing obscurely.
    """
    settings = get_settings()
    if settings.database_url:
        db_base.init_engine(settings.database_url)
    try:
        yield
    finally:
        await db_base.dispose_engine()

app = FastAPI(title="OpenBinding Gateway", lifespan=lifespan, root_path="/api")

MAX_SOLVE_BODY_BYTES = 512 * 1024 * 1024

from .routes.auth import router as auth_router
from .routes.instance_parts import router as instance_parts_router
from .routes.schemas import router as schemas_router
from .routes.users import router as users_router
from .openapi_examples import (  # noqa: F401
    _ANALYZE_FAILED_EXAMPLE,
    _ANALYZE_VALIDATED_EXAMPLE,
    _BINDING_SPACE_EXAMPLE,
    _ENGINES_EXAMPLE,
    _HEALTH_EXAMPLE,
    _JOB_COMPLETED_EXAMPLE,
    _JOB_FAILED_EXAMPLE,
    _JOB_QUEUED_EXAMPLE,
)

from fastapi.middleware.cors import CORSMiddleware

settings = get_settings()

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=settings.cors_credentials_allowed,
    allow_methods=["*"],
    allow_headers=["*"],
)

pipeline = ValidationPipeline()
router = Router()

@app.get(
    "/health",
    responses={
        200: {
            "description": "OK",
            "content": {"application/json": {"example": _HEALTH_EXAMPLE}},
        }
    },
)
async def health():
    return {"status": "ok"}

@app.get(
    "/v1/engines",
    responses={
        200: {
            "description": "Registered engines and their capabilities",
            "content": {"application/json": {"example": _ENGINES_EXAMPLE}},
        }
    },
)
async def list_engines():
    engines = EngineRegistry.list_engines()

    async def check_engine_health(engine_id: str, client: httpx.AsyncClient) -> bool:
        try:
            plugin = EngineRegistry.get_plugin(engine_id)
            base_url = EngineRegistry.get_url(engine_id)
            return await plugin.check_engine_health(base_url, client)
        except Exception:
            return False

    timeout = httpx.Timeout(1.5, connect=1.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        results = await asyncio.gather(
            *(check_engine_health(e["id"], client) for e in engines),
            return_exceptions=True,
        )

    for engine, result in zip(engines, results):
        engine["active"] = bool(result) and not isinstance(result, Exception)

    return engines


@app.get(
    "/v1/engines/{engine_id}/options/defaults",
    responses={
        200: {
            "description": "Gateway-level default options for a given engine",
            "content": {"application/json": {"example": {"iterations_count": 1000}}},
        },
        404: {"description": "Engine not found"},
    },
)
async def get_engine_default_options(engine_id: str) -> Dict[str, Any]:
    try:
        plugin = EngineRegistry.get_plugin(engine_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Engine '{engine_id}' not found")

    defaults = plugin.get_default_options() or {}
    if not isinstance(defaults, dict):
        # Defensive: ensure API always returns an object
        defaults = {}
    return defaults

def validate_and_prepare(request: SolveRequest):
    """
    Standard check-and-prep for both solving and analyzing.
    Ensures the engine exists and the instance follows our QoS schemas.
    """
    # Validate Engine ID
    default_warnings = []
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
        violations, default_warnings = pipeline.validate_full(request.engine_id, request.instance)
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
    if default_warnings:
        for path, value in default_warnings:
            warnings.append(
                AnalyzeWarning(
                    code="DEFAULT_APPLIED",
                    message=f"Applied default for '{path}'",
                    details={"path": path, "value": value}
                )
            )
    
    return {
        "valid": True,
        "binding_space": binding_space,
        "warnings": warnings
    }


def _content_length_too_large(header_value: str | None, max_bytes: int) -> bool:
    if not header_value:
        return False
    try:
        return int(header_value) > max_bytes
    except (TypeError, ValueError):
        return False

@app.post(
    "/v1/analyze",
    response_model=AnalyzeResponse,
    status_code=status.HTTP_200_OK,
    response_model_exclude_none=True,
    responses={
        200: {
            "description": "Validation result (either validated or failed)",
            "content": {
                "application/json": {
                    "examples": {
                        "validated": {"summary": "Validated instance", "value": _ANALYZE_VALIDATED_EXAMPLE},
                        "failed": {"summary": "Failed validation", "value": _ANALYZE_FAILED_EXAMPLE},
                    }
                }
            },
        }
    },
)
async def analyze(request: SolveRequest):
    start_time = time.time()
    result = validate_and_prepare(request)
    duration = (time.time() - start_time) * 1000

    if not result["valid"]:
        # Return failed analysis with structured violations
        violations_data = result.get("violations", [])
        
        # Convert violations to warnings format for the response
        warnings = []
        if violations_data:
            for v in violations_data:
                if isinstance(v, dict):
                    warnings.append(AnalyzeWarning(
                        code=v.get("code", "validation_error"),
                        message=v.get("message", str(v)),
                        details={
                            "path": v.get("path"),
                            "constraint_id": v.get("constraint_id"),
                            "stage": v.get("stage")
                        } if v.get("path") or v.get("constraint_id") else None
                    ))
                else:
                    # Handle ValidationViolation objects
                    warnings.append(AnalyzeWarning(
                        code=getattr(v, "code", "validation_error"),
                        message=getattr(v, "message", str(v)),
                        details={
                            "path": getattr(v, "path", None),
                            "constraint_id": getattr(v, "constraint_id", None),
                        } if hasattr(v, "path") or hasattr(v, "constraint_id") else None
                    ))
        
        return AnalyzeResponse(
            status="failed",
            error=result.get("error", "Validation failed"),
            warnings=warnings if warnings else None,
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

@app.post(
    "/v1/analyze/binding-space",
    response_model=BindingSpacePage,
    status_code=status.HTTP_200_OK,
    responses={
        422: {
            "description": "Validation failed",
            "content": {
                "application/json": {
                    "example": {"detail": "Validation failed"}
                }
            }
        }
    }
)
async def analyze_binding_space(request: BindingSpaceRequest):
    # Reuse the same validation logic.
    # We treat BindingSpaceRequest as a SolveRequest for validation since it inherits from it.
    result = validate_and_prepare(request)
    
    if not result["valid"]:
         # Raise 422 with details
        violations_data = result.get("violations", [])
        error_response = {
            "error": result.get("error", "Validation failed"),
            "violations": []
        }
        if violations_data:
            for v in violations_data:
                 # Helper to extract dict or object
                if isinstance(v, dict):
                     error_response["violations"].append(v)
                else:
                    error_response["violations"].append(v.model_dump())

        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=error_response
        )
        
    # Generate the requested subset
    subset = generate_binding_space_subset(request.instance, request.offset, request.limit)
    
    return BindingSpacePage(
        total_combinations=subset["total_combinations"],
        offset=subset["offset"],
        limit=subset["limit"],
        bindings=subset["bindings"]
    )

from fastapi import Response
from fastapi.responses import FileResponse

@app.post(
    "/v1/solve",
    response_model=JobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    response_model_exclude_none=True,
    responses={
        202: {
            "description": "Solve request accepted (job created)",
            "content": {"application/json": {"example": _JOB_QUEUED_EXAMPLE}},
        },
        200: {
             "description": "Solve request completed synchronously",
             "content": {"application/json": {"example": _JOB_COMPLETED_EXAMPLE}},
        },
        422: {
            "description": "Instance is invalid (semantic/logical/schema violations)",
            "content": {
                "application/json": {
                    "example": {
                        "detail": {
                            "error": "The problem has semantic or logical errors: [...]",
                            "violations": [
                                {
                                    "code": "missing_candidates",
                                    "message": "Missing candidates for tasks: t2",
                                    "path": "candidates",
                                    "constraint_id": None,
                                    "stage": None,
                                }
                            ],
                        }
                    }
                }
            },
        },
    },
)
async def solve(
    http_request: Request,
    request: SolveRequest,
    response: Response,
    user: Optional[User] = Depends(solve_caller),
    session: Optional[AsyncSession] = Depends(optional_session),
):
    if _content_length_too_large(http_request.headers.get("content-length"), MAX_SOLVE_BODY_BYTES):
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Request body is too large. Maximum allowed size is {MAX_SOLVE_BODY_BYTES} bytes.",
        )

    result = validate_and_prepare(request)
    
    if not result["valid"]:
        # Return validation error immediately with structured violations
        violations_data = result.get("violations", [])
        
        error_response = {
            "error": result.get("error", "Validation failed"),
            "violations": []
        }
        
        if violations_data:
            for v in violations_data:
                if isinstance(v, dict):
                    error_response["violations"].append({
                        "code": v.get("code", "validation_error"),
                        "message": v.get("message", str(v)),
                        "path": v.get("path"),
                        "constraint_id": v.get("constraint_id"),
                        "stage": v.get("stage")
                    })
                else:
                    # Handle ValidationViolation objects
                    error_response["violations"].append({
                        "code": getattr(v, "code", "validation_error"),
                        "message": getattr(v, "message", str(v)),
                        "path": getattr(v, "path", None),
                        "constraint_id": getattr(v, "constraint_id", None),
                    })
        
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=error_response
        )
    
    binding_space = result.get("binding_space")
    warnings = result.get("warnings")
    warning_payload = [w.model_dump() if hasattr(w, "model_dump") else w for w in (warnings or [])]
    
    # Hand the validated request over to the router to find a solution.
    try:
        job_resp = await router.route_solve(
            request,
            binding_space=binding_space,
            warnings=warning_payload,
            owner_id=user.id if user else None,
            session=session,
        )
    except PayloadTooLargeError:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=PAYLOAD_TOO_LARGE_MESSAGE,
        )
    
    if job_resp.status == JobStatus.COMPLETED or job_resp.status == JobStatus.FAILED:
        response.status_code = status.HTTP_200_OK
        
    return job_resp

@app.get(
    "/v1/jobs/{job_id}",
    response_model=JobResponse,
    response_model_exclude_none=True,
    responses={
        200: {
            "description": "Job status (queued/running/completed/failed)",
            "content": {
                "application/json": {
                    "examples": {
                        "queued": {"summary": "Queued job", "value": _JOB_QUEUED_EXAMPLE},
                        "completed": {"summary": "Completed job", "value": _JOB_COMPLETED_EXAMPLE},
                        "failed": {"summary": "Failed job", "value": _JOB_FAILED_EXAMPLE},
                    }
                }
            },
        },
        404: {
            "description": "Job not found",
            "content": {"application/json": {"example": {"detail": "Job not found"}}},
        },
    },
)
async def get_job(
    job_id: str,
    user: Optional[User] = Depends(solve_caller),
    session: Optional[AsyncSession] = Depends(optional_session),
):
    """A job's status, to whoever is entitled to it.

    A job that belongs to somebody else answers "not found" rather than
    "forbidden". Job identifiers used to be, in effect, bearer tokens for
    whatever they named; refusing by existence rather than by permission is
    what stops the endpoint from confirming which identifiers are real.
    """
    stored = await JobManager.get_job(job_id, session=session)
    if stored is not None and not stored.readable_by(user):
        raise HTTPException(status_code=404, detail="Job not found")

    job = await router.get_job_status(job_id, session=session)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


# Serving the schema files themselves has nothing to do with solving, so it
# lives in its own module.
app.include_router(schemas_router)
app.include_router(instance_parts_router)

# Accounts. These are registered whether or not this deployment configured a
# database, because the OpenAPI document describes the API rather than one
# installation of it; without a database they answer 503 and say why.
app.include_router(auth_router)
app.include_router(users_router)

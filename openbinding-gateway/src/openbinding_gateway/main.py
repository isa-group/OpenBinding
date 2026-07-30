"""The gateway's HTTP surface.

Nothing here reads configuration while being imported, which is why the imports
are ordinary imports at the top of the file. They used to sit below a
``load_dotenv()`` call because the engine registry read its URLs at import time;
that is resolved lazily now, and ``.env`` is loaded by the settings object
itself.
"""

import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager, suppress
from typing import Any, Dict, Optional

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession

from . import space_client
from .access import metering, policy
from .access.dependencies import get_optional_user, optional_session, solve_caller
from .core.settings import get_settings
from .db import base as db_base
from .db.bootstrap import (
    DEFAULT_ADMIN_PASSWORD,
    DEFAULT_ADMIN_USERNAME,
    ensure_administrator,
    seed_default_administrator,
)
from .db.models import User
from .jobs import JobManager
from .models.api import (
    AnalyzeResponse,
    AnalyzeWarning,
    BindingSpacePage,
    BindingSpaceRequest,
    JobResponse,
    JobStatus,
    Provenance,
    SolveRequest,
)
from .models.errors import (
    NOT_FOUND_RESPONSE,
    PAYLOAD_TOO_LARGE_RESPONSE,
    QUOTA_RESPONSE,
    UNAUTHORIZED_RESPONSE,
    UNAVAILABLE_RESPONSE,
    VIOLATIONS_RESPONSE,
    api_error,
)
from .openapi_examples import (
    _ANALYZE_FAILED_EXAMPLE,
    _ANALYZE_VALIDATED_EXAMPLE,
    _BINDING_SPACE_EXAMPLE,
    _ENGINES_EXAMPLE,
    _HEALTH_EXAMPLE,
    _JOB_COMPLETED_EXAMPLE,
    _JOB_FAILED_EXAMPLE,
    _JOB_QUEUED_EXAMPLE,
)
from .registry.engine import EngineRegistry
from .registry.federated import load_entries
from .routes.admin import router as admin_router
from .routes.auth import router as auth_router
from .routes.engines import admin_router as engines_admin_router
from .routes.engines import router as engines_router
from .routes.instance_parts import router as instance_parts_router
from .routes.schemas import router as schemas_router
from .routes.users import router as users_router
from .routing.router import PAYLOAD_TOO_LARGE_MESSAGE, PayloadTooLargeError, Router
from .space_client import PlanCaps, PricingUnavailable
from .validation.analysis import (
    compute_binding_space_summary,
    generate_binding_space_subset,
    generate_warnings,
)
from .validation.pipeline import ValidationPipeline

load_dotenv()

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
    space_client.set_gate(space_client.build_gate(settings))

    if settings.database_url:
        # Without this a fresh deployment has no administrator and no way to
        # acquire one, since promoting an account is an administrator's job.
        async with db_base.session_factory()() as session:
            configured = await ensure_administrator(session, settings)
            if not configured:
                # A deployment that named its administrator gets that one. One
                # that did not still has to be able to sign in: seed_default_
                # administrator acts only on a database with no accounts at
                # all, so this can never take over an installation in use.
                #
                # This used to be reachable only by running tools/seed_admin.py
                # by hand, which meant `docker compose up` produced a gateway
                # with no accounts and no way to make one - promoting somebody
                # is an administrator's privilege, and there was no
                # administrator.
                if await seed_default_administrator(session):
                    logging.getLogger(__name__).warning(
                        "No administrator existed, so '%s' was created with the well-known "
                        "password '%s'. Sign in, create a real administrator, and delete it.",
                        DEFAULT_ADMIN_USERNAME,
                        DEFAULT_ADMIN_PASSWORD,
                    )
            await session.commit()

            # Registered engines live in the database but are looked up from
            # synchronous code, so the registry holds a snapshot. Loading it
            # here means the first request after a restart already knows about
            # them; a row that will not load is skipped and logged rather than
            # taking the others with it.
            entries, problems = await load_entries(session)
            EngineRegistry.refresh_federated(entries)
            for problem in problems:
                logging.getLogger(__name__).warning("Federated engine unavailable: %s", problem)

    # A solve that nobody polls for would otherwise hold a concurrency slot
    # forever, and for an account allowed one that means never solving again.
    reconciler = None
    if settings.database_url:
        reconciler = asyncio.create_task(metering.run_reconciler(space_client.get_gate()))

    try:
        yield
    finally:
        if reconciler is not None:
            reconciler.cancel()
            with suppress(asyncio.CancelledError):
                await reconciler
        gate = space_client.get_gate()
        if hasattr(gate, "aclose"):
            await gate.aclose()
        space_client.set_gate(None)
        await db_base.dispose_engine()

#: Groups the operations, so a generated client and the interactive docs both
#: organise themselves the way the system is actually divided.
TAGS_METADATA = [
    {"name": "Health", "description": "Whether the gateway is answering."},
    {"name": "Solving", "description": "Validate an instance, measure it, and solve it."},
    {"name": "Engines", "description": "Which solvers are registered, and what they accept."},
    {"name": "Schemas", "description": "The instance schemas, and the pricing, as documents."},
    {"name": "Instance parts", "description": "Take an instance apart along the tuple, and put it back."},
    {"name": "Authentication", "description": "Accounts and sessions."},
    {"name": "Users", "description": "Your own account: profile, API keys, quotas."},
    {"name": "Administration", "description": "Other people's accounts. Administrators only."},
]

DESCRIPTION = """\
A QoS-aware service composition gateway. Validate a binding instance against
the general schema and against the manifest of the engine you asked for,
measure its binding space, and route it to that engine.

**This document is the contract.** Instance structure is described in full
under `SolveRequest.instance`; the shape of a solution is `Solution`, and its
metrics are always recomputed by the reference evaluator rather than taken from
whatever the engine reported. An engine only has to return a Task-to-Candidate
map for the rest to be derived.

**Both channels are the same channel.** A browser session and an `obk_`-prefixed
API key resolve to the same account, so a pricing plan applies to the caller
rather than to how they called. Everything the web interface can do is an
operation here.

**Errors carry a machine-readable `code`.** `402` means an allowance is spent,
which is worth retrying once it renews; `403` means a permission is missing,
which is not; `503` with `Retry-After` means the gateway could not find out.
"""

app = FastAPI(
    title="OpenBinding Gateway",
    version="1.0.0",
    summary="QoS-aware service composition: validate, measure and solve binding instances.",
    description=DESCRIPTION,
    openapi_tags=TAGS_METADATA,
    license_info={"name": "CC BY 4.0", "url": "https://creativecommons.org/licenses/by/4.0/"},
    lifespan=lifespan,
    root_path="/api",
)

MAX_SOLVE_BODY_BYTES = 512 * 1024 * 1024

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


async def plan_caps_for(user: Optional[User]) -> PlanCaps:
    """The ceilings that bound this caller's request.

    A visitor with no account gets the cautious defaults - the same ones the
    free plan carries. That matters where solving is left open: an anonymous
    request is bounded by something rather than by nothing.
    """
    if user is None:
        return PlanCaps()
    try:
        return await space_client.get_gate().caps(user.id)
    except PricingUnavailable as error:
        if get_settings().space_fail_mode == "open":
            # Development, and deployments that would rather work than meter.
            return PlanCaps()
        raise _pricing_unavailable(error) from error


def _pricing_unavailable(error: Exception) -> HTTPException:
    """What a caller is told when the pricing service cannot be reached.

    Not a 402: their quota may be perfectly healthy, and saying otherwise
    would be a lie about the reason. 503 with Retry-After says what it is.
    """
    return api_error(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "pricing_unavailable",
        f"Quotas cannot be checked right now, so solving is on hold: {error}",
        headers={"Retry-After": "30"},
    )


def _quota_exceeded(verdict) -> HTTPException:
    """What a caller is told when their plan has nothing left.

    402 rather than 403: this is not a permission the account lacks, it is an
    allowance it has spent, and the distinction is what tells a client whether
    retrying later is worth anything.
    """
    quota = None
    if verdict.limit is not None:
        quota = {
            "limit_id": verdict.limit.limit_id,
            "limit": verdict.limit.limit,
            "used": verdict.limit.used,
            "renews_at": verdict.limit.renews_at,
        }
    return api_error(
        status.HTTP_402_PAYMENT_REQUIRED,
        "quota_exceeded",
        verdict.reason or "Your plan has no allowance left for this.",
        quota=quota,
    )

@app.get(
    "/health",
    tags=["Health"],
    operation_id="health",
    summary="Whether the gateway is up",
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
    tags=["Engines"],
    operation_id="listEngines",
    summary="Registered engines and their capabilities",
    responses={
        200: {
            "description": "Registered engines and their capabilities",
            "content": {"application/json": {"example": _ENGINES_EXAMPLE}},
        }
    },
)
async def list_engines(user: Optional[User] = Depends(get_optional_user)):
    """Every engine the caller may use.

    Public, and the answer depends on who is asking: the four built-in engines
    for everybody, plus the registered ones that are public and the ones this
    caller owns. An engine somebody may not see is absent rather than listed as
    forbidden, for the same reason a foreign job answers 404 - whether
    ``alice~tabu`` exists is Alice's business.
    """
    engines = EngineRegistry.list_engines(user)

    async def check_engine_health(engine_id: str, client: httpx.AsyncClient) -> bool:
        try:
            transport = EngineRegistry.get_transport(engine_id)
            if hasattr(transport, "healthy"):
                # A federated engine is probed through its own declared health
                # operation, if it declared one. Asking it for /health would be
                # asking it to implement our contract, which is the thing
                # federation exists to avoid.
                return await transport.healthy(client)
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

    for engine, result in zip(engines, results, strict=True):
        engine["active"] = bool(result) and not isinstance(result, Exception)

    return engines


@app.get(
    "/v1/engines/{engine_id}/manifest",
    tags=["Engines"],
    operation_id="getEngineManifest",
    summary="An engine's manifest",
    responses={
        200: {"description": "The manifest this engine declares itself with"},
        404: NOT_FOUND_RESPONSE,
    },
)
async def get_engine_manifest(engine_id: str) -> Dict[str, Any]:
    """Everything an engine declares about itself, in one document.

    The same document for every engine: the four that ship with the gateway
    keep it in ``schemas/manifests/``, and a registered one keeps it in a
    database row. Capabilities, the instance schema and the options schema are
    all read from here rather than restated in code, so this is the whole of
    what the gateway believes about an engine.

    It is also the template a third party works from. Fetching the manifest of
    an engine whose behaviour you want to match, and changing the parts that
    differ, is a better starting point than an empty file.
    """
    try:
        plugin = EngineRegistry.get_plugin(engine_id)
    except ValueError as error:
        raise api_error(
            status.HTTP_404_NOT_FOUND, "engine_not_found", f"No engine called '{engine_id}'."
        ) from error

    try:
        return plugin.get_manifest().model_dump(mode="json", exclude_none=True)
    except Exception as error:
        raise api_error(
            status.HTTP_404_NOT_FOUND,
            "manifest_unavailable",
            f"No readable manifest for '{engine_id}'.",
        ) from error


@app.get(
    "/v1/engines/{engine_id}/options/defaults",
    tags=["Engines"],
    operation_id="getEngineDefaultOptions",
    summary="An engine's default options",
    responses={
        200: {
            "description": "Gateway-level default options for a given engine",
            "content": {"application/json": {"example": {"iterations_count": 1000}}},
        },
        404: NOT_FOUND_RESPONSE,
    },
)
async def get_engine_default_options(engine_id: str) -> Dict[str, Any]:
    try:
        plugin = EngineRegistry.get_plugin(engine_id)
    except ValueError as error:
        raise api_error(
            status.HTTP_404_NOT_FOUND, "engine_not_found", f"No engine called '{engine_id}'."
        ) from error

    defaults = plugin.get_default_options() or {}
    if not isinstance(defaults, dict):
        # Defensive: ensure API always returns an object
        defaults = {}
    return defaults


@app.get(
    "/v1/engines/{engine_id}/options/schema",
    tags=["Engines"],
    operation_id="getEngineOptionsSchema",
    summary="What options an engine accepts",
    responses={
        200: {
            "description": "A JSON Schema for this engine's options object",
            "content": {
                "application/json": {
                    "example": {
                        "$schema": "https://json-schema.org/draft/2020-12/schema",
                        "title": "random-search options",
                        "type": "object",
                        "additionalProperties": True,
                        "properties": {"iterations_count": {"type": "integer", "default": 1000}},
                    }
                }
            },
        },
        404: NOT_FOUND_RESPONSE,
    },
)
async def get_engine_options_schema(engine_id: str) -> Dict[str, Any]:
    """The shape of the ``options`` object, per engine.

    ``SolveRequest.options`` is an open dictionary in the contract, because what
    belongs in it depends entirely on which engine is being asked. That left a
    client with the defaults endpoint and guesswork: it could see that
    ``iterations_count`` defaults to 1000 without learning that it is an integer
    or that a plan caps it. This says so.

    It is also the counterpart of a registered engine's ``options_schema``: a
    federated manifest declares one, so a built-in engine had better be able to
    answer the same question.
    """
    try:
        plugin = EngineRegistry.get_plugin(engine_id)
    except ValueError as error:
        raise api_error(
            status.HTTP_404_NOT_FOUND, "engine_not_found", f"No engine called '{engine_id}'."
        ) from error

    schema = plugin.get_options_schema()
    if not isinstance(schema, dict):
        return {"type": "object", "additionalProperties": True}
    return schema

def assert_engine_available(engine_id: str, user: Optional[User]) -> None:
    """Refuse an engine this caller may not use, before anything else happens.

    Before this, naming a registered engine was enough to have an instance
    validated against its manifest - so a stranger could learn that
    ``alice~tabu`` exists and what it accepts, and solve on it. Hiding an engine
    from the catalogue is not the same as refusing to use it, and only the
    second one is a permission.
    """
    refusal = EngineRegistry.refusal_for(engine_id, user)
    if refusal is not None:
        code, slug, message = refusal
        raise api_error(code, slug, message)


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
    tags=["Solving"],
    operation_id="analyze",
    summary="Validate an instance and measure its binding space",
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
async def analyze(
    request: SolveRequest, user: Optional[User] = Depends(get_optional_user)
):
    start_time = time.time()
    assert_engine_available(request.engine_id, user)
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
    tags=["Solving"],
    operation_id="exploreBindingSpace",
    summary="Enumerate the binding space, a page at a time",
    response_model=BindingSpacePage,
    status_code=status.HTTP_200_OK,
    responses={
        200: {
            "description": "A page of the binding space",
            "content": {"application/json": {"example": _BINDING_SPACE_EXAMPLE}},
        },
        422: VIOLATIONS_RESPONSE,
    },
)
async def analyze_binding_space(
    request: BindingSpaceRequest, user: Optional[User] = Depends(get_optional_user)
):
    # Reuse the same validation logic.
    # We treat BindingSpaceRequest as a SolveRequest for validation since it inherits from it.
    assert_engine_available(request.engine_id, user)
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

@app.post(
    "/v1/solve",
    tags=["Solving"],
    operation_id="solve",
    summary="Solve an instance on one of the engines",
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
        401: UNAUTHORIZED_RESPONSE,
        402: QUOTA_RESPONSE,
        413: PAYLOAD_TOO_LARGE_RESPONSE,
        422: VIOLATIONS_RESPONSE,
        503: UNAVAILABLE_RESPONSE,
    },
)
async def solve(
    http_request: Request,
    request: SolveRequest,
    response: Response,
    user: Optional[User] = Depends(solve_caller),
    session: Optional[AsyncSession] = Depends(optional_session),
):
    caps = await plan_caps_for(user)
    body_ceiling = policy.payload_ceiling_bytes(caps, MAX_SOLVE_BODY_BYTES)
    if _content_length_too_large(http_request.headers.get("content-length"), body_ceiling):
        raise api_error(
            status.HTTP_413_CONTENT_TOO_LARGE,
            "payload_too_large",
            f"Request body is too large. Maximum allowed size is {body_ceiling} bytes.",
        )

    assert_engine_available(request.engine_id, user)
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
    warnings = result.get("warnings") or []

    # An instance too large for the plan is refused rather than reduced: there
    # is no smaller version of it to solve instead.
    log10_size = getattr(binding_space, "log10_cardinality", None)
    if policy.binding_space_too_large(log10_size, caps):
        raise api_error(
            status.HTTP_402_PAYMENT_REQUIRED,
            "binding_space_too_large",
            "This instance's binding space is larger than your plan solves.",
            quota={
                "limit_id": "maxBindingSpaceLimit",
                "limit": caps.max_binding_space_log10,
                "actual": log10_size,
                "unit": "log10(combinations)",
            },
        )

    # Budgets the caller merely asked for are brought within the plan, and the
    # reduction is reported rather than applied silently.
    clamped = policy.clamp_options(request.options, caps)
    request = request.model_copy(update={"options": clamped.options})
    warnings = warnings + clamped.warnings

    reservation = None
    if user is not None:
        gate = space_client.get_gate()
        try:
            verdict, reservation = await metering.reserve(gate, user.id)
            if not verdict.allowed:
                raise _quota_exceeded(verdict)
        except PricingUnavailable as error:
            # Fail closed by default: handing out an unmetered half-hour of
            # solver time is worse than a temporary outage. Deployments that
            # would rather keep working than keep accounts set the other mode,
            # and this solve simply goes uncounted.
            if get_settings().space_fail_mode != "open":
                raise _pricing_unavailable(error) from error

    warning_payload = [w.model_dump() if hasattr(w, "model_dump") else w for w in warnings]

    # Hand the validated request over to the router to find a solution.
    started_at = time.time()
    try:
        job_resp = await router.route_solve(
            request,
            binding_space=binding_space,
            warnings=warning_payload,
            owner_id=user.id if user else None,
            session=session,
            budget_s=policy.solve_timeout_s(caps, get_settings().engine_solve_timeout_s),
        )
    except PayloadTooLargeError:
        # Nothing was solved, so nothing is owed.
        await metering.release(space_client.get_gate(), reservation)
        raise api_error(
            status.HTTP_413_CONTENT_TOO_LARGE, "payload_too_large", PAYLOAD_TOO_LARGE_MESSAGE
        ) from None
    except Exception:
        await metering.release(space_client.get_gate(), reservation)
        raise

    if job_resp.status == JobStatus.COMPLETED or job_resp.status == JobStatus.FAILED:
        response.status_code = status.HTTP_200_OK
        # A synchronous engine has already spent whatever it was going to
        # spend, so the bill is settled here rather than left to a poll that
        # will never come.
        if user is not None and session is not None:
            await metering.settle(
                space_client.get_gate(),
                session,
                uuid.UUID(job_resp.job_id),
                solver_seconds=_engine_seconds(job_resp, time.time() - started_at),
            )

    return job_resp


def _engine_seconds(job_resp: JobResponse, wall_clock_s: float) -> float:
    """How long the engine spent, preferring its own account of it.

    An engine that reports its execution time is more accurate than the clock
    around the call, which also counts transferring the instance. Falling back
    to the wall clock matters more than the precision does: an engine that
    reports nothing must not solve for free.
    """
    provenance = getattr(job_resp.result, "provenance", None) if job_resp.result else None
    reported_ms = None
    if provenance is not None:
        reported_ms = (
            provenance.get("execution_time_ms")
            if isinstance(provenance, dict)
            else getattr(provenance, "execution_time_ms", None)
        )
    if isinstance(reported_ms, (int, float)) and reported_ms > 0:
        return float(reported_ms) / 1000.0
    return max(0.0, wall_clock_s)

@app.get(
    "/v1/jobs/{job_id}",
    tags=["Solving"],
    operation_id="getJob",
    summary="A job's status, and its result once it has one",
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
        401: UNAUTHORIZED_RESPONSE,
        404: {
            **NOT_FOUND_RESPONSE,
            "description": (
                "No such job, or one belonging to somebody else. Deliberately not 403: "
                "a caller who may not read a job should not learn that it exists."
            ),
        },
        503: UNAVAILABLE_RESPONSE,
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
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "No such job.")

    job = await router.get_job_status(job_id, session=session)
    if not job:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "No such job.")
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
app.include_router(admin_router)
# Registering an engine is a documented operation like any other, which is the
# whole point of the API-first rule: nothing the interface can do is missing here.
app.include_router(engines_router)
app.include_router(engines_admin_router)

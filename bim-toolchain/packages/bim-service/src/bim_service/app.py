"""The FastAPI application: routes, error translation and assembly.

``create_app()`` reads the configuration from the environment, loads the bearer tokens and refuses to return
(raises :class:`~bim_service.settings.ServiceConfigError`) when the service cannot run safely::

    uvicorn --factory bim_service.app:create_app

``build_app(settings, authenticator)`` assembles the same application from objects, which is what tests and
the OpenAPI generator use.  The service keeps no state besides the in-flight counters of its concurrency gate.
"""

from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import Any, Mapping

from bim_core import BimError
from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse, Response

from . import operations
from ._version import API_PREFIX, API_VERSION, __version__
from .auth import Authenticator, load_authenticator
from .middleware import AuthMiddleware, BodyLimitMiddleware, ContextMiddleware
from .models import (
    CompatibilityRequest,
    CompatibilityResponse,
    CompileResponse,
    EvaluateRequest,
    EvaluateResponse,
    Health,
    NeighborhoodRequest,
    OptimizationResolveRequest,
    OptimizationResolveResponse,
    PackageRequest,
    Problem,
    ReevaluateRequest,
    ValidateResponse,
    ValidateResultRequest,
    ValidateResultResponse,
)
from .problems import ServiceProblem, bim_error_problem, problem_response, respond
from .runtime import Gate
from .settings import BimServiceSettings
from .wire import decode_package_request, request_invalid, validation_diagnostics

logger = logging.getLogger("bim_service")

_PROBLEMS: dict[int | str, dict[str, Any]] = {
    401: {"model": Problem, "description": "Missing or invalid bearer token."},
    413: {"model": Problem, "description": "The request body exceeds the configured size."},
    422: {"model": Problem, "description": "The input is invalid; `code` and `diagnostics` say why."},
    429: {"model": Problem, "description": "The tenant has too many operations in flight (see `Retry-After`)."},
    500: {"model": Problem, "description": "Unexpected failure of the service."},
    503: {"model": Problem, "description": "All slots are busy, or the operation ran out of time."},
}

_PACKAGE_BODY: dict[str, Any] = {
    "requestBody": {
        "required": True,
        "content": {
            "application/json": {"schema": {"$ref": "#/components/schemas/PackageRequest"}},
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["package"],
                    "properties": {
                        "package": {"type": "string", "format": "binary", "description": "The `.bim.zip`."},
                        "registeredResources": {
                            "type": "string",
                            "description": "JSON array of registered resources, as in the JSON form.",
                        },
                    },
                }
            },
        },
    }
}


def _tenant(request: Request) -> str | None:
    return request.scope.get("state", {}).get("tenant")


async def _run(request: Request, function: Any, *args: Any) -> JSONResponse:
    """Run ``function(*args)`` within the gate and answer its result as JSON."""
    result = await request.app.state.gate.run(function, *args, tenant=_tenant(request))
    return JSONResponse(result)


def _settings(request: Request) -> BimServiceSettings:
    return request.app.state.settings


def _router() -> APIRouter:
    router = APIRouter(prefix=API_PREFIX, responses=_PROBLEMS)

    @router.get("/capabilities", operation_id="capabilities", summary="Version, digests, limits and installed contracts")
    async def capabilities(request: Request) -> Response:
        return JSONResponse(operations.capabilities(_settings(request)))

    @router.get("/profiles", operation_id="profiles", summary="Installed Profiles")
    async def profiles() -> Response:
        return JSONResponse(operations.profiles())

    @router.get("/dialects", operation_id="dialects", summary="Installed Dialects")
    async def dialects() -> Response:
        return JSONResponse(operations.dialects())

    @router.get(
        "/schemas/{kind}",
        operation_id="schema",
        summary="A BIM v1 JSON Schema",
        responses={200: {"description": "The JSON Schema document."}, 404: {"model": Problem}},
    )
    async def schema(kind: str) -> Response:
        return JSONResponse(operations.schema(kind))

    @router.get("/protocol", operation_id="protocol", summary="The bim-engine/v1 contract and its digest")
    async def protocol() -> Response:
        return JSONResponse(operations.protocol())

    @router.post(
        "/compile",
        operation_id="compile",
        summary="Compile a package to its canonical IR",
        response_model=None,
        responses={200: {"model": CompileResponse, "description": "The IR and everything that identifies it."}},
        openapi_extra=_PACKAGE_BODY,
    )
    async def compile_package(request: Request) -> Response:
        settings = _settings(request)
        data, registered = decode_package_request(
            request.headers.get("content-type", ""), await request.body(), settings
        )
        return await _run(request, operations.compile_package, data, registered, settings.limits)

    @router.post(
        "/validate",
        operation_id="validate",
        summary="Compile a package and report its diagnostics (no IR in the answer)",
        response_model=None,
        responses={200: {"model": ValidateResponse, "description": "`valid` and the diagnostics of the compilation."}},
        openapi_extra=_PACKAGE_BODY,
    )
    async def validate_package(request: Request) -> Response:
        settings = _settings(request)
        data, registered = decode_package_request(
            request.headers.get("content-type", ""), await request.body(), settings
        )
        return await _run(request, operations.validate_package, data, registered, settings.limits)

    @router.post(
        "/compatibility",
        operation_id="compatibility",
        summary="Why an Engine mode can or cannot run an IR",
        response_model=None,
        responses={200: {"model": CompatibilityResponse}},
    )
    async def compatibility(body: CompatibilityRequest, request: Request) -> Response:
        return await _run(request, operations.compatibility, body.ir, body.manifest, body.mode, body.options)

    @router.post(
        "/optimization/resolve",
        operation_id="resolveOptimization",
        summary="Validate and canonicalize an execution-time optimization selection",
        response_model=None,
        responses={200: {"model": OptimizationResolveResponse}},
    )
    async def resolve_optimization(body: OptimizationResolveRequest, request: Request) -> Response:
        return await _run(request, operations.optimization, body.ir, body.manifest, body.mode, body.optimization)

    @router.post(
        "/evaluate",
        operation_id="evaluate",
        summary="Evaluate bindings with the canonical evaluator",
        response_model=None,
        responses={200: {"model": EvaluateResponse}},
    )
    async def evaluate(body: EvaluateRequest, request: Request) -> Response:
        limit = _settings(request).max_bindings
        if len(body.bindings) > limit:
            raise ServiceProblem(422, "limit_exceeded", f"at most {limit} bindings per request")
        return await _run(request, operations.evaluate, body.ir, body.bindings, body.execution, body.onError)

    @router.post(
        "/reevaluate",
        operation_id="reevaluate",
        summary="Replace an engine's claims with the authoritative evaluation",
        response_model=None,
        responses={200: {"description": "`{termination, solutions, provenance}`; only the bindings are the engine's."}},
    )
    async def reevaluate(body: ReevaluateRequest, request: Request) -> Response:
        return await _run(
            request, operations.reevaluate, body.ir, body.result, body.execution, body.allowedTerminations
        )

    @router.post(
        "/validate-result",
        operation_id="validateResult",
        summary="Is this payload shaped like a bim-engine/v1 result? (shape only)",
        response_model=None,
        responses={200: {"model": ValidateResultResponse}},
    )
    async def validate_result(body: ValidateResultRequest, request: Request) -> Response:
        return await _run(request, operations.check_result, body.result)

    @router.post(
        "/neighborhood",
        operation_id="neighborhood",
        summary="Evaluate the one-task alternatives of a binding",
        response_model=None,
        responses={200: {"description": "The counterfactual analysis."}},
    )
    async def neighborhood(body: NeighborhoodRequest, request: Request) -> Response:
        ceiling = _settings(request).neighborhood_max_seconds
        if body.seconds > ceiling:
            raise ServiceProblem(422, "limit_exceeded", f"`seconds` is at most {ceiling:g}")
        return await _run(
            request, operations.neighborhood, body.ir, body.binding, body.task, body.limit, body.seconds, body.execution
        )

    return router


# --- errors ----------------------------------------------------------------------------------------


async def _bim_error(request: Request, exc: BimError) -> Response:
    status, body = bim_error_problem(exc)
    return problem_response(status, body)


async def _service_problem(request: Request, exc: ServiceProblem) -> Response:
    return respond(exc)


async def _invalid_request(request: Request, exc: RequestValidationError) -> Response:
    error = request_invalid("the request does not match the contract", validation_diagnostics(exc))
    status, body = bim_error_problem(error)
    return problem_response(status, body)


async def _http_exception(request: Request, exc: StarletteHTTPException) -> Response:
    code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
    return respond(ServiceProblem(exc.status_code, code, str(exc.detail), headers=exc.headers))


# --- OpenAPI ---------------------------------------------------------------------------------------


def _patch_openapi(schema: dict[str, Any]) -> None:
    """Add the request schema that routes reading the body themselves cannot declare, and tidy the errors."""
    components = schema.setdefault("components", {}).setdefault("schemas", {})
    package = PackageRequest.model_json_schema(ref_template="#/components/schemas/{model}")
    components.update(package.pop("$defs", {}))
    components["PackageRequest"] = package
    for name in ("HTTPValidationError", "ValidationError"):
        components.pop(name, None)
    schema["components"]["securitySchemes"] = {
        "bearerAuth": {
            "type": "http",
            "scheme": "bearer",
            "description": "Static service-to-service token (one of the two the service accepts during a rotation).",
        }
    }
    schema["security"] = [{"bearerAuth": []}]
    for item in schema.get("paths", {}).values():
        for operation in item.values():
            if not isinstance(operation, dict):
                continue
            for status, response in operation.get("responses", {}).items():
                content = response.get("content", {})
                if str(status).isdigit() and int(status) >= 400 and "application/json" in content:
                    content["application/problem+json"] = content.pop("application/json")


def _install_openapi(app: FastAPI) -> None:
    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            _patch_openapi(FastAPI.openapi(app))
        return app.openapi_schema  # type: ignore[return-value]

    app.openapi = openapi  # type: ignore[method-assign]


# --- assembly --------------------------------------------------------------------------------------


def build_app(settings: BimServiceSettings, authenticator: Authenticator) -> FastAPI:
    """The application for ``settings`` and ``authenticator``; nothing is read from the environment."""

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        yield
        application.state.gate.close()

    app = FastAPI(
        title="BIM service",
        version=__version__,
        summary="Stateless HTTP API over the BIM toolchain",
        description=(
            f"`{API_VERSION}`: compile and validate BIM v1 packages, check Engine compatibility, evaluate and "
            "re-evaluate bindings and analyse their neighbourhood. No state, no database; every answer is a pure "
            "function of the request and the installed toolchain. Errors are `application/problem+json`."
        ),
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.gate = Gate(settings)
    app.state.ready = True
    app.include_router(_router())

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> Health:
        return Health(status="ok")

    @app.get("/readyz", include_in_schema=False)
    async def readyz(request: Request) -> Response:
        if not request.app.state.ready:
            return respond(ServiceProblem(503, "not_ready", "the service is not ready"))
        return JSONResponse({"status": "ready"})

    app.add_exception_handler(BimError, _bim_error)  # type: ignore[arg-type]
    app.add_exception_handler(ServiceProblem, _service_problem)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _invalid_request)  # type: ignore[arg-type]
    app.add_exception_handler(StarletteHTTPException, _http_exception)  # type: ignore[arg-type]
    # The last middleware added is the outermost.
    app.add_middleware(BodyLimitMiddleware, max_body_bytes=settings.max_body_bytes)
    app.add_middleware(AuthMiddleware, authenticator=authenticator)
    app.add_middleware(ContextMiddleware)
    _install_openapi(app)
    return app


def _configure_logging(level: str) -> None:
    logger.setLevel(level if level in logging.getLevelNamesMapping() else "INFO")
    if not logger.handlers and not logging.getLogger().handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        logger.addHandler(handler)


def create_app(settings: BimServiceSettings | None = None, environ: Mapping[str, str] | None = None) -> FastAPI:
    """The application configured from ``environ`` (default: the process environment).

    Raises :class:`~bim_service.settings.ServiceConfigError` when the configuration is invalid or when there is
    no usable authentication: a service that cannot authenticate does not start.
    """
    effective = settings or BimServiceSettings.from_env(os.environ if environ is None else environ)
    _configure_logging(effective.log_level)
    authenticator = load_authenticator(effective)
    operations.warm_up()
    app = build_app(effective, authenticator)
    logger.info("bim-service %s ready (bim-core %s)", __version__, operations.toolchain_block()["version"])
    return app

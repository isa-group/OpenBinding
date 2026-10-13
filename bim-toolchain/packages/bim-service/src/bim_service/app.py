"""The FastAPI application: routes, error translation and assembly.

``create_app()`` reads the configuration from the environment, loads the bearer tokens and refuses to return
(raises :class:`~bim_service.settings.ServiceConfigError`) when the service cannot run safely::

    uvicorn --factory bim_service.app:create_app

``build_app(settings, authenticator)`` assembles the same application from objects, which is what tests and
the OpenAPI generator use.  The service keeps no state besides the in-flight counters of its concurrency gate.

The routes that take a body read its bytes and hand them to the gate (:func:`_serve`): the slot is taken first and the
decoding, validation, operation and rendering happen in the pool thread (see :mod:`bim_service.runtime`).
"""

from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import Any, Callable, Mapping

from bim_core import BimError
from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel
from pydantic.json_schema import models_json_schema
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse, Response

from . import operations
from ._version import API_PREFIX, API_VERSION, __version__
from .auth import Authenticator, load_authenticator
from .middleware import AuthMiddleware, BodyLimitMiddleware, ContextMiddleware, PendingBodyMiddleware
from .models import (
    CompatibilityRequest,
    CompatibilityResponse,
    CompileResponse,
    DiagnosticsResponse,
    EngineValidateRequest,
    EvaluateRequest,
    EvaluateResponse,
    Health,
    NeighborhoodRequest,
    OptimizationResolveRequest,
    OptimizationResolveResponse,
    PackageRequest,
    Problem,
    ReevaluateRequest,
    ResourceValidateRequest,
    ValidateResponse,
    ValidateResultRequest,
    ValidateResultResponse,
    XmlResourceRequest,
    XmlRootResponse,
    XmlValidResponse,
)
from .problems import ServiceProblem, bim_error_problem, problem_response, respond
from .runtime import Gate
from .settings import BODY_MEMORY_FACTOR, BimServiceSettings
from .wire import (
    decode_base64,
    decode_model_body,
    decode_package_request,
    render_json,
    request_invalid,
    validation_diagnostics,
)

logger = logging.getLogger("bim_service")

_PROBLEMS: dict[int | str, dict[str, Any]] = {
    401: {"model": Problem, "description": "Missing or invalid bearer token."},
    413: {
        "model": Problem,
        "description": (
            "`payload_too_large`: the request body exceeds the configured size; `memory_budget_exceeded` and "
            "`pending_body_too_large`: the request can never fit the configured memory budget or limit of request "
            "bodies in flight (not retryable, no `Retry-After`)."
        ),
    },
    422: {"model": Problem, "description": "The input is invalid; `code` and `diagnostics` say why."},
    429: {
        "model": Problem,
        "description": (
            "`rate_limited`: the tenant of the bearer token has too many operations in flight; `memory_budget`: the "
            "operations in flight already use the memory budget; `pending_body_bytes`: the request bodies in flight "
            "already use their limit (see `Retry-After`)."
        ),
    },
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


#: The request models of the routes that read and validate their body themselves (see :func:`_serve`); FastAPI cannot
#: see them in a signature, so the OpenAPI document declares them by hand.
_JSON_REQUESTS: tuple[type[BaseModel], ...] = (
    CompatibilityRequest,
    OptimizationResolveRequest,
    EvaluateRequest,
    ReevaluateRequest,
    ValidateResultRequest,
    NeighborhoodRequest,
    ResourceValidateRequest,
    EngineValidateRequest,
    XmlResourceRequest,
)


def _tenant(request: Request) -> str | None:
    """The identity bound to the token that authenticated the request (never the ``X-BIM-Tenant`` header)."""
    return request.scope.get("state", {}).get("tenant")


def _settings(request: Request) -> BimServiceSettings:
    return request.app.state.settings


async def _serve(request: Request, job: Callable[[str | None, bytes], bytes]) -> Response:
    """Read the body, then run ``job(content_type, body)`` in the pool and answer the bytes it returns as JSON.

    The event loop only moves bytes.  Everything that costs CPU or memory in proportion to the body (``json.loads``,
    validation of the models, base64, the operation and rendering the answer) is the ``job``, which starts once a
    slot (and, when configured, the memory budget) is held, so a request that finds no slot decodes nothing.  Errors
    the job raises (``BimError``, ``ServiceProblem``, ``RequestValidationError``) reach the handlers below unchanged.
    """
    body = await request.body()
    content = await request.app.state.gate.run(
        job,
        request.headers.get("content-type"),
        body,
        tenant=_tenant(request),
        cost_bytes=len(body) * BODY_MEMORY_FACTOR,
        reservation=request.scope.get("state", {}).get("body_reservation"),
    )
    return Response(content=content, media_type="application/json")


def _package_job(settings: BimServiceSettings, call: Callable[..., Any]) -> Callable[[str | None, bytes], bytes]:
    def job(content_type: str | None, body: bytes) -> bytes:
        data, registered = decode_package_request(content_type or "", body, settings)
        return render_json(call(data, registered, settings.limits))

    return job


def _model_job(model: type[BaseModel], call: Callable[[Any], Any]) -> Callable[[str | None, bytes], bytes]:
    def job(content_type: str | None, body: bytes) -> bytes:
        return render_json(call(decode_model_body(model, content_type, body)))

    return job


def _json_body(model: type[BaseModel]) -> dict[str, Any]:
    """The request body of a route that reads and validates it itself, as OpenAPI declares it."""
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"$ref": f"#/components/schemas/{model.__name__}"}}},
        }
    }


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
        job = _package_job(_settings(request), lambda *args: operations.compile_package(*args))
        return await _serve(request, job)

    @router.post(
        "/validate",
        operation_id="validate",
        summary="Compile a package and report its diagnostics (no IR in the answer)",
        response_model=None,
        responses={200: {"model": ValidateResponse, "description": "`valid` and the diagnostics of the compilation."}},
        openapi_extra=_PACKAGE_BODY,
    )
    async def validate_package(request: Request) -> Response:
        job = _package_job(_settings(request), lambda *args: operations.validate_package(*args))
        return await _serve(request, job)

    @router.post(
        "/compatibility",
        operation_id="compatibility",
        summary="Why an Engine mode can or cannot run an IR",
        response_model=None,
        responses={200: {"model": CompatibilityResponse}},
        openapi_extra=_json_body(CompatibilityRequest),
    )
    async def compatibility(request: Request) -> Response:
        return await _serve(
            request,
            _model_job(
                CompatibilityRequest,
                lambda body: operations.compatibility(body.ir, body.manifest, body.mode, body.options),
            ),
        )

    @router.post(
        "/optimization/resolve",
        operation_id="resolveOptimization",
        summary="Validate and canonicalize an execution-time optimization selection",
        response_model=None,
        responses={200: {"model": OptimizationResolveResponse}},
        openapi_extra=_json_body(OptimizationResolveRequest),
    )
    async def resolve_optimization(request: Request) -> Response:
        return await _serve(
            request,
            _model_job(
                OptimizationResolveRequest,
                lambda body: operations.optimization(body.ir, body.manifest, body.mode, body.optimization),
            ),
        )

    @router.post(
        "/evaluate",
        operation_id="evaluate",
        summary="Evaluate bindings with the canonical evaluator",
        response_model=None,
        responses={200: {"model": EvaluateResponse}},
        openapi_extra=_json_body(EvaluateRequest),
    )
    async def evaluate(request: Request) -> Response:
        limit = _settings(request).max_bindings

        def call(body: EvaluateRequest) -> Any:
            if len(body.bindings) > limit:
                raise ServiceProblem(422, "limit_exceeded", f"at most {limit} bindings per request")
            return operations.evaluate(body.ir, body.bindings, body.execution, body.onError)

        return await _serve(request, _model_job(EvaluateRequest, call))

    @router.post(
        "/reevaluate",
        operation_id="reevaluate",
        summary="Replace an engine's claims with the authoritative evaluation",
        response_model=None,
        responses={200: {"description": "`{termination, solutions, provenance}`; only the bindings are the engine's."}},
        openapi_extra=_json_body(ReevaluateRequest),
    )
    async def reevaluate(request: Request) -> Response:
        return await _serve(
            request,
            _model_job(
                ReevaluateRequest,
                lambda body: operations.reevaluate(body.ir, body.result, body.execution, body.allowedTerminations),
            ),
        )

    @router.post(
        "/validate-result",
        operation_id="validateResult",
        summary="Is this payload shaped like a bim-engine/v1 result? (shape only)",
        response_model=None,
        responses={200: {"model": ValidateResultResponse}},
        openapi_extra=_json_body(ValidateResultRequest),
    )
    async def validate_result(request: Request) -> Response:
        return await _serve(
            request, _model_job(ValidateResultRequest, lambda body: operations.check_result(body.result))
        )

    @router.post(
        "/neighborhood",
        operation_id="neighborhood",
        summary="Evaluate the one-task alternatives of a binding",
        response_model=None,
        responses={200: {"description": "The counterfactual analysis."}},
        openapi_extra=_json_body(NeighborhoodRequest),
    )
    async def neighborhood(request: Request) -> Response:
        ceiling = _settings(request).neighborhood_max_seconds

        def call(body: NeighborhoodRequest) -> Any:
            if body.seconds > ceiling:
                raise ServiceProblem(422, "limit_exceeded", f"`seconds` is at most {ceiling:g}")
            return operations.neighborhood(
                body.ir, body.binding, body.task, body.limit, body.seconds, body.execution
            )

        return await _serve(request, _model_job(NeighborhoodRequest, call))

    @router.post(
        "/resources/validate",
        operation_id="validateResource",
        summary="A resource document against the schema of the installed Dialect that claims its type",
        response_model=None,
        responses={200: {"model": DiagnosticsResponse, "description": "The findings; empty when the document is valid."}},
        openapi_extra=_json_body(ResourceValidateRequest),
    )
    async def validate_resource(request: Request) -> Response:
        return await _serve(
            request,
            _model_job(
                ResourceValidateRequest,
                lambda body: operations.validate_resource(
                    body.document, body.apiVersion, body.kind, body.mediaType, body.resource, body.dialects
                ),
            ),
        )

    @router.post(
        "/engines/validate",
        operation_id="validateEngine",
        summary="An Engine manifest against the installed Profile it declares",
        response_model=None,
        responses={200: {"model": DiagnosticsResponse, "description": "The findings; empty when the manifest is valid."}},
        openapi_extra=_json_body(EngineValidateRequest),
    )
    async def validate_engine(request: Request) -> Response:
        return await _serve(
            request, _model_job(EngineValidateRequest, lambda body: operations.validate_engine(body.document))
        )

    @router.post(
        "/resources/xml/root",
        operation_id="xmlResourceRoot",
        summary="The root element of a standalone XML resource, parsed securely",
        response_model=None,
        responses={200: {"model": XmlRootResponse}},
        openapi_extra=_json_body(XmlResourceRequest),
    )
    async def xml_resource_root(request: Request) -> Response:
        limits = _settings(request).limits
        return await _serve(
            request,
            _model_job(
                XmlResourceRequest,
                lambda body: operations.xml_resource_root(decode_base64(body.contentBase64, "/contentBase64"), limits),
            ),
        )

    @router.post(
        "/resources/xml/validate-bpmn",
        operation_id="validateBpmnResource",
        summary="A standalone XML resource against OMG BPMN 2.0.2",
        response_model=None,
        responses={200: {"model": XmlValidResponse}},
        openapi_extra=_json_body(XmlResourceRequest),
    )
    async def validate_bpmn_resource(request: Request) -> Response:
        limits = _settings(request).limits
        return await _serve(
            request,
            _model_job(
                XmlResourceRequest,
                lambda body: operations.validate_bpmn_resource(
                    decode_base64(body.contentBase64, "/contentBase64"), limits
                ),
            ),
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


def _without_nulls(value: Any) -> Any:
    """``value`` without the object members that are ``null``: what FastAPI does to the schemas it generates itself
    (``exclude_none``), so that the schemas added by hand read the same (no ``"default": null``)."""
    if isinstance(value, dict):
        return {key: _without_nulls(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_without_nulls(item) for item in value]
    return value


def _patch_openapi(schema: dict[str, Any]) -> None:
    """Add the request schema that routes reading the body themselves cannot declare, and tidy the errors."""
    components = schema.setdefault("components", {}).setdefault("schemas", {})
    package = PackageRequest.model_json_schema(ref_template="#/components/schemas/{model}")
    components.update(package.pop("$defs", {}))
    components["PackageRequest"] = package
    _, requests = models_json_schema(
        [(model, "validation") for model in _JSON_REQUESTS], ref_template="#/components/schemas/{model}"
    )
    components.update(_without_nulls(requests.get("$defs", {})))
    for name in ("HTTPValidationError", "ValidationError"):
        components.pop(name, None)
    schema["components"]["securitySchemes"] = {
        "bearerAuth": {
            "type": "http",
            "scheme": "bearer",
            "description": (
                "Static service-to-service token (up to two per tenant are accepted during a rotation). "
                "The tenant bound to the token is the caller's identity for the per-tenant concurrency share."
            ),
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
    """The application for ``settings`` and ``authenticator``; nothing is read from the environment.

    ``app.state.settings`` is the *effective* configuration: the per-tenant limit that applies depends on how many
    tenants the authenticator knows.
    """
    settings = settings.for_tenants(authenticator.tenant_count)

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        # The interval is process-wide state: it is applied while the application runs (not when it is created, which
        # tests and the OpenAPI generator do without serving) and put back at shutdown.
        configured = settings.switch_interval_seconds
        previous = sys.getswitchinterval()
        if configured is not None:
            sys.setswitchinterval(configured)
        try:
            yield
        finally:
            if configured is not None:
                sys.setswitchinterval(previous)
            application.state.gate.close()

    app = FastAPI(
        title="BIM service",
        version=__version__,
        summary="Stateless HTTP API over the BIM toolchain",
        description=(
            f"`{API_VERSION}`: compile and validate BIM v1 packages, check Engine compatibility, evaluate and "
            "re-evaluate bindings and analyse their neighbourhood, and check single documents (a resource, an "
            "Engine manifest, a standalone XML resource). No state, no database; every answer is a pure "
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
    app.add_middleware(PendingBodyMiddleware, bodies=app.state.gate.bodies)
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
    limit = app.state.settings.effective_max_concurrency_per_tenant
    logger.info("per-tenant concurrency limit: %s", limit if limit else "not applied")
    logger.info("bim-service %s ready (bim-core %s)", __version__, operations.toolchain_block()["version"])
    return app

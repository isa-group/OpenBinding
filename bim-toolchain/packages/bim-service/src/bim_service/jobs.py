"""The jobs of the routes that take a body: ``job(content_type, body) -> bytes``.

A job decodes and validates the request body, runs the operation and renders the answer as JSON bytes.  Errors it raises
(``BimError``, ``ServiceProblem``, ``RequestValidationError``) are translated by :func:`bim_service.problems.failure_response`.
The same code runs in a thread of the pool (``BIM_SERVICE_EXECUTOR=thread``) and in a worker process
(:mod:`bim_service._worker`), which is why the table is keyed by an operation id and its builders only need the settings.

``operations.<name>`` and the decoding functions are looked up when the job runs, not when it is built.
"""

from __future__ import annotations

from typing import Any, Callable

from pydantic import BaseModel

from . import operations
from .models import (
    CompatibilityRequest,
    EngineValidateRequest,
    EvaluateRequest,
    NeighborhoodRequest,
    OptimizationResolveRequest,
    ReevaluateRequest,
    ResourceValidateRequest,
    ValidateResultRequest,
    XmlResourceRequest,
)
from .problems import ServiceProblem
from .settings import BimServiceSettings
from .wire import decode_base64, decode_model_body, decode_package_request, render_json

Job = Callable[[str | None, bytes], bytes]
Builder = Callable[[BimServiceSettings], Job]


def _package_job(settings: BimServiceSettings, call: Callable[..., Any]) -> Job:
    def job(content_type: str | None, body: bytes) -> bytes:
        data, registered = decode_package_request(content_type or "", body, settings)
        return render_json(call(data, registered, settings.limits))

    return job


def _model_job(model: type[BaseModel], call: Callable[[Any], Any]) -> Job:
    def job(content_type: str | None, body: bytes) -> bytes:
        return render_json(call(decode_model_body(model, content_type, body)))

    return job


def _compile(settings: BimServiceSettings) -> Job:
    return _package_job(settings, lambda *args: operations.compile_package(*args))


def _validate(settings: BimServiceSettings) -> Job:
    return _package_job(settings, lambda *args: operations.validate_package(*args))


def _compatibility(settings: BimServiceSettings) -> Job:
    return _model_job(
        CompatibilityRequest, lambda body: operations.compatibility(body.ir, body.manifest, body.mode, body.options)
    )


def _resolve_optimization(settings: BimServiceSettings) -> Job:
    return _model_job(
        OptimizationResolveRequest,
        lambda body: operations.optimization(body.ir, body.manifest, body.mode, body.optimization),
    )


def _evaluate(settings: BimServiceSettings) -> Job:
    limit = settings.max_bindings

    def call(body: EvaluateRequest) -> Any:
        if len(body.bindings) > limit:
            raise ServiceProblem(422, "limit_exceeded", f"at most {limit} bindings per request")
        return operations.evaluate(body.ir, body.bindings, body.execution, body.onError)

    return _model_job(EvaluateRequest, call)


def _reevaluate(settings: BimServiceSettings) -> Job:
    return _model_job(
        ReevaluateRequest,
        lambda body: operations.reevaluate(body.ir, body.result, body.execution, body.allowedTerminations),
    )


def _validate_result(settings: BimServiceSettings) -> Job:
    return _model_job(ValidateResultRequest, lambda body: operations.check_result(body.result))


def _neighborhood(settings: BimServiceSettings) -> Job:
    ceiling = settings.neighborhood_max_seconds

    def call(body: NeighborhoodRequest) -> Any:
        if body.seconds > ceiling:
            raise ServiceProblem(422, "limit_exceeded", f"`seconds` is at most {ceiling:g}")
        return operations.neighborhood(body.ir, body.binding, body.task, body.limit, body.seconds, body.execution)

    return _model_job(NeighborhoodRequest, call)


def _validate_resource(settings: BimServiceSettings) -> Job:
    return _model_job(
        ResourceValidateRequest,
        lambda body: operations.validate_resource(
            body.document, body.apiVersion, body.kind, body.mediaType, body.resource, body.dialects
        ),
    )


def _validate_engine(settings: BimServiceSettings) -> Job:
    return _model_job(EngineValidateRequest, lambda body: operations.validate_engine(body.document))


def _xml_resource_root(settings: BimServiceSettings) -> Job:
    limits = settings.limits
    return _model_job(
        XmlResourceRequest,
        lambda body: operations.xml_resource_root(decode_base64(body.contentBase64, "/contentBase64"), limits),
    )


def _validate_bpmn_resource(settings: BimServiceSettings) -> Job:
    limits = settings.limits
    return _model_job(
        XmlResourceRequest,
        lambda body: operations.validate_bpmn_resource(decode_base64(body.contentBase64, "/contentBase64"), limits),
    )


#: Operation id (the ``operationId`` of the route) -> builder of its job.
JOBS: dict[str, Builder] = {
    "compile": _compile,
    "validate": _validate,
    "compatibility": _compatibility,
    "resolveOptimization": _resolve_optimization,
    "evaluate": _evaluate,
    "reevaluate": _reevaluate,
    "validateResult": _validate_result,
    "neighborhood": _neighborhood,
    "validateResource": _validate_resource,
    "validateEngine": _validate_engine,
    "xmlResourceRoot": _xml_resource_root,
    "validateBpmnResource": _validate_bpmn_resource,
}

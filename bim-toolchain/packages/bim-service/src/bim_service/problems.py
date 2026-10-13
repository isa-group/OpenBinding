"""Errors as ``application/problem+json`` (RFC 9457).

Two kinds of failure reach a client:

* a :class:`bim_core.BimError` (the library's own, deliberate errors).  One handler translates all of
  them: ``code`` and ``diagnostics`` are the error's, ``status`` is ``ContractError.http_status`` when it has
  one and 422 otherwise, and the extension member ``errorType`` names the class so that a client can raise the
  same one (``bim_client.HttpBim`` does);
* a :class:`ServiceProblem`: something about the service rather than the input (authentication, size, load,
  time).  Those have no ``errorType``.

``type`` is always ``urn:bim-toolchain:problem:<code>``.
"""

from __future__ import annotations

from typing import Any, Mapping

from bim_core import BimError
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

PROBLEM_BASE = "urn:bim-toolchain:problem:"
PROBLEM_MEDIA_TYPE = "application/problem+json"

#: Classes a client can rebuild, most specific names the ones a ``BimError`` is reported as.
ERROR_TYPES = (
    "CompileError",
    "PackageError",
    "ExpressionError",
    "CanonicalizationError",
    "EvaluationError",
    "ProtocolError",
    "ContractError",
)

#: Codes of errors that are the service's fault, not the input's.
_SERVER_FAULTS = frozenset({"protocol_document_invalid", "invalid_limit"})


class ServiceProblem(Exception):
    """A failure of the service itself (not of the input), with the status to answer."""

    def __init__(
        self,
        status: int,
        code: str,
        detail: str,
        *,
        diagnostics: list[dict[str, Any]] | None = None,
        headers: Mapping[str, str] | None = None,
        extensions: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail
        self.diagnostics = diagnostics or []
        self.headers = dict(headers or {})
        #: Extra members of the problem document (``Problem`` allows them), e.g. ``correlationId``.
        self.extensions = dict(extensions or {})


def title_for(code: str) -> str:
    return code.replace("_", " ").capitalize()


def error_type(error: BaseException) -> str:
    """Name of the most specific public class of ``error``: one of :data:`ERROR_TYPES` or ``BimError``."""
    for cls in type(error).__mro__:
        if cls.__name__ in ERROR_TYPES:
            return cls.__name__
    return "BimError"


def status_for(error: BimError) -> int:
    suggested = getattr(error, "http_status", None)
    if isinstance(suggested, int) and not isinstance(suggested, bool) and 400 <= suggested <= 599:
        return suggested
    return 500 if error.code in _SERVER_FAULTS else 422


def _diagnostics(items: list[Any]) -> list[Any]:
    return [item.as_dict() if hasattr(item, "as_dict") else item for item in items]


def bim_error_problem(error: BimError) -> tuple[int, dict[str, Any]]:
    """``(status, body)`` of the problem that reports ``error``."""
    status = status_for(error)
    body: dict[str, Any] = {
        "type": PROBLEM_BASE + error.code,
        "title": title_for(error.code),
        "status": status,
        "detail": error.message,
        "code": error.code,
        "errorType": error_type(error),
        "diagnostics": _diagnostics(error.diagnostics),
    }
    if getattr(error, "http_status", None) is not None:
        body["httpStatus"] = error.http_status
    span = getattr(error, "span", None)
    if span is not None:
        body["span"] = span
    return status, body


def service_problem(problem: ServiceProblem) -> tuple[int, dict[str, Any]]:
    return problem.status, {
        **problem.extensions,
        "type": PROBLEM_BASE + problem.code,
        "title": title_for(problem.code),
        "status": problem.status,
        "detail": problem.detail,
        "code": problem.code,
        "diagnostics": problem.diagnostics,
    }


class ProblemResponse(JSONResponse):
    media_type = PROBLEM_MEDIA_TYPE


def problem_response(status: int, body: dict[str, Any], headers: Mapping[str, str] | None = None) -> ProblemResponse:
    return ProblemResponse(body, status_code=status, headers=dict(headers) if headers else None)


def respond(problem: ServiceProblem) -> ProblemResponse:
    status, body = service_problem(problem)
    return problem_response(status, body, problem.headers)


def failure_response(error: BaseException) -> tuple[int, dict[str, Any], dict[str, str]] | None:
    """``(status, problem body, headers)`` of an error that a job raises, or ``None`` for any other exception.

    The application's exception handlers and the worker processes both call this, so a request gives the same problem
    whichever executor ran it: ``BimError``, :class:`ServiceProblem`, ``RequestValidationError`` and the HTTP
    exceptions of the framework.  ``None`` is an unexpected failure.
    """
    if isinstance(error, BimError):
        status, body = bim_error_problem(error)
        return status, body, {}
    if isinstance(error, ServiceProblem):
        status, body = service_problem(error)
        return status, body, dict(error.headers)
    if isinstance(error, RequestValidationError):
        from .wire import request_invalid, validation_diagnostics  # wire imports this module

        status, body = bim_error_problem(
            request_invalid("the request does not match the contract", validation_diagnostics(error))
        )
        return status, body, {}
    if isinstance(error, StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed"}.get(error.status_code, "http_error")
        status, body = service_problem(
            ServiceProblem(error.status_code, code, str(error.detail), headers=error.headers)
        )
        return status, body, dict(error.headers or {})
    return None

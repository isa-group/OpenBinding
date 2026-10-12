"""Errors of the client side, and the translation of ``application/problem+json`` back into ``bim_core`` errors.

A problem that reports a ``bim_core`` error carries ``errorType`` (the class), ``code``, ``detail`` (the
message), ``diagnostics`` and, when the original had one, ``httpStatus``/``span``.  :func:`exception_from_problem`
builds the same exception ``InProcessBim`` would have raised.  A problem without ``errorType`` is about the
service (authentication, size, load, time) and becomes a :class:`BimServiceError`.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from bim_core import (
    BimError,
    CanonicalizationError,
    CompileDiagnostic,
    CompileError,
    ContractError,
    EvaluationError,
    ExpressionError,
    PackageError,
    ProtocolError,
)


class BimServiceError(BimError):
    """The service could not be reached or refused the request for a reason that is not about the input.

    ``code`` is the problem's (``unauthorized``, ``payload_too_large``, ``rate_limited``, ``service_busy``,
    ``operation_timeout``, ``limit_exceeded``, ...) or one the client invents (``service_unavailable``,
    ``service_timeout``, ``bad_response``, ``http_<status>``).  ``status`` is the HTTP status when there was a
    response and ``retry_after`` the seconds of ``Retry-After``, if sent.
    """

    def __init__(
        self,
        code: str,
        message: str,
        diagnostics: Iterable[Any] = (),
        *,
        status: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(code, message, diagnostics)
        self.status = status
        self.retry_after = retry_after

    def as_dict(self) -> dict[str, Any]:
        result = super().as_dict()
        if self.status is not None:
            result["status"] = self.status
        return result


def _diagnostic(item: Mapping[str, Any]) -> CompileDiagnostic:
    return CompileDiagnostic(
        code=str(item.get("code", "")),
        message=str(item.get("message", "")),
        resource=item.get("resource"),
        pointer=item.get("pointer"),
        span=item.get("span"),
        bpmn_element=item.get("bpmnElement"),
        ir_path=item.get("irPath"),
        related=tuple(item.get("related", ())),
    )


def exception_from_problem(
    problem: Mapping[str, Any], *, status: int | None = None, retry_after: float | None = None
) -> BimError:
    """The exception that a problem document stands for."""
    code = str(problem.get("code") or f"http_{status}")
    detail = str(problem.get("detail") or problem.get("title") or "")
    raw = problem.get("diagnostics")
    diagnostics = [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []
    kind = problem.get("errorType")
    if kind == "CompileError":
        return CompileError([_diagnostic(item) for item in diagnostics])
    if kind == "PackageError":
        return PackageError(detail, code=code, diagnostics=diagnostics)
    if kind == "ExpressionError":
        return ExpressionError(detail, span=problem.get("span"), code=code)
    if kind == "CanonicalizationError":
        return CanonicalizationError(detail, code=code)
    if kind == "EvaluationError":
        return EvaluationError(code, detail, diagnostics)
    if kind == "ProtocolError":
        return ProtocolError(code, detail, diagnostics)
    if kind == "ContractError":
        return ContractError(code, detail, diagnostics, http_status=problem.get("httpStatus"))
    if kind == "BimError":
        return BimError(code, detail, diagnostics)
    return BimServiceError(code, detail, diagnostics, status=status, retry_after=retry_after)

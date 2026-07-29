"""One shape for everything that goes wrong.

The gateway already answered failed validation with a structured body - an
``error`` string beside a list of violations - but every other failure was a
bare string, and none of it was described in the OpenAPI document. A client
could not tell "this instance is invalid" from "your quota is spent" without
reading the prose.

So: every error carries a machine-readable ``code``, and the endpoints declare
which of these they can return. ``ViolationsError`` keeps the existing
validation body exactly as it was, because clients already parse it.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field


class ErrorBody(BaseModel):
    """The payload under ``detail``."""

    code: str = Field(..., description="Stable machine-readable identifier for this failure.")
    error: str = Field(..., description="Human-readable explanation.")


class ErrorResponse(BaseModel):
    """A failure, as it appears on the wire."""

    detail: ErrorBody


class ViolationBody(BaseModel):
    code: str
    message: str
    path: Optional[str] = None
    constraint_id: Optional[str] = None
    stage: Optional[str] = None


class ViolationsErrorBody(BaseModel):
    error: str
    violations: List[ViolationBody] = Field(default_factory=list)


class ViolationsErrorResponse(BaseModel):
    """A rejected instance, with the reasons it was rejected."""

    detail: ViolationsErrorBody


def api_error(
    status_code: int,
    code: str,
    message: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    **extra: Any,
) -> HTTPException:
    """An ``HTTPException`` whose body matches ``ErrorResponse``.

    ``extra`` carries the fields a particular failure needs - the quota that
    was exhausted, the plan that would allow it - alongside the code and the
    message every failure has.
    """
    detail: Dict[str, Any] = {"code": code, "error": message}
    detail.update({key: value for key, value in extra.items() if value is not None})
    return HTTPException(status_code=status_code, detail=detail, headers=headers)


#: Ready-made ``responses={}`` entries, so endpoints declare their failures
#: without repeating the description each time.
UNAUTHORIZED_RESPONSE = {
    "model": ErrorResponse,
    "description": "No usable credential was supplied.",
}
FORBIDDEN_RESPONSE = {
    "model": ErrorResponse,
    "description": "The credential is valid but not allowed to do this.",
}
NOT_FOUND_RESPONSE = {
    "model": ErrorResponse,
    "description": "No such resource, or none this caller may see.",
}
CONFLICT_RESPONSE = {
    "model": ErrorResponse,
    "description": "The request conflicts with something that already exists.",
}
UNAVAILABLE_RESPONSE = {
    "model": ErrorResponse,
    "description": "A service the gateway depends on is not reachable.",
}

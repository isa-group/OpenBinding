"""Documented account, authorization, and quota error responses.

BIM endpoints use the v1 ``application/problem+json`` contract directly.  This
module contains only the response models still shared by the surrounding
account and platform routes.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field


class ErrorBody(BaseModel):
    """The payload under ``detail``."""

    code: str = Field(..., description="Stable machine-readable identifier for this failure.")
    error: str = Field(..., description="Human-readable explanation.")


class ErrorResponse(BaseModel):
    """A failure, as it appears on the wire."""

    detail: ErrorBody


class QuotaBody(BaseModel):
    """Which allowance refused, and where it stands.

    Enough for a client to decide what to do next without asking again: the
    limit that ran out, how much of it there was, and when it comes back.
    """

    limit_id: str = Field(..., description="Identifier of the limit in the pricing.")
    limit: float = Field(..., description="What the plan allows.")
    used: Optional[float] = Field(default=None, description="What has been consumed.")
    actual: Optional[float] = Field(
        default=None,
        description="For a limit measured from the request rather than spent, what it measured.",
    )
    unit: Optional[str] = None
    renews_at: Optional[str] = Field(
        default=None, description="When a renewable limit next resets."
    )


class QuotaErrorBody(ErrorBody):
    quota: Optional[QuotaBody] = None


class QuotaErrorResponse(BaseModel):
    """An allowance spent, or an instance beyond what the plan solves."""

    detail: QuotaErrorBody


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
QUOTA_RESPONSE = {
    "model": QuotaErrorResponse,
    "description": (
        "The caller's plan has no allowance left, or the instance is larger than "
        "the plan solves. Distinct from 403: this is an allowance spent rather than "
        "a permission missing, so retrying after it renews is worth something."
    ),
}
PAYLOAD_TOO_LARGE_RESPONSE = {
    "model": ErrorResponse,
    "description": "The request body is larger than this caller's plan allows.",
}

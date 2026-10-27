"""Deprecation signals for the operations behind the retired screens (M2.4, ADR-0020 decision 5).

One table lists the retired operations; a pure ASGI middleware adds ``Deprecation`` (and ``Sunset`` once a date is
recorded) to every response of those operations, and ``annotate_retired_operations`` declares the same headers in the
OpenAPI document. Behaviour is unchanged: no route file is touched and nothing is buffered.
"""

from __future__ import annotations

import datetime
from email.utils import format_datetime
from typing import Any

from starlette.types import ASGIApp, Message, Receive, Scope, Send

#: ``@1792627200`` is 2026-10-22T00:00:00Z, the owner's retirement decision (ADR-0020), in the RFC 9745 form.
# [impl->req~gateway-api-retired-operation-deprecation~1]
DEPRECATION_VALUE = "@1792627200"

#: The one place a Sunset date lives. The R1 release pull request sets it to the R1 release date plus 90 days;
#: until then no response carries ``Sunset`` and the OpenAPI document does not declare it.
# [impl->req~gateway-api-retired-operation-no-sunset~1]
RETIRED_OPERATIONS_SUNSET: datetime.date | None = None

# [impl->req~gateway-api-retired-operation-set~1]
#: The 36 retired operations: ``(method, route path template)``.
RETIRED_OPERATIONS: tuple[tuple[str, str], ...] = (
    # decision-space workspace
    ("GET", "/v1/analysis/sources"),
    ("POST", "/v1/analysis/query"),
    ("POST", "/v1/analysis/candidate"),
    ("POST", "/v1/analysis/export"),
    ("POST", "/v1/analysis/reports"),
    ("POST", "/v1/analysis/pareto"),
    ("GET", "/v1/analysis/pareto/{task_id}"),
    ("POST", "/v1/analysis/pareto/{task_id}/cancel"),
    # report editor
    ("GET", "/v1/organizations/{org}/projects/{project}/reports/{report}"),
    ("POST", "/v1/organizations/{org}/projects/{project}/reports"),
    ("POST", "/v1/organizations/{org}/projects/{project}/reports/{report}/freeze"),
    ("POST", "/v1/organizations/{org}/projects/{project}/reports/{report}/drafts"),
    ("PATCH", "/v1/organizations/{org}/projects/{project}/reports/{report}"),
    ("DELETE", "/v1/organizations/{org}/projects/{project}/reports/{report}"),
    ("POST", "/v1/organizations/{org}/projects/{project}/publications"),
    # library catalogue
    ("POST", "/v1/organizations/{org}/library"),
    ("GET", "/v1/artifacts/{artifact_id}"),
    ("PATCH", "/v1/artifacts/{artifact_id}"),
    ("GET", "/v1/artifacts/{artifact_id}/versions/{version_id}"),
    ("GET", "/v1/artifacts/{artifact_id}/drafts"),
    ("POST", "/v1/artifacts/{artifact_id}/drafts"),
    ("PUT", "/v1/artifacts/{artifact_id}/drafts/{draft_id}"),
    ("POST", "/v1/artifacts/{artifact_id}/drafts/{draft_id}/seal"),
    ("POST", "/v1/artifacts/{artifact_id}/versions/{version_id}/publish"),
    ("POST", "/v1/artifacts/{artifact_id}/versions/{version_id}/withdraw"),
    # project library
    ("PUT", "/v1/organizations/{org}/projects/{project}/library/{artifact_id}"),
    ("GET", "/v1/organizations/{org}/projects/{project}/library"),
    ("DELETE", "/v1/organizations/{org}/projects/{project}/library/{artifact_id}"),
    # project resources
    ("POST", "/v1/organizations/{org}/projects/{project}/resources"),
    ("GET", "/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions/{revision}"),
    ("POST", "/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions"),
    ("GET", "/v1/organizations/{org}/projects/{project}/resources/{resource}"),
    ("PATCH", "/v1/organizations/{org}/projects/{project}/resources/{resource}"),
    ("DELETE", "/v1/organizations/{org}/projects/{project}/resources/{resource}"),
    # sponsorship
    ("POST", "/v1/admin/organizations/{organization_id}/sponsor"),
    ("GET", "/v1/sponsor-proposals/{proposal_id}"),
)

_ROWS = frozenset(RETIRED_OPERATIONS)

_DEPRECATION_REF = {"$ref": "#/components/headers/Deprecation"}
_SUNSET_REF = {"$ref": "#/components/headers/Sunset"}


# [impl->req~gateway-api-retired-operation-sunset~1]
def sunset_value() -> str | None:
    """The ``Sunset`` header value: the recorded date at 23:59:59 GMT (IMF-fixdate), or ``None`` while none is set."""
    day = RETIRED_OPERATIONS_SUNSET
    if day is None:
        return None
    moment = datetime.datetime(day.year, day.month, day.day, 23, 59, 59, tzinfo=datetime.timezone.utc)
    return format_datetime(moment, usegmt=True)


def response_headers() -> list[tuple[bytes, bytes]]:
    """The raw header pairs a retired operation's response carries now."""
    pairs = [(b"deprecation", DEPRECATION_VALUE.encode("latin-1"))]
    sunset = sunset_value()
    if sunset is not None:
        pairs.append((b"sunset", sunset.encode("latin-1")))
    return pairs


# [impl->req~gateway-api-retired-operation-deprecation~1] [impl->req~gateway-api-retired-operation-no-match~1]
class RetiredOperationsMiddleware:
    """Pure ASGI: adds the deprecation headers at ``http.response.start`` when the request is a table row.

    The key is the request method and the matched route's ``path_format``, read from ``scope["route"]``, which the
    router sets before the endpoint runs. Unmatched paths and a method with no row (405) carry no header. It must sit
    inside the CORS middleware so preflights never reach it.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def deprecating_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                route = scope.get("route")
                path_format = getattr(route, "path_format", None)
                if path_format is not None and (scope.get("method"), path_format) in _ROWS:
                    headers = list(message.get("headers") or [])
                    present = {name.lower() for name, _ in headers}
                    for name, value in response_headers():
                        if name not in present:
                            headers.append((name, value))
                    message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, deprecating_send)


# [impl->req~gateway-api-retired-operation-openapi~1] [impl->req~gateway-api-retired-operation-openapi-headers~1]
def annotate_retired_operations(document: dict[str, Any]) -> None:
    """Mark the table's operations ``deprecated`` and declare the headers on each of their responses, in place."""
    sunset = sunset_value()
    paths = document.get("paths", {})
    for method, template in RETIRED_OPERATIONS:
        operation = paths.get(template, {}).get(method.lower())
        if operation is None:
            continue
        operation["deprecated"] = True
        for response in operation.get("responses", {}).values():
            headers = response.setdefault("headers", {})
            headers["Deprecation"] = _DEPRECATION_REF
            if sunset is not None:
                headers["Sunset"] = _SUNSET_REF

    declared = document.setdefault("components", {}).setdefault("headers", {})
    declared["Deprecation"] = {
        "description": (
            "The operation is deprecated (RFC 9745). The value is the deprecation date as a structured-field date: "
            f"`{DEPRECATION_VALUE}` is 2026-10-22T00:00:00Z."
        ),
        "schema": {"type": "string"},
        "example": DEPRECATION_VALUE,
    }
    if sunset is not None:
        declared["Sunset"] = {
            "description": "The operation is expected to stop being served at this time (RFC 8594).",
            "schema": {"type": "string"},
            "example": sunset,
        }


__all__ = [
    "DEPRECATION_VALUE",
    "RETIRED_OPERATIONS",
    "RETIRED_OPERATIONS_SUNSET",
    "RetiredOperationsMiddleware",
    "annotate_retired_operations",
    "response_headers",
    "sunset_value",
]

"""The one problem document the gateway answers validation failures with.

Shape (RFC 9457 problem details, extended with ``code`` and ``diagnostics``)::

    {
      "type": "https://openbinding.dev/problems/validation_error",
      "title": "validation_error",      # same value as ``code`` (clients read it as the code)
      "status": 422,
      "code": "validation_error",       # stable, machine-readable
      "detail": "Request validation failed: /spec/limits/maxTasks: ...",
      "diagnostics": [
        {"code": "greater_than", "message": "...", "pointer": "/spec/limits/maxTasks"}
      ]
    }

A 5xx document also carries ``correlationId`` (``core/public_errors.py``); a 4xx never does.

Every 422 - a request Pydantic refuses, an ``HTTPException(422)`` raised by a
route, a BIM compiler refusal, a refused pricing document - goes through
:func:`problem_response`, so a client parses one shape.  The handlers that call
it are registered once, in ``main.py``; routes keep raising ``api_error(422,
...)`` / ``HTTPException(422, ...)`` and need not know about the shape.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

from fastapi.responses import JSONResponse

PROBLEM_TYPE_BASE = "https://openbinding.dev/problems/"
PROBLEM_MEDIA_TYPE = "application/problem+json"
JSON_MEDIA_TYPE = "application/json"

#: The code of a 422 that names no more specific reason.
VALIDATION_ERROR = "validation_error"

#: Keys the problem document owns; a route's extra fields never replace them.
CANONICAL_KEYS = frozenset({"type", "title", "status", "code", "detail", "diagnostics"})

#: Optional member of a 5xx document (never of a 4xx): the id that names the log line of the failure.
CORRELATION_ID_KEY = "correlationId"

#: Its declaration in the OpenAPI ``Problem`` schema.
CORRELATION_ID_SCHEMA = {
    "type": "string",
    "description": (
        "Only on 5xx. Identifies this failure in the gateway log, which records the cause; "
        "the response never states it. Quote this id when reporting the error."
    ),
}

#: Where FastAPI says a value came from (the first element of ``loc``).
_PARAMETER_LOCATIONS = frozenset({"body", "query", "path", "header", "cookie"})


def json_pointer(parts: Iterable[Any]) -> str:
    """An RFC 6901 JSON Pointer; the empty sequence is the whole document (``""``)."""
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def problem_body(
    status_code: int,
    code: str,
    detail: str,
    diagnostics: Sequence[Any] | None = None,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The canonical document.  A 422 always lists at least one diagnostic."""
    body: dict[str, Any] = {
        "type": f"{PROBLEM_TYPE_BASE}{code}",
        "title": code,
        "status": status_code,
        "code": code,
        "detail": detail,
    }
    items = normalize_diagnostics(diagnostics, code, detail)
    if not items and status_code == 422:
        items = [{"code": code, "message": detail}]
    if items:
        body["diagnostics"] = items
    for key, value in (extra or {}).items():
        if key in CANONICAL_KEYS:
            body.setdefault("extra", {})[key] = value
        else:
            body[key] = value
    return body


def problem_response(
    status_code: int,
    code: str,
    detail: str,
    diagnostics: Sequence[Any] | None = None,
    *,
    headers: Mapping[str, str] | None = None,
    extra: Mapping[str, Any] | None = None,
    media_type: str = PROBLEM_MEDIA_TYPE,
) -> JSONResponse:
    return JSONResponse(
        problem_body(status_code, code, detail, diagnostics, extra),
        status_code=status_code,
        media_type=media_type,
        headers=dict(headers) if headers else None,
    )


def normalize_diagnostics(
    diagnostics: Sequence[Any] | None, default_code: str, default_message: str = ""
) -> list[dict[str, Any]]:
    """Every diagnostic is an object with at least ``code`` and ``message``.

    Objects that already have both are passed through untouched, so the
    compiler's own diagnostics (``resource``, ``pointer``, ``span``, ...) keep
    every field.
    """
    if not isinstance(diagnostics, (list, tuple)):
        return []
    items: list[dict[str, Any]] = []
    for item in diagnostics:
        if isinstance(item, Mapping):
            entry = dict(item)
            entry.setdefault("code", default_code)
            if "message" not in entry:
                entry["message"] = str(entry.get("detail") or entry.get("error") or default_message or entry["code"])
            items.append(entry)
        else:
            items.append({"code": default_code, "message": str(item)})
    return items


def validation_diagnostics(errors: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """One diagnostic per Pydantic/FastAPI validation error, keeping what it knows.

    ``code`` is the Pydantic error type; ``pointer`` is the JSON Pointer of the
    offending field inside the request body; a value that is not in the body
    (query, path, header, cookie) is named by ``in`` and ``parameter`` instead.
    ``loc`` is the untouched Pydantic location.  The submitted value is never
    echoed: it may be a password or a token.
    """
    diagnostics: list[dict[str, Any]] = []
    for error in errors:
        loc = tuple(error.get("loc") or ())
        error_type = str(error.get("type") or VALIDATION_ERROR)
        diagnostic: dict[str, Any] = {
            "code": error_type,
            "message": str(error.get("msg") or "The value is not valid."),
        }
        origin = loc[0] if loc and loc[0] in _PARAMETER_LOCATIONS else None
        path = loc[1:] if origin else loc
        context = error.get("ctx") if isinstance(error.get("ctx"), Mapping) else {}
        if error_type == "json_invalid":
            # ``loc`` is ("body", <character offset>): not a place in the document.
            diagnostic["in"] = "body"
            offset = path[0] if path and isinstance(path[0], int) else None
            if offset is not None:
                diagnostic["span"] = {"offset": offset}
            if context.get("error"):
                diagnostic["hint"] = str(context["error"])
        elif origin == "body" or origin is None:
            if origin:
                diagnostic["in"] = origin
            if path:
                diagnostic["pointer"] = json_pointer(path)
        else:
            diagnostic["in"] = origin
            if path:
                diagnostic["parameter"] = str(path[0])
            if len(path) > 1:
                diagnostic["pointer"] = json_pointer(path[1:])
        if error_type == "missing":
            diagnostic["hint"] = "This field is required."
        diagnostic["loc"] = [part if isinstance(part, (int, str)) else str(part) for part in loc]
        simple = {
            str(key): value
            for key, value in context.items()
            if value is None or isinstance(value, (str, int, float, bool))
        }
        if simple and error_type != "json_invalid":
            diagnostic["context"] = simple
        diagnostics.append(diagnostic)
    return diagnostics


def summarize(diagnostics: Sequence[Mapping[str, Any]], prefix: str = "Request validation failed") -> str:
    """A one-line ``detail`` for a list of diagnostics: the first one, plus a count."""
    if not diagnostics:
        return prefix
    first = diagnostics[0]
    where = first.get("pointer")
    if not where and first.get("parameter"):
        where = f"{first.get('in', 'request')} parameter {first['parameter']}"
    text = f"{prefix}: {where + ': ' if where else ''}{first.get('message', '')}"
    if len(diagnostics) > 1:
        text += f" (+{len(diagnostics) - 1} more)"
    return text


def split_detail(detail: Any, default_code: str) -> tuple[str, str, list[dict[str, Any]], dict[str, Any]]:
    """Take an ``HTTPException.detail`` apart into code, message, diagnostics, extras.

    Accepts the gateway's own shapes (``{"code", "error"|"message",
    "diagnostics", ...}``), a bare string, and FastAPI's list of validation
    errors.
    """
    if isinstance(detail, Mapping):
        code = str(detail.get("code") or default_code)
        diagnostics = normalize_diagnostics(detail.get("diagnostics"), code)
        message = detail.get("message") or detail.get("error")
        if not message:
            message = summarize(diagnostics, prefix=code) if diagnostics else code
        extra = {key: value for key, value in detail.items() if key not in ("code", "message", "error", "diagnostics")}
        return code, str(message), diagnostics, extra
    if isinstance(detail, list):
        diagnostics = validation_diagnostics(item for item in detail if isinstance(item, Mapping))
        return default_code, summarize(diagnostics), diagnostics, {}
    return default_code, str(detail), [], {}

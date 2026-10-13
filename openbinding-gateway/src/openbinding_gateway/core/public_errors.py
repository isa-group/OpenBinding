"""Stable public failures and the correlation id that ties one to its log line.

A 5xx must not explain itself: the text of an exception may quote the input, a
host name or a secret.  The client gets a fixed ``code`` and ``detail`` plus a
``correlationId``; the log gets the exception class, where it was raised and the
same id, and an operator joins the two.  The pattern is the one of
``bim-service`` (``bim_service/middleware.py``).

* :func:`correlation_id` - the id of one request: the trace id of a valid
  ``traceparent`` header, otherwise a random 32-character hex string.
* :func:`internal_error_response` - the answer to an exception nobody handled.
* :class:`CorrelationIdMiddleware` - adds ``correlationId`` to every 5xx JSON
  document, whichever route or handler produced it.  4xx documents are never
  touched.
"""

from __future__ import annotations

import json
import logging
import re
import traceback
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ..models.problem import CORRELATION_ID_KEY, PROBLEM_MEDIA_TYPE, problem_response

logger = logging.getLogger(__name__)

#: Where the id of the request lives in ``scope["state"]`` (``request.state.correlation_id``).
STATE_KEY = "correlation_id"

#: W3C trace context: ``version-traceid-parentid-flags``; the all-zero ids and version ``ff`` are invalid.
_TRACEPARENT = re.compile(r"^(?!ff)[0-9a-f]{2}-(?!0{32})([0-9a-f]{32})-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$")

#: A 5xx document larger than this is passed through as it is.
_MAX_REWRITTEN_BODY = 64 * 1024


@dataclass(frozen=True)
class PublicProblem:
    """A failure as the client sees it: the status, a stable code and a fixed sentence."""

    status: int
    code: str
    detail: str


INTERNAL_ERROR = PublicProblem(500, "internal_error", "the service failed to process the request")


def new_correlation_id() -> str:
    return uuid.uuid4().hex


def correlation_id(scope: Scope) -> str:
    """The id of this request; the same value for every caller within it."""
    state = scope.setdefault("state", {})
    existing = state.get(STATE_KEY)
    if isinstance(existing, str) and existing:
        return existing
    value = None
    for name, raw in scope.get("headers", ()):
        if name.lower() == b"traceparent":
            match = _TRACEPARENT.match(raw.decode("latin-1"))
            if match:
                value = match.group(1)
            break
    value = value or new_correlation_id()
    state[STATE_KEY] = value
    return value


def public_problem_response(
    problem: PublicProblem,
    *,
    correlation_id: str | None = None,
    headers: Mapping[str, str] | None = None,
    media_type: str = PROBLEM_MEDIA_TYPE,
) -> JSONResponse:
    """The problem document of ``problem``; a 5xx should carry the ``correlation_id`` of its log line."""
    extra = {CORRELATION_ID_KEY: correlation_id} if correlation_id else None
    return problem_response(
        problem.status, problem.code, problem.detail, headers=headers, extra=extra, media_type=media_type
    )


def frames(error: BaseException) -> str:
    """``file:function:line`` of the frames of ``error``, innermost last; no source lines, no values."""
    return " > ".join(
        f"{Path(frame.filename).name}:{frame.name}:{frame.lineno}"
        for frame in traceback.extract_tb(error.__traceback__)
    )


def log_unhandled(scope: Scope, error: BaseException, correlation: str) -> None:
    """The class and the frames, never the message: it may quote the input or a secret."""
    logger.error(
        "unhandled %s while serving %s %r correlation_id=%s at %s",
        type(error).__name__,
        scope.get("method"),
        scope.get("path"),
        correlation,
        frames(error),
    )


def internal_error_response(scope: Scope, error: BaseException) -> JSONResponse:
    """What an exception nobody handled becomes: 500 ``internal_error``, fixed text, the correlation id."""
    correlation = correlation_id(scope)
    log_unhandled(scope, error, correlation)
    return public_problem_response(INTERNAL_ERROR, correlation_id=correlation)


def _is_json(message: Message) -> bool:
    for name, value in message.get("headers", ()):
        if name.lower() == b"content-type":
            media_type = value.decode("latin-1").split(";", 1)[0].strip().lower()
            return media_type == "application/json" or media_type.endswith("+json")
    return False


def _with_correlation_id(body: bytes, correlation: str) -> bytes:
    """``body`` with the ``correlationId`` member; unchanged unless it is a JSON object without one."""
    try:
        document = json.loads(body)
    except ValueError:
        return body
    if not isinstance(document, dict) or CORRELATION_ID_KEY in document:
        return body
    document[CORRELATION_ID_KEY] = correlation
    return json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class CorrelationIdMiddleware:
    """Adds ``correlationId`` to the JSON body of every 5xx response and logs the pair with the request."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        held: Message | None = None
        chunks: list[bytes] = []
        size = 0

        async def send_with_correlation(message: Message) -> None:
            nonlocal held, size
            if message["type"] == "http.response.start" and message["status"] >= 500:
                correlation = correlation_id(scope)
                logger.warning(
                    "%d response to %s %r correlation_id=%s",
                    message["status"],
                    scope.get("method"),
                    scope.get("path"),
                    correlation,
                )
                if _is_json(message):
                    held = message
                    return
            elif held is not None and message["type"] == "http.response.body":
                chunk = message.get("body", b"")
                chunks.append(chunk)
                size += len(chunk)
                if message.get("more_body", False) and size <= _MAX_REWRITTEN_BODY:
                    return
                start, held = held, None
                body = b"".join(chunks)
                if not message.get("more_body", False):
                    body = _with_correlation_id(body, correlation_id(scope))
                    message = {**message, "body": body}
                    start["headers"] = list(start.get("headers", ()))
                    MutableHeaders(scope=start)["content-length"] = str(len(body))
                    await send(start)
                    await send(message)
                    return
                # Too large to be one of our documents: send what was held, unchanged.
                await send(start)
                await send({**message, "body": body})
                return
            await send(message)

        await self.app(scope, receive, send_with_correlation)

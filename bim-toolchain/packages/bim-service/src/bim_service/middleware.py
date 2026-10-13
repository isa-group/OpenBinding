"""Pure ASGI middleware: request context, authentication and the body size limit.

They are plain ASGI callables (not ``BaseHTTPMiddleware``) because two of them must act *before* the body is
read: authentication refuses a request without looking at its body, and the size limit counts the bytes as
they arrive and answers 413 as soon as the limit is crossed.  From outermost to innermost:

1. :class:`ContextMiddleware`: ``traceparent``, ``X-BIM-Tenant``, one log line per request, a 500 problem for
   whatever escapes;
2. :class:`AuthMiddleware`: every path except ``/healthz`` and ``/readyz`` needs a valid bearer token;
3. :class:`BodyLimitMiddleware`: 413 before reading a body that is too large.

Nothing here logs a body, a header value other than the sanitized tenant, or a token.
"""

from __future__ import annotations

import logging
import re
import secrets
import time
import traceback
from pathlib import Path
from typing import Any, Awaitable, Callable, MutableMapping

from starlette.datastructures import MutableHeaders

from .auth import Authenticator
from .problems import ServiceProblem, problem_response, respond

logger = logging.getLogger("bim_service")

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

PUBLIC_PATHS = frozenset({"/healthz", "/readyz"})

_TRACEPARENT = re.compile(r"^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$")
_TENANT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$")


def header_value(scope: Scope, name: bytes) -> bytes | None:
    for key, value in scope.get("headers", ()):
        if key.lower() == name:
            return value
    return None


def route_path(scope: Scope) -> str:
    """The path below ``root_path`` (a proxy prefix), which is what the routes and the public list match."""
    path = scope.get("path", "")
    root = scope.get("root_path", "")
    return path[len(root):] if root and path.startswith(root) else path


def _frames(error: BaseException) -> str:
    """``module:function:line`` of the frames of ``error``, innermost last; no source lines, no values."""
    return " > ".join(
        f"{Path(frame.filename).name}:{frame.name}:{frame.lineno}" for frame in traceback.extract_tb(error.__traceback__)
    )


class ContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        raw_trace = header_value(scope, b"traceparent")
        trace = raw_trace.decode("latin-1") if raw_trace else ""
        if not _TRACEPARENT.match(trace):
            trace = f"00-{secrets.token_hex(16)}-{secrets.token_hex(8)}-00"
        raw_tenant = header_value(scope, b"x-bim-tenant")
        tenant_text = raw_tenant.decode("latin-1") if raw_tenant else ""
        tenant = tenant_text if _TENANT.match(tenant_text) else None
        state = scope.setdefault("state", {})
        state["tenant"] = tenant
        state["traceparent"] = trace

        started = time.perf_counter()
        status = 0
        response_started = False

        async def send_with_context(message: Message) -> None:
            nonlocal status, response_started
            if message["type"] == "http.response.start":
                status = message["status"]
                response_started = True
                message.setdefault("headers", [])
                MutableHeaders(scope=message)["traceparent"] = trace
            await send(message)

        try:
            await self.app(scope, receive, send_with_context)
        except Exception as exc:
            # The log gets the class and where it was raised (function and line of each frame), never the message
            # of the exception, which may quote the input.  The client gets the correlation id and nothing else.
            correlation_id = trace.split("-")[1]
            logger.error(
                "unhandled %s while serving %s %r correlation_id=%s at %s",
                type(exc).__name__,
                scope.get("method"),
                route_path(scope),
                correlation_id,
                _frames(exc),
            )
            if response_started:
                raise
            problem = ServiceProblem(
                500,
                "internal_error",
                "the service failed to process the request",
                extensions={"correlationId": correlation_id},
            )
            await respond(problem)(scope, receive, send_with_context)
        finally:
            logger.info(
                "request method=%s path=%r status=%d duration_ms=%.1f tenant=%s trace=%s",
                scope.get("method"),
                route_path(scope),
                status,
                (time.perf_counter() - started) * 1000,
                tenant or "-",
                trace.split("-")[1],
            )


class AuthMiddleware:
    def __init__(self, app: ASGIApp, authenticator: Authenticator) -> None:
        self.app = app
        self.authenticator = authenticator

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and route_path(scope) not in PUBLIC_PATHS:
            if not self.authenticator.authorize(header_value(scope, b"authorization")):
                problem = ServiceProblem(
                    401,
                    "unauthorized",
                    "a valid bearer token is required",
                    headers={"WWW-Authenticate": 'Bearer realm="bim-service"'},
                )
                await respond(problem)(scope, receive, send)
                return
        await self.app(scope, receive, send)


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_body_bytes: int) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    def _too_large(self) -> Any:
        return problem_response(
            413,
            {
                "type": "urn:bim-toolchain:problem:payload_too_large",
                "title": "Payload too large",
                "status": 413,
                "detail": f"the request body exceeds {self.max_body_bytes} bytes",
                "code": "payload_too_large",
                "diagnostics": [],
            },
            {"Connection": "close"},
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = header_value(scope, b"content-length")
        if declared is not None:
            try:
                length = int(declared)
            except ValueError:
                length = -1
            if length < 0:
                problem = ServiceProblem(400, "bad_request", "the Content-Length header is not valid")
                await respond(problem)(scope, receive, send)
                return
            if length > self.max_body_bytes:
                # The body is not read at all.
                await self._too_large()(scope, receive, send)
                return

        received = 0
        refused = False

        async def counting_receive() -> Message:
            nonlocal received, refused
            if refused:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body_bytes:
                    refused = True
                    await self._too_large()(scope, receive, send)
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            if not refused:
                await send(message)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except Exception:
            # Once the 413 is out, whatever the application does with the disconnect is of no interest.
            if not refused:
                raise

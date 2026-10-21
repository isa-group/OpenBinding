"""Pure ASGI middleware: request context, authentication and the body size limit.

They are plain ASGI callables (not ``BaseHTTPMiddleware``) because two of them must act *before* the body is
read: authentication refuses a request without looking at its body, and the size limit counts the bytes as
they arrive and answers 413 as soon as the limit is crossed.  From outermost to innermost:

1. :class:`ContextMiddleware`: ``traceparent``, the informative ``X-BIM-Tenant``, one log line per request, a 500
   problem for whatever escapes;
2. :class:`AuthMiddleware`: every path except ``/healthz`` and ``/readyz`` needs a valid bearer token; the tenant
   bound to that token is the caller's identity (``state["tenant"]``) and the only key of the per-tenant share;
3. :class:`BodyLimitMiddleware`: 413 before reading a body that is too large;
4. :class:`PendingBodyMiddleware`: counts the body in the ledger of in-flight bodies and refuses what does not fit
   (only when a pending-body cap or a memory budget is configured).

``X-BIM-Tenant`` is what the caller *claims*: it is kept (sanitized and bounded) as ``state["claimed_tenant"]`` for the
log and decides nothing.  Nothing here logs a body, a header value other than the sanitized claim, or a token.
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

from .auth import TENANT_PATTERN, Authenticator
from .problems import ServiceProblem, problem_response, respond
from .runtime import BodyLedger

logger = logging.getLogger("bim_service")

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

PUBLIC_PATHS = frozenset({"/healthz", "/readyz"})

_TRACEPARENT = re.compile(r"^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$")


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
        state = scope.setdefault("state", {})
        # What the caller says it is: informative only.  The identity (``state["tenant"]``) is set by AuthMiddleware
        # from the token and is never taken from the request.
        state["claimed_tenant"] = tenant_text if TENANT_PATTERN.fullmatch(tenant_text) else None
        state["tenant"] = None
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
            identity = state.get("tenant")
            claimed = state.get("claimed_tenant")
            logger.info(
                "request method=%s path=%r status=%d duration_ms=%.1f tenant=%s%s trace=%s",
                scope.get("method"),
                route_path(scope),
                status,
                (time.perf_counter() - started) * 1000,
                identity or "-",
                f" claimed_tenant={claimed}" if claimed and claimed != identity else "",
                trace.split("-")[1],
            )


class AuthMiddleware:
    def __init__(self, app: ASGIApp, authenticator: Authenticator) -> None:
        self.app = app
        self.authenticator = authenticator

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and route_path(scope) not in PUBLIC_PATHS:
            tenant = self.authenticator.identify(header_value(scope, b"authorization"))
            if tenant is None:
                problem = ServiceProblem(
                    401,
                    "unauthorized",
                    "a valid bearer token is required",
                    headers={"WWW-Authenticate": 'Bearer realm="bim-service"'},
                )
                await respond(problem)(scope, receive, send)
                return
            scope.setdefault("state", {})["tenant"] = tenant
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


class PendingBodyMiddleware:
    """Counts the bytes of a request body in the :class:`~bim_service.runtime.BodyLedger` before they are buffered.

    A declared ``Content-Length`` is reserved before a byte is read, so a body that does not fit is refused without
    reading it; without one (chunked) the bytes are counted as they arrive and the request is cut off when they do not
    fit.  The reservation travels in ``state["body_reservation"]``: the route hands it to the gate, which releases it
    when the operation's thread ends; a request that never gets that far releases it here, whatever way it ends.
    Innermost of the three, so the size limit has already refused what is over ``max_body_bytes``.
    """

    def __init__(self, app: ASGIApp, bodies: BodyLedger) -> None:
        self.app = app
        self.bodies = bodies

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self.bodies.enabled:
            await self.app(scope, receive, send)
            return
        reservation = self.bodies.reservation()
        scope.setdefault("state", {})["body_reservation"] = reservation
        refused = False
        received = 0

        async def refuse(problem: ServiceProblem) -> None:
            nonlocal refused
            refused = True
            await respond(problem)(scope, receive, send)

        async def guarded_send(message: Message) -> None:
            if not refused:
                await send(message)

        async def counting_receive() -> Message:
            nonlocal received
            if refused:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                try:
                    reservation.ensure(received)
                except ServiceProblem as problem:
                    await refuse(_unread(problem))
                    return {"type": "http.disconnect"}
            return message

        try:
            declared = header_value(scope, b"content-length")
            if declared is not None:
                try:
                    reservation.ensure(int(declared))
                except ServiceProblem as problem:
                    await refuse(_unread(problem))
                    return
                except ValueError:
                    pass  # not a number: the size limit answers 400 before this middleware is reached
            try:
                await self.app(scope, counting_receive, guarded_send)
            except Exception:
                # Once the refusal is out, whatever the application does with the disconnect is of no interest.
                if not refused:
                    raise
        finally:
            reservation.close()


def _unread(problem: ServiceProblem) -> ServiceProblem:
    """``problem`` as an answer given while the body is still on the wire: the connection is closed after it."""
    return ServiceProblem(
        problem.status,
        problem.code,
        problem.detail,
        diagnostics=problem.diagnostics,
        headers={**problem.headers, "Connection": "close"},
        extensions=problem.extensions,
    )

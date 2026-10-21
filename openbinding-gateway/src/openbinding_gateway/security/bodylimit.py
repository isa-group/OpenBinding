"""Refusing an oversized request body before it is read.

Handlers used to call ``await request.body()`` and check ``len(body)``
afterwards, so a client (or a chunked upload with no ``Content-Length`` at all)
made the gateway buffer the whole thing - up to nginx's 512 MiB - before any
limit applied. This middleware sits in front of every handler, is plain ASGI
(no ``BaseHTTPMiddleware``, which would buffer), and enforces two ceilings:

* ``MAX_REQUEST_BODY_BYTES`` for the upload routes (artifact blobs, portable
  packages, BIM source packages, resources, file inspection). Those keep
  their own, tighter, per-plan and per-format checks behind it; the ceiling is
  the one nginx already applied, so nothing a legitimate upload could send
  before is refused now.
* ``MAX_JSON_BODY_BYTES`` for every other route.

Each is enforced twice: a ``Content-Length`` above the limit is answered 413
without calling the application at all, and the bytes that actually arrive are
counted as they stream, so a chunked body (or a lying length) is cut off as
soon as it passes the limit instead of after it has been buffered.

The refusal is ``413`` ``application/problem+json`` (code ``payload_too_large``)
in every case. FastAPI turns an exception raised from ``receive`` into a 400
and some handlers catch broad exceptions, so the middleware does not rely on
the exception reaching it: once the limit was crossed, whatever the application
answers is replaced by the 413 if it had not started responding.
"""

from __future__ import annotations

import json
import re
from typing import Optional

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ..core.settings import get_settings
from ..models.problem import PROBLEM_MEDIA_TYPE, problem_body

#: ``(method, path regex)`` of the routes whose body is a file or package, not a
#: small document. Matched against the path without the ``root_path`` prefix.
UPLOAD_ROUTES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("POST", re.compile(r"^/v1/organizations/[^/]+/projects/[^/]+/blobs/?$")),
    ("POST", re.compile(r"^/v1/organizations/[^/]+/projects/[^/]+/package/?$")),
    ("POST", re.compile(r"^/v1/instances/?$")),
    ("POST", re.compile(r"^/v1/instances/validate/?$")),
    ("POST", re.compile(r"^/v1/validate/?$")),
    ("POST", re.compile(r"^/v1/jobs/?$")),
    ("POST", re.compile(r"^/v1/resources/?$")),
    ("POST", re.compile(r"^/v1/verifier/inspect-file/?$")),
)


class BodyTooLarge(Exception):
    """Raised from ``receive`` once the counted bytes pass the limit."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"request body exceeds {limit} bytes")
        self.limit = limit


def is_upload(method: str, path: str) -> bool:
    return any(
        method.upper() == upload_method and pattern.match(path)
        for upload_method, pattern in UPLOAD_ROUTES
    )


def _app_path(scope: Scope) -> str:
    path = scope.get("path", "")
    root = scope.get("root_path", "") or ""
    return path[len(root):] if root and path.startswith(root) else path


def _refusal(limit: int) -> tuple[list[tuple[bytes, bytes]], bytes]:
    body = json.dumps(
        problem_body(
            413,
            "payload_too_large",
            f"request body exceeds {limit} bytes",
            extra={"limitBytes": limit},
        ),
        separators=(",", ":"),
    ).encode("utf-8")
    headers = [
        (b"content-type", PROBLEM_MEDIA_TYPE.encode("ascii")),
        (b"content-length", str(len(body)).encode("ascii")),
        # The unread remainder of the body must not be mistaken for a request.
        (b"connection", b"close"),
    ]
    return headers, body


class BodyLimitMiddleware:
    """Pure ASGI request-body limiter; see the module docstring."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        max_request_bytes: Optional[int] = None,
        max_json_bytes: Optional[int] = None,
    ) -> None:
        self.app = app
        self._max_request_bytes = max_request_bytes
        self._max_json_bytes = max_json_bytes

    def limit_for(self, scope: Scope) -> int:
        settings = get_settings()
        request_limit = self._max_request_bytes or settings.max_request_body_bytes
        json_limit = self._max_json_bytes or settings.max_json_body_bytes
        if is_upload(scope.get("method", "GET"), _app_path(scope)):
            return request_limit
        return min(json_limit, request_limit)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.limit_for(scope)
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None and declared.strip().isdigit() and int(declared) > limit:
            await self._refuse(send, limit)
            return

        received = 0
        exceeded = False
        started = False
        replaced = False

        async def counting_receive() -> Message:
            nonlocal received, exceeded
            if exceeded:
                raise BodyTooLarge(limit)
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise BodyTooLarge(limit)
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal started, replaced
            if replaced:
                return
            if message["type"] == "http.response.start":
                if exceeded and not started:
                    # Whatever the application made of the failure (usually a
                    # 400 from the framework's body parsing), the answer is 413.
                    replaced = True
                    await self._refuse(send, limit)
                    return
                started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except BodyTooLarge:
            if not started and not replaced:
                await self._refuse(send, limit)
                return
            raise
        except Exception:
            # A handler that swallowed the failure and then crashed on the
            # truncated body: still the client's oversized request, not a 500.
            if exceeded and not started and not replaced:
                await self._refuse(send, limit)
                return
            raise

    @staticmethod
    async def _refuse(send: Send, limit: int) -> None:
        headers, body = _refusal(limit)
        await send({"type": "http.response.start", "status": 413, "headers": headers})
        await send({"type": "http.response.body", "body": body})


__all__ = ["BodyLimitMiddleware", "BodyTooLarge", "UPLOAD_ROUTES", "is_upload"]

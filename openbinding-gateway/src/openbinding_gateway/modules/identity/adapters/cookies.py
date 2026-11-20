"""``Cache-Control: no-store`` on every sign-in answer; the cookies themselves live in ``application.cookies``.

Re-exported here for the routes of this package.
"""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ..application.cookies import (  # noqa: F401 - re-exported for the adapters
    FLOW,
    PENDING,
    SESSION,
    clear_cookie,
    flow_name,
    name,
    refuse_foreign_origin,
    require_same_origin,
    set_cookie,
)


class NoStoreAuthMiddleware:
    """``Cache-Control: no-store`` on every answer under ``/v1/auth/``: nothing a sign-in returns is cached."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        root = scope.get("root_path", "")
        if root and path.startswith(root):
            path = path[len(root):]
        if not path.startswith("/v1/auth/"):
            await self.app(scope, receive, send)
            return

        async def send_no_store(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"]
                headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_no_store)

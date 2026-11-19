"""The sign-in cookies, the ``Origin`` check of the routes that read them, and ``Cache-Control: no-store``.

Cookies are ``__Host-`` prefixed and ``Secure`` when ``FRONTEND_URL`` is https, so no sibling of a shared
parent domain can plant one (``__Host-`` forbids ``Domain`` and requires ``Path=/``); on a loopback http
origin (labs) they drop the prefix and ``Secure``. Every one is ``HttpOnly`` and ``SameSite=Lax``. Data
routes never read cookies: only the sign-in routes do, and those that change state refuse a request whose
``Origin`` is not trusted.
"""

from __future__ import annotations

from fastapi import Request, Response, status
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ....core.settings import Settings
from ....models.errors import api_error

SESSION = "ob_session"
PENDING = "ob_pending"
FLOW = "ob_flow_"


def name(settings: Settings, base: str) -> str:
    return f"__Host-{base}" if settings.identity_secure_cookies else base


def flow_name(settings: Settings, state: str) -> str:
    return name(settings, FLOW + state)


def set_cookie(response: Response, settings: Settings, cookie: str, value: str, max_age: int) -> None:
    response.set_cookie(
        cookie,
        value,
        max_age=max(0, int(max_age)),
        path="/",
        secure=settings.identity_secure_cookies,
        httponly=True,
        samesite="lax",
    )


def clear_cookie(response: Response, settings: Settings, cookie: str) -> None:
    response.delete_cookie(
        cookie, path="/", secure=settings.identity_secure_cookies, httponly=True, samesite="lax"
    )


def require_same_origin(request: Request, settings: Settings) -> None:
    """403 ``origin_refused`` unless ``Origin`` is ``FRONTEND_URL``'s origin or one of ``AUTH_TRUSTED_ORIGINS``.

    An absent ``Origin`` or ``null`` is refused too: every browser sends it on these POSTs.
    """
    origin = (request.headers.get("origin") or "").strip().lower()
    if not origin or origin == "null" or origin not in settings.trusted_browser_origins:
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "origin_refused",
            "This request must come from the OpenBinding frontend.",
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

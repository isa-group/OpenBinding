"""The sign-in cookies and the ``Origin`` checks of the routes that read or set them.

Cookies are ``__Host-`` prefixed and ``Secure`` when ``FRONTEND_URL`` is https, so no sibling of a shared
parent domain can plant one (``__Host-`` forbids ``Domain`` and requires ``Path=/``); on a loopback http
origin (labs) they drop the prefix and ``Secure``. Every one is ``HttpOnly`` and ``SameSite=Lax``. Data
routes never read cookies: only the sign-in routes do, and those that change state refuse a request whose
``Origin`` is not trusted. Local sign-in (``routes/auth.py``) sets the same session cookie, so these
live in ``application`` where legacy routes may import them.

Adapted from SPHERE's ``ScoretechIdentityController`` cookies (SCORELabUS/SPHERE@73779a8a, MIT), whose cookies sit
at ``Path=/api/v1/auth/identity`` without the prefix.
"""

from __future__ import annotations

from fastapi import Request, Response, status

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


def presented_session(request: Request, settings: Settings) -> str | None:
    """The session cookie the browser presented, if any."""
    return request.cookies.get(name(settings, SESSION))


def set_session_cookie(response: Response, settings: Settings, value: str, max_age: int) -> None:
    set_cookie(response, settings, name(settings, SESSION), value, max_age)


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


def refuse_foreign_origin(request: Request, settings: Settings) -> None:
    """403 ``origin_refused`` for a present ``Origin`` outside the trusted set; an absent one passes.

    Local sign-in and registration: a browser always sends ``Origin`` on these POSTs, so a foreign one is a
    cross-site form (login CSRF); scripts, the smoke and the tests send none.
    """
    origin = (request.headers.get("origin") or "").strip().lower()
    if origin and (origin == "null" or origin not in settings.trusted_browser_origins):
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "origin_refused",
            "This request must come from the OpenBinding frontend.",
        )

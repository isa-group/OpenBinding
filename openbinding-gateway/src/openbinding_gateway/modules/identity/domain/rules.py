"""Pure rules of sign-in."""

from __future__ import annotations

import re

#: The longest ``returnTo`` kept; anything longer becomes ``/``.
RETURN_TO_MAX = 512

_CONTROL = re.compile(r"[\x00-\x1f\x7f\\]")


def safe_return_to(value: object) -> str:
    """``value`` when it is a path of the frontend to return to, else ``/`` (never an open redirect).

    One leading ``/`` and not ``//``; no backslash, control character (CR, LF included) or scheme; not under
    ``/api`` (the gateway) or ``/sso/`` (the sign-in screens themselves); at most ``RETURN_TO_MAX``
    characters. Port of SPHERE's ``safeReturnTo``, stricter.
    """
    if not isinstance(value, str) or not value or len(value) > RETURN_TO_MAX:
        return "/"
    if not value.startswith("/") or value.startswith("//") or _CONTROL.search(value):
        return "/"
    path = value.split("?", 1)[0].split("#", 1)[0]
    first = path.split("/", 2)[1].lower()
    if first in ("api", "sso") or ":" in first:
        return "/"
    return value

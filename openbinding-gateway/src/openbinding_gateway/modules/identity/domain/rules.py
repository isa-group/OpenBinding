"""Pure rules of sign-in."""

from __future__ import annotations

import re
from datetime import datetime, timedelta

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


#: The domain of the placeholder address of an account whose email Identity has not verified.
PLACEHOLDER_DOMAIN = "identity.openbinding.invalid"


def research_eligible(email: object, verified: object, domains: list[str] | tuple[str, ...]) -> bool:
    """Whether a verified institutional email entitles an account to RESEARCH.

    ``verified`` must be the boolean ``True``; the domain is the part after the last ``@``, lower-cased, and
    must equal an allowed domain exactly (``x.us.es`` and ``us.es.evil.com`` do not qualify); a placeholder never
    does.
    """
    if verified is not True or not isinstance(email, str) or "@" not in email:
        return False
    domain = email.rsplit("@", 1)[1].strip().lower()
    return domain != PLACEHOLDER_DOMAIN and domain in {item.lower() for item in domains}


def key_owner_admitted(last_refresh: datetime | None, now: datetime, days: int) -> bool:
    """Whether a person's API keys work: they refreshed with Identity within ``days`` (never: they do not)."""
    return last_refresh is not None and now - last_refresh <= timedelta(days=days)

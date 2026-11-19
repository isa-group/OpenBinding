"""What OpenBinding keeps of an Identity token: who, the verified email, a display name and an avatar.

Identity's ``tentu-authentication-policy`` mapper clears every profile claim from access tokens, so the profile
is read only from a verified ID token (``profile_from_id_token``); a refresh answer without one carries the
subject and the permissions only, and the stored profile is left as it is. Nothing else of a token is kept:
no names, phone, bio, social links or birthdate.

The avatar takes exactly the shapes of Identity's ``scoretech_avatar`` claim
(``ApplicationUserClaims.java``, SCORELabUS/SCORETech-identity@215dffe): a ``preset`` without colours, and
``initials`` or ``icon`` with two colours, each one of Identity's twelve names (normalised to hex with
Identity's own table, ``packages/ui/src/avatar.tsx``) or ``#rrggbb``. Anything else is no avatar.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

DISPLAY_NAME_MAX = 160

PRESETS = frozenset({"owl", "fox", "octopus", "robot"})
ICONS = frozenset(
    {"spark", "rocket", "heart", "leaf", "star"}
    | {f"avatar-{n}" for n in (1, 2, 3, 4, 6, 7, 8, 9, 10)}
)
#: Identity's named colours (``packages/ui/src/avatar.tsx``).
COLOURS = {
    "graphite": "#212529",
    "tentu": "#be1d37",
    "stone": "#68737d",
    "lime": "#ffd900",
    "paper": "#ffffff",
    "charcoal": "#343a40",
    "cyan": "#00a6bf",
    "pink": "#e472a8",
    "purple": "#7654b2",
    "orange": "#fa520f",
    "black": "#000000",
    "white": "#ffffff",
}
_HEX = re.compile(r"#[0-9a-fA-F]{6}")


@dataclass(frozen=True)
class IdentityClaims:
    issuer: str
    subject: str
    email: str | None = None
    email_verified: bool = False
    display_name: str | None = None
    avatar: dict | None = None
    permissions: frozenset[str] = field(default_factory=frozenset)
    profile_from_id_token: bool = False


def _colour(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if _HEX.fullmatch(value):
        return value.lower()
    return COLOURS.get(value)


def parse_avatar(value: Any) -> dict | None:
    """Identity's avatar descriptor in OpenBinding's stored shape (hex colours), or ``None``."""
    if not isinstance(value, dict):
        return None
    kind = value.get("kind")
    asset = value.get("assetId")
    if kind == "preset" and isinstance(asset, str) and asset in PRESETS:
        return {"kind": "preset", "assetId": asset}
    background, foreground = _colour(value.get("backgroundColor")), _colour(value.get("foregroundColor"))
    if background is None or foreground is None:
        return None
    if kind == "initials":
        return {"kind": "initials", "backgroundColor": background, "foregroundColor": foreground}
    if kind == "icon" and isinstance(asset, str) and asset in ICONS:
        return {"kind": "icon", "assetId": asset, "backgroundColor": background, "foregroundColor": foreground}
    return None


def display_name_of(claims: dict) -> str | None:
    """``scoretech_display_name``, else ``name``, capped; an empty string (shared but unset) is ``None``."""
    for key in ("scoretech_display_name", "name"):
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:DISPLAY_NAME_MAX]
    return None


def email_of(claims: dict) -> tuple[str | None, bool]:
    """The email lower-cased and whether it is verified: ``email_verified`` must be the boolean ``True``."""
    email = claims.get("email")
    if not isinstance(email, str) or "@" not in email or len(email) > 320:
        return None, False
    return email.strip().lower(), claims.get("email_verified") is True


def permissions_of(claims: dict) -> frozenset[str]:
    roles = (claims.get("realm_access") or {}).get("roles") if isinstance(claims.get("realm_access"), dict) else None
    return frozenset(role for role in roles if isinstance(role, str)) if isinstance(roles, list) else frozenset()


@dataclass(frozen=True)
class TokenSet:
    """An answer of Identity's token endpoint. The tokens are never logged or shown (``repr=False``)."""

    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    expires_in: int
    id_token: str | None = field(default=None, repr=False)
    refresh_expires_in: int | None = None

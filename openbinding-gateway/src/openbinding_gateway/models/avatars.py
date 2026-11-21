"""A person's avatar: exactly the descriptor SCORETech Identity shares, colours as hex.

Identity's ``scoretech_avatar`` claim (``ApplicationUserClaims.java``, SCORELabUS/SCORETech-identity@215dffe) has three
shapes: a ``preset`` without colours, and ``initials`` or ``icon`` with a background and a foreground colour. The gateway
stores what a verified ID token carries (``modules.identity.domain.claims.parse_avatar``, which turns Identity's named
colours into hex) or what a person picks in local mode, and serves it unchanged, with Identity's own camelCase keys so the
frontend draws it with Identity's renderer. Identity never shares photos, so there is no photo kind.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

AvatarPresetId = Literal["owl", "fox", "octopus", "robot"]
AvatarIconId = Literal[
    "spark", "rocket", "heart", "leaf", "star",
    "avatar-1", "avatar-2", "avatar-3", "avatar-4", "avatar-6", "avatar-7", "avatar-8", "avatar-9", "avatar-10",
]
#: ``#rrggbb``: Identity's descriptor carries six-digit colours (its named colours are stored as hex).
AVATAR_COLOR = r"^#[0-9a-fA-F]{6}$"


class _Descriptor(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)


class PresetAvatar(_Descriptor):
    """One of Identity's preset animals, drawn in Identity's default colours."""

    kind: Literal["preset"]
    asset_id: AvatarPresetId = Field(alias="assetId")


class InitialsAvatar(_Descriptor):
    """The initials of the display name (or the username), in two colours."""

    kind: Literal["initials"]
    background_color: str = Field(alias="backgroundColor", pattern=AVATAR_COLOR)
    foreground_color: str = Field(alias="foregroundColor", pattern=AVATAR_COLOR)


class IconAvatar(_Descriptor):
    """One of Identity's icons or SPHERE's predefined avatars, in two colours."""

    kind: Literal["icon"]
    asset_id: AvatarIconId = Field(alias="assetId")
    background_color: str = Field(alias="backgroundColor", pattern=AVATAR_COLOR)
    foreground_color: str = Field(alias="foregroundColor", pattern=AVATAR_COLOR)


AvatarDescriptor = Annotated[Union[PresetAvatar, InitialsAvatar, IconAvatar], Field(discriminator="kind")]

_ADAPTER: TypeAdapter[Any] = TypeAdapter(AvatarDescriptor)


def avatar_of(value: Any) -> Optional[Union[PresetAvatar, InitialsAvatar, IconAvatar]]:
    """The stored descriptor as the wire shape, or ``None`` when there is none or it is not one of the three shapes."""
    if not isinstance(value, dict):
        return None
    try:
        return _ADAPTER.validate_python(value)
    except ValidationError:
        return None


def stored_avatar(value: Union[PresetAvatar, InitialsAvatar, IconAvatar, None]) -> Optional[dict]:
    """What ``users.avatar`` keeps of a descriptor: Identity's keys, colours lower-cased."""
    if value is None:
        return None
    stored = value.model_dump(by_alias=True)
    for key in ("backgroundColor", "foregroundColor"):
        if key in stored:
            stored[key] = stored[key].lower()
    return stored


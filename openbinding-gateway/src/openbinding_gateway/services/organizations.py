"""An organization's profile: its slug, description, avatar and counts, as SPHERE's organizations have.

Ported from SPHERE (SCORELabUS/SPHERE, MIT licence, revision 73779a8a), ``api/src/main/utils/slug-manager.ts``
(``generateSlug``, ``deduplicateSlug``), ``api/src/main/config/defaultAvatars.ts`` (the predefined avatars and
the colour check) and ``OrganizationService.updateAvatar``/``removeAvatar``. Kept from OpenBinding: slugs never
change once given, the reserved slugs are never derived, and an upload is a blob of the organization (content
addressed, never deleted on the request path) rather than a file in a static folder.
"""

from __future__ import annotations

import re
import secrets
import unicodedata
import uuid
from pathlib import Path
from typing import Awaitable, Callable, Iterable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    BindingCase,
    Blob,
    Composition,
    Job,
    Organization,
    OrganizationMembership,
    Study,
)
from ..models.platform import (
    RESERVED_ORGANIZATION_SLUGS,
    OrganizationAvatar,
    OrganizationStats,
)

#: The predefined avatars, as SPHERE's ``DEFAULT_AVATAR_FILES``: plain SVGs drawn with ``currentColor``, so one
#: file serves every colour the picker offers. Also the allow-list of what an organization may point its image
#: at without an upload.
DEFAULT_AVATAR_FILES: tuple[str, ...] = (
    "avatar-1.svg", "avatar-2.svg", "avatar-3.svg", "avatar-4.svg", "avatar-6.svg",
    "avatar-7.svg", "avatar-8.svg", "avatar-9.svg", "avatar-10.svg",
)
DEFAULT_AVATAR_DIRECTORY = Path(__file__).resolve().parent.parent / "static" / "avatars"
#: The colours a predefined avatar is drawn with when the caller names none (SPHERE's defaults).
DEFAULT_AVATAR_BG_COLOR = "#023e8a"
DEFAULT_AVATAR_FG_COLOR = "#ffffff"

#: The image types an upload may be, each recognised by its first bytes: the stored media type comes from the
#: bytes, never from what the caller said, so an upload is never served as anything but an image.
AVATAR_MEDIA_TYPES = ("image/png", "image/jpeg", "image/webp")
MAX_AVATAR_BYTES = 2 * 1024 * 1024
#: How long an uploaded avatar's digest is: ``sha256-`` and 64 hex characters.
_DIGEST = re.compile(r"^sha256-[0-9a-f]{64}$")

#: The shortest slug a name may produce (SPHERE refuses a name that yields fewer than three characters).
MIN_DERIVED_SLUG = 3
_SLUG_LENGTH = 64


def generate_slug(text: str) -> str:
    """A slug from a name, as SPHERE's ``generateSlug``: lower case, spaces to ``-``, everything but letters,
    digits and ``-`` dropped, runs of ``-`` collapsed. Accents fold to their letter first, underscores count
    as spaces, and the ends are trimmed, so the result fits OpenBinding's slug pattern."""
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    slug = folded.lower().strip().replace("_", " ")
    slug = re.sub(r"\s+", "-", slug)
    slug = re.sub(r"[^a-z0-9-]+", "", slug)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug[:_SLUG_LENGTH].rstrip("-")


async def deduplicate_slug(base: str, taken: Callable[[str], Awaitable[bool]]) -> str:
    """``base``, or ``base-<digits>`` until ``taken`` says no, as SPHERE's ``deduplicateSlug``."""
    slug = base
    while await taken(slug):
        suffix = str(int.from_bytes(secrets.token_bytes(4), "big"))[:10]
        slug = f"{base[:_SLUG_LENGTH - len(suffix) - 1].rstrip('-')}-{suffix}"
    return slug


async def derived_slug(session: AsyncSession, name: str) -> str | None:
    """A free slug for an organization called ``name``, never a reserved one; ``None`` when the name yields
    fewer than ``MIN_DERIVED_SLUG`` characters."""
    base = generate_slug(name)
    if len(base) < MIN_DERIVED_SLUG:
        return None

    async def taken(slug: str) -> bool:
        return slug in RESERVED_ORGANIZATION_SLUGS or await session.scalar(
            select(Organization.id).where(Organization.slug == slug).limit(1)
        ) is not None

    return await deduplicate_slug(base, taken)


# -- Avatars ---------------------------------------------------------------------------------------------


def is_selectable_avatar(value: str | None) -> bool:
    """Null (the initials) or one of the predefined avatars, as SPHERE's ``isSelectableAvatarPath``."""
    return value is None or value in DEFAULT_AVATAR_FILES


def is_uploaded(value: str | None) -> bool:
    return value is not None and bool(_DIGEST.match(value))


def sniff_image(data: bytes) -> str | None:
    """The media type of an image upload from its first bytes, or ``None`` for anything else."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def avatar_view(organization: Organization) -> OrganizationAvatar:
    """The avatar of ``organization`` as a view shows it: a gateway URL for the image, and its colours."""
    value = organization.avatar
    colours = {"bg_color": organization.avatar_bg_color, "fg_color": organization.avatar_fg_color}
    if value in DEFAULT_AVATAR_FILES:
        return OrganizationAvatar(url=f"/v1/avatars/{value}", kind="predefined", **colours)
    if is_uploaded(value):
        return OrganizationAvatar(
            url=f"/v1/organizations/{organization.id}/avatar/{value.removeprefix('sha256-')}",
            kind="upload", **colours,
        )
    return OrganizationAvatar(**colours)


async def uploaded_avatar(session: AsyncSession, organization: Organization, digest_hex: str) -> Blob | None:
    """The blob of the organization's current uploaded avatar, when ``digest_hex`` names it."""
    value = organization.avatar
    if not is_uploaded(value) or value != f"sha256-{digest_hex}":
        return None
    return await session.scalar(
        select(Blob).where(Blob.organization_id == organization.id, Blob.digest == value).limit(1)
    )


# -- Counts ----------------------------------------------------------------------------------------------


async def _counts(session: AsyncSession, column, ids: list[uuid.UUID], *conditions) -> dict[uuid.UUID, int]:
    rows = await session.execute(
        select(column, func.count()).where(column.in_(ids), *conditions).group_by(column)
    )
    return {key: int(count) for key, count in rows.all()}


async def stats(session: AsyncSession, organization_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, OrganizationStats]:
    """What each organization holds, in six grouped queries whatever their number: direct members, direct
    sub-organizations, and its own compositions, problems, runs and studies."""
    ids = list(dict.fromkeys(organization_ids))
    if not ids:
        return {}
    members = await _counts(session, OrganizationMembership.organization_id, ids)
    children = await _counts(session, Organization.parent_id, ids)
    compositions = await _counts(session, Composition.organization_id, ids)
    problems = await _counts(session, BindingCase.organization_id, ids)
    runs = await _counts(session, Job.organization_id, ids)
    studies = await _counts(session, Study.organization_id, ids)
    return {
        oid: OrganizationStats(
            members=members.get(oid, 0), sub_organizations=children.get(oid, 0),
            compositions=compositions.get(oid, 0), problems=problems.get(oid, 0),
            runs=runs.get(oid, 0), studies=studies.get(oid, 0),
        )
        for oid in ids
    }

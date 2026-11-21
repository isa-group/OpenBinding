"""An organization's profile: its slug, description, avatar and counts, as SPHERE's organizations have.

Ported from SPHERE (SCORELabUS/SPHERE, MIT licence, revision 73779a8a), ``api/src/main/utils/slug-manager.ts``
(``generateSlug``, ``deduplicateSlug``), ``api/src/main/config/defaultAvatars.ts`` (the predefined avatars and
the colour check) and ``OrganizationService.updateAvatar``/``removeAvatar``, and the personal organizations of
``OrganizationService.ensurePersonalOrganizationForUser`` (SCORELabUS/SPHERE at ``fc776b4d``). Kept from OpenBinding: slugs never
change once given, the reserved slugs are never derived, and an upload is a blob of the organization (content
addressed, never deleted on the request path) rather than a file in a static folder.
"""

from __future__ import annotations

import re
import secrets
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Iterable

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..collaboration import ROLE_STRENGTH, ancestor_ids
from ..core.like import LIKE_ESCAPE, like_contains
from ..db.models import (
    AuditEvent,
    BindingCase,
    Blob,
    Composition,
    CompositionVersion,
    Job,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    Study,
    User,
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


# -- Personal organizations -----------------------------------------------------------------------------

#: What follows the username in a personal organization's name, as SPHERE's ``displayName``.
PERSONAL_NAME_SUFFIX = " PERSONAL"


class PersonalSlugTaken(Exception):
    """The slug a personal organization needs names another organization already."""


def personal_slug(username: str) -> str:
    """The slug of ``username``'s personal organization: the username lower-cased, as SPHERE names it.

    A username may hold ``.`` and ``_``, which a slug may not (composition references name organizations by
    slug), so each becomes ``-``, and a trailing one is dropped; a username always starts with a letter or
    digit."""
    return re.sub(r"[._]", "-", username.lower()).rstrip("-")


async def personal_slug_free(session: AsyncSession, username: str) -> bool:
    """Whether ``username`` may be given to a new account: its personal organization's slug is not reserved
    and names no organization. Organizations and usernames share one namespace."""
    slug = personal_slug(username)
    return slug not in RESERVED_ORGANIZATION_SLUGS and await session.scalar(
        select(Organization.id).where(Organization.slug == slug).limit(1)
    ) is None


async def ensure_personal_organization(session: AsyncSession, user: User) -> Organization:
    """``user``'s personal organization, created in the caller's transaction when it has none.

    Ported from SPHERE's ``ensurePersonalOrganizationForUser``: named ``<username> PERSONAL``, its slug the
    username (``personal_slug``), no description or avatar, and the user its OWNER. Raises
    ``PersonalSlugTaken`` when the slug names another organization, so that the caller refuses the account.
    """
    existing = await session.scalar(select(Organization).where(Organization.personal_owner_id == user.id))
    if existing is not None:
        return existing
    if not await personal_slug_free(session, user.username):
        raise PersonalSlugTaken(personal_slug(user.username))
    organization = Organization(
        slug=personal_slug(user.username),
        name=f"{user.username}{PERSONAL_NAME_SUFFIX}",
        description="",
        created_by_id=user.id,
        personal_owner_id=user.id,
    )
    session.add(organization)
    try:
        await session.flush()
    except IntegrityError as exc:
        # An organization took the slug meanwhile (the unique slug); the caller's transaction is lost with it.
        raise PersonalSlugTaken(organization.slug) from exc
    session.add(OrganizationMembership(organization_id=organization.id, user_id=user.id, role=OrganizationRole.OWNER))
    session.add(AuditEvent(
        organization_id=organization.id, actor_id=user.id, action="organization.created",
        target_type="Organization", target_id=organization.id, detail={"personal": True},
    ))
    await session.flush()
    return organization


class PersonalOrganizationHook:
    """The identity module's ``AccountHook``: a first SCORETech sign-in gets its personal organization."""

    async def name_free(self, db: AsyncSession, username: str) -> bool:
        return await personal_slug_free(db, username)

    async def created(self, db: AsyncSession, user: User) -> bool:
        try:
            await ensure_personal_organization(db, user)
        except PersonalSlugTaken:
            return False
        return True


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


# -- Public profiles, branches and the caller's tree ------------------------------------------------------


def _public_compositions(organization_id_column):
    """The public compositions an organization shows anybody: public, not archived, with a version, as the
    public composition list (``GET /v1/compositions``) has them."""
    return select(func.count(Composition.id)).where(
        Composition.organization_id == organization_id_column,
        Composition.visibility == "public",
        Composition.archived.is_(False),
        select(CompositionVersion.id).where(CompositionVersion.composition_id == Composition.id).exists(),
    ).scalar_subquery()


async def public_composition_count(session: AsyncSession, organization_id: uuid.UUID) -> int:
    """How many public compositions ``organization_id`` shows; one or more gives it a public profile (Q8)."""
    return int(await session.scalar(select(_public_compositions(organization_id))) or 0)


async def public_roots(
    session: AsyncSession, *, q: str | None, limit: int, offset: int,
) -> tuple[list[tuple[Organization, int]], int]:
    """The root organizations with at least one public composition, by name, each with that count, as SPHERE's
    ``findPublicRoots``: a text matches the slug, the name or the description."""
    count = _public_compositions(Organization.id).label("public_compositions")
    query = select(Organization, count).where(Organization.parent_id.is_(None), count > 0)
    if q:
        pattern = like_contains(q)
        query = query.where(or_(
            Organization.slug.ilike(pattern, escape=LIKE_ESCAPE),
            Organization.name.ilike(pattern, escape=LIKE_ESCAPE),
            Organization.description.ilike(pattern, escape=LIKE_ESCAPE),
        ))
    total = int(await session.scalar(select(func.count()).select_from(query.subquery())) or 0)
    rows = await session.execute(
        query.order_by(Organization.name, Organization.created_at.desc(), Organization.id).offset(offset).limit(limit)
    )
    return [(organization, int(found)) for organization, found in rows.all()], total


@dataclass(frozen=True)
class Placed:
    """An organization of a tree with the caller's effective role there and the organization that grants it."""

    organization: Organization
    role: OrganizationRole | None
    source: Organization | None


def place(
    organizations: dict[uuid.UUID, Organization], direct: dict[uuid.UUID, OrganizationRole],
) -> dict[uuid.UUID, Placed]:
    """Each organization's effective role: the strongest direct role on it or on an ancestor within
    ``organizations`` (the nearest one on a tie), and where that role comes from."""
    placed: dict[uuid.UUID, Placed] = {}
    for oid, organization in organizations.items():
        best: tuple[OrganizationRole, Organization] | None = None
        current: Organization | None = organization
        seen: set[uuid.UUID] = set()
        while current is not None and current.id not in seen:
            seen.add(current.id)
            role = direct.get(current.id)
            if role is not None and (best is None or ROLE_STRENGTH[role] > ROLE_STRENGTH[best[0]]):
                best = (role, current)
            current = organizations.get(current.parent_id) if current.parent_id else None
        placed[oid] = Placed(organization, best[0] if best else None, best[1] if best else None)
    return placed


async def _direct_roles(
    session: AsyncSession, user_id: uuid.UUID, organization_ids: Iterable[uuid.UUID] | None = None,
) -> dict[uuid.UUID, OrganizationRole]:
    query = select(OrganizationMembership.organization_id, OrganizationMembership.role).where(
        OrganizationMembership.user_id == user_id
    )
    if organization_ids is not None:
        query = query.where(OrganizationMembership.organization_id.in_(list(organization_ids)))
    return {oid: role for oid, role in (await session.execute(query)).all()}


async def _subtree(session: AsyncSession, root_ids: list[uuid.UUID]) -> dict[uuid.UUID, Organization]:
    """The organizations ``root_ids`` and every organization below them, in one recursive query."""
    if not root_ids:
        return {}
    below = (
        select(Organization.id.label("id")).where(Organization.id.in_(root_ids))
        .cte(name="organization_subtree", recursive=True)
    )
    below = below.union_all(select(Organization.id).join(below, Organization.parent_id == below.c.id))
    rows = await session.scalars(select(Organization).where(Organization.id.in_(select(below.c.id))))
    return {organization.id: organization for organization in rows.all()}


async def caller_tree(session: AsyncSession, user_id: uuid.UUID) -> dict[uuid.UUID, Placed]:
    """Every organization the caller holds a role in, directly or below one, with that role and its source."""
    direct = await _direct_roles(session, user_id)
    return place(await _subtree(session, list(direct)), direct)


async def branch(session: AsyncSession, organization: Organization, user_id: uuid.UUID) -> dict[uuid.UUID, Placed]:
    """The whole branch ``organization`` sits in (its root and everything below it), each node with the caller's
    effective role there, as SPHERE's ``getHierarchy``: two queries for the tree and one for the roles."""
    chain = await ancestor_ids(session, organization.id)
    root_id = await session.scalar(
        select(Organization.id).where(Organization.id.in_(chain), Organization.parent_id.is_(None))
    )
    nodes = await _subtree(session, [root_id])
    return place(nodes, await _direct_roles(session, user_id, nodes))

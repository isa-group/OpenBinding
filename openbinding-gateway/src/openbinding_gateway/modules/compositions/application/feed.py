"""An environment's feed: the adopted version's Composition2Yaml bytes, which change only on adopt.

What an application polls (``GET …/environments/{environment}/composition``). Its body is the adopted version's
sealed content, byte for byte, and its ``ETag`` that version's content digest (the version content route's tag),
so nothing but an adoption moves either: seals, edits, re-evaluations, newer offering or upstream versions, key
changes, checks and margin reads never do. A→B→A gives A's tag again.

``access.dependencies.get_feed_reader`` has answered 401, 403 and 429 before anything is looked up. Then, in order:
a feed key whose environment is not the path's is 404 "Environment not found." (the key's row decides, never the
path); a member gets the composition's 404 parity; nothing adopted yet is 404 ``nothing_adopted``; an
``If-None-Match`` naming the current tag (or ``*``) is 304; otherwise 200. A weak tag never matches.
"""

from __future__ import annotations

from fastapi import Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import FeedReader
from ....db.models import Composition, CompositionEnvironment, CompositionVersion, Organization
from ....models.errors import api_error
from .environments import environment_unreadable, readable_environment

#: The feed moves on adopt, so it is revalidated on every read; it differs by credential.
CACHE_CONTROL = "private, no-cache"
VARY = "Authorization, X-API-Key"
MEDIA_TYPE = "application/yaml; charset=utf-8"


def _names(value: str, row) -> bool:
    return value == row.slug or value == str(row.id)


async def _environment_of(
    session: AsyncSession, reader: FeedReader, org: str, composition: str, environment: str,
) -> CompositionEnvironment:
    if reader.kind == "member":
        _, _, row, _ = await readable_environment(session, org, composition, environment, reader.user)
        return row
    row: CompositionEnvironment = reader.environment
    owner = await session.get(Organization, row.organization_id)
    held = await session.get(Composition, row.composition_id)
    if owner is None or held is None or not (
        _names(org, owner) and _names(composition, held) and _names(environment, row)
    ):
        raise environment_unreadable()
    return row


def matches(if_none_match: str | None, tag: str) -> bool:
    """Whether ``If-None-Match`` names ``tag`` (strong comparison) or is ``*``."""
    if not if_none_match:
        return False
    items = [item.strip() for item in if_none_match.split(",")]
    return "*" in items or tag in items


async def feed_response(
    session: AsyncSession,
    reader: FeedReader,
    *,
    org: str,
    composition: str,
    environment: str,
    if_none_match: str | None,
) -> Response:
    """The feed's answer (rows 4 to 9 of the contract): 404s, 304 or the adopted bytes."""
    row = await _environment_of(session, reader, org, composition, environment)
    if row.adopted_version_id is None:
        raise api_error(
            status.HTTP_404_NOT_FOUND, "nothing_adopted", "Nothing is adopted in this environment yet.",
        )
    version = await session.get(CompositionVersion, row.adopted_version_id)
    tag = f'"{version.content_digest}"'
    headers = {
        "ETag": tag,
        "Cache-Control": CACHE_CONTROL,
        "Vary": VARY,
        "X-Content-Type-Options": "nosniff",
        "OpenBinding-Adoption": str(row.adoption_ordinal),
        "OpenBinding-Composition-Version": version.label,
    }
    if matches(if_none_match, tag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(content=version.content.encode("utf-8"), media_type=MEDIA_TYPE, headers=headers)

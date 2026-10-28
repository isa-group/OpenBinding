"""Optimistic concurrency for edit routes: ETag, ``If-Match`` and 412.

The revision of a row is its ``updated_at``, normalised to UTC with
microsecond precision (SQLite hands the value back naive, PostgreSQL aware).
The ETag is a strong, opaque digest of that value together with the table and
the id, so tags of different rows never collide and nothing about the row is
readable from the tag.

A client that sends ``If-Match`` gets two protections.  ``precondition`` refuses
a stale tag before anything else is validated; ``guard`` then bumps
``updated_at`` with ``UPDATE ... WHERE id = :id AND updated_at = :expected`` in
the transaction of the edit.  That statement takes the row lock, so of two
writers holding the same tag only one finds the row unchanged; the other sees
no row updated and gets the 412.  Without the header nothing changes.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Response, status
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.errors import ErrorResponse, api_error

IF_MATCH_DESCRIPTION = (
    "Revision the client last read, as given by the `ETag` of a GET or of an earlier edit: an entity-tag, "
    "a list of them, or `*` for any existing resource. Absent: the edit is applied without a revision check. "
    "Weak tags never match."
)

PRECONDITION_RESPONSES = {
    400: {
        "model": ErrorResponse,
        "description": "`If-Match` is not a list of entity-tags or `*` (code `invalid_if_match`).",
    },
    412: {
        "model": ErrorResponse,
        "description": (
            "`If-Match` does not match the current revision (code `precondition_failed`): nothing was "
            "applied. The `ETag` header carries the current revision."
        ),
    },
}

_ENTITY_TAG = r'(?:W/)?"[\x21\x23-\x7e\x80-\xff]*"'
# RFC 9110 5.6.1.2: a list recipient accepts empty elements, but needs at least one tag.
_IF_MATCH = re.compile(rf"\s*(?:\*|(?:,\s*)*{_ENTITY_TAG}(?:(?:\s*,)+\s*{_ENTITY_TAG})*(?:\s*,)*)\s*")
_TAG = re.compile(_ENTITY_TAG)


def normalise(moment: datetime) -> datetime:
    """The instant as aware UTC; a naive value is taken to be UTC already."""

    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def etag_for(row: Any) -> str:
    """The strong ETag of the row's current revision."""

    stamp = normalise(row.updated_at).isoformat(timespec="microseconds")
    digest = hashlib.sha256(f"{row.__tablename__}:{row.id}:{stamp}".encode()).hexdigest()
    return f'"{digest[:32]}"'


def parse_if_match(value: str | None) -> list[str] | None:
    """``None`` when the header is absent, else its entity-tags (``["*"]`` for the wildcard).

    Weak tags are kept with their ``W/`` prefix, so they can never equal a strong one.
    """

    if value is None:
        return None
    if _IF_MATCH.fullmatch(value) is None:
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            "invalid_if_match",
            "If-Match must be `*` or a comma-separated list of entity-tags.",
        )
    if value.strip() == "*":
        return ["*"]
    return _TAG.findall(value)


def precondition(row: Any, if_match: str | None) -> None:
    """Refuse a stale ``If-Match`` with 412 and the current ETag; absent header passes."""

    tags = parse_if_match(if_match)
    if tags is None or "*" in tags:
        return
    current = etag_for(row)
    if current not in tags:
        raise api_error(
            status.HTTP_412_PRECONDITION_FAILED,
            "precondition_failed",
            "The resource changed since it was read; fetch it again and retry.",
            headers={"ETag": current},
        )


async def guard(session: AsyncSession, row: Any, if_match: str | None) -> None:
    """Check ``If-Match`` and, when the header is present, claim the row for this transaction.

    Call it after authorisation and before validating the edit.  The claim is an
    UPDATE conditional on the revision that was read, so a concurrent writer
    that committed in between makes it match nothing (412) rather than be
    overwritten.  It also bumps ``updated_at``, so the tag always changes with
    a guarded edit.
    """

    if if_match is None:
        return
    precondition(row, if_match)
    model = type(row)
    previous = normalise(row.updated_at)
    bumped = max(datetime.now(timezone.utc), previous + timedelta(microseconds=1))
    # ``*`` accepts any revision, so only a vanished row can make its claim fail.
    unchanged = [] if "*" in parse_if_match(if_match) else [model.updated_at == row.updated_at]
    claimed = await session.execute(
        update(model)
        .where(model.id == row.id, *unchanged)
        .values(updated_at=bumped)
        .execution_options(synchronize_session=False)
    )
    if claimed.rowcount != 1:
        await session.refresh(row, ["updated_at"])
        raise api_error(
            status.HTTP_412_PRECONDITION_FAILED,
            "precondition_failed",
            "The resource changed since it was read; fetch it again and retry.",
            headers={"ETag": etag_for(row)},
        )
    await session.refresh(row, ["updated_at"])


def set_etag(response: Response, row: Any) -> None:
    response.headers["ETag"] = etag_for(row)

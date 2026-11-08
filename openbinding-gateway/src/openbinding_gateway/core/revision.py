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

from fastapi import Header, HTTPException, Response, status
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ..models.errors import ErrorResponse, api_error

IF_MATCH_DESCRIPTION = (
    "Revision the client last read, as given by the `ETag` of a GET or of an earlier edit: an entity-tag, "
    "a list of them, or `*` for any existing resource. Absent: the edit is applied without a revision check. "
    "Weak tags never match."
)

#: The ``ETag`` response header as OpenAPI declares it, shared by every conditional route.
ETAG_HEADER: dict[str, Any] = {
    "description": "Revision of the resource; send it back as `If-Match` to edit it.",
    "schema": {"type": "string"},
}

#: Fragment merged into the 200 of a read or edit: the response declares its ``ETag``.
ETAG_RESPONSE: dict[int | str, dict[str, Any]] = {200: {"headers": {"ETag": ETAG_HEADER}}}

#: The shared ``If-Match`` request header (optional).
IF_MATCH_HEADER = Header(None, alias="If-Match", description=IF_MATCH_DESCRIPTION)

PRECONDITION_RESPONSES: dict[int | str, dict[str, Any]] = {
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
        "headers": {"ETag": ETAG_HEADER},
    },
}

#: Responses of a guarded edit: 400, 412 and the ``ETag`` of the 200.
EDIT_RESPONSES: dict[int | str, dict[str, Any]] = {**PRECONDITION_RESPONSES, **ETAG_RESPONSE}

# RFC 9110 5.6.3: optional whitespace is space and horizontal tab only.
MAX_IF_MATCH_LENGTH = 2048
_ENTITY_TAG = r'(?:W/)?"[\x21\x23-\x7e\x80-\xff]*"'
# RFC 9110 5.6.1.2: a list recipient accepts empty elements, but needs at least one tag.
_IF_MATCH = re.compile(
    rf"[ \t]*(?:\*|(?:,[ \t]*)*{_ENTITY_TAG}(?:(?:[ \t]*,)+[ \t]*{_ENTITY_TAG})*(?:[ \t]*,)*)[ \t]*"
)
_TAG = re.compile(_ENTITY_TAG)


def normalise(moment: datetime) -> datetime:
    """The instant as aware UTC; a naive value is taken to be UTC already."""

    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def etag_for(row: Any) -> str:
    """The strong ETag of the row's current revision."""

    return _etag(row, row.updated_at)


def _etag(row: Any, updated_at: datetime) -> str:
    stamp = normalise(updated_at).isoformat(timespec="microseconds")
    return opaque_etag(row.__tablename__, row.id, stamp)


def opaque_etag(*parts: object) -> str:
    """A strong ETag that is a digest of ``parts``: nothing about them is readable from it.

    For a resource whose revision is not a row's ``updated_at`` (a SPACE contract's
    version, say), ``parts`` name the kind, the resource and that revision.
    """

    digest = hashlib.sha256(":".join(str(part) for part in parts).encode()).hexdigest()
    return f'"{digest[:32]}"'


def parse_if_match(value: str | None) -> list[str] | None:
    """``None`` when the header is absent, else its entity-tags (``["*"]`` for the wildcard).

    Weak tags are kept with their ``W/`` prefix, so they can never equal a strong one.
    """

    if value is None:
        return None
    if len(value) > MAX_IF_MATCH_LENGTH or _IF_MATCH.fullmatch(value) is None:
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            "invalid_if_match",
            "If-Match must be `*` or a comma-separated list of entity-tags.",
        )
    if value.strip(" \t") == "*":
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


def names(tags: list[str] | None) -> bool:
    """Whether parsed ``If-Match`` tags name a revision: present, and not the wildcard."""

    return tags is not None and "*" not in tags


def precondition_failed(current: str | None) -> HTTPException:
    """The 412 of an ``If-Match`` that does not name ``current``, which it carries as ``ETag`` (if any)."""

    return api_error(
        status.HTTP_412_PRECONDITION_FAILED,
        "precondition_failed",
        "The resource changed since it was read; fetch it again and retry.",
        headers={"ETag": current} if current else None,
    )


def check(tags: list[str] | None, current: str | None) -> None:
    """Refuse parsed ``If-Match`` tags that do not name ``current``, an ETag the caller computed.

    For a resource whose revision is not a row (see ``opaque_etag``). Absent and
    ``*`` pass: the caller has read the resource, so it exists. ``current`` is
    ``None`` when the resource keeps no revision; no tag names that, and the 412
    then carries no ``ETag``.
    """

    if names(tags) and (current is None or current not in tags):
        raise precondition_failed(current)


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
        current = (await session.execute(select(model.updated_at).where(model.id == row.id))).scalar_one_or_none()
        if current is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "The resource no longer exists.")
        raise api_error(
            status.HTTP_412_PRECONDITION_FAILED,
            "precondition_failed",
            "The resource changed since it was read; fetch it again and retry.",
            headers={"ETag": _etag(row, current)},
        )
    await session.refresh(row, ["updated_at"])
    # Every later flush of this transaction must write the claimed value, not the ``onupdate``
    # clock, which may be older: ``_keep_claims`` flags the attribute again before each flush.
    session.sync_session.info.setdefault(_CLAIMS, []).append(row)
    flag_modified(row, "updated_at")


_CLAIMS = "revision_claims"


@event.listens_for(Session, "before_flush")
def _keep_claims(session: Session, _context: Any, _instances: Any) -> None:
    for claimed in session.info.get(_CLAIMS, ()):
        if claimed in session and "updated_at" in claimed.__dict__:
            flag_modified(claimed, "updated_at")


@event.listens_for(Session, "after_transaction_end")
def _release_claims(session: Session, transaction: Any) -> None:
    if transaction.parent is None:
        session.info.pop(_CLAIMS, None)


def set_etag(response: Response, row: Any) -> None:
    response.headers["ETag"] = etag_for(row)

"""Blobs: files kept for an organization, stored once per content on disk.

A file lives at a global content-addressed path (``artifact_root/aa/bb/<hex>``); a row of ``blobs``
says that an organization keeps those bytes (``UNIQUE(organization_id, digest)``). The row carries no
quota meaning: what an account is charged for is counted where the bytes are used (D23).

Nothing here, and nothing in a request handler, ever deletes a file (D14). The paths are shared by every
organization, so a delete on the request path would race with another organization's upload of the same
bytes that is not committed yet, and for a problem revision the blob is the only copy of the package that a
later toolchain recompiles. Reclaiming disk is a maintenance sweep's job.
"""

from __future__ import annotations

import os
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path

from bim_core.canonical import digest_bytes
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.settings import get_settings
from ...db.models import Blob
from ...models.errors import api_error


@dataclass(frozen=True)
class BlobFile:
    """A file written to the store: where it is, its ``sha256-`` digest and its size."""

    storage_uri: str
    digest: str
    size: int


def path_for(digest_value: str) -> Path:
    """The content-addressed path of ``digest_value`` under ``ARTIFACT_ROOT``."""
    hexadecimal = digest_value.removeprefix("sha256-")
    return Path(get_settings().artifact_root) / hexadecimal[:2] / hexadecimal[2:4] / hexadecimal


def write_file(data: bytes) -> BlobFile:
    """Store ``data`` at its content address; idempotent. Runs outside any transaction.

    An existing file is reused only when its bytes hash to the address (never overwritten, never trusted);
    a new one is written to a temporary file in the same directory and moved into place atomically.
    """
    value = digest_bytes(data)
    destination = path_for(value)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if digest_bytes(destination.read_bytes()) != value:
            raise api_error(409, "content_integrity", "The stored content for this digest does not match it.")
        return BlobFile(str(destination), value, len(data))
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
        os.replace(temporary, destination)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return BlobFile(str(destination), value, len(data))


async def put_row(
    session: AsyncSession,
    organization_id: uuid.UUID,
    stored: BlobFile,
    media_type: str,
    actor_id: uuid.UUID,
) -> Blob:
    """The organization's row for ``stored``: the existing one, or a new one (a lost insert race reselects)."""
    query = select(Blob).where(Blob.organization_id == organization_id, Blob.digest == stored.digest)
    existing = await session.scalar(query)
    if existing is not None:
        return existing
    row = Blob(
        organization_id=organization_id,
        digest=stored.digest,
        media_type=media_type,
        size_bytes=stored.size,
        storage_uri=stored.storage_uri,
        created_by_id=actor_id,
    )
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        existing = await session.scalar(query)
        if existing is None:
            raise
        return existing
    return row


def read_verified(blob: Blob) -> bytes:
    """The bytes of ``blob``, checked against its digest (409 when missing or altered)."""
    try:
        content = Path(blob.storage_uri).read_bytes()
    except OSError as exc:
        raise api_error(409, "content_unavailable", "The stored content is unavailable.") from exc
    if digest_bytes(content) != blob.digest:
        raise api_error(409, "content_integrity", "The stored content does not match its digest.")
    return content

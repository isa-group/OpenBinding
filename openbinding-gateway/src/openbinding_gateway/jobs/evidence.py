"""The raw answer of an engine, kept while BIM evaluates it and after BIM failed to.

A solve can take half an hour and BIM can be down for a minute, so the answer is
written (and committed) before BIM is called, and a BIM that fails leaves the job
FAILED with a reference to it. Evaluating again then costs one call to BIM, not
another solve. A success deletes every row of the job: only failures keep a body.

The body can contain text written by the publisher of the engine, so nothing here
returns it to a client; it is read back only to be evaluated again. Retention and
the clock follow the leases: the database's clock decides, in the statement itself.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from bim_core.canonical import digest
from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import get_settings
from ..db.models import JobEngineEvidence
from ..v1.remote import MAX_REMOTE_RESPONSE
from . import clock
from .leases import aware

logger = logging.getLogger(__name__)

#: The largest body kept: the largest answer the transport accepts from an engine.
MAX_EVIDENCE_BYTES = MAX_REMOTE_RESPONSE

#: How many expired rows one sweep deletes.
PURGE_BATCH = 500

SECONDS_PER_DAY = 24 * 60 * 60


@dataclass(frozen=True)
class StoredEvidence:
    """What a failed job shows of its evidence: never the body."""

    id: uuid.UUID
    digest: str
    expires_at: datetime

    def reference(self) -> dict[str, str]:
        return {"id": str(self.id), "digest": self.digest, "expiresAt": aware(self.expires_at).isoformat()}


def encoded_size(raw_result: Any) -> int:
    return len(json.dumps(raw_result, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


async def store(
    session: AsyncSession, job_id: uuid.UUID, attempt: int, raw_result: dict[str, Any]
) -> StoredEvidence | None:
    """Stage the raw answer of ``attempt`` in the caller's transaction; ``None`` when it is over the bound.

    The caller commits. The expiry is the database's now plus the retention.
    """
    size = encoded_size(raw_result)
    if size > MAX_EVIDENCE_BYTES:
        logger.warning("The answer for job %s is %d bytes, over the %d kept; not keeping it", job_id, size, MAX_EVIDENCE_BYTES)
        return None
    evidence_id = uuid.uuid4()
    raw_digest = digest(raw_result)
    inserted = await session.execute(
        insert(JobEngineEvidence)
        .values(
            id=evidence_id,
            job_id=job_id,
            attempt=attempt,
            raw_result=raw_result,
            digest=raw_digest,
            created_at=clock.now(session),
            expires_at=clock.after(session, get_settings().evidence_retention_days * SECONDS_PER_DAY),
        )
        .returning(JobEngineEvidence.expires_at)
    )
    return StoredEvidence(id=evidence_id, digest=raw_digest, expires_at=inserted.scalar_one())


async def current(session: AsyncSession, job_id: uuid.UUID, attempt: int) -> JobEngineEvidence | None:
    """The row of the job's current attempt; the rows of earlier attempts are never used."""
    return (
        await session.execute(
            select(JobEngineEvidence).where(JobEngineEvidence.job_id == job_id, JobEngineEvidence.attempt == attempt)
        )
    ).scalars().first()


async def is_current(session: AsyncSession, row: JobEngineEvidence) -> bool:
    """Whether the row has not reached its expiry, by the database's clock."""
    return aware(row.expires_at) > await clock.read_now(session)


async def delete_for_job(session: AsyncSession, job_id: uuid.UUID) -> int:
    """Delete every row of the job (the caller commits): what any success does."""
    deleted = await session.execute(
        delete(JobEngineEvidence)
        .where(JobEngineEvidence.job_id == job_id)
        .execution_options(synchronize_session=False)
    )
    return deleted.rowcount or 0


async def discard_attempt(session: AsyncSession, job_id: uuid.UUID, attempt: int) -> None:
    """Best effort: delete and commit the row of an attempt whose lease was lost. Never raises."""
    try:
        await session.execute(
            delete(JobEngineEvidence)
            .where(JobEngineEvidence.job_id == job_id, JobEngineEvidence.attempt == attempt)
            .execution_options(synchronize_session=False)
        )
        await session.commit()
    except Exception:
        logger.warning("Could not delete the evidence of attempt %s of job %s", attempt, job_id, exc_info=True)
        try:
            await session.rollback()
        except Exception:
            logger.warning("Could not roll back after deleting the evidence of job %s", job_id, exc_info=True)


async def purge_expired(session: AsyncSession, limit: int = PURGE_BATCH) -> int:
    """Delete up to ``limit`` expired rows, skipping rows another replica holds. The caller commits."""
    expired = (
        await session.execute(
            select(JobEngineEvidence.id)
            .where(JobEngineEvidence.expires_at < clock.now(session))
            .order_by(JobEngineEvidence.expires_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
    ).scalars().all()
    if not expired:
        return 0
    await session.execute(
        delete(JobEngineEvidence)
        .where(JobEngineEvidence.id.in_(expired))
        .execution_options(synchronize_session=False)
    )
    return len(expired)

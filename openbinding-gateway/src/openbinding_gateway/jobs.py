"""Where a solve in flight is kept, and who it belongs to.

Jobs used to be a dictionary on the process. That was fine while the gateway
was anonymous and single-replica, and stopped being fine for two reasons at
once: a restart lost every result, and ``GET /v1/jobs/{id}`` handed any caller
who guessed an identifier somebody else's answer.

So there are two stores behind one interface. The database store is what a
deployment with accounts uses, and it is what makes a job survive a restart and
belong to someone. The in-memory store is what a gateway configured without a
database still gets - the anonymous service, working exactly as it did.

Which one is in use is decided per call rather than at import, because the
tests and the no-database deployment need the memory store while everything
else needs the other, and neither should have to know about the choice.
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from .db import base as db_base
from .db.models import Job, JobState
from .models.api import JobStatus


class GatewayJob:
    """A solve the gateway is tracking, whichever store it came from."""

    def __init__(
        self,
        engine_id: str,
        engine_job_id: str,
        service_url: str,
        *,
        job_id: Optional[str] = None,
        owner_id: Optional[uuid.UUID] = None,
    ):
        self.id = job_id or str(uuid.uuid4())
        self.engine_id = engine_id
        self.engine_job_id = engine_job_id
        self.service_url = service_url
        self.owner_id = owner_id
        self.status = JobStatus.QUEUED
        self.created_at = None
        self.result = None
        self.metadata: Dict[str, Any] = {}

    def readable_by(self, user) -> bool:
        """Whether this user may see this job.

        An unowned job - one from a gateway running without accounts - is
        readable by anyone, because there is nobody it could belong to. An
        owned one is its owner's, and an administrator's.
        """
        if self.owner_id is None:
            return True
        if user is None:
            return False
        return self.owner_id == user.id or getattr(user, "is_admin", False)


class InMemoryJobStore:
    """The original dictionary, kept for gateways with no database."""

    _jobs: Dict[str, GatewayJob] = {}

    @classmethod
    async def create(
        cls,
        engine_id: str,
        engine_job_id: str,
        service_url: str,
        *,
        owner_id: Optional[uuid.UUID] = None,
        session: Optional[AsyncSession] = None,
    ) -> GatewayJob:
        job = GatewayJob(engine_id, engine_job_id, service_url, owner_id=owner_id)
        cls._jobs[job.id] = job
        return job

    @classmethod
    async def get(
        cls, job_id: str, *, session: Optional[AsyncSession] = None
    ) -> Optional[GatewayJob]:
        return cls._jobs.get(job_id)

    @classmethod
    async def save(cls, job: GatewayJob, *, session: Optional[AsyncSession] = None) -> None:
        cls._jobs[job.id] = job


def _to_gateway_job(row: Job) -> GatewayJob:
    job = GatewayJob(
        row.engine_id,
        row.engine_job_id,
        row.service_url,
        job_id=str(row.id),
        owner_id=row.owner_id,
    )
    job.status = JobStatus(row.state.value)
    job.created_at = row.created_at
    job.result = row.result
    job.metadata = {
        "verbose": row.verbose,
        "warnings": row.warnings or [],
        "original_request": row.original_request or {},
    }
    if row.binding_space:
        job.metadata["binding_space"] = row.binding_space
    return job


class DatabaseJobStore:
    """Jobs as rows, so that they outlive the process and have an owner."""

    @staticmethod
    async def create(
        engine_id: str,
        engine_job_id: str,
        service_url: str,
        *,
        owner_id: Optional[uuid.UUID] = None,
        session: AsyncSession,
    ) -> GatewayJob:
        row = Job(
            engine_id=engine_id,
            engine_job_id=engine_job_id,
            service_url=service_url,
            owner_id=owner_id,
            state=JobState.QUEUED,
        )
        session.add(row)
        await session.flush()
        return _to_gateway_job(row)

    @staticmethod
    async def get(job_id: str, *, session: AsyncSession) -> Optional[GatewayJob]:
        try:
            key = uuid.UUID(job_id)
        except (ValueError, AttributeError):
            # A job identifier that is not a UUID names nothing; saying so is
            # the same answer as a UUID that happens not to exist.
            return None

        row = await session.get(Job, key)
        return _to_gateway_job(row) if row is not None else None

    @staticmethod
    async def save(job: GatewayJob, *, session: AsyncSession) -> None:
        row = await session.get(Job, uuid.UUID(job.id))
        if row is None:
            return

        row.state = JobState(job.status.value)
        row.verbose = bool(job.metadata.get("verbose", False))
        # What the caller was allowed to spend. The reconciler settles an
        # abandoned job against this rather than guessing at it.
        budget = job.metadata.get("budget_s")
        if budget is not None:
            row.requested_budget_s = float(budget)
        row.warnings = job.metadata.get("warnings") or None
        row.original_request = job.metadata.get("original_request") or None
        row.binding_space = job.metadata.get("binding_space") or None
        if job.result is not None:
            row.result = (
                job.result.model_dump(mode="json")
                if hasattr(job.result, "model_dump")
                else job.result
            )
        await session.flush()


class JobManager:
    """The store in use, chosen by whether this gateway has a database."""

    @staticmethod
    def store():
        return DatabaseJobStore if db_base.is_configured() else InMemoryJobStore

    @classmethod
    async def create_job(
        cls,
        engine_id: str,
        engine_job_id: str,
        service_url: str,
        *,
        owner_id: Optional[uuid.UUID] = None,
        session: Optional[AsyncSession] = None,
    ) -> GatewayJob:
        if session is not None:
            return await DatabaseJobStore.create(
                engine_id, engine_job_id, service_url, owner_id=owner_id, session=session
            )
        return await InMemoryJobStore.create(
            engine_id, engine_job_id, service_url, owner_id=owner_id
        )

    @classmethod
    async def get_job(
        cls, job_id: str, *, session: Optional[AsyncSession] = None
    ) -> Optional[GatewayJob]:
        if session is not None:
            found = await DatabaseJobStore.get(job_id, session=session)
            if found is not None:
                return found
        return await InMemoryJobStore.get(job_id)

    @classmethod
    async def save_job(
        cls, job: GatewayJob, *, session: Optional[AsyncSession] = None
    ) -> None:
        if session is not None:
            await DatabaseJobStore.save(job, session=session)
        else:
            await InMemoryJobStore.save(job)

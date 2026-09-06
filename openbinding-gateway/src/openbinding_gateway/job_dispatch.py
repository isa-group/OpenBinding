"""The one durable queue boundary for persisted solve jobs."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Optional

import dramatiq
from dramatiq.asyncio import get_event_loop_thread
from dramatiq.brokers.redis import RedisBroker
from dramatiq.middleware import AsyncIO, Middleware
from dramatiq.middleware.middleware import MiddlewareError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from . import space_client
from .core.settings import get_settings
from .db import base as db_base
from .db.models import Job, JobState, utcnow

_configured_url: Optional[str] = None
_runtime_started = False
logger = logging.getLogger(__name__)


async def start_worker_runtime() -> None:
    """Open the durable dependencies on Dramatiq's long-lived event loop."""

    global _runtime_started
    if _runtime_started:
        return
    settings = get_settings()
    if not settings.database_url:
        raise RuntimeError("Dramatiq workers require DATABASE_URL; queued jobs cannot run in memory.")
    db_base.init_engine(settings.database_url)
    space_client.set_gate(space_client.build_gate(settings))
    try:
        async with db_base.session_factory()() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        gate = space_client.get_gate()
        if hasattr(gate, "aclose"):
            await gate.aclose()
        space_client.set_gate(None)
        await db_base.dispose_engine()
        raise
    _runtime_started = True
    logger.info("Dramatiq runtime connected to PostgreSQL and initialized the pricing gate")


async def stop_worker_runtime() -> None:
    """Close resources before Dramatiq tears down its event-loop thread."""

    global _runtime_started
    if not _runtime_started:
        return
    gate = space_client.get_gate()
    if hasattr(gate, "aclose"):
        await gate.aclose()
    space_client.set_gate(None)
    await db_base.dispose_engine()
    _runtime_started = False


class WorkerRuntime(Middleware):
    """Make dependency initialization part of worker readiness, not a message side effect."""

    def before_worker_boot(self, broker, worker) -> None:
        event_loop = get_event_loop_thread()
        if event_loop is None:
            raise MiddlewareError("The Dramatiq AsyncIO middleware did not start an event loop.")
        try:
            event_loop.run_coroutine(start_worker_runtime())
        except Exception as exc:
            raise MiddlewareError(f"OpenBinding worker startup failed: {exc}") from exc

    def after_worker_shutdown(self, broker, worker) -> None:
        event_loop = get_event_loop_thread()
        if event_loop is not None:
            event_loop.run_coroutine(stop_worker_runtime())


def configure_broker() -> RedisBroker:
    global _configured_url
    url = get_settings().redis_url
    actor = globals().get("run_persisted_job_message")
    if _configured_url == url and actor is not None and isinstance(actor.broker, RedisBroker):
        return actor.broker
    broker = RedisBroker(url=url)
    broker.add_middleware(AsyncIO())
    broker.add_middleware(WorkerRuntime())
    dramatiq.set_broker(broker)
    if actor is not None:
        actor.broker = broker
        broker.declare_actor(actor)
    _configured_url = url
    return broker


async def _execute(job_id: str, request_session: AsyncSession | None = None) -> None:
    # Lazy import keeps the BIM router free of a module cycle.
    from .routes.v1 import _run_persisted_job
    from .study_jobs import sync_study_job

    await _run_persisted_job(job_id, request_session)
    await sync_study_job(job_id, request_session)


@dramatiq.actor(
    actor_name="openbinding.run_persisted_job",
    max_retries=5,
    min_backoff=1_000,
    max_backoff=30_000,
)
async def run_persisted_job_message(job_id: str) -> None:
    if not _runtime_started or not db_base.is_configured():
        raise RuntimeError("The durable worker runtime is not initialized; refusing to acknowledge the job.")
    await _execute(job_id)


async def dispatch_persisted_job(
    job_id: str, request_session: AsyncSession | None = None
) -> bool:
    settings = get_settings()
    if settings.job_dispatch_mode == "dramatiq":
        configure_broker()
        try:
            run_persisted_job_message.send(job_id)
        except Exception:
            # The row is the durable source of truth.  A broker outage after
            # commit must not turn a valid 202 into an untracked lost job;
            # the reconciler republishes old QUEUED rows when Redis returns.
            logger.exception("Could not publish job %s; it remains queued for redelivery", job_id)
            return False
        return True
    # Inline mode is for tests and single-process development. It deliberately
    # awaits the same durable runner rather than maintaining a second path.
    await _execute(job_id, request_session)
    return True


async def redeliver_queued_jobs(
    session: AsyncSession,
    *,
    older_than_s: float = 30.0,
) -> int:
    """Republish persisted work that could have missed the broker hand-off.

    Delivery is intentionally at-least-once.  The database runner claims the
    QUEUED row, so a duplicate Redis message cannot execute a terminal job.
    """

    settings = get_settings()
    if settings.job_dispatch_mode != "dramatiq":
        return 0
    cutoff = utcnow() - timedelta(seconds=max(0.0, older_than_s))
    job_ids = (
        await session.execute(
            select(Job.id).where(Job.state == JobState.QUEUED, Job.created_at <= cutoff)
        )
    ).scalars().all()
    delivered = 0
    for job_id in job_ids:
        if not await dispatch_persisted_job(str(job_id)):
            break
        delivered += 1
    return delivered

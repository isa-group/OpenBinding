"""At-least-once delivery and leased completion of exact archive Pareto work."""
from __future__ import annotations

import asyncio
import logging
import time
import uuid

import dramatiq
from sqlalchemy import select, update

from .db import base as db_base
from .db.models import AnalysisTask, User
from .jobs import clock, leases
from .models.analysis import AnalysisQuery
from .v1.archive import decide, exact_layers, pareto_rows

logger = logging.getLogger(__name__)
_INLINE_TASKS: set[asyncio.Task] = set()
_CPU_SLOT = asyncio.Semaphore(1)

#: How long a claim is good for without being renewed, and how many times a task
#: may be claimed. A worker lost mid-computation gets the task put back until the
#: third claim; the next loss fails it as ``analysis_abandoned``, so a task that
#: kills its worker cannot circle the queue forever.
LEASE_S = 60.0
MAX_ATTEMPTS = 3


class AnalysisCancelled(Exception):
    pass


async def renew_analysis_lease(task_id: uuid.UUID, token: str) -> bool:
    """Push the lease forward (by the database clock), but only for the worker that holds it."""
    async with db_base.session_factory()() as session:
        renewed = await session.execute(
            update(AnalysisTask)
            .where(
                AnalysisTask.id == task_id,
                AnalysisTask.state == "running",
                AnalysisTask.lease_token == token,
                AnalysisTask.cancellation_requested.is_(False),
            )
            .values(lease_until=clock.after(session, LEASE_S))
            .returning(AnalysisTask.id)
            .execution_options(synchronize_session=False)
        )
        held = renewed.first() is not None
        await session.commit()
        return held


async def execute_analysis(task_id: str):
    from .routes.analysis import load_archive
    async with _CPU_SLOT:
        token = str(uuid.uuid4())
        task_uuid = uuid.UUID(task_id)
        async with db_base.session_factory()() as session:
            claimed = await session.execute(update(AnalysisTask).where(AnalysisTask.id == task_uuid,
                AnalysisTask.state == "queued", AnalysisTask.cancellation_requested.is_(False)).values(
                state="running", lease_token=token, lease_until=clock.after(session, LEASE_S),
                attempts=AnalysisTask.attempts + 1, updated_at=clock.now(session)
            ).execution_options(synchronize_session=False))
            await session.commit()
            if not claimed.rowcount:
                return
        # The lease is renewed in the background for as long as the task runs, so
        # a long load or one long layer of the computation cannot let it lapse.
        # The outcome is committed before the beat stops.
        beat = leases.start_beat(lambda: renew_analysis_lease(task_uuid, token), label=f"analysis task {task_id}")
        try:
            await _run_claimed(task_id, task_uuid, token, load_archive)
        finally:
            await leases.stop_heartbeat(beat)


async def _run_claimed(task_id: str, task_uuid: uuid.UUID, token: str, load_archive) -> None:
    async with db_base.session_factory()() as session:
        task = await session.get(AnalysisTask, task_uuid)
        payload = AnalysisQuery.model_validate(task.request)
        owner = await session.get(User, task.owner_id)
        try:
            if owner is None or not owner.is_active:
                raise ValueError("The analysis owner is unavailable")
            archive = await load_archive(payload, owner, session)
        except Exception as exc:
            await session.execute(update(AnalysisTask).where(AnalysisTask.id == task.id, AnalysisTask.lease_token == token).values(
                state="failed", error=str(getattr(exc, "detail", exc))[:512], lease_token=None, lease_until=None))
            await session.commit()
            return
    loop = asyncio.get_running_loop()
    last_check = 0.0

    async def heartbeat(done, total):
        async with db_base.session_factory()() as session:
            changed = await session.execute(update(AnalysisTask).where(AnalysisTask.id == task_uuid,
                AnalysisTask.state == "running", AnalysisTask.lease_token == token,
                AnalysisTask.cancellation_requested.is_(False)).values(
                progress=done / max(1, total), lease_until=clock.after(session, LEASE_S),
                updated_at=clock.now(session)).execution_options(synchronize_session=False))
            await session.commit()
            return bool(changed.rowcount)

    def progress(done, total):
        nonlocal last_check
        now = time.monotonic()
        if now - last_check >= .25 or done == total:
            last_check = now
            if not asyncio.run_coroutine_threadsafe(heartbeat(done, total), loop).result():
                raise AnalysisCancelled()

    def calculate():
        progress(0, 1)
        decision = decide(archive, payload)
        rows = pareto_rows(archive, decision, payload)
        layers = exact_layers(tuple(c.losses for c in rows), progress)
        return {"scope": payload.paretoScope, "complete": True, "count": len(rows),
                "front": [c.id for c, rank in zip(rows, layers, strict=True) if rank == 1],
                "ranks": {c.id: rank for c, rank in zip(rows, layers, strict=True)} if payload.layers else None}

    try:
        # CPU work and cancellation checkpoints never block Dramatiq's async loop.
        result = await asyncio.to_thread(calculate)
        async with db_base.session_factory()() as session:
            # Revalidate source revision before publishing any complete result.
            await load_archive(payload, owner, session)
            await session.execute(update(AnalysisTask).where(AnalysisTask.id == task_uuid,
                AnalysisTask.state == "running", AnalysisTask.lease_token == token,
                AnalysisTask.cancellation_requested.is_(False)).values(state="completed", progress=1,
                    result=result, error=None, lease_token=None, lease_until=None, updated_at=clock.now(session)
                ).execution_options(synchronize_session=False))
            await session.commit()
    except AnalysisCancelled:
        return
    except Exception as exc:
        async with db_base.session_factory()() as session:
            await session.execute(update(AnalysisTask).where(AnalysisTask.id == task_uuid,
                AnalysisTask.state == "running", AnalysisTask.lease_token == token).values(
                state="failed", error=str(getattr(exc, "detail", exc))[:512], lease_token=None, lease_until=None))
            await session.commit()


@dramatiq.actor(actor_name="openbinding.analyze_archive", queue_name="analysis", max_retries=0, time_limit=float("inf"))
async def analyze_archive_message(task_id: str):
    if not db_base.is_configured():
        raise RuntimeError("The durable analysis worker database is not initialized")
    await execute_analysis(task_id)


async def dispatch_analysis(task_id: str):
    from .core.settings import get_settings
    from .job_dispatch import configure_broker
    if get_settings().job_dispatch_mode == "dramatiq":
        configure_broker()
        try:
            analyze_archive_message.send(task_id)
        except Exception:
            logger.exception("Analysis remains queued for redelivery: %s", task_id)
    else:
        task = asyncio.create_task(execute_analysis(task_id))
        _INLINE_TASKS.add(task)
        task.add_done_callback(_INLINE_TASKS.discard)


async def redeliver_analysis(session):
    """Fail or requeue the tasks whose worker was lost, then republish the queued ones.

    A lapsed lease (by the database clock) means the worker died: the task goes
    back in the queue until it has been claimed ``MAX_ATTEMPTS`` times, and after
    that it is failed as ``analysis_abandoned``.
    """
    now = clock.now(session)
    lapsed = (AnalysisTask.state == "running", AnalysisTask.lease_until < now)
    await session.execute(update(AnalysisTask).where(*lapsed, AnalysisTask.attempts >= MAX_ATTEMPTS).values(
        state="failed", error="analysis_abandoned", lease_token=None, lease_until=None, updated_at=now
    ).execution_options(synchronize_session=False))
    await session.execute(update(AnalysisTask).where(*lapsed).values(
        state="queued", lease_token=None, lease_until=None, progress=0, updated_at=now
    ).execution_options(synchronize_session=False))
    ids = (await session.execute(select(AnalysisTask.id).where(AnalysisTask.state == "queued",
        AnalysisTask.updated_at < clock.before(session, 30)))).scalars().all()
    await session.commit()
    for task_id in ids:
        await dispatch_analysis(str(task_id))

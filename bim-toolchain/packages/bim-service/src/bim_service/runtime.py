"""Bounded execution of CPU-bound operations.

Decoding a request, validating it, compiling or evaluating and rendering the answer are CPU work.  All of it runs in a
dedicated thread pool and the number that may run at once is capped: a request that finds no free slot within
``acquire_timeout_ms`` is answered 503 with ``Retry-After``, and a tenant (the identity bound to the caller's token, see
:mod:`bim_service.auth`) that already has its share in flight is answered 429; the global cap is independent of the
per-tenant share.  The slot is taken *before* the body is decoded, so the number of decoded bodies in memory is bounded
by the number of slots, not by the number of requests that arrive.

The slot is returned when the *thread* finishes, not when the request times out: a thread cannot be interrupted, so a
timed-out operation (or one whose client went away) keeps counting against the cap until it ends.  Releasing the slot
earlier would allow more threads than slots.

Limits of the thread mode.  ``json.loads`` and pydantic-core are C code that does not give up the GIL while they run,
and the compiler and the evaluator are pure Python that the interpreter switches every ``sys.setswitchinterval``: a large
body being parsed in a pool thread can still stall the event loop for about as long as the parse takes, and CPU-bound
threads slow the loop down.  Moving the work to the pool bounds how many such stalls run at once and what they hold in
memory; it does not remove them.  Only processes do: ``BIM_SERVICE_EXECUTOR=process`` (opt-in, Linux only) runs the
same jobs in worker processes (:mod:`bim_service.workers`, :meth:`Gate.run_process`).  The wait for a slot, the tenant
share, the memory charge and the answers for them are the ones of thread mode; what an operation holds is given back when
its worker has been killed and reaped (a timeout or a client that goes away stops the worker) and not when a computation
that nobody waits for would have ended.

Optional memory budget (``memory_budget_bytes``, off by default).  An operation is charged
:data:`~bim_service.settings.BODY_MEMORY_FACTOR` times its request body (an estimate, not a guarantee) from the moment
it holds a slot until its thread ends.  A charge that does not fit in what is left is answered 429 ``memory_budget``
with ``Retry-After``: it would fit once the other operations finish.  A charge larger than the whole budget can never
fit: it is answered 413 ``memory_budget_exceeded`` (no ``Retry-After``) before a tenant share or a slot is taken and
before anything is decoded, whatever else is in flight.  The charge is returned when the thread ends, like the slot.

Optional cap on in-flight request bodies (``max_pending_body_bytes``, derived from the budget when one is set).  The
ASGI layer buffers a whole body before the gate is asked for a slot, so without a cap the bodies of the requests that
wait (or are about to be refused) are bounded only by the number of connections.  :class:`BodyLedger` counts the bytes
of every body from the moment it starts to be read (the declared ``Content-Length`` up front, else the bytes as they
arrive) until the operation's thread ends, and refuses a body that does not fit in what is left with 429
``pending_body_bytes`` and ``Retry-After``; one that is larger than the whole cap, or whose estimate is larger than the
whole budget, with 413 and no ``Retry-After``.
"""

from __future__ import annotations

import asyncio
import threading
import time
import weakref
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from .problems import ServiceProblem
from .settings import BODY_MEMORY_FACTOR, BimServiceSettings
from .workers import Answer, ClientDisconnected, Disconnect, WorkerFailed, WorkerPool


def _retry_headers(settings: BimServiceSettings) -> dict[str, str]:
    return {"Retry-After": str(settings.retry_after_seconds)}


def check_memory_fits(settings: BimServiceSettings, cost: int) -> None:
    """Raise 413 ``memory_budget_exceeded`` when ``cost`` bytes can never fit an enabled memory budget."""
    budget = settings.memory_budget_bytes
    if budget and cost > budget:
        raise ServiceProblem(
            413,
            "memory_budget_exceeded",
            f"the request needs an estimated {cost} bytes of memory, which can never fit the configured memory budget "
            f"of {budget} bytes; send a smaller request",
        )


class BodyReservation:
    """The bytes of one request body held in a :class:`BodyLedger`.

    ``ensure`` grows it as the size becomes known, ``release`` gives everything back (idempotent).  Once the gate has
    started the operation's thread it takes the release over (:meth:`hand_off`): the bytes stay counted until the
    thread ends, not until the response is out.  :meth:`close` is what the request does when it is finished with it.
    """

    def __init__(self, ledger: "BodyLedger") -> None:
        self._ledger = ledger
        self._held = 0
        self._handed_off = False

    @property
    def held(self) -> int:
        return self._held

    def ensure(self, total: int) -> None:
        """Hold at least ``total`` bytes; raises the 413 or 429 problem when they do not fit."""
        if total <= self._held:
            return
        self._ledger._check_fits(total)
        self._ledger._take(total - self._held)
        self._held = total

    def hand_off(self) -> None:
        self._handed_off = True

    def release(self) -> None:
        held, self._held = self._held, 0
        self._ledger._give(held)

    def close(self) -> None:
        if not self._handed_off:
            self.release()


class BodyLedger:
    """Total request-body bytes in flight, bounded by the effective ``max_pending_body_bytes``."""

    def __init__(self, settings: BimServiceSettings) -> None:
        self._settings = settings
        self._cap = settings.effective_max_pending_body_bytes
        self._lock = threading.Lock()
        self._held = 0

    @property
    def enabled(self) -> bool:
        """Whether a body is checked at all: a cap, or a memory budget that a body can exceed."""
        return self._cap > 0 or self._settings.memory_budget_bytes > 0

    @property
    def held(self) -> int:
        return self._held

    def reservation(self) -> BodyReservation:
        return BodyReservation(self)

    def _check_fits(self, total: int) -> None:
        check_memory_fits(self._settings, total * BODY_MEMORY_FACTOR)
        if self._cap and total > self._cap:
            raise ServiceProblem(
                413,
                "pending_body_too_large",
                f"the request body of {total} bytes can never fit the configured limit of {self._cap} bytes of "
                "request bodies in flight; send a smaller request",
            )

    def _take(self, amount: int) -> None:
        if not self._cap or amount <= 0:
            return
        with self._lock:
            if self._held + amount > self._cap:
                raise ServiceProblem(
                    429,
                    "pending_body_bytes",
                    "the request bodies in flight already use the limit of the service; retry later",
                    headers=_retry_headers(self._settings),
                )
            self._held += amount

    def _give(self, amount: int) -> None:
        if not self._cap or amount <= 0:
            return
        with self._lock:
            self._held -= amount


class Gate:
    def __init__(self, settings: BimServiceSettings) -> None:
        self._settings = settings
        self._slots = threading.BoundedSemaphore(settings.max_concurrency)
        self._lock = threading.Lock()
        self._tenants: dict[str, int] = {}
        self._charged = 0
        self._chargers = 0
        self.bodies = BodyLedger(settings)
        #: The worker processes of ``BIM_SERVICE_EXECUTOR=process`` (refuses to exist where they cannot run); else ``None``.
        self.pool: WorkerPool | None = WorkerPool(settings) if settings.executor == "process" else None
        self._executor = (
            ThreadPoolExecutor(max_workers=settings.max_concurrency, thread_name_prefix="bim-op")
            if self.pool is None
            else None
        )
        if self.pool is not None:
            # Tests that never run the lifespan still stop the children when the gate goes away (or at interpreter exit).
            self._finalizer = weakref.finalize(self, self.pool.close)

    @property
    def process_mode(self) -> bool:
        return self.pool is not None

    def ready(self) -> bool:
        """Whether the executor can take work: always in thread mode, in process mode unless every worker slot is backing off."""
        return self.pool is None or self.pool.ready()

    def start_workers(self, check_fit: bool = True) -> None:
        """Start the worker processes now and check that they fit the container (process mode; blocking)."""
        if self.pool is not None:
            self.pool.start(check_fit)

    def _retry_headers(self) -> dict[str, str]:
        return _retry_headers(self._settings)

    def _take_tenant(self, tenant: str | None) -> None:
        limit = self._settings.effective_max_concurrency_per_tenant
        if tenant is None or limit == 0:
            return
        with self._lock:
            held = self._tenants.get(tenant, 0)
            if held >= limit:
                raise ServiceProblem(
                    429,
                    "rate_limited",
                    "the tenant already has the maximum number of operations in flight",
                    headers=self._retry_headers(),
                )
            self._tenants[tenant] = held + 1

    def _release_tenant(self, tenant: str | None) -> None:
        if tenant is None or self._settings.effective_max_concurrency_per_tenant == 0:
            return
        with self._lock:
            remaining = self._tenants.get(tenant, 0) - 1
            if remaining > 0:
                self._tenants[tenant] = remaining
            else:
                self._tenants.pop(tenant, None)

    def _take_memory(self, cost: int) -> int:
        """Charge ``cost`` bytes to the budget; the amount actually charged (0: no budget, or nothing to charge)."""
        budget = self._settings.memory_budget_bytes
        if budget == 0 or cost <= 0:
            return 0
        check_memory_fits(self._settings, cost)  # a cost above the whole budget is never admitted, alone or not
        with self._lock:
            if self._charged + cost > budget:
                raise ServiceProblem(
                    429,
                    "memory_budget",
                    "the operations in flight already use the memory budget of the service; retry later",
                    headers=self._retry_headers(),
                )
            self._charged += cost
            self._chargers += 1
        return cost

    def _release_memory(self, charged: int) -> None:
        if charged <= 0:
            return
        with self._lock:
            self._charged -= charged
            self._chargers -= 1

    async def _take_slot(self) -> None:
        deadline = time.monotonic() + self._settings.acquire_timeout_ms / 1000
        while not self._slots.acquire(blocking=False):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ServiceProblem(
                    503,
                    "service_busy",
                    "all operation slots are busy; retry later",
                    headers=self._retry_headers(),
                )
            await asyncio.sleep(min(0.01, remaining))

    def _finish(
        self, tenant: str | None, charged: int, reservation: BodyReservation | None, future: "asyncio.Future[Any]"
    ) -> None:
        self._slots.release()
        self._release_memory(charged)
        self._release_tenant(tenant)
        if reservation is not None:
            reservation.release()
        if not future.cancelled():
            future.exception()  # retrieved: a failure nobody waits for any more is not an "unretrieved" error

    async def run(
        self,
        function: Callable[..., Any],
        *args: Any,
        tenant: str | None = None,
        cost_bytes: int = 0,
        reservation: BodyReservation | None = None,
    ) -> Any:
        """``function(*args)`` in the pool, within the concurrency, memory and time limits.

        ``cost_bytes`` is the estimated memory the call needs (see the module docstring); ``function`` is what decodes
        the request, so it only starts once the slot and the budget are held.  A cost that can never fit the budget is
        refused first, holding nothing.  ``reservation`` (the body bytes of the request in :attr:`bodies`) is released
        by the gate when the thread ends if it got that far, and by whoever owns the request otherwise.
        """
        check_memory_fits(self._settings, cost_bytes)
        self._take_tenant(tenant)
        try:
            await self._take_slot()
        except BaseException:
            self._release_tenant(tenant)
            raise
        try:
            charged = self._take_memory(cost_bytes)
        except BaseException:
            self._slots.release()
            self._release_tenant(tenant)
            raise
        assert self._executor is not None, "Gate.run is the thread executor; use run_process"
        try:
            future = asyncio.get_running_loop().run_in_executor(self._executor, function, *args)
        except BaseException:
            self._slots.release()
            self._release_memory(charged)
            self._release_tenant(tenant)
            raise
        if reservation is not None:
            reservation.hand_off()
        future.add_done_callback(lambda done: self._finish(tenant, charged, reservation, done))
        finished, _ = await asyncio.wait({future}, timeout=self._settings.operation_timeout_seconds)
        if not finished:
            raise ServiceProblem(
                503,
                "operation_timeout",
                f"the operation exceeded its time budget of {self._settings.operation_timeout_seconds:g} s",
            )
        return future.result()

    def _finish_process(self, tenant: str | None, charged: int, reservation: BodyReservation | None) -> None:
        """What a process-mode operation gives back once its worker has returned or been reaped, in this order."""
        self._release_memory(charged)
        self._release_tenant(tenant)
        self._slots.release()
        if reservation is not None:
            reservation.release()

    async def run_process(
        self,
        op: str,
        content_type: str | None,
        body: bytes,
        *,
        tenant: str | None = None,
        cost_bytes: int = 0,
        reservation: BodyReservation | None = None,
        correlation_id: str = "-",
        disconnect: Disconnect | None = None,
    ) -> Answer:
        """The operation ``op`` on ``body`` in a worker process, within the same limits as :meth:`run`.

        The order is the one of :meth:`run` (memory check, tenant share, slot, memory charge, dispatch).  What the
        operation holds is given back when its worker has returned or been reaped, so a timeout or a disconnect frees
        the slot as soon as the child is gone.
        """
        assert self.pool is not None
        check_memory_fits(self._settings, cost_bytes)
        self._take_tenant(tenant)
        try:
            await self._take_slot()
        except BaseException:
            self._release_tenant(tenant)
            raise
        try:
            charged = self._take_memory(cost_bytes)
        except BaseException:
            self._slots.release()
            self._release_tenant(tenant)
            raise
        try:
            call = self.pool.submit(op, content_type, body, correlation_id)
        except BaseException:
            self._release_memory(charged)
            self._release_tenant(tenant)
            self._slots.release()
            raise
        if reservation is not None:
            reservation.hand_off()
        assert call.future is not None
        call.future.add_done_callback(lambda done: self._finish_process(tenant, charged, reservation))
        if disconnect is not None:
            disconnect.bind(call)
        try:
            outcome = await asyncio.wrap_future(call.future)
        except asyncio.CancelledError:
            call.abort("disconnect")
            raise
        if outcome.kind == "answer" and outcome.answer is not None:
            return outcome.answer
        if outcome.kind == "timeout":
            raise ServiceProblem(
                503,
                "operation_timeout",
                f"the operation exceeded its time budget of {self._settings.operation_timeout_seconds:g} s",
            )
        if outcome.kind == "cpu":
            raise ServiceProblem(
                503, "operation_timeout", "the operation exceeded the CPU time limit of its worker process"
            )
        if outcome.kind == "busy":
            raise ServiceProblem(
                503, "service_busy", "all operation slots are busy; retry later", headers=self._retry_headers()
            )
        if outcome.kind == "cancelled":
            raise ClientDisconnected()
        raise WorkerFailed(f"the worker failed while serving {op}")

    def close(self) -> None:
        if self.pool is not None:
            self.pool.close()
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
